/**
 * How a transfer ends: cancelled, failed, or abandoned by the other side.
 *
 * Found by driving the real engine over a loopback pipe:
 *
 *   - cancelling did not stop the sender. Its send loop held its own reference to the job and
 *     carried on, reported "Sent" for the cancelled file, and its leftover chunks - which carry
 *     no transfer id - landed in the next transfer, failed authentication there and failed it;
 *   - a cancel made while the link was down was thrown away, and the file was delivered anyway;
 *   - a receive whose sender reloaded stayed "receiving" for good, and every later offer from
 *     that device was refused as busy;
 *   - a failure told nobody: the sender went on to "Sent", and the receiver kept the job, its
 *     sink and the bytes in memory;
 *   - where the sink hands its bytes to a worker (Safari's storage), the length was read after
 *     they had been handed over, so every receive there sat at 0% and then failed;
 *   - attaching the same transport again - relay, then back to direct - wired it twice, and
 *     every chunk after that was decrypted, written and counted twice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { TransferManager } from '../web/core/transfer.js';
import { aeadKey, hkdf } from '../web/core/gdcrypto.js';
import { te, concat } from '../web/core/bytes.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Two transports wired to each other, with a small send buffer so a transfer takes a while. */
function pipe({ chunkSize = 16 * 1024, high = 4 } = {}) {
  const mk = () => {
    const t = new EventTarget();
    Object.assign(t, { kind: 'test', chunkSize, closed: false, ctlOpen: true, lanes: [{ idx: 0 }], readyLanes: 1, buffered: 0, sent: 0 });
    t.canSendCtl = () => !t.closed && t.ctlOpen;
    t.sendCtl = (bytes) => {
      if (!t.canSendCtl()) return false;
      const copy = new Uint8Array(bytes);
      setTimeout(() => t.peer.closed || t.peer.dispatchEvent(new CustomEvent('ctl', { detail: copy })), 0);
      return true;
    };
    t.canSend = () => !t.closed && t.ctlOpen && t.buffered < high;
    t.pickLane = () => (t.canSend() ? 0 : -1);
    t.drain = () => sleep(1);
    t.send = (lane, bytes) => {
      if (t.closed) return false;
      t.buffered++;
      t.sent++;
      const copy = new Uint8Array(bytes);
      setTimeout(() => {
        t.buffered--;
        if (!t.peer.closed) t.peer.dispatchEvent(new CustomEvent('chunk', { detail: { lane, data: copy } }));
      }, 1);
      return true;
    };
    t.close = () => (t.closed = true);
    return t;
  };
  const a = mk();
  const b = mk();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

function sessions(K = webcrypto.getRandomValues(new Uint8Array(32)), generation = 1) {
  const mk = (lane) => {
    const s = new EventTarget();
    s.lane = lane; // which way round the control chains go
    s.K = K;
    s.generation = generation;
    s.transferKey = async (id) => aeadKey(await hkdf(s.K, concat(te.encode('gd/xfer/v1'), te.encode(id)), 32));
    return s;
  };
  return [mk(0), mk(1)];
}

function record(tm, name, out) {
  for (const ev of ['incoming', 'sent', 'complete', 'aborted', 'error']) {
    tm.addEventListener(ev, (e) => out.push(`${name}:${ev}${e.detail?.transferId ? ' ' + e.detail.transferId : ''}${e.detail?.reason ? ' ' + e.detail.reason : ''}`));
  }
}

function file(size, name = 'f.bin') {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) & 0xff;
  return new File([b], name);
}

function pair() {
  const [ta, tb] = pipe();
  const [sa, sb] = sessions();
  const A = new TransferManager({ transport: ta, session: sa });
  const B = new TransferManager({ transport: tb, session: sb });
  const ev = [];
  record(A, 'A', ev);
  record(B, 'B', ev);
  B.addEventListener('incoming', (e) => B.accept(e.detail.transferId, { prefer: 'memory', userGesture: false }).catch((err) => ev.push('B:accept-threw ' + err.name)));
  return { A, B, ta, tb, sa, sb, ev };
}

const until = async (cond, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(10);
  return cond();
};

for (const who of ['receiver', 'sender']) {
  test(`a transfer cancelled by the ${who} stops being sent, and the next one arrives`, async () => {
    const { A, B, ta, ev } = pair();
    const t1 = await A.offer([file(4 * 1024 * 1024, 'one.bin')]);
    assert.ok(await until(() => B.in.get(t1)?.received > 512 * 1024), 'never started');
    const before = ta.sent;
    await (who === 'receiver' ? B : A).abort(t1);
    await sleep(100);
    // A few are already on their way when the cancel lands; before, it was the whole rest of the file.
    assert.ok(ta.sent - before < 40, `${ta.sent - before} chunks sent after the cancel`);
    assert.ok(!ev.includes(`A:sent ${t1}`), 'the cancelled file was reported sent');

    const t2 = await A.offer([file(1024 * 1024, 'two.bin')]);
    assert.ok(await until(() => ev.includes(`B:complete ${t2}`) || ev.some((e) => e.startsWith('B:error'))));
    assert.ok(ev.includes(`B:complete ${t2}`), ev.join('\n'));
  });
}

