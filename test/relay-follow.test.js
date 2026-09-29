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

/*
 * And then there is no question at all.
 *
 * Even with one tap moving both devices, nothing could be sent until somebody tapped, and a
 * banner that disappears in fourteen seconds is easy to miss. From the outside that is the app
 * failing to send. A direct link that is not up after a few seconds now moves both devices to
 * the encrypted connection by itself.
 */
test('a direct link that cannot be made moves both devices over without asking', () => {
  const offer = body('function offerRelay(conn, why)');
  assert.match(offer, /session\.send\(\{ t: 'relay-request' \}\)/, 'the other device is not taken along');
  assert.match(offer, /useRelay\(conn, why\)/);
  assert.ok(!/toast\(|allowRelay/.test(offer), 'it is a question again');
  const wait = Number(/const FALLBACK_AFTER_MS = (\d+);/.exec(MAIN)?.[1]);
  assert.ok(wait > 0 && wait <= 5000, `a failed direct attempt holds files back for ${wait} ms`);
});

/*
 * "Sending should never error."
 *
 * Picking a device that is still connecting, or whose link drops under the offer, used to
 * answer "Couldn't send" and later "Still connecting". Neither is anything a person can act on
 * except by trying again, so the app tries again: the send waits and goes when the link opens.
 */
test('a send to a device that is not ready yet waits for it instead of failing', () => {
  for (const sig of ['async function sendFiles(connId, fileList)', 'async function sendChatMedia(peerId, file, { voice = false, dur = 0 } = {})']) {
    const fn = body(sig);
    const check = fn.indexOf("if (conn.state !== 'ready') return waitToSend(conn, {");
    assert.ok(check > 0, `${sig} refuses a device that is still connecting`);
    assert.ok(check < fn.indexOf('transfers.offer('), `${sig} checks after offering`);
    assert.match(fn, /if \(linkDown\(err\)\) return waitToSend\(conn, \{/, `${sig} gives up when the link drops under it`);
    assert.ok(!/notReady|stillConnecting/.test(fn));
  }
  // What was waiting goes when the link opens, with the outbox and owed deletes.
  assert.match(MAIN, /flushWaitingSends\(conn\)\.catch/);
  assert.match(body('async function flushWaitingSends(conn)'), /conn\.state !== 'ready'/);
  // Text waits in the outbox for any conversation, not only a remembered one.
  const say = body('async function sendChat()');
  assert.match(say, /if \(!conn && !chat\.isDurable\(chatPeerId\)\) return;/);
  assert.match(say, /if \(linkDown\(err\)\)/);
});

test('an offer whose manifest never went leaves nothing behind to go stale', async () => {
  // The files are offered again under a new id once the link is back; the first job must not
  // linger as an offer the other side never saw.
  const { TransferManager } = await import('../web/core/transfer.js');
  const tm = Object.create(TransferManager.prototype);
  tm.out = new Map();
  tm.transport = { chunkSize: 65536 };
  tm.session = { transferKey: async () => null };
  tm._sendCtl = async () => {
    throw new Error('control path is not open');
  };
  await assert.rejects(tm.offer([new File([new Uint8Array(3)], 'a.bin')]), /control path is not open/);
  assert.equal(tm.out.size, 0, 'a job was left behind for an offer that never went');
});
