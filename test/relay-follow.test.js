/**
 * One end on the encrypted connection is not a connection.
 *
 * When the direct attempt fails - behind an emulator's own network, a strict router, a VPN -
 * both devices ask whether to use the encrypted connection. A tap on one sent the other a
 * request, and the other ignored it, because it had already asked its own question and does not
 * stack prompts. So one device said "encrypted" and the other said "connecting…" for good. An
 * offer from the first went somewhere the second was not listening, and every send from the
 * second failed with "Couldn't send" (`control path is not open`).
 *
 * Reproduced with two browser profiles and direct connections made to fail: after the tap, A
 * showed `[ready] encrypted`, B stayed `[connecting]`, A's photo never arrived and B's send
 * failed. With this change B follows within a second and photos go both ways.
 *
 * Checked at the source here; the harness that reproduces it end to end needs two browsers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');

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

test('the other device moving to the encrypted connection is followed, not asked about', () => {
  const at = MAIN.indexOf("e.detail?.t === 'relay-request'");
  const handler = MAIN.slice(at, at + 300);
  assert.match(handler, /followRelay\(conn\)/, 'a request from the other device is not followed');
  assert.ok(!/offerRelay\(/.test(handler), 'a request from the other device raises a question again');
  // Including one that arrived before the connection existed.
  assert.match(body('function askedForRelay(conn)'), /followRelay\(conn\)/);
});

test('following does not depend on a setting, or on a question already being on screen', () => {
  const follow = body('function followRelay(conn)');
  assert.match(follow, /useRelay\(conn, 'why\.peer'\)/);
  assert.ok(!/allowRelay|relayAsked/.test(follow), 'following is gated on something the other device already answered');
});

test('the question is taken off the screen once it has been answered either way', () => {
  assert.match(body('function offerRelay(conn, why)'), /conn\.relayToast = toast\(/);
  assert.match(body('async function useRelay(conn, why)'), /conn\.relayToast\?\.remove\(\)/);
  assert.match(body("function toast(text, tone = '', opts = {})"), /return el;/, 'a notice cannot be taken back');
});

test('nothing is offered down a link that is not open yet, and saying so is not "Couldn\'t send"', () => {
  for (const sig of ['async function sendFiles(connId, fileList)', 'async function sendChatMedia(peerId, file, { voice = false, dur = 0 } = {})']) {
    const fn = body(sig);
    const check = fn.indexOf("if (conn.state !== 'ready') return toast(notReady(conn), 'bad');");
    assert.ok(check > 0, `${sig} offers before the link is open`);
    assert.ok(check < fn.indexOf('transfers.offer('), `${sig} checks after offering`);
  }
  // A message to a remembered device waits in the outbox rather than failing.
  assert.match(body('async function sendChat()'), /if \(!conn \|\| conn\.state !== 'ready'\)/);
});
