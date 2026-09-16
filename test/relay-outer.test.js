/**
 * What the relay can read off the fallback path.
 *
 * A bulk frame is a plaintext header followed by ciphertext:
 *
 *     ver(1) lane(1) fileId(4) offset(8) index(4) | AES-256-GCM(chunk)
 *
 * The header has to be legible to the receiver before it can decrypt, because the nonce and the
 * AAD are derived from the file id and the offset — they cannot live inside the thing they
 * unlock. On the direct path that costs nothing: it rides inside DTLS and the peer is the only
 * other party.
 *
 * On the relay path the relay reads it. So the relay knew how many files a transfer held and,
 * from the last offset it forwarded, the exact size of each — while the app's own README said it
 * could not see sizes. Padding the byte count, which is what this work set out to add, would
 * have been theatre: the offset in the clear still answers the question.
 *
 * These drive two real transports through a loopback signal and read what actually lands on the
 * wire. Not the source — the bytes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RelayTransport } from '../web/core/relay-transport.js';

/** A signal that hands every forwarded frame to the other side, and keeps a copy of the wire. */
function loopback() {
  const wire = [];
  const ends = [];
  const hub = {
    wire,
    join(t) {
      ends.push(t);
    },
    connected: true,
    bufferedAmount: 0,
    forward(tag, bytes) {
      wire.push(Uint8Array.from(bytes));
      for (const end of ends) {
        end.dispatch({ key: 'tag', payload: Uint8Array.from(bytes) });
      }
    },
  };
  return hub;
}

/** Enough of a signal client for one transport: it listens, and it forwards to the hub. */
function sideOf(hub) {
  const listeners = [];
  return {
    connected: true,
    bufferedAmount: 0,
    addEventListener: (_n, fn) => listeners.push(fn),
    removeEventListener: () => {},
    forward: (tag, bytes) => hub.forward(tag, bytes),
    dispatch: (detail) => listeners.forEach((fn) => fn({ detail })),
  };
}

/** Two transports keyed the same, facing each other, with `lane` splitting the nonces. */
async function pair() {
  const hub = loopback();
  const K = new Uint8Array(32).fill(7);
  const make = (lane) => {
    const signal = sideOf(hub);
    hub.join(signal);
    return new RelayTransport({ signal, tag: new Uint8Array(16), tagKey: 'tag', K, lane });
  };
  return { hub, a: make(0), b: make(1) };
}

/** A bulk frame shaped the way the transfer engine shapes one, with a findable offset. */
function bulkFrame(fileId, offset) {
  const frame = new Uint8Array(18 + 64);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(2, fileId, true);
  new DataView(frame.buffer).setBigUint64(6, BigInt(offset), true);
  frame.fill(0xab, 18);
  return frame;
}

const seen = (t, type) =>
  new Promise((resolve) => t.addEventListener(type, (e) => resolve(e.detail), { once: true }));

test('a frame arrives at the far end exactly as it was sent', async () => {
  const { a, b } = await pair();
  const sent = bulkFrame(0x11223344, 4_294_967_296);
  const got = seen(b, 'chunk');
  a.send(0, sent);
  const { data } = await got;
  assert.deepEqual(Uint8Array.from(data), sent, 'the outer seal is not transparent to the engine');
});

test('and the relay sees none of the header it used to read', async () => {
  const { hub, a } = await pair();
  // A file id and an offset chosen so that finding them in the wire bytes means something.
  const fileId = 0xdeadbeef;
  const offset = 0x0102030405;
  a.send(0, bulkFrame(fileId, offset));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(hub.wire.length, 1, 'expected exactly one frame on the wire');
  const onWire = hub.wire[0];

  const hunt = (needle) => {
    outer: for (let i = 0; i + needle.length <= onWire.length; i++) {
      for (let j = 0; j < needle.length; j++) if (onWire[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };

  const idBytes = new Uint8Array(4);
  new DataView(idBytes.buffer).setUint32(0, fileId, true);
  const offBytes = new Uint8Array(8);
  new DataView(offBytes.buffer).setBigUint64(0, BigInt(offset), true);

  assert.ok(!hunt(idBytes), 'the file id is on the wire, so the relay can count the files');
  assert.ok(!hunt(offBytes), 'the offset is on the wire, so the relay can read the exact file size');
  assert.ok(!hunt(new Uint8Array(8).fill(0xab)), 'the chunk body is on the wire');
});

test('what is left on the wire is a type byte, a counter and ciphertext', async () => {
  const { hub, a } = await pair();
  a.send(0, bulkFrame(1, 0));
  await new Promise((r) => setTimeout(r, 30));
  const onWire = hub.wire[0];
  // 0x15 is the only type the relay ever sees now — control, bulk and padding are
  // indistinguishable from outside, which is the point of sealing the inner type.
  assert.equal(onWire[0], 0x15, 'the relay can still tell the frame types apart');
  assert.ok(onWire.length > 5 + 16, 'there is no room for a tag, so nothing was sealed');
});

test('control and bulk are the same shape from outside', async () => {
  const { hub, a } = await pair();
  const body = new Uint8Array(64).fill(3);
  a.sendCtl(body);
  a.send(0, new Uint8Array(64 + 18));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(hub.wire[0][0], hub.wire[1][0], 'a control frame is distinguishable from a data frame');
});

test('padding reaches the wire and never reaches the engine', async () => {
  const { hub, a, b } = await pair();
  let chunks = 0;
  b.addEventListener('chunk', () => chunks++);

  a.send(0, bulkFrame(1, 0));
  await new Promise((r) => setTimeout(r, 30));
  const afterData = hub.wire.length;
  assert.equal(chunks, 1, 'the data frame did not arrive');

  // The connection goes quiet, and tops itself up to the next bucket.
  await new Promise((r) => setTimeout(r, 900));
  assert.ok(hub.wire.length > afterData, 'nothing was padded, so the byte count is still the answer');
  assert.equal(chunks, 1, 'padding was delivered to the transfer engine as if it were data');
});
