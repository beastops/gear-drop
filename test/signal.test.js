/**
 * The rendezvous client.
 *
 * It is a transport and nothing else, so what is worth testing is the handful of places
 * where it has to be smarter than a pipe: replaying subscriptions after a reconnect,
 * re-subscribing after the relay sweeps a tag out from under it, and never retrying a
 * refusal.
 *
 * The socket is injected rather than taken from the global, so none of this can reach a
 * real network, and a test that fails cannot leave a reconnect loop running.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SignalClient, FRAME, GONE } from '../web/core/signal.js';

const TAG_A = Uint8Array.from({ length: 16 }, (_, i) => i);
const TAG_B = Uint8Array.from({ length: 16 }, () => 0xbb);

/** The smallest socket SignalClient can drive, and a client wired to it. */
function harness() {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.sent = [];
      this.bufferedAmount = 0;
      sockets.push(this);
    }
    send(data) {
      this.sent.push(new Uint8Array(data));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    /** Complete the handshake. */
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    /** Deliver one inbound frame. */
    deliver(bytes) {
      this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    }
    get types() {
      return this.sent.map((b) => b[0]);
    }
  }

  const client = new SignalClient('ws://relay.test/rv', { socket: (u) => new FakeSocket(u) });
  return {
    client,
    sockets,
    /** Bring up a socket without waiting on the reconnect backoff. */
    connect() {
      client.connect();
      const ws = sockets[sockets.length - 1];
      ws.open();
      return ws;
    },
    /** The backoff timer would otherwise keep the process alive after the test. */
    done() {
      client.close();
    },
  };
}

function frameOf(type, tag, payload) {
  const out = new Uint8Array(17 + (payload ? payload.length : 0));
  out[0] = type;
  out.set(tag, 1);
  if (payload) out.set(payload, 17);
  return out;
}

test('subscriptions are replayed after a reconnect, each keeping its mode', (t) => {
  const h = harness();
  t.after(() => h.done());

  const first = h.connect();
  h.client.subscribe(TAG_A);
  h.client.subscribeRoom(TAG_B);
  assert.deepEqual(first.types, [FRAME.SUBSCRIBE, FRAME.SUBSCRIBE_ROOM]);

  first.close();
  h.client._open(); // stand in for the backoff timer, which is not what is under test
  const second = h.sockets[1];
  assert.ok(second, 'a replacement socket is opened');
  second.open();

  // The relay keeps nothing across a reconnect, so everything is re-announced, and a room
  // has to come back as a room, or the relay would refuse it on mode.
  assert.deepEqual(second.types, [FRAME.SUBSCRIBE, FRAME.SUBSCRIBE_ROOM]);
});

test('a swept tag is re-subscribed, so the client is not counted a protocol offender', (t) => {
  const h = harness();
  t.after(() => h.done());

  const ws = h.connect();
  h.client.subscribeRoom(TAG_B);
  ws.sent.length = 0;

  const seen = [];
  h.client.addEventListener('peer-gone', (e) => seen.push(e.detail.reason));
  ws.deliver(frameOf(FRAME.PEER_GONE, TAG_B, Uint8Array.of(2))); // EXPIRED

  assert.deepEqual(ws.types, [FRAME.SUBSCRIBE_ROOM], 'the tag is re-created, in its own mode');
  assert.deepEqual(seen, ['expired'], 'and the layers above still hear about it');
});

test('a refusal is never retried, because that would be a loop', (t) => {
  const h = harness();
  t.after(() => h.done());

  const ws = h.connect();
  h.client.subscribe(TAG_A);
  ws.sent.length = 0;

  for (const code of [3 /* FULL */, 5 /* MODE */, 1 /* LEFT */]) {
    ws.deliver(frameOf(FRAME.PEER_GONE, TAG_A, Uint8Array.of(code)));
  }
  assert.deepEqual(ws.sent, [], 'none of these mean "the relay garbage-collected the tag"');
});

test('a tag we already dropped is not resurrected by a late expiry', (t) => {
  const h = harness();
  t.after(() => h.done());

  const ws = h.connect();
  h.client.subscribe(TAG_A);
  h.client.unsubscribe(TAG_A);
  ws.sent.length = 0;

  ws.deliver(frameOf(FRAME.PEER_GONE, TAG_A, Uint8Array.of(2)));
  assert.deepEqual(ws.sent, [], 'we asked to leave; an expiry notice does not undo that');
});

test('forwards are queued while offline and flushed after the subscriptions', (t) => {
  const h = harness();
  t.after(() => h.done());

  h.client.connect();
  const ws = h.sockets[0];
  h.client.subscribe(TAG_A);
  h.client.forward(TAG_A, Uint8Array.of(1, 2, 3)); // still connecting
  assert.deepEqual(ws.sent, [], 'nothing goes out before the socket is open');

  ws.open();
  assert.deepEqual(
    ws.types,
    [FRAME.SUBSCRIBE, FRAME.FORWARD],
    'the subscription has to land before anything forwarded on it',
  );
});

test('the offline queue is bounded, so a long outage cannot grow without limit', (t) => {
  const h = harness();
  t.after(() => h.done());

  h.client.connect();
  const ws = h.sockets[0];
  h.client.subscribe(TAG_A);
  for (let i = 0; i < 200; i++) h.client.forward(TAG_A, Uint8Array.of(i & 0xff));

  ws.open();
  const forwarded = ws.types.filter((x) => x === FRAME.FORWARD).length;
  assert.ok(forwarded > 0 && forwarded <= 64, `expected a bounded queue, flushed ${forwarded}`);
});

test('the gone-reason table covers every code the relay can send', () => {
  assert.deepEqual(Object.values(GONE).sort(), ['expired', 'full', 'left', 'mode', 'replaced']);
});
