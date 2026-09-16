/**
 * Rendezvous client: a thin, binary WebSocket transport to the relay.
 *
 * It knows nothing about crypto, peers, or transfers. It moves opaque frames and
 * tells you when a counterpart appears or vanishes. Everything above it is sealed.
 */
import { concat, toHex } from './bytes.js';
import { sanitizeIceConfig } from './ice.js';

export const FRAME = {
  SUBSCRIBE: 0x01,
  FORWARD: 0x02,
  PEER_UP: 0x03,
  PEER_GONE: 0x04,
  ICE_CREDS: 0x05,
  SUBSCRIBE_ROOM: 0x06,
};
export const GONE = { 1: 'left', 2: 'expired', 3: 'full', 4: 'replaced', 5: 'mode' };

const TAG_LEN = 16;

/** The two readyState values this class cares about, by their fixed numeric values. */
const SOCKET = { CONNECTING: 0, OPEN: 1 };

export class SignalClient extends EventTarget {
  /**
   * @param {string} url
   * @param {object} [opts]
   * @param {(url: string) => WebSocket} [opts.socket]  how to open one; injectable so the
   *   transport can be exercised without a network stack, and so a future path (WebTransport)
   *   can be swapped in without touching anything above this class.
   */
  constructor(url = defaultUrl(), { socket = (u) => new WebSocket(u) } = {}) {
    super();
    this.url = url;
    this._socket = socket;
    this._ws = null;
    this._backoff = 500;
    this._subs = new Map(); // hex(tag) -> { tag, room }
    this._queue = [];
    this.iceConfig = null;
    /**
     * An opaque label the relay derives from the address this socket arrived on, rotated
     * by the server. It is the only thing that makes "devices on this network" possible;
     * nothing is done with it unless the user turns that on.
     */
    this.networkLabel = null;
    this.state = 'idle';
    this._shouldRun = false;
  }

  connect() {
    this._shouldRun = true;
    this._open();
  }

  close() {
    this._shouldRun = false;
    this._subs.clear();
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
      this._ws = null;
    }
    this._setState('idle');
  }

  get connected() {
    return !!this._ws && this._ws.readyState === SOCKET.OPEN;
  }

  /** Bytes queued in the socket; the relay path uses this for flow control. */
  get bufferedAmount() {
    return this._ws ? this._ws.bufferedAmount : Infinity;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.dispatchEvent(new CustomEvent('state', { detail: s }));
  }

  _open() {
    if (!this._shouldRun || this.connected || this._ws?.readyState === SOCKET.CONNECTING) return;
    this._setState('connecting');

    const ws = this._socket(this.url);
    ws.binaryType = 'arraybuffer';
    this._ws = ws;

    ws.onopen = () => {
      this._backoff = 500;
      this._setState('online');
      // Re-subscribe everything; the server keeps nothing across a reconnect.
      for (const s of this._subs.values()) {
        this._send(s.room ? FRAME.SUBSCRIBE_ROOM : FRAME.SUBSCRIBE, s.tag);
      }
      for (const [tag, payload] of this._queue.splice(0)) this._send(FRAME.FORWARD, tag, payload);
    };

    ws.onmessage = (e) => this._onFrame(new Uint8Array(e.data));

    ws.onclose = () => {
      this._ws = null;
      this._setState('offline');
      if (!this._shouldRun) return;
      const wait = Math.min(this._backoff, 15000) * (0.7 + Math.random() * 0.6);
      this._backoff = Math.min(this._backoff * 2, 15000);
      setTimeout(() => this._open(), wait);
    };

    ws.onerror = () => {
      /* onclose will follow */
    };
  }

  _onFrame(buf) {
    if (buf.length < 1 + TAG_LEN) return;
    const type = buf[0];
    const tag = buf.subarray(1, 1 + TAG_LEN);
    const payload = buf.subarray(1 + TAG_LEN);
    const key = toHex(tag);

    switch (type) {
      case FRAME.PEER_UP:
        this.dispatchEvent(new CustomEvent('peer-up', { detail: { tag, key } }));
        break;
      case FRAME.PEER_GONE: {
        const reason = GONE[payload[0]] || 'unknown';
        // An expired tag was garbage-collected by the relay, not abandoned by us. Anything
        // we forward to it afterwards arrives from a non-subscriber and is counted as a
        // protocol violation, so re-create it before the layers above try again. "Full"
        // and "mode" are refusals rather than expiries and must not be retried.
        if (reason === 'expired' && this._subs.has(key) && this.connected) {
          const sub = this._subs.get(key);
          this._send(sub.room ? FRAME.SUBSCRIBE_ROOM : FRAME.SUBSCRIBE, sub.tag);
        }
        this.dispatchEvent(new CustomEvent('peer-gone', { detail: { tag, key, reason } }));
        break;
      }
      case FRAME.FORWARD:
        this.dispatchEvent(new CustomEvent('frame', { detail: { tag, key, payload } }));
        break;
      case FRAME.ICE_CREDS:
        try {
          // The network label rides along with the ICE credentials but is not part of
          // them: keep it out of the object handed to RTCPeerConnection.
          const { net, ...ice } = JSON.parse(new TextDecoder().decode(payload));
          // Reduced to the two fields we act on, with every address checked. An ICE server
          // is an instruction to send packets somewhere, and this list arrives from the
          // relay, and passing it through untouched let it aim the browser at whatever it
          // liked, including addresses only reachable from inside the user's network.
          this.iceConfig = sanitizeIceConfig(ice);
          this.networkLabel = typeof net === 'string' ? net : null;
          this.dispatchEvent(new CustomEvent('ice', { detail: this.iceConfig }));
          this.dispatchEvent(new CustomEvent('network', { detail: this.networkLabel }));
        } catch {
          /* ignore malformed */
        }
        break;
    }
  }

  subscribe(tag) {
    const key = toHex(tag);
    if (!this._subs.has(key)) this._subs.set(key, { tag, room: false });
    if (this.connected) this._send(FRAME.SUBSCRIBE, tag);
  }

  /**
   * Join a tag as a many-member presence directory rather than a two-party rendezvous.
   * The relay fixes a tag's mode when it is created, so the two cannot be confused.
   */
  subscribeRoom(tag) {
    const key = toHex(tag);
    if (!this._subs.has(key)) this._subs.set(key, { tag, room: true });
    if (this.connected) this._send(FRAME.SUBSCRIBE_ROOM, tag);
  }

  unsubscribe(tag) {
    this._subs.delete(toHex(tag));
  }

  /** Forward opaque bytes to whoever else holds this tag. Queued while offline. */
  forward(tag, payload) {
    if (!this.connected) {
      this._queue.push([tag, payload]);
      if (this._queue.length > 64) this._queue.shift();
      return;
    }
    this._send(FRAME.FORWARD, tag, payload);
  }

  _send(type, tag, payload) {
    const head = new Uint8Array(1 + TAG_LEN);
    head[0] = type;
    head.set(tag, 1);
    this._ws.send(payload ? concat(head, payload) : head);
  }
}

