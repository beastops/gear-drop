/**
 * Discovery channels.
 *
 * A channel is a shared secret several devices hold at once: a room code, or the opaque
 * network label the relay hands out. The properties that matter:
 *
 *   the tag the relay sees reveals nothing about the code, and rotates
 *   two members compute the same meeting tag without agreeing who is first
 *   a pairing hint is recognisable only to a device holding the same root, and rotates
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelKey,
  channelPairTag,
  channelSecret,
  channelTag,
  newRoomCode,
  normalizeCode,
  pairHint,
  roomEpoch,
  seal,
  open,
  ROOM_CODE_LEN,
  ROOM_EPOCH_SECONDS,
} from '../web/core/gdcrypto.js';
import { concat, randomBytes, te, td, toHex, pad, unpad } from '../web/core/bytes.js';
import { Channel } from '../web/core/channel.js';

test('room codes are five characters from the unambiguous alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = newRoomCode();
    assert.equal(code.length, ROOM_CODE_LEN);
    assert.equal(normalizeCode(code), code, `${code} should survive normalisation unchanged`);
  }
});

test('a room code maps to a tag that does not contain it', async () => {
  const code = 'GGHJ8';
  const secret = await channelSecret(`room:${code}`);
  const tag = await channelTag(secret, roomEpoch());

  assert.equal(tag.length, 16);
  assert.ok(!toHex(tag).includes(Buffer.from(code).toString('hex')));
  assert.ok(!toHex(secret).includes(Buffer.from(code).toString('hex')));
});

test('the same room code gives the same tag on both devices, in the same epoch', async () => {
  const a = await channelTag(await channelSecret('room:GGHJ8'), 4242);
  const b = await channelTag(await channelSecret('room:GGHJ8'), 4242);
  assert.deepEqual(a, b);
});

test('a different room code gives an unrelated tag', async () => {
  const a = await channelTag(await channelSecret('room:GGHJ8'), 4242);
  const b = await channelTag(await channelSecret('room:GGHJ9'), 4242);
  assert.notDeepEqual(a, b);
});

test('the tag rotates, so the relay cannot recognise a room an hour later', async () => {
  const secret = await channelSecret('room:GGHJ8');
  const now = await channelTag(secret, 4242);
  const next = await channelTag(secret, 4243);
  assert.notDeepEqual(now, next);
  assert.equal(ROOM_EPOCH_SECONDS, 3600);
});

test('two members compute the same meeting tag regardless of who speaks first', async () => {
  const secret = await channelSecret('room:GGHJ8');
  const alice = randomBytes(16);
  const bob = randomBytes(16);

  const fromAlice = await channelPairTag(secret, alice, bob);
  const fromBob = await channelPairTag(secret, bob, alice);
  assert.deepEqual(fromAlice, fromBob, 'the pair tag must be symmetric');
  assert.equal(fromAlice.length, 16);
});

test('a third member in the room meets each of them somewhere else entirely', async () => {
  const secret = await channelSecret('room:GGHJ8');
  const [a, b, c] = [randomBytes(16), randomBytes(16), randomBytes(16)];

  const ab = toHex(await channelPairTag(secret, a, b));
  const ac = toHex(await channelPairTag(secret, a, c));
  const bc = toHex(await channelPairTag(secret, b, c));
  assert.equal(new Set([ab, ac, bc]).size, 3, 'every pair gets its own two-party rendezvous');
});

test('the meeting tag depends on the channel secret, not only on the two members', async () => {
  const [a, b] = [randomBytes(16), randomBytes(16)];
  const inRoom = await channelPairTag(await channelSecret('room:GGHJ8'), a, b);
  const onNetwork = await channelPairTag(await channelSecret('net:abc123'), a, b);
  assert.notDeepEqual(inRoom, onNetwork);
});

test('a presence announcement is sealed to the channel and unreadable without the code', async () => {
  const hello = { t: 'hi', id: toHex(randomBytes(16)), name: 'Rose Bear', kind: 'phone' };
  const body = pad(te.encode(JSON.stringify(hello)), 256);
  const nonce = randomBytes(12);

  const key = await channelKey(await channelSecret('room:GGHJ8'));
  const ct = await seal(key, nonce, body, te.encode('gd/chan'));

  // Someone in the room reads it.
  const same = await channelKey(await channelSecret('room:GGHJ8'));
  assert.deepEqual(JSON.parse(td.decode(unpad(await open(same, nonce, ct, te.encode('gd/chan'))))), hello);

  // The relay, and anyone in a different room, cannot.
  const other = await channelKey(await channelSecret('room:GGHJ9'));
  await assert.rejects(() => open(other, nonce, ct, te.encode('gd/chan')));

  // And the name is not sitting in the ciphertext.
  assert.ok(!toHex(ct).includes(Buffer.from('Rose Bear').toString('hex')));
});

test('presence frames are padded, so a long name and a short one look alike', async () => {
  const key = await channelKey(await channelSecret('room:GGHJ8'));
  const nonce = randomBytes(12);
  const size = async (name) => {
    const body = pad(te.encode(JSON.stringify({ t: 'hi', id: 'a'.repeat(32), name, kind: 'laptop' })), 256);
    return (await seal(key, nonce, body, te.encode('gd/chan'))).length;
  };
  assert.equal(await size('Al'), await size('A considerably longer device name'));
});

test('a pairing hint is recognised by the device holding the same root', async () => {
  const root = randomBytes(32);
  const epoch = 1000;
  assert.equal(await pairHint(root, epoch), await pairHint(root, epoch), 'both ends compute the same hint');
});

test('a pairing hint means nothing without the root, and rotates', async () => {
  const mine = randomBytes(32);
  const theirs = randomBytes(32);

  assert.notEqual(await pairHint(mine, 1000), await pairHint(theirs, 1000), 'a stranger cannot match it');
  assert.notEqual(await pairHint(mine, 1000), await pairHint(mine, 1001), 'and it is unlinkable across epochs');
  assert.equal((await pairHint(mine, 1000)).length, 16, '8 bytes, as hex');
});

test('a hint does not leak the root it came from', async () => {
  const root = randomBytes(32);
  const hint = await pairHint(root, roomEpoch());
  assert.ok(!toHex(root).includes(hint));
});

test('the channel secret never appears in anything the relay sees', async () => {
  const secret = await channelSecret('room:GGHJ8');
  const tag = await channelTag(secret, roomEpoch());
  const pairTag = await channelPairTag(secret, randomBytes(16), randomBytes(16));
  const hex = toHex(secret);

  for (const visible of [toHex(tag), toHex(pairTag)]) {
    assert.ok(!hex.includes(visible), 'a tag is not a prefix of the secret');
    assert.ok(!visible.includes(hex), 'and the secret is not embedded in a tag');
  }
});

test('concat of tag material stays the length the relay expects', async () => {
  const secret = await channelSecret('net:deadbeef');
  const tag = await channelTag(secret, roomEpoch());
  assert.equal(concat(tag).length, 16, 'a rendezvous tag is exactly 16 bytes on the wire');
});

/* ------------------------------------------------------- leaving promptly */

