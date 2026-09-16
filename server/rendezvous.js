/**
 * Gear Drop: rendezvous relay.
 *
 * The server's entire job: let sockets that present the same opaque 16-byte tag exchange
 * opaque bytes. It never parses a payload, never stores one, never logs a tag or an IP,
 * and holds no state that survives the process.
 *
 * A tag has a mode, fixed by whoever creates it:
 *
 *   pair (SUBSCRIBE)        at most 2 sockets: a private, end-to-end keyed conversation
 *   room (SUBSCRIBE_ROOM)   up to ROOM_CAP sockets: a presence directory, nothing more
 *
 * Rooms exist because discovery among several devices needs a meeting point, but the
 * conversations themselves never happen there: members learn each other's ephemeral ids on
 * the room tag and then pair off onto ordinary two-socket tags. So the relay still only
 * ever carries two-party sealed channels, and a room is a directory, not a channel.
 *
 * Frame format (binary WebSocket messages only):
 *   [0]      type
 *   [1..16]  tag
 *   [17..]   payload (opaque)
 *
 * Deliberately free of any runtime API beyond Uint8Array, Map and setInterval, so this one
 * implementation runs unchanged on Node, Deno, Bun and Cloudflare Workers. Every free
 * hosting tier that can hold a WebSocket open can host this exact file, and the protocol
 * cannot drift between them.
 */

export const FRAME = {
  SUBSCRIBE: 0x01,
  FORWARD: 0x02,
  PEER_UP: 0x03,
  PEER_GONE: 0x04,
  ICE_CREDS: 0x05,
  SUBSCRIBE_ROOM: 0x06,
};

export const GONE = {
  LEFT: 0x01,
  EXPIRED: 0x02,
  FULL: 0x03,
  REPLACED: 0x04,
  MODE: 0x05,
};

export const TAG_LEN = 16;
const HEADER_LEN = 1 + TAG_LEN;

/** Max lifetime of a rendezvous with only one participant (ms). */
const LONE_TTL_MS = 120_000;
/** Max lifetime of a joined rendezvous with no traffic (ms). */
const IDLE_TTL_MS = 30 * 60_000;
/** Hard ceiling on concurrent rendezvous slots, to bound memory. */
const MAX_TAGS = 50_000;
/** Per-socket limits. */
const MAX_TAGS_PER_SOCKET = 64;
const MAX_PAYLOAD = 256 * 1024;
/** A room is a presence directory; this is well past any real room and bounds the fan-out. */
export const ROOM_CAP = 24;
/**
 * Presence frames are small by construction. Capping them on a room tag stops anyone from
 * using a many-member tag as a broadcast amplifier for bulk data.
 */
const ROOM_MAX_PAYLOAD = 2 * 1024;

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function hex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]];
  return out;
}

function unhex(str) {
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
  return out;
}

export class Rendezvous {
  constructor({ now = () => Date.now() } = {}) {
    this._tags = new Map(); // hex(tag) -> { peers: Set<conn>, cap, createdAt, touchedAt }
    this._now = now;
    this._sweeper = setInterval(() => this.sweep(), 10_000);
    this._sweeper.unref?.();
    this.stats = { tagsCreated: 0, framesForwarded: 0, bytesForwarded: 0, rejected: 0, throttled: 0 };
  }

  close() {
    clearInterval(this._sweeper);
    this._tags.clear();
  }

  get size() {
    return this._tags.size;
  }

  /**
   * Handle one inbound binary frame from `conn`.
   * `conn` must expose: send(Uint8Array), tags:Set<string>, bucket (token bucket).
   */
  onFrame(conn, data) {
    if (!(data instanceof Uint8Array) || data.length < HEADER_LEN) return this._reject(conn);
    const type = data[0];
    const tag = data.subarray(1, HEADER_LEN);
    const payload = data.subarray(HEADER_LEN);

    if (payload.length > MAX_PAYLOAD) return this._reject(conn);
    // Exceeding the budget is a pacing problem, not a protocol violation: drop the frame
    // and let the transfer's own resume logic recover, but do not close the socket over it.
    if (!conn.bucket.take(1 + Math.ceil(payload.length / 16384))) {
      this.stats.throttled++;
      return;
    }

    switch (type) {
      case FRAME.SUBSCRIBE:
        return this._subscribe(conn, tag, 2);
      case FRAME.SUBSCRIBE_ROOM:
        return this._subscribe(conn, tag, ROOM_CAP);
      case FRAME.FORWARD:
        return this._forward(conn, tag, payload);
      default:
        return this._reject(conn);
    }
  }

