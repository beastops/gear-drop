/**
 * The handshake, and what an attacker on the rendezvous can do to it.
 *
 * Signalling always goes through the relay, even when the file transfer itself ends up on a
 * direct WebRTC path, so every frame these sessions exchange passes through a party that can
 * drop, duplicate or invent frames. The tests below assume that position: the attacker is not
 * guessing the code, they are on the wire.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SecureSession } from '../web/core/session.js';
import { toHex } from '../web/core/bytes.js';

const F_CPACE = 0x10;
const F_CONFIRM = 0x14;
const F_SEALED = 0x11;

/** A relay that both peers are subscribed to, and that a test can also speak on. */
class Bus {
  constructor() {
    this.ends = new Set();
    this.iceConfig = { iceServers: [] };
  }
  end() {
    const ep = new EventTarget();
    ep.bus = this;
    ep.subscribe = () => {};
    ep.unsubscribe = () => {};
    ep.subscribeRoom = () => {};
    ep.forward = (tag, payload) => {
      // Delivered to the other subscriber, the way the relay forwards on a two-socket tag.
      for (const other of this.ends) {
        if (other === ep) continue;
        queueMicrotask(() =>
          other.dispatchEvent(
            new CustomEvent('frame', { detail: { key: toHex(tag), payload } }),
          ),
        );
      }
    };
    this.ends.add(ep);
    return ep;
  }
  /** What the relay operator can do: put any bytes on the tag, addressed to one peer. */
  inject(target, tag, payload) {
    target.dispatchEvent(new CustomEvent('frame', { detail: { key: toHex(tag), payload } }));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/**
 * Wait for a condition rather than for a duration.
 *
 * The handshake costs two elliptic-curve operations and a round trip more than it used to,
 * so a fixed pause that was comfortable before is marginal under a loaded test run.
 */
async function until(fn, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await settle();
  }
  return fn();
}

async function pair(code = 'AB12C') {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(7);
  const a = new SecureSession(bus.end(), { tag, code });
  const b = new SecureSession(bus.end(), { tag, code });
  a.start();
  b.start();
  await until(() => a.established && b.established);
  return { bus, tag, a, b };
}

test('two peers with the same code reach the same key', async () => {
  const { a, b } = await pair();
  assert.ok(a.established && b.established);
  assert.equal(toHex(a.K), toHex(b.K), 'the shared secret matches');
  assert.notEqual(a.lane, b.lane, 'and they take opposite nonce lanes');
});

test('a sealed message survives the round trip', async () => {
  const { a, b } = await pair();
  const got = new Promise((r) => b.addEventListener('message', (e) => r(e.detail)));
  await a.send({ t: 'hello', v: 1 });
  assert.deepEqual(await got, { t: 'hello', v: 1 });
});

/* --------------------------------------------------- the attacks */

test('an injected frame cannot silence the channel', async () => {
  const { bus, tag, a, b } = await pair();

  // One frame. Nine bytes of header, no valid ciphertext, a counter near 2^63. The relay
  // needs no key to send it and gets no error back.
  const poison = new Uint8Array(9 + 16);
  poison[0] = F_SEALED;
  new DataView(poison.buffer).setBigUint64(1, 2n ** 62n, true);
  bus.inject(b.signal, tag, poison);
  await settle();

  // Everything the other side says from here on is ordinary, correctly sealed traffic.
  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));
  await a.send({ t: 'ice', c: 'candidate:1' });
  await a.send({ t: 'ice', c: 'candidate:2' });
  await settle();

  assert.deepEqual(
    heard,
    [
      { t: 'ice', c: 'candidate:1' },
      { t: 'ice', c: 'candidate:2' },
    ],
    'a frame that does not authenticate must not be able to move the replay window',
  );
});

test('an injected frame cannot consume a counter the real peer has not used yet', async () => {
  const { bus, tag, a, b } = await pair();

  /*
   * Subtler than shutting the channel: claim the next few counters so that specific messages
   * from the real peer are dropped while the connection still looks healthy.
   *
   * Two of them, deliberately. Three unopenable frames is what the divergence detector reads
   * as the two sides being keyed against different peers, and it re-keys. That is correct
   * behaviour and the wrong thing to have running underneath a test about the replay window:
   * whether the new handshake finished before the assertion ran was down to the scheduler.
   */
  for (let c = 0; c < 2; c++) {
    const f = new Uint8Array(9 + 16);
    f[0] = F_SEALED;
    new DataView(f.buffer).setBigUint64(1, BigInt(c), true);
    bus.inject(b.signal, tag, f);
  }
  await settle();

  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));
  await a.send({ t: 'offer', sdp: 'v=0…' });
  await settle();

  assert.deepEqual(heard, [{ t: 'offer', sdp: 'v=0…' }], 'the real offer must still arrive');
});