test('a departure is sealed before it is needed, and sends without awaiting', async () => {
  /*
   * A tab that closes has no time to encrypt. Any promise started in `pagehide` is unlikely
   * to finish, so a goodbye that has to be sealed at that moment never arrives. The only
   * thing left to remove the device from everyone's screen is then the staleness timeout, a
   * minute and a half later, and until it fires a closed tab sits on the radar of every
   * device on the network, tappable, connecting to nothing.
   */
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = () => {};
  signal.unsubscribe = () => {};
  signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  const ch = new Channel(signal, { kind: 'local', label: 'net-label', self: { name: 'Laptop', kind: 'laptop' } });
  await ch.join();
  sent.length = 0;

  // The goodbye must already exist by the time anyone needs it...
  assert.ok(ch._bye, 'a departure was prepared in advance');

  // ...and going must cost nothing but a send. No awaiting, no encryption.
  ch.sayGoodbyeNow();
  assert.ok(sent.length > 0, 'the goodbye went out synchronously');

  // It decrypts to a departure naming this member, so the other side knows who left.
  const frame = sent[0];
  const key = await channelKey(await channelSecret('net-label'));
  const body = await open(key, frame.subarray(1, 13), frame.subarray(13), te.encode('gd/chan'));
  const msg = JSON.parse(td.decode(unpad(body)));
  assert.equal(msg.t, 'bye');
  assert.equal(msg.id, ch.idKey);

  await ch.leave(); // joining starts beacons; leaving them running hangs the run
});

test('a goodbye is used once, so its nonce is never repeated', async () => {
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  const ch = new Channel(signal, { kind: 'local', label: 'net', self: { name: 'A', kind: 'laptop' } });
  await ch.join();
  sent.length = 0;

  ch.sayGoodbyeNow();
  const first = sent.length;
  ch.sayGoodbyeNow();
  assert.equal(sent.length, first, 'the second call sends nothing');

  await ch.leave();
});

