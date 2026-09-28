/**
 * Deleting one message, from both devices.
 *
 * Hold a message and choose Delete, and it goes from this device and from the other one, and
 * stays gone: the sealed log is rewritten without it and any picture or recording it carried is
 * deleted with it. If the other device is not connected, the request waits and goes the next
 * time it is, exactly as a whole-conversation erase already does.
 *
 * For that to work the two devices have to agree which message is meant, and they did not:
 * each gave a message its own random id when it stored it. A message now carries the id its
 * sender gave it, and the other side stores it under the same one. Messages from before that
 * have no shared id, so they are matched by what they were instead - direction, a hash of the
 * words (or the file's name and size), and the nearest time - which is only ever used for
 * those.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as chat from '../web/core/chat.js';
import { TransferManager } from '../web/core/transfer.js';

const PEER = '0f0e0d0c0b0a0908';
const tick = () => new Promise((r) => setTimeout(r, 3));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────────── shared ids ───────────────────────────── */

test('a message can be stored under the id its sender gave it', async () => {
  await chat.clear(PEER);
  const id = chat.newId();
  const { messages } = await chat.append(PEER, { dir: 'in', text: 'hello', id });
  assert.equal(messages.at(-1).id, id);
  await chat.clear(PEER);
});

test('the same message delivered twice is kept once', async () => {
  // An outbox flush that dies after sending and before marking sends it again next time.
  await chat.clear(PEER);
  const id = chat.newId();
  await chat.append(PEER, { dir: 'in', text: 'once', id });
  await chat.append(PEER, { dir: 'in', text: 'once', id });
  assert.deepEqual((await chat.load(PEER)).messages.map((m) => m.text), ['once']);
  await chat.clear(PEER);
});

test('an id that is not an id is not trusted', async () => {
  await chat.clear(PEER);
  for (const bad of ['', 'x', '../../etc', '<b>', 'a'.repeat(200), 42, null, {}]) {
    const { messages } = await chat.append(PEER, { dir: 'in', text: 'x', id: bad });
    const got = messages.at(-1).id;
    assert.notEqual(got, bad);
    assert.match(got, /^[0-9a-z-]{8,40}$/);
  }
  await chat.clear(PEER);
});

/* ───────────────────────────── removing ───────────────────────────── */

test('removing a message rewrites the log without it, and deletes its picture', async () => {
  await chat.clear(PEER);
  const att = await chat.putAttachment(PEER, new Uint8Array([9, 9, 9]));
  await chat.append(PEER, { dir: 'out', text: 'keep me' });
  await tick();
  const { messages } = await chat.append(PEER, { dir: 'out', media: { kind: 'image', att, name: 'p.png', mime: 'image/png', size: 3 } });
  const target = messages.at(-1);

  const out = await chat.remove(PEER, [target.id]);
  assert.deepEqual(out.removed, [target.id]);
  assert.deepEqual((await chat.load(PEER)).messages.map((m) => m.text), ['keep me']);
  assert.equal(await chat.getAttachment(att), null, 'the picture outlived its message');
  await chat.clear(PEER);
});

test('removing works for a conversation that is only in memory too', async () => {
  const peer = 'chan:00112233445566778899aabbccddeeff';
  await chat.clear(peer);
  const { messages } = await chat.append(peer, { dir: 'in', text: 'gone soon' });
  await chat.remove(peer, [messages[0].id]);
  assert.equal((await chat.load(peer)).messages.length, 0);
});

test('removing something that is not there changes nothing', async () => {
  await chat.clear(PEER);
  await chat.append(PEER, { dir: 'out', text: 'stays' });
  const out = await chat.remove(PEER, ['nothing-here-00']);
  assert.deepEqual(out.removed, []);
  assert.equal((await chat.load(PEER)).messages.length, 1);
  await chat.clear(PEER);
});

/* ───────────────────────────── matching ───────────────────────────── */

test('a request names a message by the id both sides share', async () => {
  await chat.clear(PEER);
  const id = chat.newId();
  await chat.append(PEER, { dir: 'in', text: 'shared', id });
  // The other side sent it, so from there it is 'out'.
  const found = await chat.resolve(PEER, [{ id, dir: 'out', at: 0, h: '' }]);
  assert.deepEqual(found, [id]);
  await chat.clear(PEER);
});

test('an older message with no shared id is found by what it was', async () => {
  await chat.clear(PEER);
  await chat.append(PEER, { dir: 'in', text: 'same words' });
  await pause(120);
  await chat.append(PEER, { dir: 'out', text: 'same words' }); // wrong direction to match
  await pause(120);
  const { messages } = await chat.append(PEER, { dir: 'in', text: 'same words' });
  const newest = messages.at(-1);

  // The sender's clock said this one was sent a moment before it arrived here.
  const h = await chat.fingerprint({ text: 'same words' });
  const found = await chat.resolve(PEER, [{ id: 'theirs-00000000', dir: 'out', at: newest.at - 15, h }]);
  assert.deepEqual(found, [newest.id], 'matched the wrong copy, or the wrong direction');

  // Nothing matches words that were never said, or a time far from any of them.
  assert.deepEqual(await chat.resolve(PEER, [{ id: 'x-00000000', dir: 'out', at: newest.at, h: await chat.fingerprint({ text: 'other' }) }]), []);
  assert.deepEqual(await chat.resolve(PEER, [{ id: 'x-00000000', dir: 'out', at: newest.at + 3 * 86400000, h }]), []);
  await chat.clear(PEER);
});