test('a session is not established until the peer proves it holds the key', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(9);
  const victim = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const errors = [];
  victim.addEventListener('error', (e) => errors.push(e.detail?.message));
  victim.start();
  await settle();

  // The attacker does not know the code. CPace still yields a key on our side, just not the
  // same key, so nothing about the group element itself gives them away.
  const wrong = new Uint8Array(33);
  wrong[0] = F_CPACE;
  // A valid ristretto255 element: the one the victim just published, echoed back.
  wrong.set(victim._cpace.msg, 1);
  bus.inject(victim.signal, tag, wrong);
  await settle();

  assert.equal(
    victim.established,
    false,
    'keying with someone who cannot confirm the key must not count as a connection',
  );
});

test('a peer that echoes our own share back is refused', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(3);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  s.start();
  await settle();

  const reflect = new Uint8Array(33);
  reflect[0] = F_CPACE;
  reflect.set(s._cpace.msg, 1);
  bus.inject(s.signal, tag, reflect);
  await settle();
  assert.equal(s.established, false, 'a mirror is not a peer');
});

test('an injected handshake frame cannot end a running session', async () => {
  const { bus, tag, a, b } = await pair();
  // A transport is carrying traffic, which is the thing that makes an unsolicited share
  // irrelevant rather than ambiguous.
  a.transportLive = true;
  b.transportLive = true;
  const keyBefore = toHex(b.K);

  // A well-formed CPace share from someone with no code. Tearing the session down on
  // sight of one was a way to end a working connection from outside it.
  const { cpaceStart } = await import('../web/core/gdcrypto.js');
  const stranger = cpaceStart('not-the-code', tag);
  const frame = new Uint8Array(33);
  frame[0] = F_CPACE;
  frame.set(stranger.msg, 1);
  bus.inject(b.signal, tag, frame);
  await settle();

  assert.equal(b.established, true, 'the session stays up');
  assert.equal(toHex(b.K), keyBefore, 'and keeps the key it had');

  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));
  await a.send({ t: 'still-working' });
  await settle();
  assert.deepEqual(heard, [{ t: 'still-working' }]);
});

test('a wrong code is reported instead of producing a dead connection', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(5);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const b = new SecureSession(bus.end(), { tag, code: 'ZZ99Z' });
  const errors = [];
  a.addEventListener('error', (e) => errors.push(e.detail?.message));
  a.start();
  b.start();
  await until(() => errors.length > 0);

  assert.equal(a.established, false, 'two different codes are not a connection');
  assert.equal(b.established, false);
  assert.ok(
    errors.some((m) => /could not prove/i.test(m || '')),
    `the mismatch is surfaced, not left to fail later: ${JSON.stringify(errors)}`,
  );
});

test('a confirmation cannot be replayed back at the peer that sent it', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(11);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const sent = [];
  const ep = a.signal;
  const realForward = ep.forward;
  ep.forward = (t, payload) => {
    sent.push(Uint8Array.from(payload));
    realForward(t, payload);
  };
  a.start();
  await settle();

  // Key it against a stranger so a confirmation actually gets sent, then bounce that
  // confirmation straight back. If the two directions shared a value, this would pass.
  const { cpaceStart, kemKeypair } = await import('../web/core/gdcrypto.js');
  const other = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  const cp = new Uint8Array([F_CPACE, ...other.msg, ...ek]);
  bus.inject(a.signal, tag, cp);
  await settle();

  const mine = sent.find((f) => f[0] === 0x14);
  assert.ok(mine, 'a confirmation was sent');
  bus.inject(a.signal, tag, mine);
  await settle();
  assert.equal(a.established, false, 'our own proof is not proof of anyone else');
});

test('a genuine reconnect still re-keys in one round trip', async () => {
  const { bus, tag, a, b } = await pair();
  const before = toHex(b.K);

  // The other device goes away. A pair tag holds two sockets, so its slot is free before
  // anything can take it. Leaving the old endpoint attached would test a three-party tag
  // that the relay never allows.
  bus.ends.delete(a.signal);

  // And comes back: new object, same code, same tag, new ephemeral share.
  const fresh = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  fresh.start();
  await until(() => fresh.established);

  assert.equal(b.established, true, 'the surviving side is still up');
  assert.equal(fresh.established, true, 'and the returning device keyed');
  assert.equal(toHex(fresh.K), toHex(b.K), 'on a shared key');
  assert.notEqual(toHex(b.K), before, 'which is a new one, not the old one');
});

