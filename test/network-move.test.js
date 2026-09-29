/**
 * A device that changes networks is found on the new one.
 *
 * The relay tells a device which network it is on every time the socket connects, and the app
 * only used to listen the first time. A phone that went from Wi-Fi to mobile data, or a laptop
 * carried to another network, kept announcing itself on the network it had left - where it was
 * still visible, over the relay - and never joined the one it was actually on, so nothing
 * nearby could see it until the app was reopened.
 *
 * Reproduced with three browser profiles against a relay that takes the address from
 * X-Forwarded-For: A and B on one network, C on another, then B moved to C's. Before this, B
 * went on seeing A and C saw nobody. After it, within three seconds B saw C, C saw B, A no longer
 * saw B, and moving back reversed all of it.
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

test('a new network label moves the device to that network', () => {
  const on = body('function onNetworkLabel()');
  assert.match(on, /ch\.label !== `net:\$\{label\}`/, 'a changed label is not noticed');
  assert.match(on, /moveNetwork\(\)/);
});

test('moving leaves the old network and joins the new one, keeping a running transfer', () => {
  const move = body('function moveNetwork()');
  assert.match(move, /leaveChannel\(ch, 'local', \{ keepBusy: true \}\)/);
  assert.match(move, /enableLocal\(\)/);
  // One at a time, and a label that changed again meanwhile is followed too.
  assert.match(move, /moving \?\?=/);
  assert.match(body("async function leaveChannel(ch, kind, { keepBusy = false } = {})"), /dropChannelPeer\(key, \{ keepBusy \}\)/);
});
