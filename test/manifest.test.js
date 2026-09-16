/**
 * What an offer is allowed to claim.
 *
 * The channel a manifest arrives on is authenticated, so it genuinely came from the peer.
 * That is all it proves. Everything else in the offer, meaning how many files, how big and
 * what they are called, is a statement by a device that may be hostile, and for a
 * while it was believed. These pin the refusals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkManifest } from '../web/core/transfer.js';

/** Shaped exactly the way `offer()` builds it, so drift between the two shows up here. */
function realOffer(files = [{ id: 0, name: 'a.jpg', path: 'a.jpg', size: 1024, mime: 'image/jpeg' }]) {
  return { t: 'manifest', transferId: 'a1b2c3d4e5f60718', total: 1024, files };
}

test('an ordinary offer is accepted', () => {
  const ok = checkManifest(realOffer(), new Map());
  assert.ok(ok, 'the real sender must keep working; this is the check that catches drift');
  assert.equal(ok.files.length, 1);
  assert.equal(ok.total, 1024);
});

test('a multi-file offer keeps its order and sums its own sizes', () => {
  const files = [
    { id: 0, name: 'a', path: 'a', size: 10, mime: 'x' },
    { id: 1, name: 'b', path: 'b', size: 25, mime: 'x' },
  ];
  const ok = checkManifest({ ...realOffer(files), total: 999999 }, new Map());
  assert.equal(ok.total, 35, 'the stated total is recomputed, not believed');
  assert.deepEqual(
    ok.files.map((f) => f.name),
    ['a', 'b'],
  );
});

test('a size that is not a real number of bytes is refused', () => {
  // This is the one that mattered: an infinite size made the per-file chunk ceiling
  // infinite, and the bound that stops a peer writing past the end of a file stopped
  // bounding anything.
  for (const size of [Infinity, -Infinity, NaN, -1, 1.5, '1024', null, undefined, 2 ** 53]) {
    const m = realOffer([{ id: 0, name: 'a', path: 'a', size, mime: 'x' }]);
    assert.equal(checkManifest(m, new Map()), null, `size ${String(size)} must be refused`);
  }
});

test('sizes that only overflow when added up are refused too', () => {
  const big = Number.MAX_SAFE_INTEGER - 1;
  const m = realOffer([
    { id: 0, name: 'a', path: 'a', size: big, mime: 'x' },
    { id: 1, name: 'b', path: 'b', size: big, mime: 'x' },
  ]);
  assert.equal(checkManifest(m, new Map()), null, 'a total past 2^53 is not a total');
});

test('a list long enough to freeze the tab is refused', () => {
  const many = Array.from({ length: 4097 }, (_, i) => ({ id: i, name: `f${i}`, path: `f${i}`, size: 1, mime: 'x' }));
  assert.equal(checkManifest(realOffer(many), new Map()), null);
  // And the boundary itself is allowed, so the limit is a limit and not an off-by-one.
  assert.ok(checkManifest(realOffer(many.slice(0, 4096)), new Map()));
});

test('an empty offer is not an offer', () => {
  assert.equal(checkManifest(realOffer([]), new Map()), null);
  assert.equal(checkManifest({ ...realOffer(), files: 'a.jpg' }, new Map()), null);
  assert.equal(checkManifest({ ...realOffer(), files: null }, new Map()), null);
});

test('two files cannot share an id', () => {
  const m = realOffer([
    { id: 0, name: 'a', path: 'a', size: 1, mime: 'x' },
    { id: 0, name: 'b', path: 'b', size: 1, mime: 'x' },
  ]);
  // Duplicates would have the second file's sink replace the first's in the map, leaving
  // an open sink nothing ever closes and bytes going to the wrong file.
  assert.equal(checkManifest(m, new Map()), null);
});

test('a file id outside the range the wire header can carry is refused', () => {
  for (const id of [-1, 4096, 1.5, '0', null, 2 ** 32]) {
    const m = realOffer([{ id, name: 'a', path: 'a', size: 1, mime: 'x' }]);
    assert.equal(checkManifest(m, new Map()), null, `id ${String(id)} must be refused`);
  }
});

test('a name has to be a name', () => {
  for (const name of ['', 'x'.repeat(1025), null, 42, {}]) {
    const m = realOffer([{ id: 0, name, path: name, size: 1, mime: 'x' }]);
    assert.equal(checkManifest(m, new Map()), null, `name ${String(name)} must be refused`);
  }
});

test('a transfer id has to be a short, plain identifier', () => {
  for (const id of ['', 'x'.repeat(65), '../../etc', '__proto__', 42, null, 'a b']) {
    assert.equal(checkManifest({ ...realOffer(), transferId: id }, new Map()), null, String(id));
  }
});

test('an offer cannot replace one already in flight', () => {
  const live = new Map([['a1b2c3d4e5f60718', { state: 'receiving' }]]);
  assert.equal(checkManifest(realOffer(), live), null, 'reusing a live id must not reset it');
});

test('a peer cannot queue up unlimited pending decisions', () => {
  const live = new Map(Array.from({ length: 32 }, (_, i) => [`live${i}`, {}]));
  assert.equal(checkManifest(realOffer(), live), null);
});

test('garbage is refused rather than thrown on', () => {
  for (const m of [null, undefined, 'manifest', 42, []]) {
    assert.doesNotThrow(() => checkManifest(m, new Map()));
    assert.equal(checkManifest(m, new Map()), null);
  }
});

/* ------------------------------------------- the channel surviving a failure */

/**
 * Control frames are serialised so their sequence numbers match their order on the wire.
 * The mechanism is a promise chain, and a chain has a failure mode: once a link rejects,
 * every `.then` after it short-circuits and the work never runs again.
 *
 * That is what happened here. One send that threw, from an oversized frame or a channel
 * that closed mid-write, left the tail rejected, and from then on no manifest, acceptance, ack
 * or message was ever sent again. Nothing reported an error, because the sends were not
 * failing; they were not happening. Any peer able to provoke one failure could end the
 * conversation for good.
 */
test('one failed control send does not end the conversation', async () => {
  // The chain as it is written, reduced to the part that matters.
  const chain = { tail: null, ran: 0 };
  const send = (shouldThrow) => {
    const done = (chain.tail || Promise.resolve()).then(() => {
      chain.ran++;
      if (shouldThrow) throw new Error('message too large');
    });
    chain.tail = done.catch(() => {});
    return done;
  };

  await assert.rejects(() => send(true), /too large/, 'the caller still sees the failure');
  await send(false);
  await send(false);
  assert.equal(chain.ran, 3, 'and the sends after it still ran');
});

test('sends stay in order across a failure', async () => {
  const order = [];
  let tail = null;
  const send = (n, bad) => {
    const done = (tail || Promise.resolve()).then(async () => {
      await Promise.resolve();
      order.push(n);
      if (bad) throw new Error('nope');
    });
    tail = done.catch(() => {});
    return done;
  };
  const all = [send(1), send(2, true), send(3), send(4)];
  await Promise.allSettled(all);
  assert.deepEqual(order, [1, 2, 3, 4], 'ordering is the reason the chain exists at all');
});
