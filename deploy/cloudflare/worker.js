/**
 * Gear Drop relay on Cloudflare Workers + Durable Objects.
 *
 * This is the deployment worth reaching for first, because it is the one that is free and
 * stays free: Workers hold WebSockets open, and a Durable Object gives the rendezvous a
 * single place to live with no database behind it.
 *
 * The shape is different from the Node server, but the protocol is not: this file contains
 * routing and socket plumbing only. Every decision about the protocol — modes, caps, TTLs,
 * who may forward to whom — comes from the same `server/rendezvous.js` the Node server
 * uses, so the two cannot drift apart.
 *
 *   wrangler deploy        from this directory
 *   the relay URL is then  wss://<worker>.<subdomain>.workers.dev/rv
 */
import { Rendezvous, Bucket, frame, FRAME, TAG_LEN } from '../../server/rendezvous.js';
import { networkOf, abuseKeyOf } from '../../server/network.js';

/**
 * All sockets land in one Durable Object.
 *
 * That is a deliberate choice, not an oversight. A client holds a single socket and
 * subscribes to many tags on it, so tags and sockets cannot be sharded independently —
 * whoever holds a tag must also hold every socket subscribed to it. One object keeps the
 * protocol identical to the Node server. It is also the honest limit of this deployment:
 * a single Durable Object is a single thread, which is ample for a personal or small-team
 * relay and is not a design for a million users.
 */
const ROOM = 'relay';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/healthz') return new Response('ok');

    if (url.pathname === '/ice') {
      return json(iceServers(env), { 'Cache-Control': 'no-store' });
    }

    if (url.pathname !== '/rv') return new Response('not found', { status: 404 });
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    // WebSockets ignore the same-origin policy, so without this any page on the internet
    // could hold sockets here. A request with no Origin is not a browser and is left alone.
    if (!originAllowed(request, env)) return new Response('forbidden', { status: 403 });

    const id = env.RENDEZVOUS.idFromName(ROOM);
    return env.RENDEZVOUS.get(id).fetch(request);
  },
};

/**
 * The rendezvous itself. Created on first use and evicted when it goes idle, which is
 * exactly the lifetime the protocol wants: there is nothing to persist and nothing to
 * restore, here or anywhere else in this system.
 */
/** As large a frame as the protocol ever needs. The Node relay refuses the same size. */
const MAX_FRAME = 512 * 1024;

/** Sockets one network may hold at once. A NAT shares one, so it is generous. */
const MAX_PER_NETWORK = 32;

/** And a ceiling for the object as a whole, so one busy network cannot fill it. */
const MAX_SOCKETS = 20_000;

