/**
 * Gear Drop server.
 *
 * Two jobs, nothing else:
 *   1. serve the static client with strict headers
 *   2. relay opaque bytes between two sockets that present the same tag
 *
 * Deliberately absent: a database, a session store, request logs, IP storage,
 * User-Agent parsing, analytics, and any third-party origin.
 */
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import dgram from 'node:dgram';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { Rendezvous, Bucket, frame, FRAME } from './rendezvous.js';
import { networkOf, ownNetwork, primaryAddress } from './network.js';

import { iceServers } from './ice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, '..', 'web');

const conf = {
  port: Number(process.env.PORT) || 3000,
  host: process.argv.includes('--localhost-only') ? '127.0.0.1' : undefined,
  dev: process.argv.includes('--dev'),
  /*
   * Serve over TLS, for testing on a phone.
   *
   * Browsers only treat `localhost` as a secure context over plain HTTP, and everything this
   * app is built on (WebCrypto, origin-private storage, the service worker) is unavailable
   * outside one. Opened at `http://192.168.x.x` the app does not degrade, it fails at boot
   * with no key material. A self-signed certificate covering the machine's LAN address is the
   * shortest route to trying it on a real device on a real network.
   */
  tls: process.argv.includes('--tls'),
  tlsKey: process.env.TLS_KEY || path.join(__dirname, '..', 'dev-certs', 'key.pem'),
  tlsCert: process.env.TLS_CERT || path.join(__dirname, '..', 'dev-certs', 'cert.pem'),
  /*
   * No STUN server unless an operator names one, and deliberately not a default belonging to
   * somebody else.
   *
   * STUN is only reached at all when a person has turned on direct connections to devices on
   * other networks. Devices on the same network connect with host candidates and need none of
   * this, and a cross-network peer goes over this deployment's own relay unless asked
   * otherwise - so for the default configuration nothing here is ever contacted.
   *
   * It used to default to a public STUN server, which meant the one case where it *was* used
   * disclosed the person's address to a company with no part in the transfer. An operator who
   * wants cross-network direct connections sets STUN_URLS, and preferably TURN_URLS, to
   * something they run. Left unset, that path simply falls back to the relay, which carries
   * the same sealed frames and keeps no record of them.
   */
  stunUrls: (process.env.STUN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean),
  turnUrls: (process.env.TURN_URLS || '').split(',').filter(Boolean),
  turnSecret: process.env.TURN_SECRET || '',
  turnUser: process.env.TURN_USER || '',
  turnPass: process.env.TURN_PASS || '',
  maxSockets: Number(process.env.MAX_SOCKETS) || 20_000,
  /** Sockets one address may hold at once. A NAT shares one, so it is generous. */
  maxPerAddress: Number(process.env.MAX_PER_ADDRESS) || 32,
  trustProxy: process.env.TRUST_PROXY === '1',
  /**
   * Browser origins allowed to open a relay socket. Empty means same-origin only, which is
   * right for the single-service deployment; a split deployment (static app on one host,
   * relay on another) has to name the app's origin here.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean),
  /** Aggregate counters are off by default: they describe how busy the relay is. */
  stats: process.env.STATS === '1',
  /** Extra `connect-src` entries, for a client configured to reach a relay elsewhere. */
  cspConnectExtra: (process.env.CSP_CONNECT_EXTRA || '').trim(),
};

/* ------------------------------------------------------- network grouping */

/**
 * An opaque, rotating label for "the network this socket came from", so local discovery can
 * work without the client ever seeing an address.
 *
 * HMAC(secret, address), truncated to 16 bytes, with the secret random per process and
 * re-rolled every six hours. The address is used and discarded in the same expression.
 *
 * A device found this way is not authenticated: anyone reaching the same label, including
 * the operator, who holds the secret, can offer to pair. Hence the safety words.
 */
let netSecret = crypto.randomBytes(32);
const netRoll = setInterval(() => {
  netSecret = crypto.randomBytes(32);
}, 6 * 3600_000);
netRoll.unref?.();

