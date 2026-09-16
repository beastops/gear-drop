/**
 * Gear Drop relay on Deno Deploy.
 *
 * Deno Deploy's free tier holds WebSockets open, so the whole relay is this file plus the
 * shared protocol core. As with every other target here, nothing about the protocol lives
 * in this file — it is socket plumbing around `server/rendezvous.js`.
 *
 *   deployctl deploy --entrypoint=deploy/deno/relay.js
 *   the relay URL is then wss://<project>.deno.dev/rv
 */
import { Rendezvous, Bucket, frame, FRAME, TAG_LEN } from '../../server/rendezvous.js';
import { networkOf } from '../../server/network.js';

const rv = new Rendezvous();
const enc = new TextEncoder();

// No default, and deliberately not somebody else's. See the note in deploy/cloudflare.
const STUN = (Deno.env.get('STUN_URLS') || '').split(',').map((u) => u.trim()).filter(Boolean);
const TURN = (Deno.env.get('TURN_URLS') || '').split(',').filter(Boolean);
const TURN_SECRET = Deno.env.get('TURN_SECRET') || '';
/** Unset by default: without it, "devices on this network" is simply not offered. */
const NET_SECRET = Deno.env.get('NET_SECRET') || '';
/** Comma-separated. Unset means same-origin only. */
const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map((o) => o.trim()).filter(Boolean);

/**
 * WebSockets ignore the same-origin policy, so without this any page on the internet could
 * hold sockets here. A request with no Origin is not a browser and is left alone.
 */
function originAllowed(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

async function iceServers() {
  const servers = STUN.map((urls) => ({ urls }));
  if (TURN.length && TURN_SECRET) {
    const username = String(Math.floor(Date.now() / 1000) + 600);
    servers.push({ urls: TURN, username, credential: await hmac(TURN_SECRET, username, 'SHA-1') });
  }
  return { iceServers: servers, ttl: 600 };
}

async function hmac(secret, message, hash) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return btoa(String.fromCharCode(...sig));
}

/** Opaque, rotating, never stored. See the same comment in server/index.js. */
async function networkLabel(info) {
  if (!NET_SECRET) return null;
  const addr = info?.remoteAddr?.hostname;
  if (!addr) return null;
  // Grouped by network, not by address. On IPv6 there is no NAT, so every device in a home
  // has its own global address and hashing it makes each one its own network - which is
  // local discovery finding nobody. `networkOf` is the one place that decides this.
  const window = Math.floor(Date.now() / (6 * 3600_000));
  const key = await crypto.subtle.importKey('raw', enc.encode(NET_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${window}:${networkOf(addr)}`)));
  return [...sig.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req, info) => {
  const url = new URL(req.url);

  if (url.pathname === '/healthz') return new Response('ok');
  if (url.pathname === '/ice') {
    return Response.json(await iceServers(), { headers: { 'Cache-Control': 'no-store' } });
  }
  if (url.pathname !== '/rv') return new Response('not found', { status: 404 });
  if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  if (!originAllowed(req)) return new Response('forbidden', { status: 403 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = 'arraybuffer';

  const conn = {
    tags: new Set(),
    bucket: new Bucket(),
    send: (bytes) => {
      try {
        socket.send(bytes);
      } catch {
        /* closing */
      }
    },
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        /* already closed */
      }
    },
  };

  socket.onopen = async () => {
    const payload = { ...(await iceServers()), net: await networkLabel(info) };
    conn.send(frame(FRAME.ICE_CREDS, new Uint8Array(TAG_LEN), enc.encode(JSON.stringify(payload))));
  };
  socket.onmessage = (e) => {
    if (typeof e.data === 'string') return; // text frames are not part of the protocol
    rv.onFrame(conn, new Uint8Array(e.data));
  };
  socket.onclose = () => rv.drop(conn);
  socket.onerror = () => rv.drop(conn);

  return response;
});
