/**
 * What actually leaves this repository.
 *
 * Two different things get published and they are checked for different reasons.
 *
 * The static build is what a CDN serves, and a CDN serves one set of headers to every page. So
 * `connect-src` in `vercel.json` has to be wide enough for whatever relay a deployment uses,
 * which makes it wide enough to be a way out for injected script. What closes it is a second
 * policy written into the page itself, naming only the relay this build was made for: both are
 * enforced and the browser takes the intersection. That is a real protection resting on a build
 * step, which is exactly the kind of thing that is true until somebody changes the build.
 *
 * The repository is the other one. Vendored code carries other people's licences, and the file
 * people read to find out what a project is licensed under should not be the file that gets it
 * wrong. A missing LICENSE beside a vendored library is not a small thing once this is public.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Build into `dist/` the way a deploy does, so what is tested is what would ship. */
function build(env = {}) {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-static.mjs')], {
    cwd: ROOT,
    env: { ...process.env, GD_RELAY: '', ...env },
    stdio: 'pipe',
  });
  return fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
}

const metaCsp = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';

/* ------------------------------------------------------------- the build */

test('the built page carries a policy of its own, not just the host header', () => {
  const csp = metaCsp(build());
  assert.ok(csp, 'nothing would stop a wide host header being the whole policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, /object-src 'none'/);
});

test('with no relay configured the built page talks to nowhere but itself', () => {
  const csp = metaCsp(build());
  assert.match(csp, /connect-src 'self'\s*;/);
  assert.ok(!/\bwss?:/.test(csp), `a blanket socket scheme is a way out: ${csp}`);
});

test('a configured relay is named exactly, rather than opening the scheme', () => {
  const csp = metaCsp(build({ GD_RELAY: 'wss://relay.example.test/rv' }));
  assert.match(csp, /connect-src 'self' wss:\/\/relay\.example\.test\s*;/);
  // Naming one host is the point. `wss:` on its own would allow every host there is.
  assert.ok(!/connect-src[^;]*\bwss:\s/.test(csp), `the scheme is open, not just the host: ${csp}`);
});

test('the relay a build was made for is the one the page looks for', () => {
  const html = build({ GD_RELAY: 'wss://relay.example.test/rv' });
  assert.match(html, /<meta name="gd-relay" content="wss:\/\/relay\.example\.test\/rv">/);
});

/*
 * The host header is allowed to be wide, and is, because it cannot know the relay. What it may
 * not be is wide in a way the page's own policy does not narrow again - so the two are checked
 * together rather than separately.
 */
test('the host header is never the only thing standing in front of a socket', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const header = vercel.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key.toLowerCase() === 'content-security-policy');
  assert.ok(header, 'a static host with no policy at all is worse than a wide one');
  assert.match(header.value, /require-trusted-types-for 'script'/);
  assert.match(header.value, /frame-ancestors 'none'/);

  // If this ever stops being wide, the page policy stops being the thing that matters and a
  // cross-origin relay breaks instead. Either way it should be a decision, not a surprise.
  assert.match(header.value, /connect-src[^;]*wss:/, 'a cross-origin relay could not connect');
  assert.ok(metaCsp(build()).includes("connect-src 'self'"), 'nothing narrows the header again');
});

/* -------------------------------------------------------- the repository */

test('every vendored library keeps the licence it came with', () => {
  const expected = {
    '@noble/curves': /MIT/,
    '@noble/hashes': /MIT/,
    '@noble/post-quantum': /MIT/,
    libheif: /GNU LESSER GENERAL PUBLIC LICENSE/,
  };
  for (const [dir, pattern] of Object.entries(expected)) {
    const file = path.join(ROOT, 'web', 'vendor', dir, 'LICENSE');
    assert.ok(fs.existsSync(file), `${dir} is published with no licence beside it`);
    assert.match(fs.readFileSync(file, 'utf8'), pattern, `${dir} has the wrong licence text`);
  }
});

/*
 * No deployment ships with a stranger in it.
 *
 * A STUN server learns the address of everybody who asks it a question. It is only reached
 * when somebody turns on direct connections to other networks, and that is off by default -
 * but "only when you opt in" is not "never", and a default belonging to a company with no
 * part in the transfer is the wrong thing to ship. The Node server was fixed first and the
 * two alternative relays kept the old default, which would have put it straight back on the
 * deployment being used.
 */
test('no relay is configured to contact a third party', () => {
  const configs = [
    'server/index.js',
    'server/ice.js',
    'deploy/cloudflare/worker.js',
    'deploy/cloudflare/wrangler.toml',
    'deploy/deno/relay.js',
  ];
  for (const rel of configs) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      !/stun[:.][^'"\s]*(google|cloudflare|twilio|metered|stunprotocol)/i.test(src),
      `${rel} names a STUN host that is not the operator's`,
    );
  }
});

test('the project states its own licence, and says the same thing twice', () => {
  const licence = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(licence, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3, 19 November 2007/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.license, /^AGPL-3\.0/, 'package.json and LICENSE disagree');
});

/*
 * A private key is the one file here that must never be committed, and the only reason it is
 * safe is a line in a .gitignore that somebody could delete without noticing.
 */
test('nothing that must stay on this machine is publishable', () => {
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const entry of ['dev-certs/', 'node_modules/', 'dist/', 'reference/', '.env']) {
    assert.ok(ignored.includes(entry), `${entry} would be committed`);
  }
});
