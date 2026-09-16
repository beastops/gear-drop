/**
 * What the *receiver* is allowed to tell the sender.
 *
 * Most of the checking in this codebase guards the receiving side, because that is where
 * files land. The other direction was taken on trust: a receiver acknowledges progress and
 * asks to rewind, and those messages carry a file id and a byte offset that were used
 * without being looked at.
 *
 * A file id was used straight as an array index. `job.entries["__proto__"]` is not a file,
 * it is Array.prototype, and the assignment that followed wrote a property onto it that
 * every array in the page then carried. The offsets were unchecked as well, so a single
 * NaN stopped a transfer from ever completing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TransferManager } from '../web/core/transfer.js';

function manager() {
  const transport = new EventTarget();
  transport.chunkSize = 65536;
  transport.ctl = { readyState: 'open' };
  transport.sendCtl = () => true;
  transport.lanes = [{ idx: 0, ready: true }];

  const session = new EventTarget();
  session.lane = 0;
  session.generation = 1;
  session.K = new Uint8Array(32).fill(1);
  session.transferKey = async () => null;

  const m = new TransferManager({ transport, session });
  // These tests drive the message handlers, not the send loop. Without this the loop runs
  // on fixtures that have no file behind them and throws after the test has finished.
  m._pump = async () => {};
  m._sendCtl = async () => {};
  m.out.set('t1', {
    transferId: 't1',
    state: 'sending',
    sent: 0,
    entries: [
      { id: 0, name: 'a.bin', size: 1000, offset: 0, acked: 0, hashes: [] },
      { id: 1, name: 'b.bin', size: 2000, offset: 0, acked: 0, hashes: [] },
    ],
  });
  return m;
}

test('a file id of "__proto__" cannot write onto every array in the page', () => {
  const m = manager();
  assert.equal([].acked, undefined, 'clean to begin with');

  for (const fileId of ['__proto__', 'constructor', 'prototype', 'length']) {
    m._onAck({ transferId: 't1', fileId, upto: 999 });
    m._onResume({ transferId: 't1', fileId, from: 999 });
  }

  assert.equal([].acked, undefined, 'Array.prototype.acked was never written');
  assert.equal([].offset, undefined, 'nor offset');
  assert.equal(Object.getPrototypeOf([]), Array.prototype);
});

test('a file id outside the transfer is ignored', () => {
  const m = manager();
  const job = m.out.get('t1');
  for (const fileId of [-1, 2, 99, 1.5, '0', null, undefined, {}]) {
    m._onAck({ transferId: 't1', fileId, upto: 500 });
  }
  assert.equal(job.entries[0].acked, 0, 'nothing moved');
  assert.equal(job.entries[1].acked, 0);
});

test('an acknowledgement cannot exceed the file it acknowledges', () => {
  const m = manager();
  const job = m.out.get('t1');
  m._onAck({ transferId: 't1', fileId: 0, upto: 10 ** 12 });
  assert.equal(job.entries[0].acked, 1000, 'clamped to the size we are actually sending');

  m._onAck({ transferId: 't1', fileId: 0, upto: -5 });
  assert.equal(job.entries[0].acked, 1000, 'and never goes backwards');
});

test('a nonsense acknowledgement cannot poison the offset', () => {
  const m = manager();
  const job = m.out.get('t1');
  for (const upto of [NaN, Infinity, -Infinity, '500', null, undefined, {}]) {
    m._onAck({ transferId: 't1', fileId: 0, upto });
  }
  assert.equal(job.entries[0].acked, 0);
  assert.ok(Number.isFinite(job.entries[0].acked), 'still a number a send loop can use');
});

test('a resume request lands inside the file or not at all', () => {
  const m = manager();
  const job = m.out.get('t1');

  m._onResume({ transferId: 't1', fileId: 1, from: 500 });
  assert.equal(job.entries[1].offset, 500, 'an ordinary rewind works');

  m._onResume({ transferId: 't1', fileId: 1, from: 10 ** 12 });
  assert.equal(job.entries[1].offset, 2000, 'past the end is the end');

  m._onResume({ transferId: 't1', fileId: 1, from: -1000 });
  assert.equal(job.entries[1].offset, 0, 'before the start is the start');

  const before = job.entries[1].offset;
  m._onResume({ transferId: 't1', fileId: 1, from: NaN });
  assert.equal(job.entries[1].offset, before, 'and NaN changes nothing');
});

test('an acceptance cannot rewrite where we read from', async () => {
  const m = manager();
  const job = m.out.get('t1');
  job.state = 'offered';

  await m._onAccept({ transferId: 't1', files: [0, 1], have: { 0: 10 ** 12, 1: -99 } });
  assert.equal(job.entries[0].offset, 1000, 'clamped to the file');
  assert.equal(job.entries[1].offset, 0);
});

test('an acceptance naming things that are not file ids is harmless', async () => {
  const m = manager();
  const job = m.out.get('t1');
  job.state = 'offered';

  await m._onAccept({ transferId: 't1', files: 'everything', have: 'all of it' });
  assert.ok(job.accepted instanceof Set);
  assert.equal(job.accepted.size, 0, 'a string is not a list of ids');
  assert.equal(job.entries[0].offset, 0);
});