test('a member that came back announces itself again', async () => {
  /*
   * The goodbye above is sent on `pagehide`, which fires on the way into the back/forward
   * cache as well as on the way out of the tab. A page restored from that cache has already
   * been forgotten by everyone who heard it leave, and nothing about the restore is visible
   * to them, so it has to speak first or sit invisible until the next beacon.
   */
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  const ch = new Channel(signal, { kind: 'local', label: 'net', self: { name: 'A', kind: 'laptop' } });
  await ch.join();
  ch.sayGoodbyeNow();
  sent.length = 0;

  await ch.hello();
  // One per tag the channel holds: this hour's and the one before it, so a device that
  // joined either side of the boundary hears it.
  assert.equal(sent.length, ch._tags.size, 'coming back did not reach every tag');

  const key = await channelKey(await channelSecret('net'));
  const frame = sent[0];
  const body = await open(key, frame.subarray(1, 13), frame.subarray(13), te.encode('gd/chan'));
  const msg = JSON.parse(td.decode(unpad(body)));
  assert.equal(msg.t, 'hi');
  assert.equal(msg.id, ch.idKey);

  await ch.leave();
});

test('a channel that was never joined has nothing to say', async () => {
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  const ch = new Channel(signal, { kind: 'local', label: 'net', self: { name: 'A', kind: 'laptop' } });
  await ch.hello();
  assert.equal(sent.length, 0, 'an unjoined channel announced itself');
});

/* ------------------------------------------- recognising a device already paired */

test('a hint list is read at announce time, not frozen when the channel is built', async () => {
  /*
   * A presence announcement carries one rotating hint per paired device; a device holding
   * the same root recognises it and stays on the pairing it has rather than opening a
   * second conversation as a stranger. The list is asked for on every announce, because
   * pairing with someone changes it and so does the epoch rolling over.
   */
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  let current = [];
  const ch = new Channel(signal, {
    kind: 'local',
    label: 'net',
    self: { name: 'A', kind: 'laptop' },
    hints: async () => current,
  });
  await ch.join();

  const key = await channelKey(await channelSecret('net'));
  const readBack = async (frame) => {
    const body = await open(key, frame.subarray(1, 13), frame.subarray(13), te.encode('gd/chan'));
    return JSON.parse(td.decode(unpad(body)));
  };

  assert.deepEqual((await readBack(sent[0])).h, [], 'nothing is paired yet, so nothing is hinted');

  current = ['39beccc2919522db'];
  sent.length = 0;
  await ch.hello();
  assert.deepEqual(
    (await readBack(sent[0])).h,
    ['39beccc2919522db'],
    'a pairing made after joining was not announced',
  );

  await ch.leave();
});

test('a goodbye carries no hints', async () => {
  // A departure names the member and nothing else: hints are for being recognised on
  // arrival, and one attached to a farewell would be a linkable identifier for free.
  const sent = [];
  const signal = new EventTarget();
  signal.subscribe = signal.unsubscribe = signal.subscribeRoom = () => {};
  signal.forward = (tag, payload) => sent.push(payload);

  const ch = new Channel(signal, {
    kind: 'local',
    label: 'net',
    self: { name: 'A', kind: 'laptop' },
    hints: async () => ['39beccc2919522db'],
  });
  await ch.join();
  sent.length = 0;
  ch.sayGoodbyeNow();

  const key = await channelKey(await channelSecret('net'));
  const body = await open(key, sent[0].subarray(1, 13), sent[0].subarray(13), te.encode('gd/chan'));
  const msg = JSON.parse(td.decode(unpad(body)));
  assert.equal(msg.t, 'bye');
  assert.ok(!msg.h?.length, 'a hint rode along on a departure');

  await ch.leave();
});

test('the pairing list is loaded before the app announces itself', async () => {
  /*
   * The ordering the two tests above depend on, asserted where it actually lives.
   *
   * `onNetworkLabel` joins the local channel, and joining announces immediately. Run before
   * the paired devices have been read out of the database, that first announcement carries no
   * hints, so every device on the network that already knows this one sees a stranger, opens a
   * second conversation and throws it away a moment later: two handshakes and two arrival
   * banners for one device, with nothing in the log to say why.
   */
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../web/main.js', import.meta.url), 'utf8');
  const loaded = src.indexOf('await refreshPaired();');
  const announced = src.indexOf('if (networkArrived) onNetworkLabel();');
  assert.ok(loaded > 0 && announced > 0, 'boot no longer looks like this; check this test');
  assert.ok(loaded < announced, 'presence is announced before the pairing list is read');
});
