/**
 * Remembering a device, on both sides or not at all.
 *
 * Pairing is one root held twice. It used to be written the moment *this* screen confirmed the
 * safety words, with a request sent across asking the other device to do the same. When that
 * request went unanswered - the other tab was reloaded, the link dropped, or a dialog was
 * already up there and the request was thrown away - this device kept a pairing the other had
 * never heard of. From then on the other device turned up twice whenever it was opened nearby:
 * once live, as the stranger it now was, and once as a remembered device stuck on "offline",
 * because a rendezvous only one side knows about is one nobody else attends. Reopening the site
 * did not help; the record was on disk.
 *
 * Reproduced end to end with two browser profiles before this change: A confirmed, B reloaded
 * without answering, and A showed `Gourd-Dodge [verified, offline]` beside
 * `Gourd-Dodge [ready] local network` indefinitely, through reloads of both.
 *
 * What holds now:
 *   - a pairing is written only once both screens have confirmed the words;
 *   - a request that arrives while another question is on screen waits instead of vanishing;
 *   - forgetting a device tells that device, so it does not keep the other half;
 *   - a remembered device that is offline is not drawn beside the same device live, and pairing
 *     with it again replaces the stale record, conversation included.
 *
 * The conversation has to move whenever the identity does, because the second half of the
 * pairing can now land at any moment - including while the conversation is open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { adopt, append, load, clear, putAttachment, getAttachment, sweep } from '../web/core/chat.js';
import { chats } from '../web/core/store.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');

/** A named function's body, brace-matched. */
function body(signature) {
  const at = MAIN.indexOf(signature);
  assert.ok(at > 0, `${signature} has gone`);
  const open = MAIN.indexOf('{', at + signature.length);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(open, i + 1);
    }
  }
  throw new Error(`${signature} does not close`);
}

const tick = () => new Promise((r) => setTimeout(r, 3));

/* ───────────────────────────── the conversation moves ───────────────────────────── */

test('what was said before a device was paired comes with it', async () => {
  const before = 'chan:0123456789abcdef0123456789abcdef';
  const after = 'feedfacecafe0001';
  await clear(before);
  await clear(after);

  const picture = new Uint8Array([1, 2, 3, 4, 5]);
  const att = await putAttachment(before, picture);
  await append(before, { dir: 'out', text: 'hello' });
  await tick();
  await append(before, { dir: 'in', text: '', media: { kind: 'image', att, name: 'p.png', mime: 'image/png', size: 5 } });

  assert.equal(await adopt(before, after), true);

  const { messages } = await load(after);
  assert.deepEqual(messages.map((m) => m.dir + ':' + (m.text || m.kind)), ['out:hello', 'in:image']);
  const moved = messages[1].att;
  assert.ok(moved.startsWith(after + '|'), 'the picture still belongs to the old identity');
  assert.deepEqual([...(await getAttachment(moved))], [...picture], 'the picture did not survive the move');
  assert.equal((await load(before)).messages.length, 0, 'the old identity still holds the conversation');

  // Stored durably now: a sweep that keeps only paired devices keeps this.
  await sweep([after]);
  assert.deepEqual([...(await getAttachment(moved))], [...picture], 'the moved picture is swept as an orphan');
  await clear(after);
});

test('a replaced pairing brings its history, merged in the order it happened', async () => {
  const stale = 'aaaaaaaaaaaaaaaa';
  const fresh = 'bbbbbbbbbbbbbbbb';
  await clear(stale);
  await clear(fresh);

  await append(stale, { dir: 'out', text: 'one' });
  await tick();
  await append(fresh, { dir: 'in', text: 'two' });
  await tick();
  await append(stale, { dir: 'out', text: 'three', pending: true });

  assert.equal(await adopt(stale, fresh), true);
  const { messages } = await load(fresh);
  assert.deepEqual(messages.map((m) => m.text), ['one', 'two', 'three']);
  assert.equal(messages[2].pending, true, 'a message still waiting to go stopped waiting');
  assert.equal((await load(stale)).messages.length, 0);
  await clear(fresh);
});

test('a conversation that cannot be read is left where it is', async () => {
  const stale = 'cccccccccccccccc';
  const fresh = 'dddddddddddddddd';
  await clear(fresh);
  // Sealed under a key this browser does not have: `load` reports it as locked.
  await chats.put({ id: stale, updated: Date.now(), sealed: { v: 1, iv: [1, 2, 3], ct: [4, 5, 6] } });
  assert.equal((await load(stale)).locked, true, 'the fixture is not the locked case');

  assert.equal(await adopt(stale, fresh), false, 'claimed to move something it could not read');
  assert.ok(await chats.get(stale), 'an unreadable conversation was deleted rather than left alone');
  await chats.del(stale);
});

