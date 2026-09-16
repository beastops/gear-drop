/**
 * The ratchet under loss patterns nobody designed for.
 *
 * The audit left this open: the skipped-key store and the window are tuned for ordinary
 * reordering, and "ordinary" is an assumption about the network rather than a property of it.
 * These take the other side (bursts, long silences, a sender that keeps writing into a link
 * that is not there) and check two things each time: that the chains still meet, and that
 * memory stays bounded.
 *
 * The failure being hunted is silent. A ratchet that desynchronises does not throw; it leaves
 * two devices that each believe they are connected and cannot read anything from the other.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function pair() {
  const k = webcrypto.getRandomValues(new Uint8Array(32));
  return { a: await ratchetPair(k, 0), b: await ratchetPair(k, 1) };
}

/** Send one frame; returns what would travel. */
async function emit(side, text) {
  const { seq, key } = await side.out.send();
  return { seq, ct: await seal(key, nonceFor(0, seq), te.encode(text), AAD) };
}

/** Deliver one; returns the text, or null if the receiver refused or could not open it. */
async function deliver(side, frame) {
  const step = await side.in.receive(frame.seq);
  if (!step) return null;
  try {
    const pt = await open(step.key, nonceFor(0, frame.seq), frame.ct, AAD);
    step.commit();
    return td.decode(pt);
  } catch {
    return null;
  }
}

/* ── the gap that cannot be closed ────────────────────────────────────────── */

test('a sender that runs past the window leaves the two chains unable to meet', async () => {
  /*
   * Stated as a property rather than a bug, because it is inherent: the receiver cannot walk
   * more than MAX_SKIP steps on an unproven claim, so a gap wider than the window is not
   * recoverable by the ratchet itself. What must never happen is the sender opening one,
   * which is what the next test covers.
   */
  const { a, b } = await pair();
  for (let i = 0; i < MAX_SKIP + 1; i++) await a.out.send();
  const frame = await emit(a, 'after the gap');
  assert.equal(await deliver(b, frame), null, 'a gap past the window is somehow recoverable');
});

test('a gap inside the window closes, however it was made', async () => {
  for (const lost of [1, 2, 63, 255, MAX_SKIP - 2]) {
    const { a, b } = await pair();
    for (let i = 0; i < lost; i++) await a.out.send();
    const frame = await emit(a, `after ${lost} lost`);
    assert.equal(await deliver(b, frame), `after ${lost} lost`, `${lost} lost frames broke it`);
  }
});

test('the engine never mints a key for a frame the link cannot carry', () => {
  /*
   * The protection for the property above, asserted where it lives. The chain steps inside
   * `_sendCtl`, so the check that the transport can carry the frame has to come first; after
   * it, the key is spent whatever happens next.
   */
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core', 'transfer.js'),
    'utf8',
  );
  const body = src.slice(src.indexOf('_sendCtl(obj'), src.indexOf('this._ctlOut = done'));
  const guard = body.indexOf('canSendCtl');
  const mint = body.indexOf('ctl.out.send()');
  assert.ok(guard > 0, 'nothing asks the transport whether it can carry the frame');
  assert.ok(mint > 0, 'the chain no longer steps here; check this test');
  assert.ok(guard < mint, 'the key is minted before the link is checked');
});

test('both transports can say whether a control frame would go', async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core');
  for (const f of ['transport.js', 'relay-transport.js']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(src, /canSendCtl\(\)\s*\{/, `${f} cannot be asked`);
  }
});

/* ── adversarial delivery orders ──────────────────────────────────────────── */

test('every permutation of a small batch arrives intact', async () => {
  // Exhaustive rather than sampled: five frames is 120 orders, and an off-by-one in the
  // skipped store shows up in exactly one of them.
  const order = [0, 1, 2, 3, 4];
  const perms = [];
  (function permute(rest, acc) {
    if (!rest.length) return perms.push(acc);
    rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
  })(order, []);
  assert.equal(perms.length, 120);

  for (const perm of perms) {
    const { a, b } = await pair();
    const frames = [];
    for (let i = 0; i < 5; i++) frames.push(await emit(a, `m${i}`));
    for (const i of perm) {
      assert.equal(await deliver(b, frames[i]), `m${i}`, `order ${perm.join('')} lost frame ${i}`);
    }
  }
});

test('a long run of random loss and reordering never desynchronises', async () => {
  /*
   * Pseudo-random with a fixed seed, so a failure is reproducible rather than a story about
   * one unlucky run. Losses are kept inside the window because outside it is the property
   * asserted at the top of this file.
   */
  let state = 0x2f6fd0;
  const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  const { a, b } = await pair();
  const held = [];
  let sent = 0;
  let got = 0;

  for (let round = 0; round < 400; round++) {
    // Write a few, hold them back, then deliver a shuffled subset of what is waiting.
    const burst = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < burst; i++) held.push(await emit(a, `m${sent++}`));

    const take = Math.floor(rnd() * held.length);
    for (let i = 0; i < take; i++) {
      const at = Math.floor(rnd() * held.length);
      const [frame] = held.splice(at, 1);
      const text = await deliver(b, frame);
      // A frame may legitimately be refused only if it fell behind a committed window.
      if (text !== null) got++;
    }
    // The store is the thing that could grow without anyone noticing.
    assert.ok(b.in.skipped.size <= MAX_SKIP, `skipped store reached ${b.in.skipped.size}`);
  }

  assert.ok(got > 200, `only ${got} of ${sent} frames were readable; the chains drifted`);
});

