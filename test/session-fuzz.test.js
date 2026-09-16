/**
 * The handshake state machine, driven at random.
 *
 * Every defect found in this file's subject so far has come from ordering rather than from
 * cryptography: a confirmation arriving mid-computation, a reset landing between a candidate
 * being built and being promoted, a share answered after the round it belonged to was gone.
 * Those are not found by reading, and they are not found by a test that delivers frames in
 * the order they were sent.
 *
 * So the frames are delivered in every order the network could produce. A seeded generator
 * builds a schedule (deliver, duplicate, delay, drop, reset, report the peer gone, inject
 * something invented) and the invariants are checked after each step. A failing seed is
 * printed and reproduces exactly.
 *
 * The invariants are few, and each one is a thing that has actually gone wrong:
 *
 *   1. Established means keyed. Never a session that believes it is up around a null key.
 *   2. Nothing throws out of a frame handler. Anyone can send a frame; a handler that throws
 *      on one is a remote crash.
 *   3. A counter is never reused under one key.
 *   4. Two sides may briefly hold different keys, and must not stay that way.
 *
 * The fourth is stated that way because of what the fuzzer found. Delivered a share from a
 * round the peer has left, together with the confirmation belonging to it, a side keys and
 * promotes, and so does the peer on its own round with its own valid confirmation. Both up,
 * neither able to read the other, and nothing saying so.
 *
 * The first reading was that a two-message handshake cannot tell "this proof is for the round
 * you are in" from "this proof is for a round you have left", so the state is reachable and
 * the answer is to notice it afterwards. Nothing in the frame says which round it belongs to,
 * but the receiver knows three things the frame does not carry, and together they stop the
 * cases the fuzzer was reaching:
 *
 *   - the order it first heard the peer's offers in, so an offer the peer has since replaced
 *     is recognisable and goes unanswered;
 *   - the confirmations it was waiting for in rounds that are over, so the peer's late answer
 *     to one no longer takes the round in progress with it;
 *   - a guard that had been there all along and had stopped working, because the offer grew an
 *     encapsulation key and the repeat-detection still compared it against a bare share. Every
 *     duplicate offer read as a new peer, on a live session.
 *
 * What is left is a race rather than a hole. After a hostile schedule and a flood of stale
 * frames the two sides can still be found holding different keys, and every such pair agreed
 * again as soon as either of them sent anything. The tests below assert the prevention, the
 * detection and the recovery, in that order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { SecureSession } = await import('../web/core/session.js');
const { cpaceStart, kemKeypair } = await import('../web/core/gdcrypto.js');
const { concat, toHex } = await import('../web/core/bytes.js');

const F_CPACE = 0x10;
const F_SEALED = 0x11;
const F_CONFIRM = 0x14;

/** Long enough for a lattice keypair, which is what an offer waits on. */
const settle = () => new Promise((r) => setTimeout(r, 25));

/** Deterministic, so a failure names a seed rather than a mood. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/**
 * Two sessions whose frames are captured rather than delivered, so the schedule is ours.
 */
function bench(code = 'AB12C') {
  const tag = new Uint8Array(16).fill(7);
  const outbox = { a: [], b: [] };
  const thrown = [];

  const end = (who) => {
    const ep = new EventTarget();
    ep.subscribe = ep.unsubscribe = ep.subscribeRoom = () => {};
    ep.forward = (_t, payload) => outbox[who].push(Uint8Array.from(payload));
    return ep;
  };

  const a = new SecureSession(end('a'), { tag, code });
  const b = new SecureSession(end('b'), { tag, code });
  for (const [name, s] of [['a', a], ['b', b]]) {
    s.addEventListener('error', () => {}); // an error event is a report, not a crash
    s._who = name;
  }
  return { a, b, tag, outbox, thrown };
}

/** Hand one frame to one side, and never let a throw escape unnoticed. */
async function feed(session, frame, thrown) {
  try {
    await session._handle(frame);
  } catch (err) {
    thrown.push(`${session._who}: ${err?.message || err}`);
  }
}

