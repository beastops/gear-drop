/** Protocol-level invariants: resume bookkeeping, replay resistance, QR encoding. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addRange, contiguous, covered, missing } from '../web/core/ranges.js';
import { ReplayWindow } from '../web/core/session.js';
import { encodeQR } from '../web/core/qr.js';

/* ------------------------------------------------------------------ ranges */

test('ranges: adjacent pieces coalesce', () => {
  const r = [];
  addRange(r, 0, 10);
  addRange(r, 20, 30);
  addRange(r, 10, 20);
  assert.deepEqual(r, [[0, 30]]);
});

test('ranges: out-of-order arrival still merges', () => {
  const r = [];
  addRange(r, 100, 200);
  addRange(r, 0, 50);
  addRange(r, 50, 100);
  assert.deepEqual(r, [[0, 200]]);
});

test('ranges: overlaps are absorbed, duplicates are harmless', () => {
  const r = [];
  addRange(r, 0, 10);
  addRange(r, 5, 15);
  addRange(r, 5, 15);
  assert.deepEqual(r, [[0, 15]]);
});

test('ranges: a gap is preserved, and blocks the contiguous prefix', () => {
  const r = [];
  addRange(r, 30, 40);
  addRange(r, 0, 10);
  assert.deepEqual(r, [
    [0, 10],
    [30, 40],
  ]);
  assert.equal(contiguous(r), 10, 'only the prefix is safe to acknowledge');
  assert.equal(covered(r), 20);
});

test('ranges: contiguous is zero until the first byte arrives', () => {
  const r = [];
  addRange(r, 10, 20);
  assert.equal(contiguous(r), 0);
  addRange(r, 0, 10);
  assert.equal(contiguous(r), 20);
});

test('ranges: missing() reports exactly what a resume must request', () => {
  const r = [];
  addRange(r, 0, 10);
  addRange(r, 30, 40);
  assert.deepEqual(missing(r, 100), [
    [10, 30],
    [40, 100],
  ]);
  assert.deepEqual(missing([[0, 100]], 100), []);
  assert.deepEqual(missing([], 50), [[0, 50]]);
});

test('ranges: an empty or inverted range is ignored', () => {
  const r = [];
  addRange(r, 5, 5);
  addRange(r, 10, 4);
  assert.deepEqual(r, []);
});

test('ranges: a thousand shuffled chunks reassemble into one range', () => {
  const chunk = 4096;
  const count = 1000;
  const order = Array.from({ length: count }, (_, i) => i);
  // Deterministic shuffle, so a failure is reproducible.
  let seed = 12345;
  for (let i = count - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const r = [];
  for (const i of order) addRange(r, i * chunk, (i + 1) * chunk);
  assert.deepEqual(r, [[0, count * chunk]]);
  assert.equal(contiguous(r), count * chunk);
});

/* ----------------------------------------------------------- replay window */

test('replay window: accepts in order, refuses an exact replay', () => {
  const w = new ReplayWindow(8);
  assert.ok(w.accept(0));
  assert.ok(w.accept(1));
  assert.ok(!w.accept(1), 'a replay must be refused');
  assert.ok(w.accept(2));
});

test('replay window: accepts out-of-order arrivals inside the window', () => {
  const w = new ReplayWindow(8);
  assert.ok(w.accept(5));
  assert.ok(w.accept(3), 'an ICE candidate that merely overtook another is still valid');
  assert.ok(w.accept(4));
  assert.ok(!w.accept(3), 'but only once');
});

test('replay window: refuses anything older than the window', () => {
  const w = new ReplayWindow(4);
  assert.ok(w.accept(100));
  assert.ok(!w.accept(10), 'too old to judge, so refuse');
  assert.ok(w.accept(98));
});

test('replay window: rejects nonsense counters', () => {
  const w = new ReplayWindow();
  assert.ok(!w.accept(-1));
  assert.ok(!w.accept(1.5));
  assert.ok(!w.accept(NaN));
  assert.ok(!w.accept('3'));
});

test('replay window: memory stays bounded over a long run', () => {
  const w = new ReplayWindow(64);
  for (let i = 0; i < 10000; i++) w.accept(i);
  assert.ok(w.seen.size <= 128, `expected a bounded set, saw ${w.seen.size}`);
});

/* -------------------------------------------------------------------- QR */

test('qr: encodes a pairing URL and reports a valid module count', () => {
  const qr = encodeQR('https://geardrop.example/#ABC234');
  assert.ok(qr, 'a pairing URL must fit');
  assert.ok([21, 25, 29, 33, 37].includes(qr.size), `unexpected size ${qr.size}`);
});

test('qr: the three finder patterns are present and well formed', () => {
  const qr = encodeQR('https://geardrop.example/#ABC234');
  const n = qr.size;
  const corners = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  for (const [r0, c0] of corners) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        const expected = ring || core ? 1 : 0;
        assert.equal(qr.get(r0 + dr, c0 + dc), expected, `finder at ${r0},${c0} broken`);
      }
    }
  }
});

