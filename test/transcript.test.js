/**
 * What the key is actually bound to.
 *
 * The audit left two things here unexamined, and both are local decisions rather than
 * anything a specification settles:
 *
 *   · the session id folded into the CPace generator, which is what stops a share agreed at
 *     one rendezvous from meaning anything at another;
 *   · the pairing root folded in afterwards, which is what stops a correct guess at a
 *     six-character code from impersonating a device you already know.
 *
 * Neither is exotic and both are the kind of thing that is right until somebody reorders an
 * argument. So each is tested as a property of the output rather than by reading the code:
 * change one input, and the key must change with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { cpaceStart, cpaceFinish, hkdf, toHex, KEM_CT_BYTES } = await import('../web/core/gdcrypto.js');
const { SecureSession } = await import('../web/core/session.js');
const { concat } = await import('../web/core/bytes.js');

const tagOf = (n) => new Uint8Array(16).fill(n);

/** One complete CPace exchange, as the session performs it. */
async function agree(code, sid, otherCode = code, otherSid = sid) {
  const a = cpaceStart(code, sid);
  const b = cpaceStart(otherCode, otherSid);
  return {
    a: await cpaceFinish(a.state, b.msg),
    b: await cpaceFinish(b.state, a.msg),
    shares: [a.msg, b.msg],
  };
}

/* ── the session id ───────────────────────────────────────────────────────── */

test('the same code at two rendezvous agrees two different keys', async () => {
  /*
   * The rendezvous tag is the session id. Without it in the generator, a share published at
   * one tag would be usable at another under the same code, so anybody who could watch two
   * rendezvous could carry a handshake between them.
   */
  const one = await agree('AB12C', tagOf(1));
  const two = await agree('AB12C', tagOf(2));
  assert.equal(toHex(one.a), toHex(one.b), 'the exchange does not agree with itself');
  assert.equal(toHex(two.a), toHex(two.b));
  assert.notEqual(toHex(one.a), toHex(two.a), 'the session id does not reach the key');
});

test('two sides at different rendezvous never agree, whatever the code', async () => {
  const mixed = await agree('AB12C', tagOf(1), 'AB12C', tagOf(2));
  assert.notEqual(toHex(mixed.a), toHex(mixed.b), 'a share crossed between rendezvous');
});

test('a share from another rendezvous does not key this one', async () => {
  const here = cpaceStart('AB12C', tagOf(3));
  const elsewhere = cpaceStart('AB12C', tagOf(4));
  const mine = await cpaceFinish(here.state, elsewhere.msg);
  const theirs = await cpaceFinish(elsewhere.state, here.msg);
  assert.notEqual(toHex(mine), toHex(theirs));
});

test('one character of the code changes the key completely', async () => {
  const right = await agree('AB12C', tagOf(5));
  const wrong = await agree('AB12C', tagOf(5), 'AB12D', tagOf(5));
  assert.notEqual(toHex(wrong.a), toHex(wrong.b), 'two codes agreed a key');
  assert.notEqual(toHex(right.a), toHex(wrong.a));
});

test('an empty code is still a code, and its own one', async () => {
  // Paired reconnects run CPace with no code at all and lean on the root instead; the
  // exchange still has to be a real one rather than a constant.
  const one = await agree('', tagOf(6));
  const two = await agree('', tagOf(6));
  assert.equal(toHex(one.a), toHex(one.b));
  assert.notEqual(toHex(one.a), toHex(two.a), 'two exchanges with no code produced one key');
});

/* ── elements that are not group elements ─────────────────────────────────── */

test('a share that is not a point is refused rather than folded in', async () => {
  const { state } = cpaceStart('AB12C', tagOf(7));
  const bad = [
    new Uint8Array(32), // the identity encoding
    new Uint8Array(31),
    new Uint8Array(33),
    new Uint8Array(0),
    new Uint8Array(32).fill(0xff),
  ];
  for (const msg of bad) {
    await assert.rejects(() => cpaceFinish(state, msg), `a ${msg.length}-byte share was accepted`);
  }
});