function invariants(a, b, where) {
  for (const s of [a, b]) {
    if (s.established) {
      assert.ok(s.K, `${where}: ${s._who} is established with no key`);
      assert.ok(s.key, `${where}: ${s._who} is established with no AEAD key`);
      assert.equal(s.K.length, 32, `${where}: ${s._who} has a key of the wrong size`);
    }
  }
  if (a.established && b.established && toHex(a.K) === toHex(b.K)) {
    assert.notEqual(a.lane, b.lane, `${where}: both sides agree a key and took the same lane`);
  }
}

/** Hand a side enough unopenable frames to trip its detector, and say whether it re-keyed. */
async function pushUntilNoticed(from, to, thrown) {
  const before = to.established;
  for (let i = 0; i < 6 && to.established; i++) {
    const box = [];
    const realForward = from.signal.forward;
    from.signal.forward = (_t, p) => box.push(Uint8Array.from(p));
    try {
      await from.send({ t: 'are you there', i });
    } catch {
      break;
    }
    from.signal.forward = realForward;
    for (const frame of box) await feed(to, frame, thrown);
  }
  return before && !to.established;
}

/* ── the fuzz ─────────────────────────────────────────────────────────────── */

test('no ordering of handshake frames leaves a session broken and unaware of it', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = rng(seed * 2654435761);
    const { a, b, tag, outbox, thrown } = bench();

    a.start();
    b.start();
    await new Promise((r) => setTimeout(r, 25)); // the offer waits on a lattice keypair

    const held = { a: [], b: [] };
    for (let step = 0; step < 60; step++) {
      // Whatever each side has published since the last step joins the pool.
      held.a.push(...outbox.a.splice(0));
      held.b.push(...outbox.b.splice(0));

      const roll = rnd();
      if (roll < 0.55) {
        // Deliver something from one pool to the other side, chosen at random.
        const from = rnd() < 0.5 ? 'a' : 'b';
        const pool = held[from];
        if (!pool.length) continue;
        const at = Math.floor(rnd() * pool.length);
        const frame = rnd() < 0.15 ? pool[at] : pool.splice(at, 1)[0]; // sometimes a duplicate
        await feed(from === 'a' ? b : a, frame, thrown);
      } else if (roll < 0.7) {
        // A frame nobody sent.
        const side = rnd() < 0.5 ? a : b;
        const type = [F_CPACE, F_CONFIRM, F_SEALED, 0x99][Math.floor(rnd() * 4)];
        const len = Math.floor(rnd() * 1300);
        const junk = new Uint8Array(len + 1);
        junk[0] = type;
        for (let i = 1; i < junk.length; i++) junk[i] = Math.floor(rnd() * 256);
        await feed(side, junk, thrown);
      } else if (roll < 0.8) {
        // The relay says somebody joined.
        const side = rnd() < 0.5 ? a : b;
        side.signal.dispatchEvent(new CustomEvent('peer-up', { detail: { key: toHex(tag) } }));
      } else if (roll < 0.88) {
        // The relay says somebody left.
        const side = rnd() < 0.5 ? a : b;
        side.signal.dispatchEvent(
          new CustomEvent('peer-gone', { detail: { key: toHex(tag), reason: 'left' } }),
        );
      } else if (roll < 0.94) {
        // A transport coming up or going down changes what a stray frame is allowed to do.
        const side = rnd() < 0.5 ? a : b;
        side.transportLive = rnd() < 0.5;
      } else {
        const side = rnd() < 0.5 ? a : b;
        side.reset();
      }

      await new Promise((r) => setTimeout(r, 0));
      invariants(a, b, `seed ${seed} step ${step}`);
    }

    assert.deepEqual(thrown, [], `seed ${seed}: a frame handler threw`);

    // If the schedule left the two on different keys, saying anything must be enough to
    // notice. A session that stayed up around a key nobody else has is the failure.
    if (a.established && b.established && toHex(a.K) !== toHex(b.K)) {
      const noticed = await pushUntilNoticed(a, b, thrown);
      assert.ok(noticed, `seed ${seed}: divergence went unnoticed by the receiving side`);
    }
  }
});

