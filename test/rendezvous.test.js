/**
 * Rendezvous relay tests.
 *
 * The relay is the only server-side component, and its whole security story is:
 * a tag holds at most two sockets, only a subscriber may forward on it, payloads are
 * never inspected, and nothing outlives its TTL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Rendezvous, Bucket, frame, FRAME, GONE, TAG_LEN, ROOM_CAP } from '../server/rendezvous.js';

const TAG_A = Buffer.alloc(TAG_LEN, 0xaa);
const TAG_B = Buffer.alloc(TAG_LEN, 0xbb);

function fakeConn() {
  const conn = {
    tags: new Set(),
    bucket: new Bucket(1e6, 1e6),
    sent: [],
    closed: null,
    send(buf) {
      conn.sent.push(Buffer.from(buf));
    },
    close(code, reason) {
      conn.closed = { code, reason };
    },
  };
  return conn;
}

const typesOf = (conn) => conn.sent.map((b) => b[0]);
const payloadsOf = (conn, type) => conn.sent.filter((b) => b[0] === type).map((b) => b.subarray(1 + TAG_LEN));

test('two subscribers to a tag are told about each other', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();

  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  assert.deepEqual(typesOf(a), [], 'a lone subscriber hears nothing yet');

  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  assert.deepEqual(typesOf(a), [FRAME.PEER_UP]);
  assert.deepEqual(typesOf(b), [FRAME.PEER_UP]);
  rv.close();
});

test('a payload is relayed verbatim to the counterpart, and never echoed back', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  a.sent.length = 0;
  b.sent.length = 0;

  const secret = Buffer.from('an opaque sealed envelope');
  rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, secret));

  assert.deepEqual(payloadsOf(b, FRAME.FORWARD), [secret], 'delivered byte for byte');
  assert.deepEqual(a.sent, [], 'never echoed to the sender');
  rv.close();
});

test('a non-subscriber cannot forward into a tag', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  const outsider = fakeConn();

  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  a.sent.length = 0;
  b.sent.length = 0;

  rv.onFrame(outsider, frame(FRAME.FORWARD, TAG_A, Buffer.from('injected')));

  assert.deepEqual(a.sent, [], 'nothing reaches the members');
  assert.deepEqual(b.sent, []);
  assert.equal(rv.stats.rejected, 1);
  rv.close();
});

test('a third subscriber is refused rather than joining', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  const c = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(c, frame(FRAME.SUBSCRIBE, TAG_A));

  const gone = c.sent.filter((f) => f[0] === FRAME.PEER_GONE);
  assert.equal(gone.length, 1);
  assert.equal(gone[0][1 + TAG_LEN], GONE.FULL);
  assert.equal(c.tags.size, 0, 'and is not registered');
  rv.close();
});

test('leaving notifies the counterpart and frees the tag', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  b.sent.length = 0;

  rv.drop(a);

  const gone = b.sent.filter((f) => f[0] === FRAME.PEER_GONE);
  assert.equal(gone.length, 1);
  assert.equal(gone[0][1 + TAG_LEN], GONE.LEFT);
  assert.equal(a.tags.size, 0);

  rv.drop(b);
  assert.equal(rv.size, 0, 'an empty tag is deleted, not retained');
  rv.close();
});

test('tags are independent of one another', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  const c = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(c, frame(FRAME.SUBSCRIBE, TAG_B));
  b.sent.length = 0;
  c.sent.length = 0;

  rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, Buffer.from('for b')));
  assert.equal(payloadsOf(b, FRAME.FORWARD).length, 1);
  assert.equal(payloadsOf(c, FRAME.FORWARD).length, 0, 'another tag hears nothing');
  rv.close();
});

test('a lone rendezvous expires, a joined one survives', () => {
  let now = 1_000_000;
  const rv = new Rendezvous({ now: () => now });
  const lonely = fakeConn();
  const a = fakeConn();
  const b = fakeConn();

  rv.onFrame(lonely, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_B));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_B));

  now += 130_000; // past the lone TTL, inside the idle TTL
  rv.sweep();

  const expired = lonely.sent.filter((f) => f[0] === FRAME.PEER_GONE);
  assert.equal(expired.length, 1);
  assert.equal(expired[0][1 + TAG_LEN], GONE.EXPIRED);
  assert.equal(rv.size, 1, 'the joined rendezvous is still alive');
  rv.close();
});

test('malformed frames are rejected and a persistent offender is closed', () => {
  const rv = new Rendezvous();
  const bad = fakeConn();
  for (let i = 0; i < 9; i++) rv.onFrame(bad, Buffer.from([0x99]));
  assert.ok(rv.stats.rejected >= 9);
  assert.ok(bad.closed, 'the socket is eventually closed');
  assert.equal(bad.closed.code, 1008);
  rv.close();
});

test('an unknown frame type is rejected, not guessed at', () => {
  const rv = new Rendezvous();
  const c = fakeConn();
  rv.onFrame(c, frame(0x7f, TAG_A, Buffer.from('x')));
  assert.equal(rv.stats.rejected, 1);
  assert.equal(rv.size, 0);
  rv.close();
});

test('an oversized payload is refused', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  b.sent.length = 0;

  rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, Buffer.alloc(300 * 1024)));
  assert.deepEqual(b.sent, []);
  assert.equal(rv.stats.rejected, 1);
  rv.close();
});

test('subscribing twice to the same tag is idempotent', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  assert.equal(a.tags.size, 1);
  assert.equal(rv.size, 1);
  rv.close();
});

test('one socket cannot hoard tags', () => {
  const rv = new Rendezvous();
  const greedy = fakeConn();
  for (let i = 0; i < 80; i++) {
    const tag = Buffer.alloc(TAG_LEN);
    tag.writeUInt32BE(i, 0);
    rv.onFrame(greedy, frame(FRAME.SUBSCRIBE, tag));
  }
  assert.ok(greedy.tags.size <= 64, `expected a cap, saw ${greedy.tags.size}`);
  rv.close();
});

test('the token bucket refills over time and throttles a flood', () => {
  let now = 0;
  const bucket = new Bucket(10, 10, () => now);
  for (let i = 0; i < 10; i++) assert.ok(bucket.take(1));
  assert.ok(!bucket.take(1), 'the burst is spent');
  now += 1000;
  assert.ok(bucket.take(1), 'and refills at the configured rate');
});

test('the relay keeps no payload anywhere', () => {
  const rv = new Rendezvous();
  const a = fakeConn();
  const b = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, Buffer.from('sensitive')));

  const dump = JSON.stringify(rv._tags, (k, v) => (v instanceof Set ? [...v].length : v));
  assert.ok(!dump.includes('sensitive'), 'no payload is retained in relay state');
  rv.close();
});

test('exceeding the rate budget throttles the frame without closing the socket', () => {
  let now = 0;
  const rv = new Rendezvous({ now: () => now });
  const a = fakeConn();
  const b = fakeConn();
  a.bucket = new Bucket(10, 10, () => now); // a deliberately tiny budget
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE, TAG_A));
  b.sent.length = 0;

  const payload = Buffer.alloc(64 * 1024);
  let delivered = 0;
  for (let i = 0; i < 50; i++) {
    rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, payload));
    delivered = b.sent.filter((f) => f[0] === FRAME.FORWARD).length;
  }

  assert.ok(delivered > 0, 'some frames get through');
  assert.ok(delivered < 50, 'and the rest are held back');
  assert.ok(rv.stats.throttled > 0, 'throttling is counted');
  assert.equal(a.closed, null, 'pacing is not a protocol violation, so the socket stays open');
  assert.equal(rv.stats.rejected, 0, 'and no strike is recorded');
  rv.close();
});

test('the budget refills, so a paced sender keeps going', () => {
  let now = 0;
  const bucket = new Bucket(100, 100, () => now);
  assert.ok(bucket.take(100));
  assert.ok(!bucket.take(1));
  now += 500;
  assert.ok(bucket.take(50), 'half a second buys half the rate back');
});

/* ------------------------------------------------------------------- rooms */

