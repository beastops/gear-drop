/**
 * Messages, and the control channel they travel on.
 *
 * Files get most of the attention because they are big, but a message is the thing most
 * likely to contain a sentence someone would mind being read. It rides the same sealed
 * control channel as the file manifests, and this pins the properties that make that true:
 * a separate key, a nonce that cannot repeat, length hidden by padding, and replays
 * refused.
 *
 * The scheme is reproduced here from its parts rather than driving a live connection,
 * because what is being asserted is the construction itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { hkdf, aeadKey, seal, open } from '../web/core/gdcrypto.js';
import { te, td, pad, unpad, u64le, randomBytes, toHex } from '../web/core/bytes.js';
import { ReplayWindow } from '../web/core/session.js';

const CTL_BLOCK = 256;
const TEXT_BLOCK = 1024;
const AAD = te.encode('gd/ctl');

const ctlKey = (K) => hkdf(K, 'gd/ctl/v1', 32).then(aeadKey);

function nonceFor(lane, seq) {
  const n = new Uint8Array(12);
  n[0] = lane;
  n.set(u64le(seq), 4);
  return n;
}

async function sendCtl(key, lane, seq, obj, block) {
  return seal(key, nonceFor(lane, seq), pad(te.encode(JSON.stringify(obj)), block), AAD);
}

test('a message is encrypted under a key of its own, not the signalling key', async () => {
  const K = randomBytes(32);
  const ctl = await ctlKey(K);
  const sig = await aeadKey(await hkdf(K, 'gd/sig/v1', 32));
  const xfer = await aeadKey(await hkdf(K, 'gd/xfer/v1', 32));

  const ct = await sendCtl(ctl, 0, 0, { t: 'text', body: 'meet me at six' }, TEXT_BLOCK);

  // Each purpose has its own key, so compromising one does not read another.
  await assert.rejects(() => open(sig, nonceFor(0, 0), ct, AAD), 'the signalling key must not open it');
  await assert.rejects(() => open(xfer, nonceFor(0, 0), ct, AAD), 'nor the payload key');

  const back = JSON.parse(td.decode(unpad(await open(ctl, nonceFor(0, 0), ct, AAD))));
  assert.equal(back.body, 'meet me at six');
});

test('the message never appears in the ciphertext', async () => {
  const ctl = await ctlKey(randomBytes(32));
  const secret = 'the answer is 42';
  const ct = await sendCtl(ctl, 0, 1, { t: 'text', body: secret }, TEXT_BLOCK);
  assert.ok(!toHex(ct).includes(toHex(te.encode(secret))), 'no plaintext survives');
});

test('two messages of very different lengths are the same size on the wire', async () => {
  const ctl = await ctlKey(randomBytes(32));
  const short = await sendCtl(ctl, 0, 0, { t: 'text', body: 'ok' }, TEXT_BLOCK);
  const long = await sendCtl(ctl, 0, 1, { t: 'text', body: 'x'.repeat(700) }, TEXT_BLOCK);

  assert.equal(short.length, long.length, 'a relay cannot tell a word from a paragraph');
  assert.equal(short.length, TEXT_BLOCK + 16, 'one block plus the GCM tag');
});

test('a file name is hidden the same way', async () => {
  const ctl = await ctlKey(randomBytes(32));
  const a = await sendCtl(ctl, 0, 0, { t: 'manifest', files: [{ name: 'a.jpg', size: 1 }] }, CTL_BLOCK);
  const b = await sendCtl(
    ctl,
    0,
    1,
    { t: 'manifest', files: [{ name: 'quarterly-results-final-v3.xlsx', size: 1 }] },
    CTL_BLOCK,
  );
  assert.equal(a.length, b.length, 'the length of a name is not readable from the ciphertext');
});

test('the two directions never share a nonce', async () => {
  // The peer with the lower CPace share owns lane 0, the other lane 1, so both sides can
  // count from zero without ever colliding.
  const seen = new Set();
  for (const lane of [0, 1]) {
    for (let seq = 0; seq < 64; seq++) seen.add(toHex(nonceFor(lane, seq)));
  }
  assert.equal(seen.size, 128, 'every (lane, sequence) pair is a distinct nonce');
});

test('a message cannot be replayed', async () => {
  const window = new ReplayWindow();
  assert.ok(window.accept(0));
  assert.ok(!window.accept(0), 'the same frame twice is refused');
  assert.ok(window.accept(5), 'a gap is fine; frames may arrive out of order');
  assert.ok(window.accept(1), 'and a straggler inside the window still lands');
  assert.ok(!window.accept(5), 'but not twice');
});

test('a tampered message does not decrypt into anything', async () => {
  const ctl = await ctlKey(randomBytes(32));
  const ct = await sendCtl(ctl, 0, 0, { t: 'text', body: 'transfer £10' }, TEXT_BLOCK);

  const flipped = Uint8Array.from(ct);
  flipped[40] ^= 0x01; // one bit, in the middle of the ciphertext
  await assert.rejects(() => open(ctl, nonceFor(0, 0), flipped, AAD), 'GCM refuses it whole');

  // And a frame moved to a different sequence number fails too: the nonce is the binding.
  await assert.rejects(() => open(ctl, nonceFor(0, 1), ct, AAD), 'a replayed-at-a-new-seq frame');
});

test('the associated data binds a control frame to being a control frame', async () => {
  const ctl = await ctlKey(randomBytes(32));
  const ct = await sendCtl(ctl, 0, 0, { t: 'text', body: 'hello' }, TEXT_BLOCK);
  await assert.rejects(
    () => open(ctl, nonceFor(0, 0), ct, te.encode('gd/sig')),
    'it cannot be passed off as a signalling frame',
  );
});

test('a different session cannot read any of it', async () => {
  const mine = await ctlKey(randomBytes(32));
  const theirs = await ctlKey(randomBytes(32));
  const ct = await sendCtl(mine, 0, 0, { t: 'text', body: 'private' }, TEXT_BLOCK);
  await assert.rejects(() => open(theirs, nonceFor(0, 0), ct, AAD));
});
