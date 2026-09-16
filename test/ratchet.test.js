/**
 * The ratchet.
 *
 * The property being tested is a negative and an awkward one: that a key recovered *later*
 * does not open what was sent earlier. Most of these take the attacker's side: they
 * seize the whole chain state at a chosen moment and then try to read the past with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { Ratchet, ratchetPair, MAX_SKIP } = await import('../web/core/session.js');
const { seal, open } = await import('../web/core/gdcrypto.js');

const te = new TextEncoder();
const td = new TextDecoder();
const AAD = te.encode('gd/ctl');
const nonceFor = (lane, seq) => {
  const n = new Uint8Array(12);
  n[0] = lane;
  new DataView(n.buffer).setBigUint64(4, BigInt(seq), true);
  return n;
};

const K = () => webcrypto.getRandomValues(new Uint8Array(32));

/** A sender and a receiver that agree, built the way the session builds them. */
async function pair() {
  const k = K();
  return { a: await ratchetPair(k, 0), b: await ratchetPair(k, 1) };
}

test('what one side seals, the other opens', async () => {
  const { a, b } = await pair();
  for (const text of ['first', 'second', 'third']) {
    const { seq, key } = await a.out.send();
    const ct = await seal(key, nonceFor(0, seq), te.encode(text), AAD);

    const step = await b.in.receive(seq);
    assert.ok(step, `no key for ${seq}`);
    const pt = await open(step.key, nonceFor(0, seq), ct, AAD);
    step.commit();
    assert.equal(td.decode(pt), text);
  }
});

test('the two directions do not collide', async () => {
  const { a, b } = await pair();
  const fromA = await a.out.send();
  const fromB = await b.out.send();
  // Same index, different chains: the keys must not be the same one.
  const ct = await seal(fromA.key, nonceFor(0, fromA.seq), te.encode('from a'), AAD);
  await assert.rejects(
    () => open(fromB.key, nonceFor(0, fromA.seq), ct, AAD),
    'the send chains are the same in both directions',
  );
});

/* ─────────────────────────── the actual property ─────────────────────────── */

test('a chain seized later does not open what was sent earlier', async () => {
  const { a, b } = await pair();

  // Three messages are sent, delivered, and closed.
  const recorded = [];
  for (const text of ['the first thing', 'the second thing', 'the third thing']) {
    const { seq, key } = await a.out.send();
    const ct = await seal(key, nonceFor(0, seq), te.encode(text), AAD);
    recorded.push({ seq, ct, text });

    const step = await b.in.receive(seq);
    assert.equal(td.decode(await open(step.key, nonceFor(0, seq), ct, AAD)), text);
    step.commit();
  }

  // Now the device is seized. The attacker takes everything that was in memory: the chain
  // value, how far it had got, and anything it was holding for frames that had not arrived.
  const seized = Uint8Array.from(b.in.next);
  const seizedIndex = b.in.index;
  assert.equal(b.in.skipped.size, 0, 'nothing was skipped, so no key should be held');

  // And has the recorded traffic. The chain will not go backwards to reach any of it.
  for (const { seq, ct } of recorded) {
    const attacker = new Ratchet(seized);
    attacker.index = seizedIndex;
    assert.equal(
      await attacker.receive(seq),
      null,
      `message ${seq} still had a key available after the fact`,
    );

    // And forcing a key out of it anyway produces the wrong one.
    const forced = new Ratchet(seized);
    const guess = await forced.receive(0);
    await assert.rejects(
      () => open(guess.key, nonceFor(0, seq), ct, AAD),
      `message ${seq} was readable from a chain seized afterwards`,
    );
  }
});

/*
 * The other half of the truth, asserted so it cannot be quietly forgotten.
 *
 * A symmetric ratchet does not heal. Whoever holds the chain keeps pace with it, because
 * every key after this point is derived from what they are holding. Getting that back needs
 * fresh key material from a new exchange, either a Diffie-Hellman ratchet or re-keying the
 * session, which is the blunt version of the same thing.
 */
test('but a seized chain does follow what comes next', async () => {
  const { a, b } = await pair();
  const first = await a.out.send();
  const opened = await b.in.receive(first.seq);
  opened.commit();

  const seized = new Ratchet(b.in.next);
  seized.index = b.in.index;

  const { seq, key } = await a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('sent after the seizure'), AAD);
  const step = await seized.receive(seq);
  assert.equal(
    td.decode(await open(step.key, nonceFor(0, seq), ct, AAD)),
    'sent after the seizure',
    'this is expected: forward secrecy is not post-compromise security',
  );
});

test('a delivered message leaves no key behind on the receiver', async () => {
  const { a, b } = await pair();
  const { seq, key } = await a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('read and closed'), AAD);

  const step = await b.in.receive(seq);
  await open(step.key, nonceFor(0, seq), ct, AAD);
  step.commit();

  // The same frame again: the key that opened it is gone, not cached.
  assert.equal(await b.in.receive(seq), null, 'the used key is still available');
});

/* ──────────────────────────── loss and reordering ─────────────────────────── */

test('a frame that arrives out of order still opens', async () => {
  const { a, b } = await pair();
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const { seq, key } = await a.out.send();
    frames.push({ seq, ct: await seal(key, nonceFor(0, seq), te.encode(`m${seq}`), AAD) });
  }

  // Delivered 3, 0, 4, 1, 2, the order a lossy link produces.
  for (const i of [3, 0, 4, 1, 2]) {
    const { seq, ct } = frames[i];
    const step = await b.in.receive(seq);
    assert.ok(step, `no key for out-of-order ${seq}`);
    const pt = await open(step.key, nonceFor(0, seq), ct, AAD);
    step.commit();
    assert.equal(td.decode(pt), `m${seq}`);
  }
});