test('an undisturbed handshake always completes, whatever the delivery order', async () => {
  /*
   * The fuzz above may end with nobody connected, since it resets and drops frames on purpose.
   * This one only reorders, so the handshake has to finish every time. A protocol that
   * converges only when frames arrive in order does not work on a network.
   */
  for (let seed = 1; seed <= 25; seed++) {
    const rnd = rng(seed * 97);
    const { a, b, outbox, thrown } = bench();
    a.start();
    b.start();

    for (let round = 0; round < 40 && !(a.established && b.established); round++) {
      await new Promise((r) => setTimeout(r, 5));
      const pool = [];
      for (const frame of outbox.a.splice(0)) pool.push([b, frame]);
      for (const frame of outbox.b.splice(0)) pool.push([a, frame]);
      // Shuffle what is pending, then deliver all of it.
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const [side, frame] of pool) await feed(side, frame, thrown);
    }

    assert.deepEqual(thrown, [], `seed ${seed}: a handler threw`);
    assert.ok(a.established && b.established, `seed ${seed}: the handshake did not converge`);
    assert.equal(toHex(a.K), toHex(b.K), `seed ${seed}: converged on different keys`);
  }
});

test('a wrong code never produces a shared key, however the frames are ordered', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = rng(seed * 7919);
    const tag = new Uint8Array(16).fill(3);
    const outbox = { a: [], b: [] };
    const thrown = [];
    const end = (who) => {
      const ep = new EventTarget();
      ep.subscribe = ep.unsubscribe = ep.subscribeRoom = () => {};
      ep.forward = (_t, p) => outbox[who].push(Uint8Array.from(p));
      return ep;
    };
    const a = new SecureSession(end('a'), { tag, code: 'AB12C' });
    const b = new SecureSession(end('b'), { tag, code: 'ZZ99Z' });
    a._who = 'a';
    b._who = 'b';
    a.addEventListener('error', () => {});
    b.addEventListener('error', () => {});

    a.start();
    b.start();
    for (let round = 0; round < 20; round++) {
      await new Promise((r) => setTimeout(r, 5));
      const pool = [];
      for (const f of outbox.a.splice(0)) pool.push([b, f]);
      for (const f of outbox.b.splice(0)) pool.push([a, f]);
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      for (const [side, frame] of pool) await feed(side, frame, thrown);
    }

    assert.deepEqual(thrown, [], `seed ${seed}: a handler threw`);
    assert.ok(
      !(a.established && b.established),
      `seed ${seed}: two different codes agreed a session`,
    );
  }
});

/* ── the counter, which must never repeat under one key ───────────────────── */

test('a sealed frame never reuses a counter, across resets and reconnects', async () => {
  const { a, b, outbox, thrown } = bench();
  a.start();
  b.start();
  for (let round = 0; round < 12 && !(a.established && b.established); round++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const f of outbox.a.splice(0)) await feed(b, f, thrown);
    for (const f of outbox.b.splice(0)) await feed(a, f, thrown);
  }
  assert.ok(a.established, 'the handshake did not complete');

  const seen = new Map(); // key fingerprint -> counters used under it
  const record = () => {
    const fp = toHex(a.K).slice(0, 16);
    if (!seen.has(fp)) seen.set(fp, new Set());
    return seen.get(fp);
  };

  for (let i = 0; i < 30; i++) {
    outbox.a.length = 0;
    await a.send({ t: 'probe', i });
    for (const frame of outbox.a) {
      if (frame[0] !== F_SEALED) continue;
      const counter = Number(new DataView(frame.buffer, frame.byteOffset + 1, 8).getBigUint64(0, true));
      const used = record();
      assert.ok(!used.has(counter), `counter ${counter} was reused under one key`);
      used.add(counter);
    }
    // Re-key part way through: the counters must restart safely, not continue into a new key.
    if (i === 14) {
      a.reset();
      b.reset();
      for (let round = 0; round < 12 && !(a.established && b.established); round++) {
        await new Promise((r) => setTimeout(r, 5));
        for (const f of outbox.a.splice(0)) await feed(b, f, thrown);
        for (const f of outbox.b.splice(0)) await feed(a, f, thrown);
      }
      assert.ok(a.established, 'the session did not come back after a reset');
    }
  }

  assert.ok(seen.size >= 2, 'the re-key did not produce a different key');
  assert.deepEqual(thrown, []);
});