test('ciphertext is refused until the key has been confirmed', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(13);
  const victim = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const heard = [];
  victim.addEventListener('message', (e) => heard.push(e.detail));
  victim.start();
  await settle();

  const { cpaceStart } = await import('../web/core/gdcrypto.js');
  const peer = cpaceStart('AB12C', tag);
  const cp = new Uint8Array(33);
  cp[0] = F_CPACE;
  cp.set(peer.msg, 1);
  bus.inject(victim.signal, tag, cp);
  await settle();

  // A key exists on our side, but nobody has proved anything, so nothing sealed under it
  // may be acted on.
  assert.equal(victim.established, false);
  const f = new Uint8Array(9 + 32);
  f[0] = F_SEALED;
  bus.inject(victim.signal, tag, f);
  await settle();
  assert.deepEqual(heard, []);
});

test('the replay window still refuses a genuine frame sent twice', async () => {
  const { a, b } = await pair();
  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));

  // Capture a real sealed frame by watching what A puts on the wire.
  const captured = [];
  const realForward = a.signal.forward;
  a.signal.forward = (t, payload) => {
    captured.push({ t, payload: Uint8Array.from(payload) });
    realForward(t, payload);
  };
  await a.send({ t: 'once' });
  await settle();

  const frame = captured.find((c) => c.payload[0] === F_SEALED);
  assert.ok(frame, 'a sealed frame went out');
  b.signal.dispatchEvent(
    new CustomEvent('frame', { detail: { key: toHex(frame.t), payload: frame.payload } }),
  );
  await settle();

  assert.deepEqual(heard, [{ t: 'once' }], 'delivered once, not twice');
});

test('a device that was already waiting still gets keyed when we arrive', async () => {
  /*
   * The order that actually happens in a room: one device is sitting on the tag, having
   * announced itself before anyone else was there. We join. The relay tells both sides the
   * membership changed, and that notice is the only cue for the waiting device to say its
   * share again, since nobody heard it the first time.
   *
   * Rate-limiting that re-announcement alongside the ones a stranger can provoke left the
   * arriving device holding a confirmation for a share it had never seen, and the handshake
   * stopped. Nothing errored; the two devices never connected.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(21);

  const waiting = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  waiting.start();
  await settle();

  const arriving = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  arriving.start();
  // The relay announces the membership change to everyone present.
  for (const ep of bus.ends) {
    ep.dispatchEvent(new CustomEvent('peer-up', { detail: { key: toHex(tag) } }));
  }
  await until(() => arriving.established && waiting.established);

  assert.equal(arriving.established, true, 'the device that just joined keyed');
  assert.equal(waiting.established, true, 'and so did the one that was already there');
  assert.equal(toHex(arriving.K), toHex(waiting.K), 'on the same key');
});

test('handshake frames from a stranger cannot be amplified through us', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(22);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });

  const sent = [];
  const real = s.signal.forward;
  s.signal.forward = (t, payload) => {
    sent.push(payload[0]);
    real(t, payload);
  };
  s.start();
  await settle();

  // Establish, then hammer it with well-formed shares from nobody in particular.
  const { cpaceStart } = await import('../web/core/gdcrypto.js');
  const before = sent.filter((b) => b === F_CPACE).length;
  for (let i = 0; i < 50; i++) {
    const junk = cpaceStart(`x${i}`, tag);
    const f = new Uint8Array(33);
    f[0] = F_CPACE;
    f.set(junk.msg, 1);
    bus.inject(s.signal, tag, f);
  }
  await settle();

  const after = sent.filter((b) => b === F_CPACE).length;
  assert.ok(after - before <= 2, `fifty prompts produced ${after - before} announcements`);
});

test('a burst of injected handshakes cannot leave the two sides on different keys', async () => {
  /*
   * Answering an unsolicited share by re-keying looked safe, because the new key still had
   * to be confirmed. With several such frames in flight it was not: each side kept starting
   * fresh rounds and they could settle on different ones, each holding a key the other had
   * moved past. Both reported themselves connected, neither could read anything the other
   * sent, and a frame that will not open is dropped without complaint.
   */
  const { bus, tag, a, b } = await pair();
  a.transportLive = true;
  b.transportLive = true;
  const agreed = toHex(a.K);

  const { cpaceStart } = await import('../web/core/gdcrypto.js');
  for (let i = 0; i < 12; i++) {
    const junk = cpaceStart(`stranger-${i}`, tag);
    const f = new Uint8Array(33);
    f[0] = F_CPACE;
    f.set(junk.msg, 1);
    // No pause between them: the point is that the rounds overlap. Letting each finish
    // before starting the next is exactly the case that never went wrong.
    bus.inject(i % 2 ? a.signal : b.signal, tag, f);
  }
  await settle();
  await settle();
  await settle();

  assert.equal(toHex(a.K), toHex(b.K), 'the two sides still hold the same key');
  assert.equal(toHex(a.K), agreed, 'and it is the one they agreed on');
  assert.equal(a.generation, b.generation, 'so their generations match');

  // And the channel is not merely intact in principle.
  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));
  await a.send({ t: 'after-the-storm' });
  await settle();
  assert.deepEqual(heard, [{ t: 'after-the-storm' }]);
});

