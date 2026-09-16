/**
 * The transfer engine, fed by a peer that is not behaving.
 *
 * Everything here arrives from the other device and drives a write to disk: an offset, a
 * chunk index, a file id, an acknowledged position, a resume point. The audit flagged this
 * as "bounds are checked; whether they are checked *everywhere* is the question", which is
 * not a question reading answers: every path has to be walked with hostile numbers in it.
 *
 * The peer here is authenticated. Pairing means deciding somebody may send
 * you files, not that they may size your allocations or position your writes. What must hold
 * even then is that nothing lands outside the file that was offered and accepted, nothing
 * grows without a bound, and no frame takes the engine down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { TransferManager } = await import('../web/core/transfer.js');
const { aeadKey, hkdf, seal } = await import('../web/core/gdcrypto.js');
const { te, concat } = await import('../web/core/bytes.js');

const VER = 1;
const HDR = 18;
const SIZE = 64 * 1024; // the file the receiver will be told about

/** A transport that records what it is asked to send and delivers what we hand it. */
function fakeTransport() {
  const t = new EventTarget();
  t.kind = 'test';
  t.chunkSize = 16 * 1024;
  t.ctl = { readyState: 'open' };
  t.lanes = [{ idx: 0, ready: true, bulk: null, sent: 0 }];
  t.readyLanes = 1;
  t.sent = [];
  t.canSendCtl = () => true;
  t.sendCtl = (bytes) => {
    t.sent.push(bytes);
    return true;
  };
  t.sendChunk = () => true;
  t.send = () => true;
  t.close = () => {};
  t.attachTransport = () => {};
  return t;
}

/** Just enough session for the engine: a key to derive from, and a lane. */
async function fakeSession() {
  const K = webcrypto.getRandomValues(new Uint8Array(32));
  const s = new EventTarget();
  s.K = K;
  s.lane = 0;
  s.peerLane = 1;
  s.established = true;
  s.transportLive = true;
  s.send = async () => {};
  s.transferKey = async (transferId) =>
    aeadKey(await hkdf(K, concat(te.encode('gd/xfer/v1'), te.encode(transferId)), 32));
  return s;
}

/** A sink that refuses to be written outside the file it was told about. */
function watchfulSink(size) {
  const writes = [];
  return {
    writes,
    size,
    async write(offset, bytes) {
      assert.ok(Number.isInteger(offset) && offset >= 0, `write at a bad offset: ${offset}`);
      assert.ok(offset + bytes.length <= size, `write of ${bytes.length} at ${offset} runs past ${size}`);
      writes.push([offset, bytes.length]);
    },
    async close() {
      return { kind: 'memory', name: 'x', file: new Blob([]) };
    },
    async abort() {},
  };
}

/** A manager already receiving one file, with hostile frames ready to be injected. */
async function receiving() {
  const transport = fakeTransport();
  const session = await fakeSession();
  const tm = new TransferManager({ transport, session });
  const errors = [];
  tm.addEventListener('error', (e) => errors.push(e.detail?.message || String(e.detail)));

  const transferId = 'tttttttttttt';
  const sink = watchfulSink(SIZE);
  const entry = {
    id: 0,
    name: 'a.bin',
    path: 'a.bin',
    size: SIZE,
    mime: 'application/octet-stream',
    received: 0,
    contiguous: 0,
    hashes: [],
    lastAck: 0,
    ranges: [],
    maxChunks: Math.ceil(SIZE / (16 * 1024)) + 1,
  };
  entry.complete = new Promise((resolve) => {
    entry.resolveComplete = resolve;
  });

  const job = {
    transferId,
    state: 'receiving',
    files: [{ id: 0, name: 'a.bin', size: SIZE }],
    entries: new Map([[0, entry]]),
    sinks: new Map([[0, sink]]),
    key: await session.transferKey(transferId),
    chain: Promise.resolve(),
    received: 0,
    total: SIZE,
  };
  tm.in.set(transferId, job);
  return { tm, job, entry, sink, errors, transferId, transport };
}