test('a fingerprint says nothing readable about the message', async () => {
  const h = await chat.fingerprint({ text: 'meet me at six' });
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.ok(!h.includes('six'));
  assert.notEqual(h, await chat.fingerprint({ text: 'meet me at seven' }));
  // A picture is named by its name and size, since its bytes are not in the log.
  assert.equal(await chat.fingerprint({ name: 'a.png', size: 5 }), await chat.fingerprint({ name: 'a.png', size: 5 }));
});

/* ───────────────────────────── on the wire ───────────────────────────── */

function wired() {
  const sent = [];
  const tm = Object.create(TransferManager.prototype);
  Object.assign(tm, { _sendCtl: async (obj, block) => sent.push({ obj, block }) });
  // EventTarget state lives on the instance in Node only when constructed; borrow one.
  const target = new EventTarget();
  tm.addEventListener = target.addEventListener.bind(target);
  tm.dispatchEvent = target.dispatchEvent.bind(target);
  return { tm, sent };
}

test('a message goes out with its id, and arrives with it', async () => {
  const { tm, sent } = wired();
  const id = chat.newId();
  await tm.sendText('hi', id);
  assert.deepEqual(sent[0].obj, { t: 'text', body: 'hi', mid: id });

  const got = [];
  tm.addEventListener('text', (e) => got.push(e.detail));
  await TransferManager.prototype._onCtl.call(tm, { t: 'text', body: 'hi', mid: id });
  await TransferManager.prototype._onCtl.call(tm, { t: 'text', body: 'old client' });
  await TransferManager.prototype._onCtl.call(tm, { t: 'text', body: 'bad', mid: '<script>' });
  assert.deepEqual(got, [
    { body: 'hi', mid: id },
    { body: 'old client', mid: '' },
    { body: 'bad', mid: '' },
  ]);
});

test('a delete request carries ids and hashes, and nothing the other side cannot already see', async () => {
  const { tm, sent } = wired();
  await tm.sendUnsend([{ id: 'abc-12345678', dir: 'out', at: 5, h: '0123456789abcdef', text: 'leak?' }]);
  assert.deepEqual(sent[0].obj, { t: 'unsend', items: [{ id: 'abc-12345678', dir: 'out', at: 5, h: '0123456789abcdef' }] });

  const got = [];
  tm.addEventListener('unsend', (e) => got.push(e.detail));
  await TransferManager.prototype._onCtl.call(tm, {
    t: 'unsend',
    items: [
      { id: 'abc-12345678', dir: 'out', at: 5, h: '0123456789abcdef' },
      { id: '<img>', dir: 'sideways', at: 'soon', h: 'zz' },
      null,
      'nope',
    ],
  });
  assert.deepEqual(got, [[{ id: 'abc-12345678', dir: 'out', at: 5, h: '0123456789abcdef' }]]);

  // Bounded, so one frame cannot make this side search its log ten thousand times.
  await TransferManager.prototype._onCtl.call(tm, { t: 'unsend', items: Array.from({ length: 5000 }, (_, i) => ({ id: `m-${String(i).padStart(8, '0')}`, dir: 'in', at: i, h: '' })) });
  assert.ok(got[1].length <= 100);
});

test('the answer to a delete names only ids', async () => {
  const { tm, sent } = wired();
  await tm.sendUnsent(['abc-12345678']);
  assert.deepEqual(sent[0].obj, { t: 'unsent', ids: ['abc-12345678'] });
  const got = [];
  tm.addEventListener('unsent', (e) => got.push(e.detail));
  await TransferManager.prototype._onCtl.call(tm, { t: 'unsent', ids: ['abc-12345678', 7, '<b>'] });
  assert.deepEqual(got, [['abc-12345678']]);
});

/* ───────────────────────────── the page ───────────────────────────── */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');

test('every message this app writes carries an id the other side will share', () => {
  // Text sent now, text sent from the outbox later, and a picture, which is named by its transfer.
  assert.match(MAIN, /conn\.transfers\.sendText\(body, id\)/);
  assert.match(MAIN, /conn\.transfers\.sendText\(m\.text, m\.id\)/);
  assert.match(MAIN, /chat\.append\(conn\.id, \{ dir: 'in', text: body, id: mid \}\)/);
  assert.match(MAIN, /id: transferId,/);
});

test('a remembered device is never saved from an old copy of its record', () => {
  /*
   * Found by the end-to-end run of this feature: the other device came back, was sent the
   * delete it was owed, and still had the message. The name it announces on every connection
   * was being written back from the record as it stood when the connection began, which put
   * back a delete already confirmed and dropped the one owed since. The same write could undo an
   * owed erase of the whole conversation, or an auto-accept switched off in the meantime.
   */
  assert.ok(!/savePeer\(conn\.peer\)/.test(MAIN), 'the announced name is saved from the copy held since connecting');
  const rename = MAIN.slice(MAIN.indexOf("transfers.addEventListener('peer-name'"), MAIN.indexOf("transfers.addEventListener('offered'"));
  assert.match(rename, /updatePeer\(conn\.peer\.id/);
  // The devices list is drawn once and kept open while other things change the records.
  assert.ok(!/savePeer\(peer\)/.test(MAIN), 'a switch in the devices list saves the copy it was drawn from');
  assert.match(MAIN, /const rec = app\.paired\.find\(\(p\) => p\.id === id\);\n  if \(!rec \|\| change\(rec\) === false\)/);
});

test('a delete that cannot be delivered now is owed, and cleared only when answered', () => {
  assert.match(MAIN, /unsendPending/);
  assert.match(MAIN, /transfers\.addEventListener\('unsent'/);
  // Sent again every time the device connects, after the settle the outbox waits for.
  assert.match(MAIN, /if \(!conn\.closed\) flushUnsendPending\(conn\)/);
});
