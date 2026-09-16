/**
 * The hosted relay and the self-hosted one have to behave the same.
 *
 * They are two implementations of one protocol. The protocol itself is shared - both import
 * `rendezvous.js`, so modes, caps, TTLs and who-may-forward-to-whom cannot drift. What is not
 * shared is everything around it: the socket limits, the frame size, what happens when a
 * frame does not parse. Those were written twice, and they had already diverged.
 *
 * What the divergence cost, so the next person knows why this file exists:
 *
 *   - The Worker hashed the raw client address instead of asking `networkOf`. On IPv4 behind
 *     a NAT that is the same answer. On IPv6 there is no NAT, every device has its own global
 *     address, and local discovery found nobody on exactly the connections it should work
 *     best on.
 *   - The Worker called `rv.onFrame` with no try/catch. Every socket on that deployment lives
 *     in one Durable Object, so a frame that throws does not drop one client, it drops the
 *     object and every rendezvous open on it.
 *   - No frame size limit and no per-network socket cap, both of which the Node relay has.
 *
 * Checked at the source level because the Worker needs a Cloudflare runtime to import. That is
 * a weaker test than running it, and it is much stronger than nothing: each assertion below
 * names a property that was actually missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const worker = read('deploy', 'cloudflare', 'worker.js');
const deno = read('deploy', 'deno', 'relay.js');
const node = read('server', 'index.js');

/* ------------------------------------------------------- the shared protocol */

test('every relay gets the protocol from one file rather than reimplementing it', () => {
  for (const [name, src] of [['worker', worker], ['deno', deno], ['node', node]]) {
    assert.match(src, /from '.*rendezvous\.js'/, `${name} has its own idea of the protocol`);
  }
});

/* ------------------------------------------------------------ grouping */

test('no relay decides for itself what a network is', () => {
  // `networkOf` is the only place that answer lives. A relay that derives a label from the
  // raw address gets IPv4 right by accident and IPv6 wrong.
  for (const [name, src] of [['worker', worker], ['deno', deno], ['node', node]]) {
    assert.match(src, /networkOf/, `${name} does not use the shared grouping`);
  }
  // All three had this exact shape at some point, and all three got IPv6 wrong because of it.
  for (const [name, src] of [['worker', worker], ['deno', deno]]) {
    assert.ok(
      !/\$\{window\}:\$\{addr\}/.test(src),
      `${name} is hashing a raw address again, so each IPv6 device is its own network`,
    );
  }
});

/* -------------------------------------------------------------- the guards */

test('a frame that does not parse closes one socket, never the relay', () => {
  // The Node relay has always done this. On the Worker it is the difference between one
  // client being disconnected and every client on the deployment being disconnected.
  assert.match(node, /try \{[\s\S]{0,120}?onFrame[\s\S]{0,120}?catch/, 'node stopped catching');
  assert.match(worker, /try \{[\s\S]{0,200}?onFrame[\s\S]{0,200}?catch/, 'worker calls onFrame unguarded');
});

test('an oversized frame is refused, at the same size, by both', () => {
  assert.match(node, /maxPayload: 512 \* 1024/);
  assert.match(worker, /MAX_FRAME = 512 \* 1024/);
  assert.match(worker, /byteLength > MAX_FRAME/, 'the limit is declared but never applied');
});

test('one network cannot take the whole relay', () => {
  assert.match(node, /maxPerAddress/);
  assert.match(worker, /MAX_PER_NETWORK/);

  /*
   * The refusal, not the arithmetic.
   *
   * Asserting that the counter is read passes for a relay that counts every socket and turns
   * none away, because the decrement on close reads it too. Deleting the whole refusal branch
   * left this test green until it was written this way.
   */
  assert.match(
    worker,
    /perNetwork\.get\(netKey\)[\s\S]{0,40}?MAX_PER_NETWORK[\s\S]{0,140}?429/,
    'sockets are counted per network but none are ever refused',
  );

  // And the count has to come back down, or the cap becomes a slow ban on a whole household.
  assert.match(worker, /perNetwork\.delete\(netKey\)/);
});

test('text frames are not part of the protocol anywhere', () => {
  assert.match(node, /if \(!isBinary\) return/);
  assert.match(worker, /typeof e\.data === 'string'\) return/);
});

/* ------------------------------------------------------------- what is kept */

test('no relay writes down who connected', () => {
  // The whole claim rests on this: the relay forwards opaque bytes and keeps no record.
  for (const [name, src] of [['worker', worker], ['deno', deno]]) {
    assert.ok(!/console\.(log|info|warn|error)\s*\(/.test(src), `${name} logs something`);
  }
  // The Node relay prints a startup banner and nothing per request.
  const perRequest = node.match(/console\.\w+\([^)]*\b(req|request|socket|addr|ip)\b/gi) || [];
  assert.deepEqual(perRequest, [], 'the node relay logs something about a request');
});

test('an origin the operator did not name cannot open a socket', () => {
  for (const [name, src] of [['worker', worker], ['deno', deno], ['node', node]]) {
    assert.match(src, /originAllowed/, `${name} accepts a socket from any page on the internet`);
  }
});

/*
 * Who is allowed how much, and by what grain.
 *
 * `networkOf` answers "same household" and for IPv6 that is /64. A socket limit keyed that way
 * gives one subscriber with an ordinary /48 some 65 536 budgets, which is no limit at all — and
 * the fix has to land on every deployment, because the Node relay is the one people are told to
 * run when they want the strongest privacy.
 */
test('every relay counts sockets against the party, not the subnet', () => {
  for (const [name, src] of Object.entries({ node, worker })) {
    assert.match(src, /abuseKeyOf/, `the ${name} relay keys its socket limit by the grouping grain`);
  }
});

test('and every relay still groups discovery by household', () => {
  // The limit moved; what counts as "on this network" must not have moved with it.
  for (const [name, src] of Object.entries({ node, worker })) {
    assert.match(src, /networkOf\(/, `the ${name} relay stopped grouping by network`);
  }
});

test('no relay invents a budget for an address it cannot read', () => {
  /*
   * `abuseKeyOf` returns nothing for anything unparseable, and each call site turns that into
   * one shared `unknown` bucket. Without the fallback a null key would be counted under its own
   * entry, which is the bug again wearing a different hat.
   */
  for (const [name, src] of Object.entries({ node, worker })) {
    assert.match(src, /abuseKey\w*\([^)]*\)[\s\S]{0,40}\|\| 'unknown'/, `the ${name} relay has no fallback bucket`);
  }
});
