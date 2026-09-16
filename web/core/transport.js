/**
 * Transport: WebRTC lanes with real backpressure.
 *
 * Three things here are the whole speed story, and all three are missing from every
 * browser file-transfer app we surveyed:
 *
 *   1. Chunk size is NEGOTIATED from `pc.sctp.maxMessageSize` instead of hardcoded.
 *   2. Flow control is event-driven on `bufferedamountlow`, never a per-megabyte round
 *      trip, which would cap throughput at 1 MB/RTT.
 *   3. A lane is a whole RTCPeerConnection, not just another data channel, because
 *      channels on one connection share a single SCTP association and therefore a
 *      single congestion/receive window. Extra lanes buy real parallelism on
 *      high-latency and relayed paths.
 */
const BUF_HIGH = 8 * 1024 * 1024;
const BUF_LOW = 1 * 1024 * 1024;
const CHUNK_MIN = 16 * 1024;
const CHUNK_MAX = 256 * 1024;
const FRAME_OVERHEAD = 64; // header + GCM tag headroom

/** Lanes are whole peer connections, so the number of them is not the peer's to choose. */
const MAX_LANES = 4;
/** An SDP describing two data channels is a few kilobytes; this is room to spare. */
const MAX_SDP = 64 * 1024;
/** Candidates held while waiting for a description to apply them to. */
const MAX_PENDING_ICE = 64;

export class Transport extends EventTarget {
  /**
   * @param {SecureSession} session
   * @param {object} opts  { iceConfig }
   */
  constructor(session, { iceConfig } = {}) {
    super();
    this.session = session;
    this.iceConfig = iceConfig || { iceServers: [] };
    this.lanes = [];
    this.ctl = null;
    this.chunkSize = 64 * 1024;
    this.closed = false;
    this.pathType = 'unknown';
    this.rtt = 0;

    // The peer holding session lane 0 offers; the other answers. Deterministic, no glare.
    this.isOfferer = session.lane === 0;

    // Everything this transport signals is stamped with the session generation it was
    // built for, and anything from another generation is ignored.
    this.gen = session.generation || 0;

    this._pending = new Map(); // lane -> queued remote candidates
    session.addEventListener('message', (e) =>
      this._onSignal(e.detail).catch((err) =>
        this.dispatchEvent(new CustomEvent('degraded', { detail: { lane: 0, state: String(err?.message || err) } })),
      ),
    );
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    await this._makeLane(0, true);
    if (this.isOfferer) await this._negotiate(0);
    return this;
  }

  async addLane() {
    if (this.lanes.length >= MAX_LANES) return null;
    const idx = this.lanes.length;
    await this._makeLane(idx, false);
    if (this.isOfferer) await this._negotiate(idx);
    return idx;
  }

  close() {
    this.session.transportLive = false;

    this.closed = true;
    for (const lane of this.lanes) {
      try {
        lane.pc.close();
      } catch {
        /* ignore */
      }
    }
    this.lanes = [];
    this.dispatchEvent(new CustomEvent('closed'));
  }

  /* ------------------------------------------------------------ negotiation */


