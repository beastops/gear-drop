/**
 * RelayTransport: the fallback path, for networks where WebRTC does not work.
 * corporate proxies, some VPNs, browsers with WebRTC disabled for fingerprinting reasons.
 *
 * It presents exactly the same surface as the WebRTC Transport, so the transfer engine
 * cannot tell the difference and can be moved between them mid-transfer.
 *
 * The privacy point: this carries the *same sealed frames* the data channel would have
 * carried. The relay sees AEAD ciphertext and nothing else: no file names, no sizes
 * beyond a padded length, no plaintext. PairDrop's equivalent fallback base64-encodes the
 * file and hands it to the server in the clear, which is why theirs is off by default and
 * ours does not need to be.
 */
import { concat } from './bytes.js';

const F_CTL = 0x12;
const F_BULK = 0x13;

// A relayed byte costs the operator money and the peer latency, so the window is smaller
// than the data channel's and the frame is capped to what the relay accepts.
const BUF_HIGH = 2 * 1024 * 1024;
const BUF_LOW = 256 * 1024;
const CHUNK = 64 * 1024;
// Mirrors the relay's own budget with headroom, so a well-behaved client never trips it.
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
      if (!buf?.length) return;
      if (buf[0] === F_CTL) {
        this.dispatchEvent(new CustomEvent('ctl', { detail: buf.subarray(1) }));
      } else if (buf[0] === F_BULK) {
        this.dispatchEvent(new CustomEvent('chunk', { detail: { lane: 0, data: buf.subarray(1) } }));
      }
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
    this.signal.forward(this.tag, concat(new Uint8Array([F_CTL]), asBytes(bytes)));
    return true;
  }

  send(_lane, bytes) {
    if (this.closed || !this.signal.connected) return false;
    const payload = asBytes(bytes);
    this._budget(payload.length + 1);
    this.signal.forward(this.tag, concat(new Uint8Array([F_BULK]), payload));
    this.lanes[0].sent += payload.length;
    return true;
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
