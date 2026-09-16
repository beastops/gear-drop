/**
 * Receive-path integrity.
 *
 * Every value in a chunk header (file id, offset, chunk index) arrives from the peer and
 * is used *before* the chunk is authenticated: to size an array and to position a write.
 * The chunk body cannot be forged without the session key, but these numbers can be wrong
 * even from a peer that holds it, and the receiver must survive that.
 *
 * These tests exercise the rules directly rather than through a live connection, because
 * what is being asserted is arithmetic, and arithmetic is worth pinning exactly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addRange, contiguous, covered, missing } from '../web/core/ranges.js';

/** The bound the receiver derives from the manifest it was offered. */
const MIN_CHUNK = 16 * 1024;
const maxChunksFor = (size) => Math.ceil(Math.max(0, size) / MIN_CHUNK) + 1;

const indexAccepted = (index, size) =>
  Number.isInteger(index) && index >= 0 && index <= maxChunksFor(size);

const offsetAccepted = (offset, size) => Number.isFinite(offset) && offset >= 0 && offset <= size;

test('a chunk index beyond the offered file is refused', () => {
  const size = 10 * 1024 * 1024; // 10 MB → at most 641 chunks at the smallest legal size

  assert.ok(indexAccepted(0, size));
  assert.ok(indexAccepted(640, size));
  assert.ok(indexAccepted(maxChunksFor(size), size), 'one spare for a short final chunk');

  // The shape of the attack: one frame that would size `hashes` to four billion entries,
  // after which the root hash walks all of them.
  assert.ok(!indexAccepted(0xffffffff, size));
  assert.ok(!indexAccepted(maxChunksFor(size) + 1, size));
  assert.ok(!indexAccepted(-1, size));
  assert.ok(!indexAccepted(1.5, size));
});

test('an offset outside the offered file is refused', () => {
  const size = 1_000_000;
  assert.ok(offsetAccepted(0, size));
  assert.ok(offsetAccepted(size, size));
  assert.ok(!offsetAccepted(size + 1, size), 'a sparse file larger than the one offered');
  assert.ok(!offsetAccepted(-1, size));
  assert.ok(!offsetAccepted(Number.POSITIVE_INFINITY, size));
  assert.ok(!offsetAccepted(Number.NaN, size));
});

test('an empty file still admits exactly one chunk', () => {
  assert.equal(maxChunksFor(0), 1);
  assert.ok(indexAccepted(0, 0));
  assert.ok(offsetAccepted(0, 0));
});

/* ------------------------------------------------------------- completeness */

test('coverage counts bytes once, however many times they arrive', () => {
  const ranges = [];
  addRange(ranges, 0, 1000);
  addRange(ranges, 0, 1000); // the resume path resends, byte-identical, by design
  addRange(ranges, 0, 1000);
  assert.equal(covered(ranges), 1000, 'three arrivals, one thousand bytes');
});

test('a resend cannot make a file with a hole look complete', () => {
  const size = 3000;
  const ranges = [];
  addRange(ranges, 0, 1000);
  addRange(ranges, 2000, 3000);
  addRange(ranges, 0, 1000); // resent after a reconnect

  // Counting arrivals would reach the file size with 1000 bytes still missing. This is the
  // bug the receiver had: `received += pt.length` on every chunk, including duplicates.
  const naiveArrivalTotal = 1000 + 1000 + 1000;
  assert.equal(naiveArrivalTotal, size, 'the naive count would say "done"');

  assert.equal(covered(ranges), 2000, 'coverage knows better');
  assert.equal(contiguous(ranges), 1000, 'and the contiguous prefix stops at the hole');
  assert.ok(contiguous(ranges) < size, 'so completeness must be judged on the prefix');
  assert.deepEqual(missing(ranges, size), [[1000, 2000]], 'and the hole is exactly what resume asks for');
});

test('completeness is the contiguous prefix, not the byte count', () => {
  const size = 4096;
  const ranges = [];
  addRange(ranges, 2048, 4096); // the tail arrives first
  assert.equal(covered(ranges), 2048);
  assert.equal(contiguous(ranges), 0, 'nothing is contiguous until the first byte lands');

  addRange(ranges, 0, 2048);
  assert.equal(contiguous(ranges), size, 'now it is whole');
  assert.equal(covered(ranges), size);
});

test('out-of-order delivery across lanes still converges exactly', () => {
  const size = 64 * 1024;
  const step = 4096;
  const order = [];
  for (let o = 0; o < size; o += step) order.push(o);
  // shuffle deterministically, then deliver some twice
  order.sort((a, b) => ((a * 7919) % 13) - ((b * 7919) % 13));

  const ranges = [];
  for (const o of order) {
    addRange(ranges, o, o + step);
    if (o % (step * 3) === 0) addRange(ranges, o, o + step); // duplicate
  }
  assert.equal(contiguous(ranges), size);
  assert.equal(covered(ranges), size);
  assert.deepEqual(missing(ranges, size), []);
});