test('a frame that never arrives does not block the ones after it', async () => {
  const { a, b } = await pair();
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const { seq, key } = await a.out.send();
    frames.push({ seq, ct: await seal(key, nonceFor(0, seq), te.encode(`m${seq}`), AAD) });
  }

  // 1 is lost for good.
  for (const i of [0, 2, 3]) {
    const { seq, ct } = frames[i];
    const step = await b.in.receive(seq);
    assert.ok(step, `${seq} was blocked by the gap`);
    assert.equal(td.decode(await open(step.key, nonceFor(0, seq), ct, AAD)), `m${seq}`);
    step.commit();
  }
  // Its key is held, because it might still turn up.
  assert.ok(b.in.skipped.has(1));
});

/* ──────────────────────────── what an attacker can do ────────────────────── */

test('an unauthenticated sequence number cannot move the chain', async () => {
  const { a, b } = await pair();
  const before = { index: b.in.index, chain: Uint8Array.from(b.in.next) };

  // A frame claiming to be far ahead, which does not decrypt. The receiver derives a key to
  // try it, and must not keep any of that work.
  const step = await b.in.receive(200);
  assert.ok(step, 'within the skip limit, so a key is offered');
  // never committed, because the frame would not open

  assert.equal(b.in.index, before.index, 'the chain advanced on an unproven claim');
  assert.deepEqual(Array.from(b.in.next), Array.from(before.chain), 'the chain state changed');
  assert.equal(b.in.skipped.size, 0, 'keys were banked for a frame that never authenticated');

  // The honest frame that follows still opens.
  const { seq, key } = await a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('still here'), AAD);
  const real = await b.in.receive(seq);
  assert.equal(td.decode(await open(real.key, nonceFor(0, seq), ct, AAD)), 'still here');
});

test('a sequence far beyond the skip limit is refused outright', async () => {
  const { b } = await pair();
  assert.equal(await b.in.receive(MAX_SKIP + 1), null);
  assert.equal(await b.in.receive(2 ** 40), null);
  assert.equal(await b.in.receive(Number.MAX_SAFE_INTEGER), null);
  assert.equal(b.in.index, 0, 'a refused claim still moved the chain');
});

test('nonsense sequence numbers are refused', async () => {
  const { b } = await pair();
  for (const bad of [-1, 1.5, NaN, Infinity, '3', null, undefined]) {
    assert.equal(await b.in.receive(bad), null, `${String(bad)} was accepted`);
  }
});

test('the skipped store cannot be grown without bound', async () => {
  const { a, b } = await pair();
  // Send a lot and deliver only the last, forcing everything between to be banked.
  for (let i = 0; i < MAX_SKIP * 2; i++) await a.out.send();
  let seq = 0;
  for (let round = 0; round < 3; round++) {
    seq += MAX_SKIP;
    const step = await b.in.receive(seq);
    if (step) step.commit();
  }
  assert.ok(b.in.skipped.size <= MAX_SKIP, `${b.in.skipped.size} keys held`);
});

test('destroying a chain leaves nothing derivable', async () => {
  const { a, b } = await pair();
  const { seq, key } = await a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('gone'), AAD);

  b.in.destroy();
  assert.deepEqual(Array.from(b.in.next), new Array(32).fill(0), 'the chain was not zeroed');
  assert.equal(b.in.skipped.size, 0);

  // A fresh chain from the zeroed state cannot reach the key.
  const after = new Ratchet(b.in.next);
  const step = await after.receive(seq);
  if (step) await assert.rejects(() => open(step.key, nonceFor(0, seq), ct, AAD));
});

/*
 * Re-keying, which is the one thing that can desync two chains.
 *
 * A session that drops and comes back agrees a new key and both sides rebuild from it. If one
 * rebuilt and the other carried on, every frame after that point would fail to open while the
 * connection looked healthy, which is the worst shape a bug of this kind can take, because
 * nothing reports it.
 */
test('a rekey resyncs both sides from the new key', async () => {
  const first = await pair();
  // Traffic on the old key, so both chains are well past zero.
  for (let i = 0; i < 7; i++) {
    const { seq } = await first.a.out.send();
    const step = await first.b.in.receive(seq);
    step.commit();
  }
  assert.equal(first.a.out.index, 7);
  assert.equal(first.b.in.index, 7);

  // The session re-keys. Both sides throw the old chains away and build from the new key.
  first.a.out.destroy();
  first.b.in.destroy();
  const second = await pair();

  assert.equal(second.a.out.index, 0, 'the new chain did not start from the beginning');
  const { seq, key } = await second.a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('after the rekey'), AAD);
  const step = await second.b.in.receive(seq);
  assert.ok(step, 'the rebuilt chains do not agree');
  assert.equal(td.decode(await open(step.key, nonceFor(0, seq), ct, AAD)), 'after the rekey');
});

test('chains from different session keys never agree', async () => {
  const one = await pair();
  const two = await pair();
  const { seq, key } = await one.a.out.send();
  const ct = await seal(key, nonceFor(0, seq), te.encode('from session one'), AAD);

  const step = await two.b.in.receive(seq);
  await assert.rejects(
    () => open(step.key, nonceFor(0, seq), ct, AAD),
    'a chain from another session key opened this frame',
  );
});