  async _makeLane(idx, withCtl) {
    // No iceCandidatePoolSize: pre-gathered pool candidates can surface with an invalid
    // component id in Chromium, which the remote agent then refuses to pair.
    // Spelled out rather than spread. Spreading whatever arrived left every other knob
    // RTCPeerConnection accepts, including ones added in future browser versions, for the
    // relay to set, which is a wider grant than "here are the STUN servers".
    const pc = new RTCPeerConnection({
      iceServers: this.iceConfig.iceServers || [],
      ...(this.iceConfig.iceTransportPolicy ? { iceTransportPolicy: this.iceConfig.iceTransportPolicy } : {}),
      bundlePolicy: 'max-bundle',
    });
    const lane = { idx, pc, bulk: null, ready: false, sent: 0 };
    this.lanes[idx] = lane;

    pc.onicecandidate = (e) => {
      if (e.candidate) this.session.send({ t: 'ice', gen: this.gen, lane: idx, cand: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // Once nothing is carrying traffic, a fresh share from the peer is worth acting on
        // again, which lets a reconnect happen without waiting for the relay.
        if (!this.lanes.some((l) => l?.ready)) this.session.transportLive = false;
        this.dispatchEvent(new CustomEvent('degraded', { detail: { lane: idx, state: pc.connectionState } }));
      }
      if (pc.connectionState === 'connected') this._probePath(lane);
    };

    if (this.isOfferer) {
      if (withCtl) this._attachCtl(pc.createDataChannel('ctl', { ordered: true }));
      this._attachBulk(lane, pc.createDataChannel(`bulk${idx}`, { ordered: true }));
    } else {
      pc.ondatachannel = (e) => {
        if (e.channel.label === 'ctl') this._attachCtl(e.channel);
        else this._attachBulk(lane, e.channel);
      };
    }
    return lane;
  }

  _attachCtl(dc) {
    dc.binaryType = 'arraybuffer';
    this.ctl = dc;
    dc.onopen = () => this.dispatchEvent(new CustomEvent('open'));
    dc.onclose = () => this.dispatchEvent(new CustomEvent('ctl-closed'));
    dc.onmessage = (e) => {
      this.dispatchEvent(new CustomEvent('ctl', { detail: e.data }));
    };
  }

  _attachBulk(lane, dc) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUF_LOW;
    lane.bulk = dc;
    dc.onopen = () => {
      lane.ready = true;
      this.session.transportLive = true;
      this._negotiateChunkSize(lane);
      this.dispatchEvent(new CustomEvent('lane-open', { detail: lane.idx }));
    };
    dc.onclose = () => {
      lane.ready = false;
      /*
       * A channel can close on its own without the connection ever changing state, and the
       * only other place this flag is cleared is that state change. Left set, the session
       * goes on believing it is carrying traffic, and a session that believes that ignores a
       * peer republishing its share, which is what a peer that has just restarted does. One
       * side up around a transport with nothing open, the other trying to come back.
       */
      if (!this.lanes.some((l) => l?.ready)) this.session.transportLive = false;
    };
    dc.onmessage = (e) => {
      this.dispatchEvent(new CustomEvent('chunk', { detail: { lane: lane.idx, data: e.data } }));
    };
  }