/**
 * Is this browser allowed to open a relay socket?
 *
 * WebSockets are not subject to the same-origin policy, so without this any page on the
 * internet could open a socket here, burning slots and probing whether a given tag is
 * occupied. A request with no Origin is a non-browser client and is left alone; the header
 * is what a browser always sends and what an attacker in a browser cannot forge.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (conf.allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Fixed for the life of the process: interfaces do not move underneath a running relay. */
const SELF_NETWORK = ownNetwork(os.networkInterfaces(), await primaryAddress(dgram));

function networkLabel(req) {
  let addr = req?.socket?.remoteAddress || '';
  if (conf.trustProxy) {
    const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) addr = fwd;
  }
  if (!addr) return null;
  return crypto.createHmac('sha256', netSecret).update(networkOf(addr, SELF_NETWORK)).digest('hex').slice(0, 32);
}

/* ------------------------------------------------------------------ static */

/*
 * Compression, done once per file rather than once per request. The client is all text and
 * was going out raw, about four times what it needs to be.
 *
 * Results are cached on file and mtime, which also keeps an exact `Content-Length`; streaming
 * through a transform would fall back to chunked encoding.
 */
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt',
]);

/*
 * Below this, compressing makes things worse.
 *
 * A gzip member carries about twenty bytes of header and trailer, and a response this small
 * fits in one packet either way - so the only thing shrinking it buys is CPU on both ends.
 */
const COMPRESS_MIN = 1024;

/** Only cache what is worth caching; anything enormous streams raw rather than living in RAM. */
const COMPRESS_MAX = 4 * 1024 * 1024;

/*
 * One entry per file and encoding, replaced when the file changes rather than added to.
 *
 * Keying on the mtime as well meant every save during development minted a new entry and the
 * old one was never reachable again or freed. Nothing remote can drive that - it takes write
 * access to the served directory, which is the whole game already - but a cache that only ever
 * grows is the wrong thing to leave in a long-running process. Keyed this way it is bounded by
 * the number of files on disk, and the stored mtime is what decides whether the entry is
 * still good.
 */
const encoded = new Map(); // `${abs}:${enc}` -> { mtimeMs, buf }

/**
 * Which encoding the client asked for, in the order we prefer to give them.
 *
 * Brotli first because it is meaningfully smaller on this kind of text, gzip because
 * everything speaks it, and identity when a client says it wants neither. The header is parsed
 * for presence only: `q=0` is the one case worth honouring, since that is a client explicitly
 * refusing an encoding rather than just not ranking it.
 */
function pickEncoding(header) {
  const wanted = new Map();
  for (const part of String(header || '').toLowerCase().split(',')) {
    const bits = part.trim().split(';').map((x) => x.trim());
    const name = bits.shift();
    if (!name) continue;
    const q = bits.find((p) => p.startsWith('q='));
    wanted.set(name, q ? Number(q.slice(2)) : 1);
  }
  const ok = (n) => (wanted.get(n) ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

function compress(buf, enc) {
  return enc === 'br'
    ? zlib.brotliCompressSync(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
        },
      })
    : zlib.gzipSync(buf, { level: 9 });
}

/**
 * The encoded body for a file, or null to send it as it is.
 *
 * Returns null rather than throwing on anything unexpected, so a file that will not compress
 * is served uncompressed instead of not being served.
 */
