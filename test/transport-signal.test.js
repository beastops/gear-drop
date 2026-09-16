/**
 * What the peer is allowed to ask the transport to do.
 *
 * These messages are sealed, and since key confirmation they provably come from the device
 * we agreed a key with. That rules out a stranger on the relay and nothing else: in a room
 * the code is shared by everyone in it, so "the peer" is any member, and a member who has
 * modified their client sends whatever they like.
 *
 * A lane is an entire RTCPeerConnection. Letting the number that selects one arrive
 * unchecked was two separate ways to end someone else's session from across a room.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/** Just enough RTCPeerConnection to let the signalling paths run. */
class FakePC {
  static made = 0;
  constructor() {
    FakePC.made++;
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.sctp = { maxMessageSize: 65536 };
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.ondatachannel = null;
    this.added = [];
  }
  createDataChannel() {
    return { readyState: 'connecting', send() {}, close() {} };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA\r\n' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 BB\r\n' };
  }
  async setLocalDescription(d) {
    this.localDescription = d;
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
  }
  async addIceCandidate(c) {
    this.added.push(c);
  }
  close() {}
}
globalThis.RTCPeerConnection = FakePC;

const { Transport } = await import('../web/core/transport.js');

/** A session stand-in that records what the transport tries to send back. */
function fakeSession() {
  const s = new EventTarget();
  s.lane = 0;
  s.generation = 0;
  s.sent = [];
  s.send = (m) => {
    s.sent.push(m);
    return Promise.resolve();
  };
  s.computeSas = async (a, b) => {
    s.sas = `${a}|${b}`;
  };
  return s;
}

const settle = () => new Promise((r) => setTimeout(r, 10));
const OFFER = 'v=0\r\na=fingerprint:sha-256 CC\r\n';

test('a lane number outside the cap is refused', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});
  FakePC.made = 0;

  for (const lane of [4, 5, 99, 1_000_000, 2 ** 31]) {
    await t._onSignal({ t: 'offer', gen: 0, lane, sdp: OFFER });
  }
  await settle();
  assert.equal(FakePC.made, 0, 'no peer connection is built for a lane that cannot exist');
});

test('a peer cannot ask for a thousand peer connections', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});
  FakePC.made = 0;

  for (let lane = 0; lane < 1000; lane++) {
    await t._onSignal({ t: 'offer', gen: 0, lane, sdp: OFFER });
  }
  await settle();
  assert.ok(FakePC.made <= 4, `at most the lane cap, got ${FakePC.made}`);
});

test('a lane number that is not a number cannot replace the array it indexes', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});

  // `lanes['__proto__'] = lane` does not add an element; it swaps the array's prototype,
  // and every method on it disappears. One message, and the transport is over.
  for (const lane of ['__proto__', 'constructor', 'length', -1, 1.5, '0', null, {}]) {
    await t._onSignal({ t: 'offer', gen: 0, lane, sdp: OFFER });
  }
  await settle();

  assert.ok(Array.isArray(t.lanes), 'lanes is still an array');
  assert.equal(Object.getPrototypeOf(t.lanes), Array.prototype, 'with its prototype intact');
  assert.equal(typeof t.lanes.reduce, 'function', 'and its methods');
});

test('an oversized description is refused before it reaches the browser', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});
  FakePC.made = 0;
  await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp: 'v=0\r\n' + 'a=x\r\n'.repeat(200000) });
  await settle();
  assert.equal(FakePC.made, 0);

  // And an SDP that is not a string at all.
  for (const sdp of [null, 42, {}, ['v=0']]) {
    await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp });
  }
  assert.equal(FakePC.made, 0);
});

test('candidates queued before a description cannot grow without limit', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});

  for (let i = 0; i < 5000; i++) {
    await t._onSignal({ t: 'ice', gen: 0, lane: 0, cand: { candidate: `c${i}` } });
  }
  const queued = t._pending.get(0) || [];
  assert.ok(queued.length <= 64, `held at most the cap, got ${queued.length}`);
});

test('an ordinary offer still works', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});
  FakePC.made = 0;

  await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp: OFFER });
  await settle();

  assert.equal(FakePC.made, 1, 'one lane, built as asked');
  const answer = session.sent.find((m) => m.t === 'answer');
  assert.ok(answer, 'and answered');
  assert.equal(answer.lane, 0);
  assert.ok(session.sas, 'with the safety words computed from the real fingerprints');
});

test('the words are recomputed when the peer renegotiates with a new certificate', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});

  await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp: 'v=0\r\na=fingerprint:sha-256 CC\r\n' });
  await settle();
  const first = session.sas;
  assert.ok(first);

  // The same peer, offering again with a different certificate. Computing the words once
  // and never again left the screen showing a statement about a connection that had been
  // replaced underneath it.
  await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp: 'v=0\r\na=fingerprint:sha-256 DD\r\n' });
  await settle();
  assert.notEqual(session.sas, first, 'new certificate, new words');
});

test('signalling from a previous generation is ignored', async () => {
  const session = fakeSession();
  const t = new Transport(session, {});
  FakePC.made = 0;
  await t._onSignal({ t: 'offer', gen: 7, lane: 0, sdp: OFFER });
  await settle();
  assert.equal(FakePC.made, 0);
});

test('a transport with nothing open stops claiming it is carrying traffic', async () => {
  /*
   * The flag that decides whether a peer republishing its share is worth answering.
   *
   * A session that believes its transport is live deliberately ignores handshake frames, and that
   * is what stops a stranger on the rendezvous re-keying a working connection. It only works
   * while the belief is true. The flag was cleared when the peer connection changed state, and
   * a data channel that closes on its own changes no state at all, so a transport could sit
   * with every lane shut and the flag still set. The peer, which has restarted and is
   * republishing, gets ignored for as long as that lasts: one side up around a transport with
   * nothing open, the other trying to come back and being answered by nobody.
   */
  const session = fakeSession();
  const t = new Transport(session, {});
  await t._onSignal({ t: 'offer', gen: 0, lane: 0, sdp: OFFER });
  await settle();

  const lane = t.lanes[0];
  assert.ok(lane, 'no lane was built to close');

  // Bring the lane up the way a real one comes up, then close it without touching the
  // connection state, which is what a channel closing by itself looks like.
  const dc = { binaryType: '', bufferedAmountLowThreshold: 0 };
  t._attachBulk(lane, dc);
  dc.onopen();
  assert.equal(session.transportLive, true, 'an open lane is not reported as carrying traffic');

  dc.onclose();
  assert.equal(lane.ready, false, 'the lane is still marked ready');
  assert.equal(session.transportLive, false, 'a transport with no open lane still claims to be live');
});