  _negotiateChunkSize(lane) {
    const max = lane.pc.sctp?.maxMessageSize || 65536;
    const size = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, max - FRAME_OVERHEAD));
    // All lanes share one chunk size; take the most conservative seen so far.
    this.chunkSize = this.lanes.reduce(
      (acc, l) => (l?.pc?.sctp?.maxMessageSize ? Math.min(acc, l.pc.sctp.maxMessageSize - FRAME_OVERHEAD) : acc),
      size,
    );
    this.chunkSize = Math.max(CHUNK_MIN, Math.min(CHUNK_MAX, this.chunkSize));
  }

  async _negotiate(idx) {
    const { pc } = this.lanes[idx];
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.session.send({ t: 'offer', gen: this.gen, lane: idx, sdp: pc.localDescription.sdp });
  }

  /**
   * Signalling from the peer.
   *
   * Sealed and, since key confirmation, provably from the device we agreed a key with. That
   * says it is not a stranger and nothing about whether it means well: in a room the code is
   * shared by everyone in it, so "the peer" can be any member.
   *
   * The lane number used to be taken as given and used directly as an array index. A lane
   * is a whole RTCPeerConnection, so a peer could ask for a few thousand of them; and
   * `lanes['__proto__'] = lane` does not add an element at all, it replaces the array's
   * prototype, after which every method on it is gone and the transport is finished. Both
   * are one short message from anybody sharing a room code.
   */
  async _onSignal(msg) {
    if (!msg || typeof msg !== 'object') return;
    // A message from an older connection generation describes a peer connection that no
    // longer exists; applying it makes ICE succeed against a dead endpoint and DTLS hang.
    if ((msg.gen ?? 0) !== this.gen) return;

    const idx = msg.lane ?? 0;
    // A lane index is a small whole number and an array position, in that order.
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_LANES) return;

    if (msg.t === 'offer') {
      if (typeof msg.sdp !== 'string' || msg.sdp.length > MAX_SDP) return;
      if (!this.lanes[idx]) await this._makeLane(idx, idx === 0);
      const { pc } = this.lanes[idx];
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await this._flushCandidates(idx);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.session.send({ t: 'answer', gen: this.gen, lane: idx, sdp: pc.localDescription.sdp });
      this._maybeSas(idx);
      return;
    }

    if (msg.t === 'answer') {
      if (typeof msg.sdp !== 'string' || msg.sdp.length > MAX_SDP) return;
      const lane = this.lanes[idx];
      if (!lane) return;
      await lane.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await this._flushCandidates(idx);
      this._maybeSas(idx);
      return;
    }

    if (msg.t === 'ice') {
      const lane = this.lanes[idx];
      if (!lane || !lane.pc.remoteDescription) {
        // Held until there is something to apply them to, but only so many. Candidates
        // arriving before a description are ordinary; an endless stream of them is a way to
        // grow our memory from the other side.
        if (!this._pending.has(idx)) this._pending.set(idx, []);
        const queue = this._pending.get(idx);
        if (queue.length < MAX_PENDING_ICE) queue.push(msg.cand);
        return;
      }
      try {
        await lane.pc.addIceCandidate(msg.cand);
      } catch {
        /* a candidate that no longer applies is not fatal */
      }
    }
  }

  async _flushCandidates(idx) {
    const queued = this._pending.get(idx);
    if (!queued) return;
    this._pending.delete(idx);
    for (const cand of queued) {
      try {
        await this.lanes[idx].pc.addIceCandidate(cand);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Compute the SAS from lane 0's real DTLS fingerprints, once both sides exist.
   *
   * Recomputed whenever those fingerprints change, rather than once and never again. A
   * peer may renegotiate at any point, including with a different certificate, and the
   * words are a statement about the certificates in use, so computing them once left the
   * words on screen describing a connection that no longer existed after a renegotiation.
   * Since a confirmation is recorded as the words it was given for, new words mean the check
   * has not been made yet.
   */
  async _maybeSas(idx) {
    if (idx !== 0) return;
    const pc = this.lanes[0]?.pc;
    if (!pc?.localDescription || !pc?.remoteDescription) return;
    const { fingerprintOf } = await import('./gdcrypto.js');
    const local = fingerprintOf(pc.localDescription.sdp);
    const remote = fingerprintOf(pc.remoteDescription.sdp);
    const stamp = `${local}|${remote}`;
    if (stamp === this._sasStamp) return;
    this._sasStamp = stamp;
    await this.session.computeSas(local, remote);
  }

  /* ------------------------------------------------------------------ io */

  /**
   * Whether a control frame handed over now would actually go.
   *
   * Asked *before* the frame is sealed, because sealing one costs a ratchet key: the chain
   * steps whether or not anything carries the result, so a frame minted for a dead channel
   * moves this side's chain and not the peer's.
   */
  canSendCtl() {
    return !!this.ctl && this.ctl.readyState === 'open';
  }

  sendCtl(bytes) {
    if (!this.canSendCtl()) return false;
    this.ctl.send(bytes);
    return true;
  }

  /** True when this lane can accept another chunk without growing an unbounded buffer. */
  canSend(idx = 0) {
    const lane = this.lanes[idx];
    return !!lane && lane.ready && lane.bulk.bufferedAmount < BUF_HIGH;
  }

  /** Resolves when the lane's send buffer has drained to the low-water mark. */
  drain(idx = 0) {
    const lane = this.lanes[idx];
    if (!lane || !lane.ready) return Promise.resolve();
    if (lane.bulk.bufferedAmount < BUF_LOW) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        lane.bulk.removeEventListener('bufferedamountlow', done);
        resolve();
      };
      lane.bulk.addEventListener('bufferedamountlow', done);
      // Safety net: some engines have historically missed the event under load.
      setTimeout(done, 1000);
    });
  }

  send(idx, bytes) {
    const lane = this.lanes[idx];
    if (!lane || !lane.ready) return false;
    lane.bulk.send(bytes);
    lane.sent += bytes.byteLength;
    return true;
  }

  /** Pick the least-loaded ready lane. */
  pickLane() {
    let best = -1;
    let bestBuf = Infinity;
    for (const lane of this.lanes) {
      if (!lane?.ready) continue;
      const b = lane.bulk.bufferedAmount;
      if (b < bestBuf) {
        bestBuf = b;
        best = lane.idx;
      }
    }
    return best;
  }

  get readyLanes() {
    return this.lanes.filter((l) => l?.ready).length;
  }

  /* --------------------------------------------------------------- stats */

  async _probePath(lane) {
    try {
      const stats = await lane.pc.getStats();
      let pair = null;
      const candidates = new Map();
      stats.forEach((r) => {
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') candidates.set(r.id, r);
        if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded')) pair = r;
      });
      if (!pair) return;
      this.rtt = (pair.currentRoundTripTime || 0) * 1000;
      const local = candidates.get(pair.localCandidateId);
      const remote = candidates.get(pair.remoteCandidateId);
      const t = [local?.candidateType, remote?.candidateType];
      this.pathType = t.includes('relay') ? 'relay' : t.includes('srflx') ? 'direct' : 'local';
      this.dispatchEvent(
        new CustomEvent('path', { detail: { pathType: this.pathType, rtt: this.rtt, lane: lane.idx } }),
      );
    } catch {
      /* stats are advisory */
    }
  }

  async sampleRtt() {
    const lane = this.lanes[0];
    if (!lane) return 0;
    await this._probePath(lane);
    return this.rtt;
  }
}

export const LIMITS = { BUF_HIGH, BUF_LOW, CHUNK_MIN, CHUNK_MAX };