test('a replayed sealed frame is refused even while everything else is in flight', async () => {
  const { a, b, outbox, thrown } = bench();
  a.start();
  b.start();
  for (let round = 0; round < 12 && !(a.established && b.established); round++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const f of outbox.a.splice(0)) await feed(b, f, thrown);
    for (const f of outbox.b.splice(0)) await feed(a, f, thrown);
  }

  const heard = [];
  b.addEventListener('message', (e) => heard.push(e.detail));

  outbox.a.length = 0;
  await a.send({ t: 'once' });
  const sealed = outbox.a.find((f) => f[0] === F_SEALED);
  assert.ok(sealed, 'nothing was sealed');

  for (let i = 0; i < 5; i++) await feed(b, sealed, thrown);
  assert.equal(heard.length, 1, `the frame was accepted ${heard.length} times`);
  assert.deepEqual(thrown, []);
});

/* ── the detector, on its own ─────────────────────────────────────────────── */

test('a session keyed against nobody notices and keys again', async () => {
  /*
   * Built directly rather than found by a schedule: two sessions on the same tag with
   * different codes, each forced to believe it is established. Nothing either says can be
 * read by the other, which is the state the fuzzer reaches by accident.
   */
  const { a, thrown } = bench();
  const other = bench('ZZ99Z');

  a.start();
  other.a.start();
  await new Promise((r) => setTimeout(r, 25));

  // Bring `a` up against its own peer so it is genuinely established.
  const { b, outbox } = bench();
  const live = bench();
  live.a.start();
  live.b.start();
  for (let round = 0; round < 12 && !(live.a.established && live.b.established); round++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const f of live.outbox.a.splice(0)) await feed(live.b, f, live.thrown);
    for (const f of live.outbox.b.splice(0)) await feed(live.a, f, live.thrown);
  }
  assert.ok(live.a.established && live.b.established, 'the control pair did not come up');

  // Now feed one of them frames sealed under a key nobody shares with it.
  const stranger = bench('QQ11Q');
  stranger.a.start();
  stranger.b.start();
  for (let round = 0; round < 12 && !stranger.a.established; round++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const f of stranger.outbox.a.splice(0)) await feed(stranger.b, f, stranger.thrown);
    for (const f of stranger.outbox.b.splice(0)) await feed(stranger.a, f, stranger.thrown);
  }
  assert.ok(stranger.a.established, 'the stranger pair did not come up');

  let noticed = false;
  for (let i = 0; i < 6 && live.b.established; i++) {
    stranger.outbox.a.length = 0;
    await stranger.a.send({ t: 'not for you', i });
    for (const frame of stranger.outbox.a) await feed(live.b, frame, live.thrown);
    if (!live.b.established) noticed = true;
  }

  assert.ok(noticed, 'a session kept believing in a key the other end does not have');
  assert.deepEqual(live.thrown, []);
  void b;
  void outbox;
  void other;
  void thrown;
});