async function encodedBody(abs, ext, stat, enc) {
  if (!enc || !COMPRESSIBLE.has(ext)) return null;
  if (stat.size < COMPRESS_MIN || stat.size > COMPRESS_MAX) return null;

  const key = `${abs}:${enc}`;
  const hit = encoded.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.buf;

  try {
    const out = compress(await fsp.readFile(abs), enc);
    // Compressing made it bigger, which happens with small already-dense files. Send the
    // original, and record that so it is not attempted again for this version of the file.
    const buf = out.length >= stat.size ? null : out;
    encoded.set(key, { mtimeMs: stat.mtimeMs, buf });
    return buf;
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/*
 * `connect-src 'self'` covers ws:// and wss:// on this origin, so the blanket `ws: wss:`
 * that used to be here bought nothing except a route out: any script that did get injected
 * could open a socket to a host of its choosing. An operator running the app and the relay
 * on different origins names the relay explicitly with CSP_CONNECT_EXTRA.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  `connect-src 'self'${conf.cspConnectExtra ? ' ' + conf.cspConnectExtra : ''}`,
  // Both workers here are same-origin module URLs minted by the one Trusted Types policy.
  // Nothing constructs a worker from a blob, so the capability is not granted: it is the
  // sink a future `new Worker(URL.createObjectURL(...))` would need, and it has no caller.
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  // No string can become script. Every worker and service-worker URL goes through the one
  // policy in web/core/tt.js, which only mints same-origin module URLs; assigning a plain
  // string to innerHTML or eval throws instead of running. This is what keeps a future
  // careless line from turning a peer's file name into code in a page holding session keys.
  "require-trusted-types-for 'script'",
  'trusted-types gd',
].join('; ');

function secureHeaders(res, extra = {}) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // With the opener policy above, this puts the page in its own process: no other site's
  // code shares an address space with the session keys or with a file being decrypted.
  // It costs nothing here because the app loads no cross-origin resource at all.
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  /*
   * Deny everything the app does not use, so a foothold inherits no capability by default.
   *
   * `(self)` and `()` are not the same thing: an empty allowlist denies the feature to this
   * document as well, not only to anything it embeds. The microphone was written that way, so
   * recording a voice message was refused by this app's own header before the browser asked
   * the person, with nothing on screen to say why. It is granted to this origin and to nobody
   * else; there are no frames here to inherit it.
   */
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(self), geolocation=(), interest-cohort=(), payment=(), usb=(), ' +
      'serial=(), bluetooth=(), midi=(), hid=(), display-capture=(), idle-detection=(), ' +
      'local-fonts=(), xr-spatial-tracking=(), screen-wake-lock=(self)',
  );

  /*
   * And insist on TLS, where there is TLS to insist on.
   *
   * Sent only over a secure connection. On plain HTTP it would be ignored by every browser
   * anyway, and pinning `localhost` to HTTPS is a way to make someone's machine refuse the
   * dev server months later with no obvious cause.
   */
  if (conf.tls) {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}

async function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const abs = path.join(WEB_ROOT, path.normalize(urlPath));
  /*
   * Inside the web root, and a prefix match is not that.
   *
   * `startsWith(WEB_ROOT)` also accepts a sibling directory whose name merely begins with it -
   * `…/webfoo/secret` passes a check for `…/web`. Nothing reaches that today because
   * `path.join` re-anchors whatever `normalize` produces, so the escape has to come from a
   * future edit rather than from a request. It is one character of separator to make the
   * check say what it means, and the alternative is a guard that is correct by accident.
   */
  if (abs !== WEB_ROOT && !abs.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    // SPA-ish fallback: unknown paths render the app shell, no redirect chain.
    return serveFile(req, res, path.join(WEB_ROOT, 'index.html'), 200);
  }
  if (stat.isDirectory()) return serveFile(req, res, path.join(abs, 'index.html'), 200);
  return serveFile(req, res, abs, 200, stat);
}

async function serveFile(req, res, abs, code = 200, stat = null) {
  try {
    stat = stat || (await fsp.stat(abs));
  } catch {
    secureHeaders(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const enc = pickEncoding(req.headers['accept-encoding']);
  const body = await encodedBody(abs, ext, stat, enc);

  /*
   * The tag names the bytes on the wire, not the bytes on disk.
   *
   * Two clients asking for the same path can be sent two different bodies depending on what
   * they accept, and a tag that did not say which would let a cache hand a gzip body to a
   * client that asked for brotli. `Vary` tells a shared cache to key on the header; the suffix
   * makes the two entries distinguishable even where that is mishandled.
   */
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}${body ? '-' + enc : ''}"`;
  /*
   * Everything revalidates, because nothing here is content-addressed.
   *
   * This used to send `max-age=31536000, immutable` for anything that was not HTML, which is
   * the correct header for a file whose name contains a hash of its contents and the wrong one
   * for `main.js`. The build deliberately does not rewrite filenames - "you are trusting the
   * code this origin serves" is the app's one stated assumption and a transform step is a
   * place for that to go wrong quietly - so the URL is stable and the bytes behind it are not.
   * `immutable` told every browser that had ever loaded the app not to ask again for a year.
   *
   * Revalidation costs a conditional request that answers 304 in a couple of hundred bytes,
   * and the service worker serves its own copy immediately and refreshes behind the page, so
   * nothing waits on it.
   */
  const cache = conf.dev ? 'no-store' : 'no-cache';

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    ETag: etag,
  };
  // Announced whenever the type is one we would have compressed, not only when we did - a
  // cache that stored the identity copy still needs to know the answer depends on the header.
  if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
  if (body) headers['Content-Encoding'] = enc;
  secureHeaders(res, headers);

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304).end();
    return;
  }

  res.writeHead(code, { 'Content-Length': body ? body.length : stat.size });
  if (req.method === 'HEAD') return res.end();
  if (body) return res.end(body);
  fs.createReadStream(abs).pipe(res);
}