test('a share reflected back at its sender is refused by the session', async () => {
  // Otherwise the key is one only we can compute, and it would confirm against itself.
  const tag = tagOf(8);
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  const sent = [];
  signal.forward = (_t, p) => sent.push(Uint8Array.from(p));

  const s = new SecureSession(signal, { tag, code: 'AB12C' });
  const errors = [];
  s.addEventListener('error', (e) => errors.push(e.detail?.message || ''));
  s.start();
  await new Promise((r) => setTimeout(r, 30));

  const offer = sent.find((f) => f[0] === 0x10);
  assert.ok(offer, 'no offer was published');
  await s._handle(offer); // our own, straight back at us
  assert.equal(s.established, false, 'a reflected share keyed the session');
  assert.ok(errors.some((m) => /reflected/i.test(m)), `the reflection is reported: ${errors}`);
});

/* ── the pairing root ─────────────────────────────────────────────────────── */

test('folding a pairing root changes the key, and a different root changes it again', async () => {
  /*
   * The reason a remembered device cannot be impersonated by somebody who guesses the code:
   * the root is a secret only the two of them hold, and it is mixed in after the exchange.
   */
  const base = await agree('', tagOf(9));
  const rootA = webcrypto.getRandomValues(new Uint8Array(32));
  const rootB = webcrypto.getRandomValues(new Uint8Array(32));

  const withA = await hkdf(concat(base.a, rootA), 'gd/reconnect/v1', 32);
  const withAagain = await hkdf(concat(base.b, rootA), 'gd/reconnect/v1', 32);
  const withB = await hkdf(concat(base.a, rootB), 'gd/reconnect/v1', 32);

  assert.equal(toHex(withA), toHex(withAagain), 'the two sides disagree with the same root');
  assert.notEqual(toHex(withA), toHex(base.a), 'the root did not reach the key');
  assert.notEqual(toHex(withA), toHex(withB), 'two different roots gave one key');
});

test('the root is folded in a direction that cannot be reversed', async () => {
  /*
   * Concatenation then HKDF, not XOR: an attacker who learns the exchange output must not be
   * able to strip it back off and be left with the root.
   *
   * Asserted over the whole value, not byte by byte. A single byte of a hash matches a single
   * byte of a random root once in two hundred and fifty-six tries, so a per-byte version of
   * this fails outright about one run in eight, and says nothing when it passes, because one
   * coincidence is not a reversal. Thirty-two bytes at once is the actual claim.
   */
  const base = await agree('', tagOf(10));
  const root = webcrypto.getRandomValues(new Uint8Array(32));
  const folded = await hkdf(concat(base.a, root), 'gd/reconnect/v1', 32);
  const stripped = folded.map((byte, i) => byte ^ base.a[i]);
  assert.notEqual(toHex(stripped), toHex(root), 'the root falls out of an XOR');
});

test('a session given a root will not agree with one that has none', async () => {
  const tag = tagOf(11);
  const root = webcrypto.getRandomValues(new Uint8Array(32));
  const withRoot = await hkdf(concat((await agree('', tag)).a, root), 'gd/reconnect/v1', 32);
  const without = (await agree('', tag)).a;
  assert.notEqual(toHex(withRoot), toHex(without));
});

/* ── the encapsulation, which must be one per offer ───────────────────────── */

/** Drive a session to the point where it has answered one offer, and return what it sent. */
async function answerOffer(session, offer) {
  const sent = [];
  session.signal.forward = (_t, p) => sent.push(Uint8Array.from(p));
  await session._handle(offer);
  await new Promise((r) => setTimeout(r, 20));
  return sent.filter((f) => f[0] === 0x14);
}