/** A chunk frame with whatever header values we like. */
function chunkFrame({ fileId, offset, index, payload }) {
  const head = new Uint8Array(HDR);
  head[0] = VER;
  head[1] = 0;
  const view = new DataView(head.buffer);
  view.setUint32(2, fileId >>> 0, true);
  view.setBigUint64(6, BigInt(offset), true);
  view.setUint32(14, index >>> 0, true);
  const out = new Uint8Array(HDR + payload.length);
  out.set(head, 0);
  out.set(payload, HDR);
  return out;
}

/* ── positions that must never reach a sink ───────────────────────────────── */

test('no chunk header lands a write outside the file that was accepted', async () => {
  const { tm, entry, sink, job } = await receiving();

  // Sealed properly, so the only hostile thing is where the header says to put it.
  const body = new Uint8Array(1024).fill(7);
  const hostile = [
    { offset: SIZE, index: 0 },
    { offset: SIZE - 1, index: 0 },
    { offset: SIZE + 1, index: 0 },
    { offset: 2 ** 53 - 1, index: 0 },
    { offset: 2 ** 63, index: 0 },
    { offset: 0, index: 0xffffffff },
    { offset: 0, index: entry.maxChunks + 1 },
    { offset: SIZE - 8, index: 1 },
  ];

  for (const h of hostile) {
    const { chunkNonce, aadFor } = await nonceHelpers();
    let ct;
    try {
      ct = await seal(job.key, chunkNonce(0, h.index), body, aadFor(0, h.offset));
    } catch {
      continue; // an index too large to encode is itself a refusal
    }
    tm._onChunk({ data: chunkFrame({ fileId: 0, offset: h.offset, index: h.index, payload: ct }) });
  }
  await job.chain;

  // The watchful sink asserts on every write; reaching here means none were out of bounds.
  for (const [offset, len] of sink.writes) {
    assert.ok(offset + len <= SIZE, `a write ran past the file: ${offset}+${len}`);
  }
  assert.ok(entry.hashes.length <= entry.maxChunks + 1, `hashes grew to ${entry.hashes.length}`);
});

test('a chunk index cannot be used to grow an array without bound', async () => {
  const { tm, entry, job } = await receiving();
  const { chunkNonce, aadFor } = await nonceHelpers();
  const body = new Uint8Array(16);

  for (const index of [0xffffffff, 0x7fffffff, 1e6, entry.maxChunks + 1]) {
    const ct = await seal(job.key, chunkNonce(0, index), body, aadFor(0, 0));
    tm._onChunk({ data: chunkFrame({ fileId: 0, offset: 0, index, payload: ct }) });
  }
  await job.chain;
  assert.ok(entry.hashes.length <= entry.maxChunks + 1, `hashes reached ${entry.hashes.length}`);
});

test('a chunk for a file that was never offered is ignored', async () => {
  const { tm, sink, job } = await receiving();
  const { chunkNonce, aadFor } = await nonceHelpers();
  const body = new Uint8Array(64);
  for (const fileId of [1, 7, 0xffffffff, 4095]) {
    const ct = await seal(job.key, chunkNonce(fileId, 0), body, aadFor(fileId, 0));
    tm._onChunk({ data: chunkFrame({ fileId, offset: 0, index: 0, payload: ct }) });
  }
  await job.chain;
  assert.equal(sink.writes.length, 0, 'a chunk for an unoffered file reached a sink');
});

test('a truncated or mis-versioned chunk frame is dropped, not parsed', async () => {
  const { tm, sink, job } = await receiving();
  for (const bytes of [new Uint8Array(0), new Uint8Array(1), new Uint8Array(HDR - 1), new Uint8Array(HDR)]) {
    if (bytes.length) bytes[0] = VER;
    tm._onChunk({ data: bytes });
  }
  const wrongVersion = chunkFrame({ fileId: 0, offset: 0, index: 0, payload: new Uint8Array(32) });
  wrongVersion[0] = 9;
  tm._onChunk({ data: wrongVersion });
  await job.chain;
  assert.equal(sink.writes.length, 0);
});

/* ── control messages with hostile numbers ────────────────────────────────── */