/* ── what an attacker can make the store do ───────────────────────────────── */

test('an unproven claim cannot grow the skipped store at all', async () => {
  /*
   * The store holds keys for frames that were stepped over, and an attacker who could fill it
   * would be spending the defender's memory for free. Nothing is banked until a frame has
   * decrypted, so a stream of invented sequence numbers costs one derivation and keeps nothing.
   */
  const { b } = await pair();
  // Enough to prove the property; each one walks the chain, so the count is kept sane.
  for (let i = 1; i <= 120; i++) {
    const step = await b.in.receive(i);
    if (step) {
      /* a key is offered, and deliberately never committed */
    }
  }
  assert.equal(b.in.skipped.size, 0, 'invented sequences were banked');
  assert.equal(b.in.index, 0, 'invented sequences moved the chain');
});

test('repeated near-window jumps keep the store bounded', async () => {
  // The honest version of the same shape: a real sender whose frames keep being lost in
  // large-but-legal batches. Each accepted jump banks the keys it stepped over.
  const { a, b } = await pair();
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < MAX_SKIP - 1; i++) await a.out.send();
    const frame = await emit(a, `round ${round}`);
    assert.equal(await deliver(b, frame), `round ${round}`, `round ${round} was refused`);
    assert.ok(b.in.skipped.size <= MAX_SKIP, `store reached ${b.in.skipped.size}`);
  }
});

test('a banked key opens its frame once and is then gone', async () => {
  const { a, b } = await pair();
  const first = await emit(a, 'early');
  const second = await emit(a, 'late');

  assert.equal(await deliver(b, second), 'late', 'the later frame did not arrive');
  assert.ok(b.in.skipped.has(first.seq), 'the skipped key was not banked');
  assert.equal(await deliver(b, first), 'early', 'the banked key did not open its frame');
  assert.equal(b.in.skipped.has(first.seq), false, 'the used key is still banked');
  assert.equal(await deliver(b, first), null, 'the frame replayed');
});

test('destroying a chain empties the store as well as the chain', async () => {
  const { a, b } = await pair();
  await emit(a, 'one');
  const third = await emit(a, 'three');
  await deliver(b, third);
  assert.ok(b.in.skipped.size > 0, 'nothing was banked to destroy');

  b.in.destroy();
  assert.equal(b.in.skipped.size, 0);
  assert.deepEqual(Array.from(b.in.next), new Array(32).fill(0));
});

/* ── the shape of the window itself ───────────────────────────────────────── */

test('the window is large enough to be useful and small enough to be cheap', () => {
  // 512 keys of 32 bytes is 16 KiB at worst, per direction, per session.
  assert.ok(MAX_SKIP >= 256, `MAX_SKIP of ${MAX_SKIP} is too tight for a lossy link`);
  assert.ok(MAX_SKIP * 32 <= 64 * 1024, `MAX_SKIP of ${MAX_SKIP} costs too much memory`);
});

test('a chain seized mid-stream still cannot read what the store already released', async () => {
  // Forward secrecy, restated against the store rather than against the chain: a committed
  // key is zeroed, so it is not sitting in the map waiting to be found.
  const { a, b } = await pair();
  const early = await emit(a, 'the early one');
  const later = await emit(a, 'the later one');
  await deliver(b, later);
  await deliver(b, early);

  const seized = new Ratchet(b.in.next);
  seized.index = b.in.index;
  for (const frame of [early, later]) {
    const step = await seized.receive(frame.seq);
    if (!step) continue;
    await assert.rejects(
      () => open(step.key, nonceFor(0, frame.seq), frame.ct, AAD),
      `a seized chain read frame ${frame.seq} back`,
    );
  }
});

test('a transport that cannot be asked is given the benefit of the doubt', async () => {
  /*
   * Found live rather than by reading: `canSendCtl?.()` on a transport without the method is
   * undefined, which fails the check, and every control frame then throws. A page running two
   * builds at once, one module from the cache and one from the network, hits that, and a skew
   * that should resolve on the next reload instead connects and carries nothing.
   *
   * A transport that answers is believed either way; one that has no opinion is not treated as
   * a refusal, and its own `sendCtl` still reports what happened.
   */
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core', 'transfer.js'),
    'utf8',
  );
  // Comments stripped first: the one explaining this quotes the very form it forbids.
  const body = src
    .slice(src.indexOf('_sendCtl(obj'), src.indexOf('this._ctlOut = done'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(
    !/canSendCtl\?\.\(\)/.test(body),
    'a missing canSendCtl is being read as a refusal to send',
  );
  assert.match(body, /typeof ask === 'function'/, 'the transport is no longer asked explicitly');
});