test('one offer is answered with one wrapped secret, however many times it arrives', async () => {
  /*
   * The bug this guards was silent and total: encapsulating afresh for a repeated offer sends
   * two ciphertexts carrying two different secrets, the peer opens whichever reaches it first,
   * and this side keeps the other. Both devices come up, on different keys.
   */
  const tag = tagOf(12);
  const mk = () => {
    const sig = new EventTarget();
    sig.subscribe = sig.unsubscribe = sig.subscribeRoom = () => {};
    sig.forward = () => {};
    return new SecureSession(sig, { tag, code: 'AB12C' });
  };

  const peer = mk();
  const peerSent = [];
  peer.signal.forward = (_t, p) => peerSent.push(Uint8Array.from(p));
  peer.start();
  await new Promise((r) => setTimeout(r, 30));
  const offer = peerSent.find((f) => f[0] === 0x10);
  assert.ok(offer, 'the peer published no offer');

  const s = mk();
  s.addEventListener('error', () => {});
  s.start();
  await new Promise((r) => setTimeout(r, 30));

  const first = await answerOffer(s, offer);
  const second = await answerOffer(s, offer);
  const third = await answerOffer(s, offer);

  const cts = [...first, ...second, ...third].map((f) => toHex(f.subarray(1, 1 + KEM_CT_BYTES)));
  assert.ok(cts.length >= 1, 'the offer was never answered');
  assert.equal(new Set(cts).size, 1, `one offer produced ${new Set(cts).size} different secrets`);
});

test('a different offer is answered with a different wrapped secret', async () => {
  const tag = tagOf(13);
  const mk = (code = 'AB12C') => {
    const sig = new EventTarget();
    sig.subscribe = sig.unsubscribe = sig.subscribeRoom = () => {};
    sig.forward = () => {};
    return new SecureSession(sig, { tag, code });
  };

  const offers = [];
  for (let i = 0; i < 2; i++) {
    const peer = mk();
    const sent = [];
    peer.signal.forward = (_t, p) => sent.push(Uint8Array.from(p));
    peer.start();
    await new Promise((r) => setTimeout(r, 30));
    offers.push(sent.find((f) => f[0] === 0x10));
  }
  assert.notEqual(toHex(offers[0]), toHex(offers[1]), 'two peers published the same offer');

  const s = mk();
  s.addEventListener('error', () => {});
  s.start();
  await new Promise((r) => setTimeout(r, 30));

  const cts = [];
  for (const offer of offers) {
    for (const confirm of await answerOffer(s, offer)) {
      cts.push(toHex(confirm.subarray(1, 1 + KEM_CT_BYTES)));
    }
  }
  assert.equal(new Set(cts).size, cts.length, 'two different offers were answered identically');
});

test('the cached encapsulation lives and dies with the keypair it belongs to', async () => {
  /*
   * Two paths through `reset`, and they want opposite things.
   *
   * A reset on a session that has not keyed yet only re-announces: the CPace share and the
   * lattice keypair are untouched, so a secret already wrapped to the peer's key is still the
   * right answer and throwing it away would send a second, different one.
   *
   * A reset on a live session builds a new keypair, and then the cached secret is wrapped to
   * a key this side no longer holds. Keeping it there would answer the next round with a
   * secret the peer cannot open.
   */
  const tag = tagOf(14);
  const sig = new EventTarget();
  sig.subscribe = sig.unsubscribe = sig.subscribeRoom = () => {};
  sig.forward = () => {};
  const s = new SecureSession(sig, { tag, code: 'AB12C' });
  s.addEventListener('error', () => {});
  s.start();
  await new Promise((r) => setTimeout(r, 30));

  const before = await s._kem;
  const cached = { forOffer: new Uint8Array([1, 2, 3]), pending: Promise.resolve({}) };

  // Not yet keyed: the keypair stays, so the answer stays with it.
  s._kemOut = cached;
  s.reset();
  assert.equal(await s._kem, before, 'an un-keyed reset replaced the keypair');
  assert.equal(s._kemOut, cached, 'an un-keyed reset discarded an answer that was still valid');

  // Keyed, then reset: a new keypair, and nothing left over from the old one.
  s.established = true;
  s.K = new Uint8Array(32);
  s._kemOut = cached;
  s.reset();
  await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(await s._kem, before, 'a re-key kept the previous keypair');
  assert.equal(s._kemOut, null, 'a re-key kept an answer wrapped to a key it no longer holds');
});