test('no control message with a hostile number throws or moves a position out of range', async () => {
  const { tm, entry, errors } = await receiving();

  const nasty = [
    -1, -0, 0, 1.5, NaN, Infinity, -Infinity,
    2 ** 53, 2 ** 53 + 1, 2 ** 64, Number.MAX_VALUE, Number.MIN_SAFE_INTEGER,
    '0', '999999', true, false, null, undefined, {}, [], () => {},
  ];

  for (const value of nasty) {
    for (const msg of [
      { t: 'ack', transferId: 'tttttttttttt', fileId: 0, upto: value },
      { t: 'resume', transferId: 'tttttttttttt', fileId: 0, from: value },
      { t: 'ack', transferId: 'tttttttttttt', fileId: value, upto: 0 },
      { t: 'resume', transferId: 'tttttttttttt', fileId: value, from: 0 },
      { t: 'done', transferId: 'tttttttttttt', fileId: value, root: 'ff' },
      { t: 'abort', transferId: 'tttttttttttt', reason: value },
      { t: 'accept', transferId: 'tttttttttttt', files: value },
      { t: 'decline', transferId: 'tttttttttttt', reason: value },
      { t: 'text', body: value },
      { t: 'rename', name: value },
    ]) {
      await tm._onCtl(msg); // must never throw
      assert.ok(entry.contiguous >= 0 && entry.contiguous <= entry.size, `contiguous left the file: ${entry.contiguous}`);
      assert.ok(entry.lastAck >= 0, `lastAck went negative: ${entry.lastAck}`);
    }
  }

  // Reporting is fine; crashing is not. Nothing above should have produced an unhandled error.
  assert.ok(Array.isArray(errors));
});

test('a control message with no type, or an invented one, is ignored', async () => {
  const { tm } = await receiving();
  for (const msg of [null, undefined, 0, '', 'ack', [], { t: '' }, { t: 'nope' }, { t: '__proto__' }, { t: 'constructor' }]) {
    await tm._onCtl(msg);
  }
  assert.equal(Object.prototype.hasOwnProperty.call({}, 'polluted'), false);
});

test('an acknowledgement cannot rewind a sender past the start or past the end', async () => {
  /*
   * The acknowledged position drives where a sender resumes from, so a receiver that lies
   * about it is asking the sender to read outside the file it is sending.
   */
  const transport = fakeTransport();
  const session = await fakeSession();
  const tm = new TransferManager({ transport, session });
  const transferId = 'ssssssssssss';
  // A real Blob, so the send loop reads from something rather than tripping over the fake.
  const entry = {
    id: 0,
    name: 'a.bin',
    path: 'a.bin',
    mime: 'application/octet-stream',
    file: new Blob([new Uint8Array(SIZE)]),
    size: SIZE,
    offset: 1000,
    acked: 1000,
    hashes: [],
  };
  tm.out.set(transferId, {
    transferId,
    state: 'sending',
    entries: [entry],
    sent: 1000,
    total: SIZE,
    key: await session.transferKey(transferId),
    chain: Promise.resolve(),
  });

  for (const value of [-1, NaN, Infinity, 2 ** 64, SIZE * 10, '5', null, undefined, {}]) {
    await tm._onCtl({ t: 'ack', transferId, fileId: 0, upto: value });
    await tm._onCtl({ t: 'resume', transferId, fileId: 0, from: value });
    assert.ok(entry.offset >= 0 && entry.offset <= SIZE, `offset left the file: ${entry.offset}`);
    assert.ok(entry.acked >= 0 && entry.acked <= SIZE, `acked left the file: ${entry.acked}`);
  }
});

/* ── the shared helper, which mirrors what the engine computes ────────────── */

async function nonceHelpers() {
  // Recomputed here rather than imported, so the test does not agree with the engine by
  // sharing its arithmetic.
  const chunkNonce = (fileId, index) => {
    const n = new Uint8Array(12);
    n[1] = fileId & 0xff;
    n[2] = (fileId >> 8) & 0xff;
    n[3] = (fileId >> 16) & 0xff;
    new DataView(n.buffer).setBigUint64(4, BigInt(Math.max(0, Math.trunc(index))), true);
    return n;
  };
  const aadFor = (fileId, offset) => {
    const a = new Uint8Array(12);
    const v = new DataView(a.buffer);
    v.setUint32(0, fileId >>> 0, true);
    v.setBigUint64(4, BigInt(Math.max(0, Math.trunc(offset))), true);
    return a;
  };
  return { chunkNonce, aadFor };
}