test('a peer that really did go away can still come back', async () => {
  // The relay reports a dropped socket, and that, rather than a frame anyone can forge, is
  // what allows keying again.
  const { bus, tag, a, b } = await pair();
  a.transportLive = true;
  b.transportLive = true;
  const before = toHex(b.K);

  bus.ends.delete(a.signal);
  b.signal.dispatchEvent(
    new CustomEvent('peer-gone', { detail: { key: toHex(tag), reason: 'left' } }),
  );
  await settle();

  const fresh = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  fresh.start();
  for (const ep of bus.ends) {
    ep.dispatchEvent(new CustomEvent('peer-up', { detail: { key: toHex(tag) } }));
  }
  await until(() => fresh.established);

  assert.equal(fresh.established, true, 'the returning device keyed');
  assert.equal(b.established, true);
  assert.equal(toHex(fresh.K), toHex(b.K), 'on a shared key');
  assert.notEqual(toHex(b.K), before, 'and a new one');
});

/* ────────────────── a confirmation that arrives mid-computation ───────────── */

/**
 * Two sessions whose frames are held rather than delivered, so the order is ours to choose.
 */
function heldPair(code = 'QR34S') {
  const tag = new Uint8Array(16).fill(9);
  const held = { a: [], b: [] };
  const endFor = (who) => {
    const ep = new EventTarget();
    ep.subscribe = () => {};
    ep.unsubscribe = () => {};
    ep.subscribeRoom = () => {};
    ep.iceConfig = { iceServers: [] };
    ep.forward = (_tag, payload) => held[who].push(Uint8Array.from(payload));
    return ep;
  };
  return { a: new SecureSession(endFor('a'), { tag, code }), b: new SecureSession(endFor('b'), { tag, code }), held };
}

/*
 * The timing that left one device connected and the other not.
 *
 * Keying is asynchronous, and the peer's confirmation can land at any point during it. It is
 * held in a slot that `_dropCandidate` clears, so whether the handshake completed depended on
 * which side of that call the confirmation arrived on. Landing after it, the replay found it
 * and the session came up; landing before, it was wiped and the session did not, while the
 * other side went ahead.
 *
 * Delivering the confirmation first makes that deterministic, since it is then in the slot
 * when the drop runs.
 */
test('a confirmation held before keying begins is not lost', async () => {
  const { a, b, held } = heldPair();
  a.start();
  b.start();
  // The offer waits on a lattice keypair now, so it is published a turn later than it was.
  await settle();
  const shareA = held.a.find((f) => f[0] === F_CPACE);
  const shareB = held.b.find((f) => f[0] === F_CPACE);

  await b._handle(shareA);
  const confirmB = held.b.find((f) => f[0] === F_CONFIRM);
  assert.ok(confirmB, 'B produced a confirmation');

  // It arrives before the share it belongs to, so it is waiting when keying starts.
  await a._handle(confirmB);
  assert.equal(a.established, false, 'nothing to key against yet');
  await a._handle(shareB);

  assert.ok(a.established, 'the waiting confirmation was discarded during keying');
  assert.deepEqual(a.sas, b.sas, 'the two sides keyed to different things');
});

/* And a confirmation from a round that no longer exists is reported, not acted on. */
test('a stale confirmation is reported without destroying the agreement', async () => {
  const { a, b, held } = heldPair();
  const errors = [];
  a.addEventListener('error', (e) => errors.push(e.detail?.message));

  a.start();
  b.start();
  await settle();
  const shareA = held.a.find((f) => f[0] === F_CPACE);
  const shareB = held.b.find((f) => f[0] === F_CPACE);
  await b._handle(shareA);
  const confirmB = held.b.find((f) => f[0] === F_CONFIRM);

  // Wrong in both halves: a tag that proves nothing, behind a ciphertext that opens to junk.
  const { KEM_CT_BYTES } = await import('../web/core/gdcrypto.js');
  await a._handle(
    new Uint8Array([F_CONFIRM, ...new Uint8Array(KEM_CT_BYTES).fill(3), ...new Uint8Array(32).fill(7)]),
  );
  await a._handle(shareB);

  assert.ok(errors.some((m) => /could not prove/i.test(m || '')), 'the mismatch went unreported');
  assert.equal(a.established, false, 'a mismatched confirmation must not establish anything');

  // The real one still completes it.
  await a._handle(confirmB);
  assert.ok(a.established, 'the stale confirmation took the real agreement with it');
  assert.deepEqual(a.sas, b.sas);
});