test('one unopenable frame is noise, not a reason to tear anything down', async () => {
  // The other half: a detector that fires on the first bad frame is a lever anyone can pull.
  const live = bench();
  live.a.start();
  live.b.start();
  for (let round = 0; round < 12 && !(live.a.established && live.b.established); round++) {
    await new Promise((r) => setTimeout(r, 5));
    for (const f of live.outbox.a.splice(0)) await feed(live.b, f, live.thrown);
    for (const f of live.outbox.b.splice(0)) await feed(live.a, f, live.thrown);
  }
  const key = toHex(live.b.K);

  const junk = new Uint8Array(200);
  junk[0] = F_SEALED;
  await feed(live.b, junk, live.thrown);
  assert.ok(live.b.established, 'one bad frame tore the session down');
  assert.equal(toHex(live.b.K), key, 'one bad frame re-keyed the session');

  // And a good frame in between clears the count, so noise never accumulates into a re-key.
  for (let i = 0; i < 10; i++) {
    await feed(live.b, junk, live.thrown);
    live.outbox.a.length = 0;
    await live.a.send({ t: 'still here', i });
    for (const f of live.outbox.a) await feed(live.b, f, live.thrown);
  }
  assert.ok(live.b.established, 'noise between real frames still tore the session down');
  assert.equal(toHex(live.b.K), key, 'noise between real frames re-keyed the session');
  assert.deepEqual(live.thrown, []);
});

test('an offer the peer has already moved past is refused rather than answered', async () => {
  /*
   * Prevention, where there used to be only recovery.
   *
   * Nothing in a handshake frame says which round it belongs to, so a share from a round the
   * peer has left can be keyed against and confirmed. The confirmation is genuine, just for a
   * round nobody is in, and both ends end up established on keys the other does not have.
   *
   * The receiver knows the order it heard these in, which the frame does not carry. An offer
   * it has seen before, and has since seen a newer one than, is one the peer has replaced.
   */
  const { a, tag } = bench();
  a.start();
  await settle();

  const one = cpaceStart('AB12C', tag);
  const two = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  const offer = (pake) => concat(pake.msg, ek);

  await a._beginKey(offer(one));
  await a._beginKey(offer(two));

  // The newest is still answerable, however many times it arrives.
  await a._beginKey(offer(two));

  await assert.rejects(
    () => a._beginKey(offer(one)),
    /replaced by a newer one/,
    'the abandoned round was answered',
  );
});

test('the list of offers a peer has published does not grow without a bound', async () => {
  /*
   * It is fed by the network, so it has a bound. Anyone can publish shares at a session that
   * has not keyed yet, which is what the announcement throttle is about, and a list that
   * remembered all of them would be a way to spend another device's memory from outside.
   */
  const { a, tag } = bench();
  a.start();
  await settle();

  const { ek } = await kemKeypair();
  for (let i = 0; i < 60; i++) {
    const pake = cpaceStart('AB12C', tag);
    await a._beginKey(concat(pake.msg, ek));
  }

  assert.ok(a._heard.length <= 8, `the list reached ${a._heard.length}`);
});

test('a fresh start forgets what the last peer published', async () => {
  // The list is about one peer's rounds. Carried across a restart it would refuse an offer
  // from whoever turns up next purely because an earlier device happened to send it.
  const { a, tag } = bench();
  a.start();
  await settle();

  const pake = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  const offer = concat(pake.msg, ek);

  await a._beginKey(offer);
  const later = cpaceStart('AB12C', tag);
  await a._beginKey(concat(later.msg, ek));
  assert.ok(a._heard.length >= 2, 'nothing was remembered to forget');

  a.start();
  assert.deepEqual(a._heard, [], 'the rounds of the last peer outlived it');
  await a._beginKey(offer); // refused before; ordinary news now
});

test('a confirmation for a round that is over does not cost the round in progress', async () => {
  /*
   * The other half of the same problem.
   *
   * Refusing to answer a replaced offer stops this side from wandering into an abandoned
   * round. It does nothing about the peer's answer to a round this side has left, which looks
   * like a stranger getting the code wrong and was treated as one, taking the candidate for
   * the current round with it. The peer has already confirmed and will not say it again, so
   * nothing completes the handshake: one device up, the other waiting.
   *
   * A tag this side computed for an earlier round is recognisable as its own, and once
   * recognised there is nothing to do with it. The round in progress carries on.
   */
  const { a, tag } = bench();
  a.start();
  await settle();

  const first = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();

  await a._beginKey(concat(first.msg, ek));
  const stale = Uint8Array.from(a._candidate.theirs); // what that round was waiting for

  const second = cpaceStart('AB12C', tag);
  await a._beginKey(concat(second.msg, ek));
  const live = a._candidate;
  assert.ok(live, 'there is no round in progress to protect');

  const errors = [];
  a.addEventListener('error', (e) => errors.push(e.detail.message));
  await a._onConfirm(concat(new Uint8Array(1088), stale));

  assert.equal(a._candidate, live, 'the late confirmation took the current round with it');
  assert.deepEqual(errors, [], 'a late confirmation was reported as a wrong code');
});