  _reject(conn) {
    this.stats.rejected++;
    conn.strikes = (conn.strikes || 0) + 1;
    if (conn.strikes > 8) conn.close(1008, 'protocol');
  }

  _subscribe(conn, tag, cap) {
    const key = hex(tag);

    if (conn.tags.has(key)) return; // idempotent
    if (conn.tags.size >= MAX_TAGS_PER_SOCKET) return this._reject(conn);

    let slot = this._tags.get(key);
    if (!slot) {
      if (this._tags.size >= MAX_TAGS) return this._reject(conn);
      slot = { peers: new Set(), cap, createdAt: this._now(), touchedAt: this._now() };
      this._tags.set(key, slot);
      this.stats.tagsCreated++;
    }

    // The first subscriber fixes the mode. Joining an existing tag under the other mode is
    // refused rather than silently widened. Otherwise anyone could turn a two-party
    // rendezvous into a room and sit inside it.
    if (slot.cap !== cap) {
      conn.send(frame(FRAME.PEER_GONE, tag, Uint8Array.of(GONE.MODE)));
      if (slot.peers.size === 0) this._tags.delete(key);
      return;
    }

    if (slot.peers.size >= slot.cap) {
      conn.send(frame(FRAME.PEER_GONE, tag, Uint8Array.of(GONE.FULL)));
      return;
    }

    slot.peers.add(conn);
    conn.tags.add(key);
    slot.touchedAt = this._now();

    // Everyone present is told the membership changed. On a pair tag that happens exactly
    // once, when the second socket arrives; in a room it happens on every join, which is
    // what prompts the existing members to re-announce themselves to the newcomer.
    if (slot.peers.size >= 2) {
      for (const peer of slot.peers) peer.send(frame(FRAME.PEER_UP, tag));
    }
  }

  _forward(conn, tag, payload) {
    const key = hex(tag);
    const slot = this._tags.get(key);
    // Only a subscriber of this tag may forward on it. This is the check PairDrop omits.
    if (!slot || !slot.peers.has(conn)) return this._reject(conn);
    if (slot.cap > 2 && payload.length > ROOM_MAX_PAYLOAD) return this._reject(conn);

    slot.touchedAt = this._now();
    const out = frame(FRAME.FORWARD, tag, payload);
    for (const peer of slot.peers) {
      if (peer === conn) continue;
      peer.send(out);
      this.stats.framesForwarded++;
      this.stats.bytesForwarded += payload.length;
    }
  }

  /** Remove a socket from every tag it holds and notify counterparts. */
  drop(conn) {
    for (const key of conn.tags) {
      const slot = this._tags.get(key);
      if (!slot) continue;
      slot.peers.delete(conn);
      const tag = unhex(key);
      for (const peer of slot.peers) peer.send(frame(FRAME.PEER_GONE, tag, Uint8Array.of(GONE.LEFT)));
      if (slot.peers.size === 0) this._tags.delete(key);
    }
    conn.tags.clear();
  }

  sweep() {
    const now = this._now();
    for (const [key, slot] of this._tags) {
      const ttl = slot.peers.size >= 2 ? IDLE_TTL_MS : LONE_TTL_MS;
      if (now - slot.touchedAt < ttl) continue;
      const tag = unhex(key);
      for (const peer of slot.peers) {
        peer.tags.delete(key);
        peer.send(frame(FRAME.PEER_GONE, tag, Uint8Array.of(GONE.EXPIRED)));
      }
      this._tags.delete(key);
    }
  }
}

export function frame(type, tag, payload) {
  const out = new Uint8Array(HEADER_LEN + (payload ? payload.length : 0));
  out[0] = type;
  const t = tag instanceof Uint8Array ? tag : new Uint8Array(tag);
  out.set(t.subarray(0, TAG_LEN), 1);
  if (payload) out.set(payload instanceof Uint8Array ? payload : new Uint8Array(payload), HEADER_LEN);
  return out;
}

/**
 * Simple token bucket: `rate` tokens/sec, `burst` capacity.
 *
 * Sized for the relayed data path, not just for signalling: a frame costs one token per
 * 16 KB, so the defaults allow roughly 15 MB/s per socket. Generous enough to be a usable
 * fallback when WebRTC is blocked, bounded enough that one client cannot take the relay
 * down. Operators who pay for the bandwidth will want to lower it.
 */
export class Bucket {
  constructor(rate = 1200, burst = 2400, now = () => Date.now()) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = now();
    this._now = now;
  }
  take(n = 1) {
    const now = this._now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