test('a cancel made while the link is down still cancels, and is delivered when it is back', async () => {
  for (const who of ['sender', 'receiver']) {
    const { A, B, ta, tb, ev } = pair();
    const t1 = await A.offer([file(2 * 1024 * 1024, 'one.bin')]);
    assert.ok(await until(() => B.in.get(t1)?.received > 256 * 1024));
    ta.ctlOpen = tb.ctlOpen = false;
    const M = who === 'sender' ? A : B;
    await M.abort(t1); // must not throw
    assert.ok(ev.some((e) => e.startsWith(`${who === 'sender' ? 'A' : 'B'}:aborted ${t1}`)), `${who}: the cancel did nothing on screen`);
    await sleep(50);
    ta.ctlOpen = tb.ctlOpen = true;
    await M.flushOwed();
    await sleep(300);
    assert.ok(!ev.includes(`A:sent ${t1}`) && !ev.includes(`B:complete ${t1}`), `${who}: the cancelled file was delivered\n${ev.join('\n')}`);
    assert.ok(!B.in.has(t1) && !A.out.has(t1), `${who}: the other side still holds it`);
  }
});

test('a receive whose sender forgot it ends, and does not block the next one', async () => {
  const { A, B, ta, tb, sb, ev } = pair();
  const t1 = await A.offer([file(4 * 1024 * 1024, 'big.bin')]);
  assert.ok(await until(() => B.in.get(t1)?.received > 512 * 1024));

  // The sender's tab reloads: a new engine, on a session keyed again.
  ta.close();
  tb.close();
  const K2 = webcrypto.getRandomValues(new Uint8Array(32));
  Object.assign(sb, { K: K2, generation: 2 });
  const [ta2, tb2] = pipe();
  const [sa2] = sessions(K2, 2);
  const A2 = new TransferManager({ transport: ta2, session: sa2 });
  record(A2, 'A2', ev);
  await B.attachTransport(tb2);
  await B.resumeAll();
  assert.ok(await until(() => !B.in.has(t1), 2000), 'still receiving from a sender that no longer has it');

  const t2 = await A2.offer([file(64 * 1024, 'photo.jpg')]);
  assert.ok(await until(() => ev.includes(`B:complete ${t2}`)), `the next offer was refused\n${ev.join('\n')}`);
});

test('a failed receive is let go, and the sender is told', async () => {
  const { A, B, ev } = pair();
  const t1 = await A.offer([file(2 * 1024 * 1024, 'one.bin')]);
  assert.ok(await until(() => B.in.get(t1)?.received > 256 * 1024));
  const job = B.in.get(t1);
  let aborted = 0;
  for (const s of job.sinks.values()) {
    const ab = s.abort.bind(s);
    s.abort = async () => (aborted++, ab());
  }
  B._fail(job, 'integrity check failed');
  await sleep(200);
  assert.ok(!B.in.has(t1), 'the failed job is kept');
  assert.ok(aborted >= 1, 'its sink, and the bytes in it, are kept');
  assert.ok(!A.out.has(t1), 'the sender goes on sending');
  assert.ok(!ev.includes(`A:sent ${t1}`), 'the sender says "Sent"');
  assert.ok(ev.includes(`A:aborted ${t1} failed`), ev.join('\n'));
});

test('a sink that hands its bytes over does not lose count of them', async () => {
  // As the worker-backed storage does: the plaintext's buffer is transferred to the worker.
  const { A, B, ev } = pair();
  B.addEventListener('receiving', (e) => {
    for (const s of B.in.get(e.detail.transferId).sinks.values()) {
      const w = s.write.bind(s);
      s.write = async (offset, bytes) => {
        const copy = bytes.slice();
        structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); // detached, as postMessage leaves it
        return w(offset, copy);
      };
    }
  });
  const t1 = await A.offer([file(512 * 1024, 'one.bin')]);
  assert.ok(await until(() => ev.includes(`B:complete ${t1}`) || ev.some((e) => e.startsWith('B:error')), 5000), 'stuck at 0%');
  assert.ok(ev.includes(`B:complete ${t1}`), ev.join('\n'));
});

test('attaching the same transport again does not wire it twice', async () => {
  const { A, B, ta, tb, ev } = pair();
  let writes = 0;
  B.addEventListener('receiving', (e) => {
    for (const s of B.in.get(e.detail.transferId).sinks.values()) {
      const w = s.write.bind(s);
      s.write = async (o, b) => (writes++, w(o, b));
    }
  });
  // Relay and back again: the direct transport is attached a second time.
  await A.attachTransport(ta);
  await B.attachTransport(tb);
  const t1 = await A.offer([file(256 * 1024, 'one.bin')]);
  assert.ok(await until(() => ev.includes(`B:complete ${t1}`)));
  assert.equal(writes, 16, 'each chunk written more than once');
});

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MAIN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'main.js'), 'utf8');

test('the page asks to continue after moving from the relay back to direct, and says what it owes', () => {
  // The send loop stops when its transport is replaced, and only a resume starts it again: the
  // move back to direct asked for none, and a transfer under way sat where it was for good.
  const rtcOpen = MAIN.slice(MAIN.indexOf("rtc?.addEventListener('open'"), MAIN.indexOf("rtc?.addEventListener('open'") + 700);
  assert.match(rtcOpen, /attachTransport\(rtc\)[\s\S]*resumeAll\(\)/);
  const owed = MAIN.slice(MAIN.indexOf('function sendOwed('), MAIN.indexOf('function wireTransport('));
  assert.match(owed, /transfers\.flushOwed\(\)/);
  // A failure is said as one, not as somebody having cancelled.
  assert.match(MAIN, /e\.detail\?\.reason === 'failed' \|\| e\.detail\?\.reason === 'gone'/);
});
