/**
 * RelayTransport: the fallback path, for networks where WebRTC does not work.
 * corporate proxies, some VPNs, browsers with WebRTC disabled for fingerprinting reasons.
 *
 * It presents exactly the same surface as the WebRTC Transport, so the transfer engine
 * cannot tell the difference and can be moved between them mid-transfer.
 *
 * The privacy point: this carries the *same sealed frames* the data channel would have
 * carried. The relay sees AEAD ciphertext and nothing else: no file names, no sizes
 * beyond a padded length, no plaintext. A fallback that hands the server readable bytes has
 * to be off by default and asked for each time; this one does not, because there is nothing
 * in it to read.
 */
import { concat } from './bytes.js';
import { aeadKey, hkdf, seal, open } from './gdcrypto.js';

const F_CTL = 0x12;
const F_BULK = 0x13;
/**
 * Padding. Sealed and sized exactly like a data frame, so nothing outside can tell the two
 * apart - which is the entire requirement, and is unachievable while any part of a frame is
 * legible from outside.
 */
const F_PAD = 0x14;
/**
 * What actually goes on the wire once there is an outer seal: a type byte the relay cannot act
 * on, a counter, and bytes. The old types live on inside the seal, where they belong.
 */
const F_SEALED = 0x15;

// A relayed byte costs the operator money and the peer latency, so the window is smaller
// than the data channel's and the frame is capped to what the relay accepts.
const BUF_HIGH = 2 * 1024 * 1024;
const BUF_LOW = 256 * 1024;
const CHUNK = 64 * 1024;
// Mirrors the relay's own budget with headroom, so a well-behaved client never trips it.
/** Bound to every outer frame, so one cannot be replayed into another context. */
const OUTER_AAD = new TextEncoder().encode('gd/relay-outer/v1');
/** Quiet for this long and the connection tops itself up to the next bucket. */
const PAD_IDLE_MS = 400;
/** Below this there is nothing to hide that a bucket would hide. */
const PAD_MIN_GRAIN = 256 * 1024;

const RATE_BYTES = 10 * 1024 * 1024;
const BURST_BYTES = 4 * 1024 * 1024;

export class RelayTransport extends EventTarget {
  /**
   * @param {SecureSession} session  supplies the rendezvous tag and the signal client
   */
  constructor(session) {
    super();
    this.session = session;
    this.signal = session.signal;
    this.tag = session.tag;
    this.tagKey = session.tagKey;

    /*
     * The outer key, for this path only.
     *
     * Its own label, so it is not the signalling key and not a transfer key: a compromise of one
     * reveals nothing about the others, which is the same rule the rest of the app follows.
     * Derived lazily because the constructor cannot await, and awaited once by everything that
     * needs it.
     */
    this._outerKey = hkdf(session.K, 'gd/relay-outer/v1', 32).then(aeadKey);
    this._outCounter = 0;

    this.kind = 'relay';
    this.chunkSize = CHUNK;
    this.closed = false;
    this.pathType = 'relay';
    this.rtt = 0;
    this.ctl = { readyState: 'open' }; // the engine only ever checks this
    this.lanes = [{ idx: 0, ready: true, bulk: null, sent: 0 }];

    this._onFrame = (e) => {
      if (e.detail.key !== this.tagKey || this.closed) return;
      const buf = e.detail.payload;
      if (!buf?.length || buf[0] !== F_SEALED || buf.length < 5) return;
      this._unwrap(buf).catch(() => {});
    };
    this.signal.addEventListener('frame', this._onFrame);
  }

  async start() {
    /*
     * Safety words before the connection is announced. There is no DTLS here to bind to, so
     * they come from the session key alone, which still answers what the words are for, and
     * the empty binding means a relayed path never produces the same words as a direct one
     * under the same key.
     *
     * Skipping them here would drop the check on the one path where every byte crosses the
     * relay.
     */
    await this.session.computeSas('', '');
    this.session.transportLive = true;

    // Nothing to negotiate: the rendezvous is already open, which is the entire appeal
    // of this path when ICE cannot get through.
    queueMicrotask(() => {
      if (this.closed) return;
      this.dispatchEvent(new CustomEvent('open'));
      this.dispatchEvent(new CustomEvent('lane-open', { detail: 0 }));
      this.dispatchEvent(
        new CustomEvent('path', { detail: { pathType: 'relay', rtt: this.rtt, lane: 0 } }),
      );
    });
    return this;
  }

  async addLane() {
    return null; // one socket, one lane
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.session.transportLive = false;
    // The top-up is scheduled on a timer, so a connection that closes first must not wake up
    // afterwards and start writing to a tag it has left.
    clearTimeout(this._padTimer);
    this.signal.removeEventListener('frame', this._onFrame);
    this.ctl = null;
    this.dispatchEvent(new CustomEvent('closed'));
  }

  /* -------------------------------------------------------------------- io */

  /** Whether a control frame handed over now would actually go. See Transport.canSendCtl. */
  canSendCtl() {
    return !this.closed && !!this.signal.connected;
  }

  sendCtl(bytes) {
    if (!this.canSendCtl()) return false;
    this._wrap(F_CTL, asBytes(bytes));
    return true;
  }

  send(_lane, bytes) {
    if (this.closed || !this.signal.connected) return false;
    const payload = asBytes(bytes);
    this._budget(payload.length + 1);
    this._wrap(F_BULK, payload);
    this.lanes[0].sent += payload.length;
    this._relayed = (this._relayed || 0) + payload.length;
    this._schedulePadding(payload.length);
    return true;
  }