/**
 * Where the relay lives. The app and the relay need not be the same deployment: a CDN can
 * serve the files while the relay runs somewhere that can hold a socket open. Resolved at
 * runtime, in order:
 *
 *   1. the value remembered from a previous visit, once the user agreed to it
 *   2. <meta name="gd-relay" content="wss://…"> baked in at deploy time
 *   3. this origin
 *
 * `?relay=` is deliberately not in that list. A link cannot silently route a browser through
 * a server of the sender's choosing: it only *proposes* one, and the app asks. See
 * `proposedRelay()`. Only ws:/wss: are accepted, and an https page will not be talked out
 * of wss.
 */
export function defaultUrl() {
  let stored = null;
  try {
    stored = localStorage.getItem('gd.relay');
  } catch {
    /* private mode */
  }
  const fromMeta = document.querySelector('meta[name="gd-relay"]')?.content;

  return sanitizeRelay(stored) || sanitizeRelay(fromMeta) || originRelay();
}

export function originRelay() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rv`;
}

/**
 * A relay a link is asking us to use, if it differs from the one already in force.
 * Returns null when there is nothing to ask about.
 */
export function proposedRelay(current = defaultUrl()) {
  const raw = new URLSearchParams(location.search).get('relay');
  if (raw === null) return null;
  const clean = sanitizeRelay(raw);
  if (!clean || clean === current) return null;
  return clean;
}

/** Remember a relay the user agreed to, or clear it back to the built-in default. */
export function rememberRelay(url) {
  try {
    if (url) localStorage.setItem('gd.relay', url);
    else localStorage.removeItem('gd.relay');
  } catch {
    /* private mode: the choice lasts for this tab only */
  }
}

function sanitizeRelay(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;
  // Never downgrade: a secure page talking to a plaintext relay would be a silent
  // security hole, and the browser would block it anyway.
  if (location.protocol === 'https:' && url.protocol !== 'wss:') return null;
  if (url.pathname === '/') url.pathname = '/rv';
  return url.toString();
}
