/**
 * The guards in front of the relay socket.
 *
 * These run against a real server on a real port, because what is being tested is the
 * handshake: an Origin header a browser sends and an attacker in a browser cannot forge,
 * and a per-address cap that only exists at connection time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3987;
const URL_WS = `ws://127.0.0.1:${PORT}/rv`;

let server;

/** Open a socket and report how it ended: 'open', or the close code. */
function attempt(headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS, { headers });
    const done = (v) => {
      try {
        ws.removeAllListeners();
      } catch {
        /* already gone */
      }
      resolve({ result: v, ws });
    };
    ws.on('open', () => done('open'));
    ws.on('close', (code) => done(code));
    ws.on('error', () => done('error'));
    setTimeout(() => done('timeout'), 4000);
  });
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), MAX_PER_ADDRESS: '3', STATS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listening line rather than a fixed sleep.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10_000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
});

test.after(() => {
  server?.kill();
});

test('a socket from this origin is accepted', async () => {
  const { result, ws } = await attempt({ Origin: `http://127.0.0.1:${PORT}` });
  assert.equal(result, 'open');
  ws.close();
});

test('a socket from another website never opens at all', async () => {
  // WebSockets are not subject to the same-origin policy, so without this check any page on
  // the internet could hold sockets here and probe whether a tag is occupied. The refusal
  // happens at the upgrade, so there is no moment where the socket is open.
  const { result } = await attempt({ Origin: 'https://evil.example' });
  assert.equal(result, 'error', 'the handshake fails; it is not opened and then closed');
});

test('a client that sends no Origin is left alone', async () => {
  // Not a browser: a CLI or another service. The header is the browser-only signal.
  const { result, ws } = await attempt({});
  assert.equal(result, 'open');
  ws.close();
});

test('one address cannot hold more sockets than the cap', async () => {
  const open = [];
  for (let i = 0; i < 3; i++) {
    const { result, ws } = await attempt({ Origin: `http://127.0.0.1:${PORT}` });
    assert.equal(result, 'open', `socket ${i + 1} should be inside the cap of 3`);
    open.push(ws);
  }

  const overflow = await attempt({ Origin: `http://127.0.0.1:${PORT}` });
  assert.equal(overflow.result, 'error', 'the fourth never completes a handshake');

  // Releasing one frees a slot again; the counter must not leak.
  open[0].close();
  await once(open[0], 'close');
  await new Promise((r) => setTimeout(r, 150));

  const after = await attempt({ Origin: `http://127.0.0.1:${PORT}` });
  assert.equal(after.result, 'open', 'a closed socket returns its slot');
  after.ws.close();
  for (const ws of open.slice(1)) ws.close();
});

/*
 * Whether a deploy can reach somebody who already has the app.
 *
 * Nothing here is content-addressed: there is no bundler and no hash in a filename, by
 * design, so `main.js` is always `main.js`. An `immutable` response tells a browser not even
 * to ask again, and with a year on it that meant a returning visitor kept running whatever
 * they first loaded - including past a fix. Everything revalidates instead, which costs a
 * conditional request that comes back 304.
 */
test('an asset is never pinned in a browser for longer than it is true', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/main.js`);
  const cache = res.headers.get('cache-control') || '';
  assert.ok(!/immutable/.test(cache), `a stable URL cannot promise immutability: ${cache}`);
  assert.ok(!/max-age=\d{5,}/.test(cache), `nothing here is fresh for that long: ${cache}`);
  assert.ok(res.headers.get('etag'), 'without a tag, revalidating means sending it all again');
});

test('revalidating an unchanged asset costs a 304 rather than the file', async () => {
  const first = await fetch(`http://127.0.0.1:${PORT}/main.js`);
  const again = await fetch(`http://127.0.0.1:${PORT}/main.js`, {
    headers: { 'If-None-Match': first.headers.get('etag') },
  });
  assert.equal(again.status, 304);
});

/*
 * The one place a third party could get in front of a transfer.
 *
 * An ICE server is an instruction to send packets to a host, and a STUN server learns the
 * address of everyone who asks it a question. It is only ever reached when somebody turns on
 * direct connections to other networks - a device on your own network uses host candidates
 * and a cross-network peer uses this deployment's relay - but the default must still be
 * nobody, so that no configuration anyone ships by accident has a stranger in it.
 */