  /**
   * Seal a frame so the relay sees a type byte, a counter and bytes.
   *
   * Everything that used to be legible goes inside: the inner type, and for a bulk frame the
   * header the transfer engine needs in the clear at the far end - version, lane, file id,
   * offset, chunk index. That header cannot be inside the *transfer* encryption, because the
   * nonce and AAD are derived from it, so it has to be readable before the chunk can be opened.
   * Readable by the peer, though, not by the relay. This is the layer that makes the difference.
   *
   * It is what the relay was reading: how many files a transfer held, and from the last offset
   * forwarded, the exact size of each.
   *
   * The counter is prefixed rather than sealed because the far end needs it to build the nonce,
   * and it reveals only how many frames have gone - which the relay can count anyway.
   */
  async _wrap(innerType, bytes) {
    try {
      const key = await this._outerKey;
      if (this.closed || !this.signal.connected) return;
      const counter = this._outCounter++;
      const nonce = new Uint8Array(12);
      // Split by direction, exactly as the signalling nonces are: one key, two senders, and a
      // repeated nonce under AES-GCM is not a weakness, it is the plaintext.
      nonce[0] = this.session.lane & 1;
      new DataView(nonce.buffer).setUint32(8, counter, true);
      const ct = await seal(key, nonce, concat(new Uint8Array([innerType]), bytes), OUTER_AAD);
      const head = new Uint8Array(5);
      head[0] = F_SEALED;
      new DataView(head.buffer).setUint32(1, counter, true);
      this.signal.forward(this.tag, concat(head, ct));
    } catch {
      /* the session went away mid-flight; the transfer's own recovery handles it */
    }
  }

  /** The inverse. A frame that does not open is somebody else's, not a broken one of ours. */
  async _unwrap(buf) {
    const key = await this._outerKey;
    if (this.closed) return;
    const counter = new DataView(buf.buffer, buf.byteOffset).getUint32(1, true);
    const nonce = new Uint8Array(12);
    nonce[0] = (this.session.lane & 1) ^ 1;
    new DataView(nonce.buffer).setUint32(8, counter, true);
    const plain = await open(key, nonce, buf.subarray(5), OUTER_AAD).catch(() => null);
    if (!plain?.length) return;

    if (plain[0] === F_CTL) {
      this.dispatchEvent(new CustomEvent('ctl', { detail: plain.subarray(1) }));
    } else if (plain[0] === F_BULK) {
      this.dispatchEvent(new CustomEvent('chunk', { detail: { lane: 0, data: plain.subarray(1) } }));
    }
    // F_PAD is the third case, and there is deliberately nothing to do with it.
  }

  /**
   * Round what this connection has relayed up to a bucket, once it goes quiet.
   *
   * Only worth anything because of the seal above. While the offsets were legible the relay read
   * the real size off the last frame and no amount of padding changed that answer.
   *
   * Bounded overhead rather than a round number: the next power of two costs up to double, and
   * this is already the slow path. An eighth blurs the exact figure - which is the identifying
   * part - for a cost the fallback can carry.
   */
  _schedulePadding(lastLen) {
    this._padLen = lastLen;
    clearTimeout(this._padTimer);
    this._padTimer = setTimeout(() => this._padToBucket(), PAD_IDLE_MS);
  }

  async _padToBucket() {
    if (this.closed || !this.signal.connected) return;
    const sent = this._relayed || 0;
    const grain = Math.max(PAD_MIN_GRAIN, 2 ** Math.floor(Math.log2(Math.max(sent, 1))) / 8);
    const target = Math.ceil(sent / grain) * grain;
    const frame = this._padLen || CHUNK;
    let remaining = target - sent;
    while (remaining > 0 && !this.closed && this.signal.connected) {
      await this._wrap(F_PAD, new Uint8Array(Math.min(frame, remaining)));
      remaining -= frame;
    }
    // Counted, so a later burst rounds up from where this left off rather than repeating it.
    this._relayed = target;
  }

  /**
   * Two limits apply here, not one.
   *
   * The socket buffer is the usual backpressure signal, but on a loopback or a fast link
   * it drains instantly and the sender would push thousands of frames a second straight
   * into the relay's rate limiter. So the client mirrors the server's budget and paces
   * itself: the relay is a shared resource, and a client that floods it is the client's
   * bug, not the relay's.
   */
  canSend() {
    return (
      !this.closed &&
      this.signal.connected &&
      this.bufferedAmount < BUF_HIGH &&
      this._budget(0) >= 0
    );
  }

  get bufferedAmount() {
    return this.signal.bufferedAmount;
  }

  /** Token bucket in bytes/second, refilled continuously. */
  _budget(spend) {
    const now = performance.now();
    const elapsed = (now - (this._lastRefill ?? now)) / 1000;
    this._lastRefill = now;
    this._tokens = Math.min(BURST_BYTES, (this._tokens ?? BURST_BYTES) + elapsed * RATE_BYTES);
    if (spend > 0) this._tokens -= spend;
    return this._tokens;
  }

  drain() {
    if (this.closed) return Promise.resolve();
    // Always yield at least a macrotask: returning an already-resolved promise here lets
    // a caller that is blocked for some other reason spin the event loop flat.
    return new Promise((resolve) => {
      const tick = () => {
        if (this.closed) return resolve();
        if (this.bufferedAmount < BUF_LOW && this._budget(0) >= 0) return resolve();
        setTimeout(tick, 20);
      };
      setTimeout(tick, 20);
    });
  }

  pickLane() {
    return this.canSend() ? 0 : -1;
  }

  get readyLanes() {
    return this.closed ? 0 : 1;
  }

  async sampleRtt() {
    return this.rtt;
  }
}

/** Never drop a subarray's byte offset: that silently sends the wrong bytes. */
function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