export class RendezvousRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rv = new Rendezvous();
    this.conns = new Map(); // WebSocket -> conn shim
    this.perNetwork = new Map(); // network key -> sockets held
  }

  async fetch(request) {
    /*
     * Counted per network, the way the Node relay counts per address.
     *
     * The key is derived and held as a counter for the life of the socket and never stored,
     * sent or logged - the same thing `networkLabel` does with the same input, one line
     * further down.
     */
    /*
     * Counted against the party, not the subnet.
     *
     * `networkOf` groups by /64, which is a household - and a household is handed a /48, so
     * 65 536 of them. Keyed that way this limit was 32 sockets per /64 and two million per
     * customer, which the relay's own ceiling beats to the punch. `abuseKeyOf` is /48: one
     * subscriber, one budget, however many subnets they were given.
     */
    const netKey = abuseKeyOf(request.headers.get('CF-Connecting-IP') || '') || 'unknown';
    if (this.conns.size >= MAX_SOCKETS) {
      return new Response('busy', { status: 503 });
    }
    if ((this.perNetwork.get(netKey) || 0) >= MAX_PER_NETWORK) {
      return new Response('too many', { status: 429 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.perNetwork.set(netKey, (this.perNetwork.get(netKey) || 0) + 1);

    const conn = {
      tags: new Set(),
      bucket: new Bucket(),
      send: (bytes) => {
        try {
          server.send(bytes);
        } catch {
          /* the socket is going away; drop() will follow */
        }
      },
      close: (code, reason) => {
        try {
          server.close(code, reason);
        } catch {
          /* already closed */
        }
      },
    };
    this.conns.set(server, conn);

    server.addEventListener('message', (e) => {
      // Text frames are not part of the protocol.
      if (typeof e.data === 'string') return;
      // Nor is anything this large. The Node relay refuses it at the socket; there is no
      // equivalent knob here, so it is refused on arrival.
      if (e.data.byteLength > MAX_FRAME) return conn.close(1009, 'too large');
      /*
       * One bad frame closes one socket, not the relay.
       *
       * Every socket on this deployment lives in this one object, so letting `onFrame` throw
       * would take the object down and drop every rendezvous anybody had open with it. The
       * Node relay has always caught this; here it is the difference between one client
       * being disconnected and all of them.
       */
      try {
        this.rv.onFrame(conn, new Uint8Array(e.data));
      } catch {
        conn.close(1011, 'error');
      }
    });

    const gone = () => {
      this.rv.drop(conn);
      this.conns.delete(server);
      const held = (this.perNetwork.get(netKey) || 1) - 1;
      if (held > 0) this.perNetwork.set(netKey, held);
      else this.perNetwork.delete(netKey);
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);

    conn.send(
      frame(
        FRAME.ICE_CREDS,
        new Uint8Array(TAG_LEN),
        new TextEncoder().encode(
          JSON.stringify({ ...iceServers(this.env), net: networkLabel(request, this.env) }),
        ),
      ),
    );

    return new Response(null, { status: 101, webSocket: client });
  }
}

/* ------------------------------------------------------------------ config */

/**
 * ALLOWED_ORIGINS is a comma-separated list. Unset means same-origin only, which is right
 * when the app and the relay share a host; a split deployment has to name the app's origin.
 */
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function iceServers(env) {
  // No default, and deliberately not somebody else's: an operator who wants cross-network
  // direct connections names their own. Unset, that path falls back to this relay, which
  // carries the same sealed frames and keeps no record of them.
  const stun = (env.STUN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
  const servers = stun.map((urls) => ({ urls }));
  const turn = (env.TURN_URLS || '').split(',').filter(Boolean);

  if (turn.length && env.TURN_SECRET) {
    // Short-lived coturn REST credentials. A static username and password shipped to every
    // client is a standing invitation to relay theft.
    const username = String(Math.floor(Date.now() / 1000) + 600);
    servers.push({ urls: turn, username, credential: hmacSha1(env.TURN_SECRET, username) });
  }
  return { iceServers: servers, ttl: 600 };
}

/**
 * The opaque "same network" label. Cloudflare hands us the client address in a header; it
 * is hashed with a secret and a six-hour window and never stored. Without NET_SECRET set
 * the feature is simply unavailable, which is the right default for an operator who has
 * not thought about it.
 */
function networkLabel(request, env) {
  if (!env.NET_SECRET) return null;
  const addr = request.headers.get('CF-Connecting-IP') || '';
  if (!addr) return null;
  /*
   * Grouped by network, not by address, and by the same rule the Node relay uses.
   *
   * This hashed the raw address, which is right for IPv4 behind a NAT and wrong for
   * everything else: on IPv6 every device in a home has its own global address, so each one
   * became its own network and local discovery found nobody. `networkOf` is the one place
   * that decides what a network is, and both relays now ask it rather than each having an
   * opinion. The address is used and discarded in this expression either way.
   */
  const window = Math.floor(Date.now() / (6 * 3600_000));
  return hmacSha1(env.NET_SECRET, `${window}:${networkOf(addr)}`)
    .replace(/[^a-f0-9]/gi, '')
    .slice(0, 32);
}

/** Tiny synchronous HMAC-SHA1, because ICE credentials are minted per connection. */
function hmacSha1(key, message) {
  const enc = new TextEncoder();
  let k = enc.encode(key);
  if (k.length > 64) k = sha1(k);
  const pad = new Uint8Array(64);
  pad.set(k);
  const inner = new Uint8Array(64 + enc.encode(message).length);
  const outer = new Uint8Array(64 + 20);
  for (let i = 0; i < 64; i++) {
    inner[i] = pad[i] ^ 0x36;
    outer[i] = pad[i] ^ 0x5c;
  }
  inner.set(enc.encode(message), 64);
  outer.set(sha1(inner), 64);
  return base64(sha1(outer));
}

function sha1(bytes) {
  const ml = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  new DataView(withPad.buffer).setUint32(withPad.length - 4, ml >>> 0, false);

  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Int32Array(80);
  const view = new DataView(withPad.buffer);

  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getInt32(i + j * 4, false);
    for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);

    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let j = 0; j < 80; j++) {
      const [f, k] =
        j < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : j < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : j < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const t = (rol(a, 5) + f + e + k + w[j]) | 0;
      [e, d, c, b, a] = [d, c, rol(b, 30), a, t];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0, (h4 + e) | 0];
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setInt32(i * 4, h, false));
  return out;
}

const rol = (n, s) => (n << s) | (n >>> (32 - s));

function base64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