test('qr: the timing patterns alternate', () => {
  const qr = encodeQR('hello');
  for (let i = 8; i < qr.size - 8; i++) {
    assert.equal(qr.get(6, i), i % 2 === 0 ? 1 : 0);
    assert.equal(qr.get(i, 6), i % 2 === 0 ? 1 : 0);
  }
});

test('qr: the always-dark module is set', () => {
  const qr = encodeQR('hello');
  assert.equal(qr.get(qr.size - 8, 8), 1);
});

test('qr: grows with the payload and gives up past its largest version', () => {
  const small = encodeQR('a');
  const large = encodeQR('x'.repeat(100));
  assert.ok(large.size > small.size);
  assert.equal(encodeQR('x'.repeat(200)), null, 'too long is null, not a broken code');
});

test('qr: a finished symbol reads back to the exact text that went in', async () => {
  const { readBackText, readBack } = await import('../web/core/qr.js');
  for (const text of ['a', 'https://geardrop.example/#ABC234', 'x'.repeat(50), 'Gear Drop 0123456789']) {
    const qr = encodeQR(text);
    assert.ok(qr, `${text} should fit`);
    const info = readBack(qr);
    assert.equal(info.ecLevel, 0b01, 'error correction level L');
    assert.ok(info.maskIndex >= 0 && info.maskIndex <= 7, 'a valid mask is recorded');
    assert.equal(readBackText(qr), text, 'placement, masking and format must agree');
  }
});

test('qr: both copies of the format information agree', async () => {
  const { readBack } = await import('../web/core/qr.js');
  const qr = encodeQR('https://geardrop.example/#ABC234');
  const n = qr.size;

  const first = [];
  for (let i = 0; i <= 5; i++) first.push(qr.get(8, i));
  first.push(qr.get(8, 7), qr.get(8, 8), qr.get(7, 8));
  for (let i = 9; i <= 14; i++) first.push(qr.get(14 - i, 8));

  const second = [];
  for (let i = 0; i <= 6; i++) second.push(qr.get(n - 1 - i, 8));
  for (let i = 7; i <= 14; i++) second.push(qr.get(8, n - 15 + i));

  assert.deepEqual(first, second, 'a scanner may read either copy');
  assert.ok(readBack(qr).maskIndex >= 0);
});

test('session generation: both peers derive the same tag from the same key, and it changes on re-key', async () => {
  const { cpaceStart, cpaceFinish } = await import('../web/core/gdcrypto.js');
  const tag = new Uint8Array(16).fill(3);
  const gen = (K) => ((K[0] << 24) | (K[1] << 16) | (K[2] << 8) | K[3]) >>> 0;

  const a = cpaceStart('ABC234', tag);
  const b = cpaceStart('ABC234', tag);
  const ka = await cpaceFinish(a.state, b.msg);
  const kb = await cpaceFinish(b.state, a.msg);
  assert.equal(gen(ka), gen(kb), 'peers must agree without exchanging the generation');

  // A fresh exchange with the same code is a different connection.
  const c = cpaceStart('ABC234', tag);
  const d = cpaceStart('ABC234', tag);
  const kc = await cpaceFinish(c.state, d.msg);
  assert.notEqual(gen(ka), gen(kc), 'a re-key must produce a different generation');
});
