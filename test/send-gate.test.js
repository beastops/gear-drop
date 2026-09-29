/**
 * The safety words, asked on both sides of the conversation.
 *
 * Receiving from a device nobody has checked put Accept behind a gate you had to tick. Sending
 * to that same device asked nothing at all: pick a file, pick the tile, and it went.
 *
 * That is the asymmetry the whole design exists to avoid. The words catch somebody standing
 * between two devices that meant to meet, and an attacker in the middle does not care which
 * direction the file travels — if anything the sending direction is worse, because what is at
 * risk is a file you chose rather than one you were offered.
 *
 * Building the gate turned up two bugs of its own, and both are pinned here, because both
 * produced the same symptom: a send that silently never happened, which is exactly what a gate
 * against accidents must never cause by accident.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');

/** A named function's body, brace-matched — non-greedy regexes stop at the first nested close. */
function body(signature) {
  const at = MAIN.indexOf(signature);
  assert.ok(at > 0, `${signature} has gone`);
  const open = MAIN.indexOf('{', at);
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

test('nothing is sent to a device whose words have not been checked', () => {
  const send = body('async function sendFiles(connId, fileList)');
  assert.match(
    send,
    /if \(!conn\.verified && !sasConfirmed\(conn\)\)/,
    'the send path no longer asks for the words',
  );
  assert.match(send, /promptVerify\(conn, \{ force: true \}\)/, 'it notices, and asks nothing');
});

test('and it asks the same question the receiving side asks', () => {
  /*
   * Not a second opinion about when a device is trusted — the same condition. `sasConfirmed`
   * compares against the words currently in force, so a re-key asks again and a confirmation
   * cannot be carried across one.
   */
  const receive = MAIN.slice(MAIN.indexOf('const needsSas ='));
  assert.match(receive.slice(0, 120), /!conn\.verified && !sasConfirmed\(conn\)/, 'the receive gate has changed shape');
});

test('the gate is on the one funnel, not on one of the ways in', () => {
  // The tile, the picker, the share target and the chat attachment all reach `sendFiles`. Put
  // on any single one of them, the other three are the hole.
  const tile = body('function onTileClick(connId, wantFolder = false)');
  assert.ok(!/promptVerify/.test(tile), 'the check moved onto the tile, which is one way in of four');
  assert.match(tile, /sendFiles\(connId, files\)/, 'the tile no longer sends through the funnel');
});

test('the held files go only once the device really is verified', () => {
  /*
   * This ran sixteen lines earlier at first, right after the pairing request and before
   * `conn.verified` is set. `sendFiles` then re-entered, met the gate it had just satisfied, and
   * put the files back on hold — the same question about the same device, and a send that never
   * happened.
   */
  const resolve = body('async function resolveVerify(matched)');
  const verifiedAt = resolve.indexOf('conn.verified = true');
  const releaseAt = resolve.lastIndexOf('releaseHeldSend(conn)');
  assert.ok(verifiedAt > 0 && releaseAt > 0, 'resolveVerify no longer verifies or releases');
  assert.ok(releaseAt > verifiedAt, 'the files are released before the device is marked verified');
  // And when both sides have confirmed, the connection is re-keyed to its pairing id, which can
  // happen after the files were released or while they are still held, so the record must follow.
  assert.match(
    body('async function rememberPair(conn)'),
    /for \(const w of heldSends\) if \(w\.connId === oldId\) w\.connId = id;/,
    'the held id is not re-keyed',
  );
});

test('an answer about one device does not throw away files picked for another', () => {
  /*
   * The first version cleared the held record and checked whose it was afterwards, so any
   * verification resolving in between discarded it. Not hypothetical: every peer that asks to
   * pair raises this dialog, so with more than one device on the network the collision is
   * ordinary.
   */
  const release = body('function releaseHeldSend(answered)');
  // Whose each entry is, checked entry by entry; one for another device that still waits on its
  // words is kept, not cleared with the rest.
  assert.match(release, /if \(w\.connId === answered\.id\)/, 'ownership is not checked');
  assert.match(release, /heldSends\.push\(w\)/, 'what another device is waiting for is thrown away');
});

test('and a question that could not be asked yet still gets asked', () => {
  // `promptVerify` turns away anything raised while another dialog is open. Nothing used to come
  // back to it, so a send could wait on a question nobody would ever ask.
  const release = body('function releaseHeldSend(answered)');
  assert.match(release, /promptVerify\(other, \{ force: true \}\)/, 'a turned-away question is never raised again');
});

test('a picture or a recording sent from the conversation is held for the words too', () => {
  /*
   * The comment on the funnel said the chat attachment arrived there. It did only for files the
   * conversation could not show; every picture and every voice message went straight to the
   * offer, to a device nobody had checked, which is exactly what the words are for.
   */
  // Sliced by hand: the helper would stop at the braces of the options in the signature.
  const sig = 'async function sendChatMedia(peerId, file, { voice = false, dur = 0 } = {})';
  const from = MAIN.indexOf(sig);
  assert.ok(from > 0, 'sendChatMedia has gone');
  const media = MAIN.slice(from, MAIN.indexOf('\n}\n', from));
  const gate = media.search(/!conn\.verified && !sasConfirmed\(conn\)/);
  assert.ok(gate > 0 && gate < media.indexOf('conn.transfers.offer('), 'a chat picture goes to an unchecked device');
  // And once they are checked it goes, as a picture in the conversation, not as a file.
  assert.match(body('function releaseHeldSend(answered)'), /sendChatMedia\(/);
});

test('everything picked while the words were waiting goes once they are checked', () => {
  /*
   * One slot held what waited for the words. Two picks for a device still connecting each took
   * it in turn, so only the last went out once the words were checked, and the earlier photos
   * were dropped without a word said. Held as a list now, each for its own device.
   */
  const release = body('function releaseHeldSend(answered)');
  const sent = [];
  const asked = [];
  const conns = new Map([
    ['a', { id: 'a', verified: true }],
    ['b', { id: 'b', verified: false }],
  ]);
  const heldSends = [
    { connId: 'a', files: ['one.jpg'] },
    { connId: 'a', files: ['two.jpg'] },
    { connId: 'a', media: 'voice.webm', opts: {} },
    { connId: 'b', files: ['for-b.pdf'] },
    { connId: 'gone', files: ['nobody.txt'] },
  ];
  const run = new Function(
    'state', 'app', 'sendFiles', 'sendChatMedia', 'sasConfirmed', 'promptVerify',
    `let heldSends = state.held; function releaseHeldSend(answered) ${release}; releaseHeldSend(state.answered); state.held = heldSends;`,
  );
  const state = { held: heldSends, answered: conns.get('a') };
  run(
    state,
    { conns },
    (id, files) => sent.push(`${id}:${files.join()}`),
    (id, media) => sent.push(`${id}:${media}`),
    () => false,
    (conn) => asked.push(conn.id),
  );
  assert.deepEqual(sent, ['a:one.jpg', 'a:two.jpg', 'a:voice.webm'], 'only the last pick went');
  assert.deepEqual(asked, ['b'], 'the other device is asked about next');
  assert.deepEqual(state.held.map((w) => w.connId), ['b'], 'what is for the other device keeps waiting');
});