test('moving a conversation onto itself, or from nowhere, does nothing', async () => {
  const id = 'eeeeeeeeeeeeeeee';
  await clear(id);
  await append(id, { dir: 'out', text: 'stay' });
  await adopt(id, id);
  assert.deepEqual((await load(id)).messages.map((m) => m.text), ['stay']);
  assert.equal(await adopt('ffffffffffffffff', id), true);
  assert.deepEqual((await load(id)).messages.map((m) => m.text), ['stay']);
  await clear(id);
});

/* ───────────────────────────── the pairing itself ───────────────────────────── */

test('confirming the words on one screen does not remember the device', () => {
  const resolve = body('async function resolveVerify(matched)');
  assert.ok(!/savePeer\(/.test(resolve), 'the record is written before the other side has confirmed');
  assert.match(resolve, /if \(conn\.theirWordsOk\) await rememberPair\(conn\)/, 'both confirming no longer pairs');
  assert.match(resolve, /conn\.wordsOk = true/);
});

test('the other side confirming completes it, and asks if this side has not yet', () => {
  const handler = MAIN.slice(MAIN.indexOf("e.detail?.t === 'pair-ask'"), MAIN.indexOf("e.detail?.t === 'pair-ask'") + 400);
  assert.match(handler, /conn\.theirWordsOk = true/);
  assert.match(handler, /if \(conn\.wordsOk\) rememberPair\(conn\)/);
  assert.match(handler, /askToPair\(conn\)/);
});

test('a request that arrives while another question is up is asked afterwards', () => {
  // `promptVerify` turns away anything raised while a dialog is open. The request used to go
  // with it; it is noted on the connection and asked when the dialog before it is answered.
  assert.match(body('async function resolveVerify(matched)'), /askNextPair\(\)/);
  assert.match(body('function askNextPair()'), /theirWordsOk && !c\.wordsOk/);
});

test('forgetting a device tells that device, over the pairing only it shares', () => {
  const forget = body('async function forgetDevice(id, { theirs = false } = {})');
  const tell = forget.indexOf("t: 'unpair'");
  assert.ok(tell > 0, 'the other device is never told');
  assert.ok(tell < forget.indexOf('dropConn(id)'), 'it is told after the connection has gone');
  const handler = MAIN.slice(MAIN.indexOf("e.detail?.t === 'unpair'"), MAIN.indexOf("e.detail?.t === 'unpair'") + 300);
  // Only a paired session can say it: anyone else on a channel has no record here to remove.
  assert.match(handler, /conn\.peer/);
});

/*
 * Two ways a working connection was dropped a few seconds after every pairing on the network.
 *
 * Found while checking the fix above, end to end: the new pairing's own device went "offline"
 * about two seconds after both sides confirmed, for five seconds or more. Both are old; pairing
 * both sides at once only made them land every time.
 */
test('the next announcement from a newly paired device does not drop its conversation', () => {
  // Its hints now name the pairing, so it is recognised as paired - and the conversation that
  // recognition would retire as a duplicate is the one the pairing adopted.
  const member = MAIN.slice(MAIN.indexOf("ch.addEventListener('member'"), MAIN.indexOf("ch.addEventListener('member-gone'"));
  assert.match(member, /c\.peer\?\.id === known\.id/, 'the adopted conversation is not recognised as the paired one');
  assert.match(member, /if \(!adopted\) dropChannelPeer\(/, 'it is retired anyway');
});

test("a session's departures and words only touch its own connection", () => {
  // The pairing's rendezvous session answers to the same id as the adopted conversation.
  for (const event of ['peer-gone', 'sas']) {
    const at = MAIN.indexOf(`session.addEventListener('${event}'`);
    assert.ok(at > 0, `${event} handler has gone`);
    assert.match(MAIN.slice(at, at + 1200), /if \(!conn \|\| conn\.session !== session\) return;/, `${event} acts on another session's connection`);
  }
});

test('a remembered device is not drawn twice beside itself', () => {
  assert.match(body('function render()'), /staleTwin\(/, 'an offline record is drawn beside the same device live');
  assert.match(body('async function rememberPair(conn)'), /supersede\(/, 'pairing again leaves the stale record behind');
});

/* ─────────────── after pairing, in the same visit ─────────────── */

const ATTACH = (() => {
  const at = MAIN.indexOf('function attachSession(session, ');
  return MAIN.slice(at, MAIN.indexOf('\n}\n', at));
})();
const handler = (event) => {
  // 'secure' is a named function, so a parked connection's takeover can run it again.
  if (event === 'secure') {
    const at = ATTACH.indexOf('const onSecure = async () => {');
    assert.ok(at > 0, 'no secure handler');
    return ATTACH.slice(at, ATTACH.indexOf('\n  };', at));
  }
  const at = ATTACH.indexOf(`session.addEventListener('${event}'`);
  assert.ok(at > 0, `no ${event} handler`);
  return ATTACH.slice(at, ATTACH.indexOf('\n  });', at));
};

test('a conversation adopted by a pairing still hears the session it arrived on', () => {
  /*
   * Pairing re-files the conversation under the pairing's id. The handlers looked it up by the
   * id they started with, found nothing, and dropped what came: the other device's "unpair"
   * among it, so forgetting a device paired in the same visit left the pairing on the other one.
   */
  for (const event of ['message', 'sas', 'peer-gone']) {
    assert.match(handler(event), /const conn = own\(\);/, `${event} looks the conversation up by the id it started with`);
  }
  assert.doesNotMatch(handler('peer-gone'), /dropConn\(connId\)/);
  assert.match(handler('secure'), /const existing = own\(\) \|\| app\.conns\.get\(connId\);/);
  // Found by its session, it must not be resumed there: that key is the channel's or the code's,
  // not the pairing's, and the pairing's own rendezvous is what brings it back.
  assert.match(handler('secure'), /if \(!peer && existing\?\.peer && existing\.session === session\) \{/);
});

test('a key agreed again asks for the words again', () => {
  // The words confirmed were for the old key. Carried across, a re-key forced by whoever sits
  // in the middle would be trusted - and paired - without anybody reading the new ones.
  const secure = handler('secure');
  const resume = secure.slice(secure.indexOf('if (resuming) {'));
  assert.match(resume, /if \(!existing\.peer\) \{[^}]*existing\.verified = false;[^}]*existing\.wordsOk = false;[^}]*existing\.theirWordsOk = false;/);
  assert.match(resume, /if \(verifying === existing\)/, 'the old words stay on screen to be confirmed');
});

test('forgetting a device met on the network lets the two meet there again', () => {
  // The channel's entry for it outlived the conversation, and every later announcement from
  // that device was taken as one already being talked to.
  assert.match(body('async function forgetDevice(id, { theirs = false } = {})'), /dropChannelPeer\(conn\.member\.idKey, \{ keepBusy: false \}\)/);
});

test('a room joined from a link is the one a reload comes back to', () => {
  // Already public, the new code was set in memory only, and a reload rejoined the room left.
  assert.match(body('async function joinRoom(raw, { quiet = false } = {})'), /app\.prefs\.publicCode = code;[\s\S]{0,200}?if \(!quiet\) await savePrefs\(\);/);
});

test('a paired device that leaves the network stops being marked as on it', () => {
  const make = body('function makeChannel(kind, label)');
  assert.match(make, /member\.pairedId = known\.id;/);
  assert.match(make, /if \(gone\?\.pairedId\) app\.alsoOn\.get\(gone\.pairedId\)\?\.delete\(kind\);/);
});

test('words closed by a re-key are asked again, and a relay request waits for the re-attach', () => {
  const secure = handler('secure');
  // Closed because they were for the old key - and then nothing asked again for a device met on
  // the network, so what was held for that answer waited on a question nobody would see.
  assert.match(secure, /existing\.reask = true;/);
  assert.match(handler('sas'), /if \(conn\.reask\) \{\s*conn\.reask = false;\s*promptVerify\(conn, \{ force: true \}\);/);
  // A request to use the relay that lands while the engine is being moved onto the new path
  // was followed on the old one, and the engine was left on a transport nothing used.
  assert.match(secure, /existing\.reattaching = true;[\s\S]*await existing\.transfers\.attachTransport\(transport\);[\s\S]*existing\.reattaching = false;/);
  assert.match(handler('message'), /if \(!conn \|\| conn\.reattaching\) \{\s*relayAsked = true;/);
});