const TAG_R = Buffer.alloc(TAG_LEN, 0xcc);

test('a room tag holds more than two members, and each join re-notifies everyone', () => {
  const rv = new Rendezvous();
  const members = [fakeConn(), fakeConn(), fakeConn(), fakeConn()];

  for (const m of members) rv.onFrame(m, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));

  for (const m of members) assert.equal(m.tags.size, 1, 'every member is registered');
  // The first member hears about the second, third and fourth arriving.
  assert.equal(members[0].sent.filter((f) => f[0] === FRAME.PEER_UP).length, 3);
  // The last one hears only about its own arrival.
  assert.equal(members[3].sent.filter((f) => f[0] === FRAME.PEER_UP).length, 1);
  rv.close();
});

test('a room payload reaches every other member and is never echoed back', () => {
  const rv = new Rendezvous();
  const [a, b, c] = [fakeConn(), fakeConn(), fakeConn()];
  for (const m of [a, b, c]) rv.onFrame(m, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  for (const m of [a, b, c]) m.sent.length = 0;

  const hello = Buffer.from('sealed presence');
  rv.onFrame(a, frame(FRAME.FORWARD, TAG_R, hello));

  assert.deepEqual(payloadsOf(b, FRAME.FORWARD), [hello]);
  assert.deepEqual(payloadsOf(c, FRAME.FORWARD), [hello]);
  assert.deepEqual(a.sent, [], 'never echoed to the sender');
  rv.close();
});

test('a tag keeps the mode it was created with, in both directions', () => {
  const rv = new Rendezvous();

  // pair tag, approached as a room
  const a = fakeConn();
  const intruder = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  rv.onFrame(intruder, frame(FRAME.SUBSCRIBE_ROOM, TAG_A));
  assert.equal(intruder.tags.size, 0, 'a pair rendezvous cannot be widened into a room');
  const refused = intruder.sent.filter((f) => f[0] === FRAME.PEER_GONE);
  assert.equal(refused[0][1 + TAG_LEN], GONE.MODE);

  // room tag, approached as a pair
  const r1 = fakeConn();
  const r2 = fakeConn();
  rv.onFrame(r1, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  rv.onFrame(r2, frame(FRAME.SUBSCRIBE, TAG_R));
  assert.equal(r2.tags.size, 0, 'and a room cannot be entered as a two-party rendezvous');
  rv.close();
});

test('a refused mode probe does not leave an empty tag behind', () => {
  const rv = new Rendezvous();
  const probe = fakeConn();
  rv.onFrame(probe, frame(FRAME.SUBSCRIBE, TAG_R));
  probe.sent.length = 0;
  rv.drop(probe);
  assert.equal(rv.size, 0);

  const other = fakeConn();
  rv.onFrame(other, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  assert.equal(other.tags.size, 1, 'the tag is free to be created in the other mode');
  rv.close();
});

test('a room is capped, and the member over the cap is told so', () => {
  const rv = new Rendezvous();
  const members = [];
  for (let i = 0; i < ROOM_CAP + 1; i++) {
    const m = fakeConn();
    members.push(m);
    rv.onFrame(m, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  }
  const last = members[members.length - 1];
  assert.equal(last.tags.size, 0);
  const gone = last.sent.filter((f) => f[0] === FRAME.PEER_GONE);
  assert.equal(gone[0][1 + TAG_LEN], GONE.FULL);
  rv.close();
});

test('a room tag cannot be used to broadcast bulk data', () => {
  const rv = new Rendezvous();
  const [a, b] = [fakeConn(), fakeConn()];
  rv.onFrame(a, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  rv.onFrame(b, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  b.sent.length = 0;

  rv.onFrame(a, frame(FRAME.FORWARD, TAG_R, Buffer.alloc(64 * 1024)));
  assert.deepEqual(b.sent, [], 'a large payload on a room tag is refused');
  assert.equal(rv.stats.rejected, 1);

  // The same payload on a two-party tag is fine: that is the relayed transfer path.
  const [c, d] = [fakeConn(), fakeConn()];
  rv.onFrame(c, frame(FRAME.SUBSCRIBE, TAG_B));
  rv.onFrame(d, frame(FRAME.SUBSCRIBE, TAG_B));
  d.sent.length = 0;
  rv.onFrame(c, frame(FRAME.FORWARD, TAG_B, Buffer.alloc(64 * 1024)));
  assert.equal(payloadsOf(d, FRAME.FORWARD).length, 1);
  rv.close();
});

test('a member leaving a room tells the rest, and the last one out frees the tag', () => {
  const rv = new Rendezvous();
  const [a, b, c] = [fakeConn(), fakeConn(), fakeConn()];
  for (const m of [a, b, c]) rv.onFrame(m, frame(FRAME.SUBSCRIBE_ROOM, TAG_R));
  for (const m of [a, b, c]) m.sent.length = 0;

  rv.drop(b);
  for (const m of [a, c]) {
    const gone = m.sent.filter((f) => f[0] === FRAME.PEER_GONE);
    assert.equal(gone.length, 1);
    assert.equal(gone[0][1 + TAG_LEN], GONE.LEFT);
  }

  rv.drop(a);
  rv.drop(c);
  assert.equal(rv.size, 0);
  rv.close();
});

test('forwarding to a swept tag is refused, which is why the client must re-subscribe', () => {
  let now = 1_000_000;
  const rv = new Rendezvous({ now: () => now });
  const a = fakeConn();
  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));

  now += 130_000; // past the lone TTL
  rv.sweep();
  assert.equal(rv.size, 0, 'the relay garbage-collected the tag under the client');
  a.sent.length = 0;

  // A client that kept forwarding would be counted a protocol offender for a tag it never
  // abandoned. SignalClient re-subscribes on GONE.EXPIRED for exactly this reason.
  rv.onFrame(a, frame(FRAME.FORWARD, TAG_A, Buffer.from('still talking')));
  assert.equal(rv.stats.rejected, 1);

  rv.onFrame(a, frame(FRAME.SUBSCRIBE, TAG_A));
  assert.equal(rv.size, 1, 're-subscribing re-creates it cleanly');
  rv.close();
});