const handler = (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }

  // `new URL` throws on a request target it cannot parse, and `//` is enough. Unguarded, that
  // threw out of the request handler and took the whole process with it: one request, and the
  // relay is down for everybody.
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch {
    res.writeHead(400).end();
    return;
  }

  if (url.pathname === '/ice') {
    // Fresh, short-lived relay credentials. No identity required, rate-limited by the CDN/proxy.
    secureHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.writeHead(200).end(JSON.stringify(iceServers(conf)));
    return;
  }

  if (url.pathname === '/healthz') {
    /*
     * The one place that says which kind of server this is.
     *
     * A header rather than a word in the body, because the body is a bare `ok` and something
     * outside this repo may well be matching on it. On this endpoint rather than on every
     * response, because one probe at startup is all the page needs to decide whether to
     * register a worker, and a real deployment never even asks.
     */
    const head = { 'Content-Type': 'text/plain' };
    if (conf.dev) head['X-Gear-Drop-Dev'] = '1';
    res.writeHead(200, head).end('ok');
    return;
  }

  if (url.pathname === '/stats' && !conf.stats) {
    res.writeHead(404).end();
    return;
  }

  if (url.pathname === '/stats') {
    // Aggregate counters only: nothing per-user, nothing identifying.
    secureHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.writeHead(200).end(JSON.stringify({ ...rv.stats, tags: rv.size, sockets: wss.clients.size }));
    return;
  }

  serveStatic(req, res);
};

/*
 * One server object either way, so the upgrade handling, the guards and the rendezvous do
 * not need to know which they are on.
 */
const server = conf.tls
  ? https.createServer({ key: fs.readFileSync(conf.tlsKey), cert: fs.readFileSync(conf.tlsCert) }, handler)
  : http.createServer(handler);

/* -------------------------------------------------------------- rendezvous */

const rv = new Rendezvous();
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

/**
 * Sockets held per address label, so one client cannot take the relay's capacity. The key
 * is the same rotating HMAC used for network discovery, never the address itself, which is
 * used and discarded in the same expression as everywhere else here.
 */
const perAddress = new Map();

/**
 * Every check happens at the upgrade, before a WebSocket exists.
 *
 * Doing it in the `connection` handler, where it was, means the handshake has completed and
 * the client has seen an open socket, which it then has to be told to close. A refusal should
 * cost a response line rather than a protocol negotiation, and a rejected client should never
 * hold a socket at all.
 */
const onUpgrade = (req, socket, head) => {
  const refuse = (code, reason) => {
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  let pathname;
  try {
    pathname = new URL(req.url, 'http://x').pathname;
  } catch {
    return socket.destroy();
  }
  if (pathname !== '/rv') return socket.destroy();

  // WebSockets are not subject to the same-origin policy, so without this any page on the
  // internet could open a socket here, burning slots and probing whether a given tag is
  // occupied.
  if (!originAllowed(req)) return refuse(403, 'Forbidden');
  if (wss.clients.size >= conf.maxSockets) return refuse(503, 'Service Unavailable');

  const addressKey = networkLabel(req) || 'unknown';
  if ((perAddress.get(addressKey) || 0) >= conf.maxPerAddress) {
    return refuse(429, 'Too Many Requests');
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.addressKey = addressKey;
    perAddress.set(addressKey, (perAddress.get(addressKey) || 0) + 1);
    wss.emit('connection', ws, req);
  });
};