test('a confirmation that matches no round of ours is still reported', async () => {
  // The rule above must not become a way to fail silently: a tag this side never computed is
  // somebody who does not have the code, and that is the one thing the screen has to say.
  const { a, tag } = bench();
  a.start();
  await settle();

  const peer = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  await a._beginKey(concat(peer.msg, ek));

  const errors = [];
  a.addEventListener('error', (e) => errors.push(e.detail.message));
  await a._onConfirm(concat(new Uint8Array(1088), new Uint8Array(32).fill(0x5a)));

  assert.equal(a._candidate, null, 'a wrong code left the round standing');
  assert.equal(errors.length, 1, 'a wrong code was not reported');
});

test('the memory of finished rounds does not grow without a bound', async () => {
  const { a, tag } = bench();
  a.start();
  await settle();

  const { ek } = await kemKeypair();
  for (let i = 0; i < 60; i++) {
    const peer = cpaceStart('AB12C', tag);
    await a._beginKey(concat(peer.msg, ek));
  }

  assert.ok(a._spent.length <= 8, `the list reached ${a._spent.length}`);
});

test('a session up on a key the peer has left still answers the peer that comes back', async () => {
  /*
   * The deadlock that outlived the divergence detector.
   *
   * Detecting a split and re-keying only helps if the re-key completes. One side notices,
   * resets and publishes a fresh share; the other is established, so the handler's answer-a-
   * share-with-a-share step is skipped on the assumption that a session which is up has
   * nothing to re-publish.
   *
   * One state breaks that: established on a key the peer has left while still holding the
   * scalar from a round that never finished. The branch that mints a fresh share does not
   * fire, because there is a scalar, so the side confirms against a share it published long
   * ago that the peer never received. The confirmation arrives for a round the peer cannot
   * build, and neither side speaks again.
   *
   * Built here rather than waited for: a session is brought up, given a scalar from a round
   * that goes nowhere, and then handed the peer's fresh share.
   */
  const { a, b, tag, outbox, thrown } = bench();
  a.start();
  b.start();

  const pump = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
      const fa = outbox.a.splice(0);
      const fb = outbox.b.splice(0);
      if (!fa.length && !fb.length) {
        await settle();
        continue;
      }
      for (const f of fa) await feed(b, f, thrown);
      for (const f of fb) await feed(a, f, thrown);
      await settle();
    }
  };
  await pump();
  assert.equal(a.established && b.established, true, 'no session to break');

  /*
   * A round that goes nowhere, leaving A with a scalar it has published and B has not seen.
   * A stranger's share is enough to produce one, and dropping what A sends is what makes it
   * the state this is about.
   */
  const stranger = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  await feed(a, concat(new Uint8Array([F_CPACE]), stranger.msg, ek), thrown);
  await settle();
  outbox.a.splice(0); // everything A said about that round is lost on the way
  assert.ok(a._cpace?.state, 'A has no unfinished round, so there is nothing to test');

  // Now B gives up on the key it has and comes back with a fresh share, as the detector does.
  b.reset();
  await pump(30);

  assert.equal(b.established, true, 'the peer that came back was never answered');
  assert.equal(a.established, true, 'the established side did not come back up');
  assert.equal(toHex(a.K), toHex(b.K), 'they came back up on different keys');
  assert.deepEqual(thrown, [], 'a frame handler threw');
});