test('no third party is named by default', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/ice`);
  const body = await res.json();
  assert.deepEqual(body.iceServers, [], 'an operator names their own, or there is none');
});

test('aggregate counters are not published by default', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/stats`);
  assert.equal(res.status, 404, 'how busy the relay is, is not public information');
});

test('the served CSP does not allow a connection to an arbitrary WebSocket host', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const csp = res.headers.get('content-security-policy') || '';
  assert.match(csp, /connect-src 'self'/);
  assert.ok(!/connect-src[^;]*\bwss:/.test(csp), 'a blanket wss: is a route out for injected script');
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});

test('there is no sink a string can become script through', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const csp = res.headers.get('content-security-policy') || '';
  // Without both halves this is decoration: the first turns the sinks off, the second names
  // the only policy allowed to mint a script URL.
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, /trusted-types gd(?:;|$)/, 'exactly one policy, not a wildcard');
  assert.ok(!/trusted-types[^;]*\*/.test(csp), "a '*' here would allow any policy to be created");
});

test('the page is isolated into its own process', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  // Both are required for crossOriginIsolated. With only the opener policy, another site's
  // code can still share an address space with the session keys.
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
});

/**
 * Deny what is unused, grant what is used, and tell the two apart.
 *
 * `feature=()` is an empty allowlist: the capability is denied to everything, this document
 * included. `feature=(self)` grants it to this origin and to nothing embedded in it. Getting
 * that wrong breaks a feature with no error anywhere, because the browser never asks the person,
 * and it has happened twice here, first to the wake lock and then to the microphone, which
 * spent a release unable to record a voice message because of this header.
 *
 * The parsing is exact rather than a regexp built by interpolation. The version this replaces
 * read `new RegExp(\`\${feature}=\\(\\)\`)`, where the backslashes are eaten by the template
 * literal before the pattern is compiled, leaving `microphone=()`, an empty capture group,
 * which matches `microphone=(self)` perfectly happily. It asserted nothing.
 */
test('capabilities the app never uses are denied, and the ones it uses are granted to self', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/`);
  const pp = res.headers.get('permissions-policy') || '';

  const allowlist = (feature) => {
    const found = pp.split(',').map((p) => p.trim()).find((p) => p.startsWith(`${feature}=`));
    assert.ok(found, `${feature} is not mentioned in the policy at all`);
    return found.slice(feature.length + 1);
  };

  // Never used, and a foothold should inherit none of them.
  for (const feature of ['camera', 'geolocation', 'payment', 'usb', 'display-capture', 'bluetooth', 'hid', 'serial', 'midi', 'idle-detection']) {
    assert.equal(allowlist(feature), '()', `${feature} should be denied to everything`);
  }

  // Used, so granted to this origin only. There are no frames here to inherit them.
  for (const feature of ['microphone', 'screen-wake-lock']) {
    assert.equal(allowlist(feature), '(self)', `${feature} is used by this app and must be granted to it`);
  }
});

test('a feature granted to self is genuinely different from one denied outright', () => {
  // The distinction the test above turns on, asserted so it cannot quietly stop being true.
  const denied = 'microphone=()';
  const granted = 'microphone=(self)';
  assert.notEqual(denied, granted);
  assert.equal(denied.slice('microphone='.length), '()');
  assert.equal(granted.slice('microphone='.length), '(self)');
});

/* ------------------------------------------------- surviving bad requests */

test('a malformed request path does not take the server down', async () => {
  // `new URL('//', 'http://x')` throws, and that throw used to escape the request handler
  // and end the process: one request from anyone, and every live rendezvous is dropped.
  const hostile = ['//', '///', '//evil.example', '/%', '/%zz', '/..%2f..%2f', '/' + String.fromCharCode(92), '//?a=1'];

  for (const path of hostile) {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { redirect: 'manual' }).catch(
      (err) => ({ failed: String(err) }),
    );
    assert.ok(!res.failed, `request for ${JSON.stringify(path)} killed the connection: ${res.failed}`);
    assert.ok(res.status >= 200 && res.status < 500, `${path} → ${res.status}`);
  }

  // Still alive and serving afterwards. That is the assertion that actually matters.
  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
  assert.equal(health.status, 200, 'the server is still up');
  assert.equal(await health.text(), 'ok');
});

test('a socket can still be opened after a malformed request', async () => {
  await fetch(`http://127.0.0.1:${PORT}//`).catch(() => {});
  const { result, ws } = await attempt({ Origin: `http://127.0.0.1:${PORT}` });
  assert.equal(result, 'open', 'the relay still accepts rendezvous');
  ws.close();
});