server.on('upgrade', onUpgrade);

wss.on('connection', (ws, req) => {
  const addressKey = ws.addressKey;

  ws.tags = new Set();
  ws.bucket = new Bucket();
  ws.isAlive = true;
  ws.binaryType = 'nodebuffer';

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return; // text frames are not part of the protocol
    try {
      rv.onFrame(ws, data);
    } catch {
      ws.close(1011, 'error');
    }
  });

  const release = () => {
    rv.drop(ws);
    if (!ws.addressKey) return;
    const left = (perAddress.get(ws.addressKey) || 1) - 1;
    if (left > 0) perAddress.set(ws.addressKey, left);
    else perAddress.delete(ws.addressKey);
    ws.addressKey = null;
  };
  ws.on('close', release);
  ws.on('error', release);

  // Hand the client fresh ICE servers on connect; tag is all-zero (not tag-scoped).
  ws.send(
    frame(
      FRAME.ICE_CREDS,
      Buffer.alloc(16),
      Buffer.from(JSON.stringify({ ...iceServers(conf), net: addressKey === 'unknown' ? null : addressKey }), 'utf8'),
    ),
  );
});

// Protocol-level keep-alive: 25 s, two misses. A backgrounded mobile tab survives;
// PairDrop's 1 Hz JSON ping with a 5 s eviction does not.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 25_000);
heartbeat.unref?.();

/* ------------------------------------------------------------------ start */

/*
 * In TLS dev mode, also serve plain HTTP on the next port, bound to loopback.
 *
 * The certificate is self-signed, so every browser asks before trusting it: fine once on a
 * phone, tiresome on the machine you are working on, and impossible in tooling that cannot
 * click through. `localhost` is a secure context over plain HTTP by definition, so the
 * machine running the relay gets the same app with no warning. Same process, same rendezvous:
 * a browser here and a phone on the network meet as they would in production, and since the
 * host counts as being on its own network, they find each other without a code.
 */
if (conf.tls && conf.dev) {
  const plain = http.createServer(handler);
  plain.on('upgrade', onUpgrade);
  plain.on('clientError', (err, socket) => {
    const CRLF = String.fromCharCode(13, 10);
    if (socket.writable) socket.end(`HTTP/1.1 400 Bad Request${CRLF}Connection: close${CRLF}${CRLF}`);
    socket.destroy();
  });
  plain.listen(conf.port + 1, '127.0.0.1', () => {
    console.log(`  http://localhost:${conf.port + 1}  (this machine, no certificate warning)`);
  });
}

server.listen(conf.port, conf.host, () => {
  const scheme = conf.tls ? 'https' : 'http';
  const where = conf.host ? `${conf.host}:${conf.port}` : `:${conf.port}`;
  if (conf.tls) {
    // Print the addresses a phone on the same network can actually use, because finding
    // them is the first thing anyone tries to do and the last thing a log usually says.
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  ${scheme}://${a.address}:${conf.port}  (${name})`);
      }
    }
    console.log('  the certificate is self-signed, so a browser will ask once before trusting it');
  }
  console.log(`Gear Drop listening on ${where}${conf.dev ? ' (dev)' : ''}`);
  if (!conf.turnUrls.length) {
    console.log('No TURN configured — transfers across strict NATs will fall back to the relay path.');
  }
});

/**
 * A request must never be able to stop the relay.
 *
 * The URL parse above was one way in; there is no reason to assume it was the only one. A
 * connection-level error takes that connection down and nothing else.
 */
server.on('clientError', (err, socket) => {
  // Built from char codes so no escape sequence has to survive a build step.
  const CRLF = String.fromCharCode(13, 10);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request' + CRLF + 'Connection: close' + CRLF + CRLF);
  socket.destroy();
});

process.on('uncaughtException', (err) => {
  // Last resort. Staying up with one failed request is strictly better than exiting and
  // dropping every live rendezvous on the floor.
  console.error('unhandled error, staying up:', err?.message || err);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    rv.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server, rv, conf };
