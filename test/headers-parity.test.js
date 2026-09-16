/**
 * The same protections on whichever host is serving this.
 *
 * Nearly everything this app relies on outside its own code is a response header set by the
 * host: the CSP that enforces Trusted Types and refuses every third-party origin, HSTS, the
 * cross-origin isolation trio, the permissions policy that turns the camera off. None of it is
 * in the JavaScript. All of it is in the hosting config.
 *
 * Which makes moving hosts a quiet way to lose the lot. Vercel applies `vercel.json`; Cloudflare
 * Pages reads `_headers` and nothing else. A move that does not carry them across leaves an app
 * that looks identical, passes every other test in this suite, and has no CSP.
 *
 * So `_headers` is generated from `vercel.json` at build time rather than kept as a second copy,
 * and these check that it really is — because a generator nobody runs is the same as a copy
 * nobody updated. This suite has found that exact shape of drift four times already: three
 * relays that agreed on the protocol and not on their limits, and a fix applied to one
 * deployment of three.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

/** Build once, here, so the file under test is the one a deploy would actually upload. */
function built() {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-static.mjs')], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return fs.readFileSync(path.join(ROOT, 'dist', '_headers'), 'utf8');
}

const headers = built();

test('every header Vercel sends, Cloudflare Pages sends too', () => {
  const missing = [];
  for (const rule of config.headers || []) {
    for (const { key, value } of rule.headers) {
      if (!headers.includes(`${key}: ${value}`)) missing.push(`${rule.source} -> ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'these protections exist on one host and not the other');
});

test('and the wildcard is spelled the way Pages spells it', () => {
  // Vercel writes `/(.*)`. Pages does not understand that, and a rule it cannot parse is a rule
  // it does not apply — the failure is silent and total.
  assert.match(headers, /^\/\*$/m, 'the catch-all rule will not match anything on Pages');
  assert.ok(!headers.includes('/(.*)'), 'a Vercel-only pattern was copied across verbatim');
});

test('the security headers are actually in there, by name', () => {
  /*
   * Named individually rather than counted. A generator that produced an empty file would pass a
   * comparison against a config that had also been emptied; these are the ones whose absence
   * would matter most, so they are asserted rather than inferred.
   */
  for (const key of [
    'Content-Security-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Embedder-Policy',
    'Cross-Origin-Resource-Policy',
    'Permissions-Policy',
  ]) {
    assert.match(headers, new RegExp(`^\\s+${key}: `, 'm'), `${key} is missing on Pages`);
  }
});

test('Trusted Types survive the move, which is what stops a name becoming a script', () => {
  // The single header the XSS story rests on. Everything else in the app assumes it is present.
  assert.match(headers, /require-trusted-types-for 'script'/, 'Trusted Types are not enforced on Pages');
  assert.match(headers, /script-src 'self'/, 'scripts could be loaded from anywhere on Pages');
});

test('the worker is never cached forever, on either host', () => {
  // A worker pinned in a cache is a deploy that can never reach the people already using it.
  assert.match(headers, /^\/sw\.js$/m, 'sw.js has no rule of its own on Pages');
  assert.ok(!/immutable/.test(headers), 'something is served immutable, so an update cannot land');
});
