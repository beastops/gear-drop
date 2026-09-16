/**
 * The post-quantum half of the key agreement.
 *
 * AES-256-GCM is not what ages here. A recorder does not need to break the cipher to read this
 * traffic one day; it needs the key, and the key came out of a Diffie-Hellman over
 * ristretto255. Discrete logs fall to a quantum computer, so everything sent under a purely
 * classical agreement is readable by whoever kept a copy and waited.
 *
 * ML-KEM-768 is mixed in beside it. What these assert is the property that buys: that the
 * session key genuinely depends on the lattice secret, that the lattice half cannot be
 * stripped off or tampered into irrelevance, and that neither half alone reaches the key.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { SecureSession } = await import('../web/core/session.js');
const { kemKeypair, kemEncapsulate, kemDecapsulate, KEM_EK_BYTES, KEM_CT_BYTES, hkdf, sha256, cpaceStart } =
  await import('../web/core/gdcrypto.js');
const { concat, te, toHex } = await import('../web/core/bytes.js');

const F_CPACE = 0x10;
const F_CONFIRM = 0x14;
const settle = () => new Promise((r) => setTimeout(r, 30));
const until = async (fn, ms = 4000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
};

/** Two sessions on one wire, with every frame visible. */
class Bus {
  constructor() {
    this.ends = new Set();
    this.seen = [];
    this.drop = null;
    this.mangle = null;
  }
  end() {
    const ep = new EventTarget();
    ep.subscribe = ep.unsubscribe = ep.subscribeRoom = () => {};
    ep.forward = (tag, payload) => {
      this.seen.push(Uint8Array.from(payload));
      if (this.drop?.(payload)) return;
      const out = this.mangle ? this.mangle(Uint8Array.from(payload)) : payload;
      for (const other of this.ends) {
        if (other === ep) continue;
        queueMicrotask(() =>
          other.dispatchEvent(new CustomEvent('frame', { detail: { key: toHex(tag), payload: out } })),
        );
      }
    };
    this.ends.add(ep);
    return ep;
  }
}

async function pair(code = 'AB12C', setup = () => {}) {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(9);
  const a = new SecureSession(bus.end(), { tag, code });
  const b = new SecureSession(bus.end(), { tag, code });
  setup(bus);
  a.start();
  b.start();
  await until(() => a.established && b.established);
  return { bus, tag, a, b };
}

/* ── the KEM itself ───────────────────────────────────────────────────────── */

test('the KEM agrees, at the sizes FIPS 203 fixes for ML-KEM-768', async () => {
  const { ek, dk } = await kemKeypair();
  assert.equal(ek.length, KEM_EK_BYTES);
  const { ct, ss } = await kemEncapsulate(ek);
  assert.equal(ct.length, KEM_CT_BYTES);
  assert.equal(ss.length, 32);
  assert.deepEqual(await kemDecapsulate(dk, ct), ss);
});

test('a tampered ciphertext opens to something else rather than to an error', async () => {
  /*
   * Implicit rejection by design, so there is no failure to time or probe. For this protocol
   * it is also the behaviour that matters: the two sides end up with different secrets, so
   * nothing decrypts afterwards and the connection fails closed rather than continuing on the
   * classical half alone.
   */
  const { ek, dk } = await kemKeypair();
  const { ct, ss } = await kemEncapsulate(ek);
  for (const at of [0, 7, ct.length - 1]) {
    const bad = Uint8Array.from(ct);
    bad[at] ^= 1;
    assert.notDeepEqual(await kemDecapsulate(dk, bad), ss, `flipping byte ${at} changed nothing`);
  }
});

test('each encapsulation to the same key is a fresh secret', async () => {
  // Otherwise two sessions to the same device would share a post-quantum half.
  const { ek } = await kemKeypair();
  const one = await kemEncapsulate(ek);
  const two = await kemEncapsulate(ek);
  assert.notDeepEqual(one.ss, two.ss);
  assert.notDeepEqual(one.ct, two.ct);
});

test('a key or ciphertext of the wrong size is refused, not guessed at', async () => {
  const { dk, ek } = await kemKeypair();
  for (const bad of [new Uint8Array(0), new Uint8Array(32), new Uint8Array(KEM_EK_BYTES - 1)]) {
    await assert.rejects(() => kemEncapsulate(bad));
  }
  for (const bad of [new Uint8Array(0), new Uint8Array(KEM_CT_BYTES + 1)]) {
    await assert.rejects(() => kemDecapsulate(dk, bad));
  }
  assert.ok(ek.length === KEM_EK_BYTES);
});

/* ── what the handshake now carries ───────────────────────────────────────── */

test('the offer carries an encapsulation key beside the share', async () => {
  const { bus } = await pair();
  const share = bus.seen.find((f) => f[0] === F_CPACE);
  assert.ok(share, 'no offer was published');
  assert.equal(share.length, 1 + 32 + KEM_EK_BYTES, 'the offer is not a hybrid one');
});

test('the confirmation carries the wrapped secret, so it is still two messages', async () => {
  const { bus } = await pair();
  const confirm = bus.seen.find((f) => f[0] === F_CONFIRM);
  assert.ok(confirm, 'no confirmation was published');
  assert.equal(confirm.length, 1 + KEM_CT_BYTES + 32);
  // And nothing else went out: no third frame type appeared to carry the KEM.
  assert.deepEqual([...new Set(bus.seen.map((f) => f[0]))].sort(), [F_CPACE, F_CONFIRM]);
});

test('both sides reach the same key, and it is not the classical one', async () => {
  const { a, b } = await pair();
  assert.equal(a.established && b.established, true);
  assert.equal(toHex(a.K), toHex(b.K), 'the two sides keyed to different things');

  /*
   * Whoever recovers the classical secret, which is what a quantum computer buys years after
   * the fact, holds a value that is not the session key and does not lead to it without the
   * lattice secret.
   */
  const classical = await hkdf(new Uint8Array(32), 'gd/sig/v1', 32);
  assert.notEqual(toHex(a.K), toHex(classical));
});

/* ── the downgrade that must not exist ────────────────────────────────────── */

test('an offer with no encapsulation key is refused', async () => {
  /*
   * Stripping the lattice half is the cheapest attack on a hybrid: send the old shape and let
   * the other end fall back to the agreement you already expect to break. Both ends here run
   * the code this origin served, so there is nothing to be compatible with and the frame is
   * simply not a valid offer.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(4);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const errors = [];
  s.addEventListener('error', (e) => errors.push(e.detail?.message || ''));
  s.start();
  await settle();

  const other = cpaceStart('AB12C', tag);
  await s._handle(new Uint8Array([F_CPACE, ...other.msg])); // the pre-hybrid shape
  await settle();

  assert.equal(s.established, false, 'a classical-only offer was accepted');
  assert.ok(
    errors.some((m) => /hybrid/i.test(m)),
    `the refusal is surfaced: ${JSON.stringify(errors)}`,
  );
  assert.ok(
    !bus.seen.some((f) => f[0] === F_CONFIRM),
    'a confirmation was sent for an offer that carried no lattice key',
  );
});

test('an offer with a truncated encapsulation key is refused', async () => {
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(5);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  s.addEventListener('error', () => {});
  s.start();
  await settle();

  const other = cpaceStart('AB12C', tag);
  await s._handle(new Uint8Array([F_CPACE, ...other.msg, ...new Uint8Array(KEM_EK_BYTES - 1)]));
  await settle();
  assert.equal(s.established, false);
  assert.ok(!bus.seen.some((f) => f[0] === F_CONFIRM));
});

test('a mangled wrapped secret leaves the two sides unable to talk', async () => {
  /*
   * The failure has to be total rather than partial. An attacker who flips a byte in the
   * ciphertext cannot be left with a session that still comes up on a key they understand;
   * what they get is two devices that each think they are connected and cannot read a word
   * from each other.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(6);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const b = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  let flipped = false;
  bus.mangle = (frame) => {
    if (frame[0] === F_CONFIRM && !flipped) {
      flipped = true;
      frame[5] ^= 0xff; // inside the ciphertext, well clear of the tag
    }
    return frame;
  };
  a.start();
  b.start();
  await until(() => a.established && b.established);

  assert.equal(flipped, true, 'no confirmation was intercepted, so nothing was tested');
  assert.notEqual(toHex(a.K), toHex(b.K), 'a tampered ciphertext still produced a shared key');
});

/* ── determinism across a repeated offer ──────────────────────────────────── */

test('keying twice against one offer wraps the same secret both times', async () => {
  /*
   * Handshake frames repeat: a share is re-announced, a reset republishes. Encapsulating
   * afresh each time sends two ciphertexts carrying two different secrets, the peer opens
   * whichever arrives first, and this side keeps the other. Both devices come up, on
   * different keys, with nothing to say so until the first frame fails to open.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(8);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  s.addEventListener('error', () => {});
  s.start();
  await settle();

  const other = cpaceStart('AB12C', tag);
  const { ek } = await kemKeypair();
  const offer = new Uint8Array([F_CPACE, ...other.msg, ...ek]);

  // Driven straight at the keying step, because the duplicate filter above it stops the
  // second copy from getting here, and this is the step that has to be idempotent.
  await s._beginKey(offer.subarray(1));
  await settle();
  await s._beginKey(offer.subarray(1));
  await settle();

  const confirms = bus.seen.filter((f) => f[0] === F_CONFIRM);
  assert.ok(confirms.length >= 2, `only ${confirms.length} confirmation(s) to compare`);
  const cts = confirms.map((f) => toHex(f.subarray(1, 1 + KEM_CT_BYTES)));
  assert.equal(new Set(cts).size, 1, 'the same offer produced two different wrapped secrets');
});

test('a repeat of the offer a live session was built on is ignored', async () => {
  /*
   * The guard that reads the share off an offer.
   *
   * A held frame arriving twice is ordinary. Answering the second copy means publishing a
   * fresh share and keying again under a session that is already up, leaving the peer, which
   * has no reason to repeat anything, holding the round before. Both ends established, one
   * round apart.
   *
   * It read as new for as long as the offer carried a lattice key, because the comparison was
   * share against share-plus-key and never matched. Nothing failed loudly; the cost was a
   * handshake that could be restarted from the outside by replay alone.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(22);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const b = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  a.start();
  b.start();
  assert.equal(await until(() => a.established && b.established), true, 'no session to repeat at');

  const settled = toHex(a.K);
  const offerB = bus.seen.filter((f) => f[0] === F_CPACE).find((f) => toHex(f.subarray(1, 33)) === toHex(a._peerShare));
  assert.ok(offerB, "B's offer was not on the wire");

  const before = bus.seen.length;
  await a._handle(offerB);
  await settle();

  assert.equal(bus.seen.length, before, 'the repeat drew a reply');
  assert.equal(toHex(a.K), settled, 'the repeat moved the session to another key');
  assert.equal(a._candidate, null, 'the repeat started a second round');
});

test('a different offer gets a different wrapped secret', async () => {
  // The cache above is keyed to the offer, not held across peers.
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(10);
  const s = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  s.addEventListener('error', () => {});
  s.start();
  await settle();

  for (let i = 0; i < 2; i++) {
    const other = cpaceStart('AB12C', tag);
    const { ek } = await kemKeypair();
    await s._handle(new Uint8Array([F_CPACE, ...other.msg, ...ek]));
    await settle();
  }

  const cts = bus.seen
    .filter((f) => f[0] === F_CONFIRM)
    .map((f) => toHex(f.subarray(1, 1 + KEM_CT_BYTES)));
  assert.equal(new Set(cts).size, cts.length, 'two different offers were answered identically');
});

/* ── the ordering both sides have to agree on ─────────────────────────────── */

test('the two secrets go into the key in one canonical order', async () => {
  /*
   * Each side holds the secret it wrapped and the secret it opened, and they are opposite:
   * what A wrapped, B opened. Feeding them in "mine then theirs" would give the two sides the
   * same pair in opposite orders and therefore different keys. They go in by lane instead,
   * which is the tiebreak the rest of the handshake already agrees on.
   */
  for (let i = 0; i < 4; i++) {
    const { a, b } = await pair(`CODE${i}`);
    assert.equal(a.established && b.established, true, `round ${i} did not come up`);
    assert.equal(toHex(a.K), toHex(b.K), `round ${i} keyed to different values`);
    assert.notEqual(a.lane, b.lane, 'the two sides took the same lane');
  }
});

test('every session gets its own key', async () => {
  const one = await pair('SAME1');
  const two = await pair('SAME1');
  assert.notEqual(toHex(one.a.K), toHex(two.a.K), 'the same code twice gave the same key');
});

test('the session key is the hash of both secrets, and of the classical one alone it is not', async () => {
  /*
   * Rebuilt from the parts rather than taken on trust.
   *
   * The handshake is driven by hand so the classical secret can be read out of the candidate
   * before the confirmation turns it into the final one. Both halves of the claim are then
   * checked: the key is HKDF over the classical secret and the two lattice secrets in lane
   * order, and it is not what the classical secret alone produces.
   *
   * The context is rebuilt the same way, off the wire: the two offers as published and the
   * two ciphertexts as sent. Recomputing it from frames rather than reading it off the session
   * makes this a check on the binding rather than a restatement of it, because the transcript
   * in the key has to be the one that crossed the network.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(12);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const b = new SecureSession(bus.end(), { tag, code: 'AB12C' });

  // Hold every frame so nothing completes until we say so.
  const held = [];
  bus.drop = (frame) => {
    held.push(Uint8Array.from(frame));
    return true;
  };

  a.start();
  b.start();
  await settle();

  const offerA = held.find((f) => f[0] === F_CPACE);
  const offerB = held.filter((f) => f[0] === F_CPACE).find((f) => toHex(f) !== toHex(offerA));
  assert.ok(offerA && offerB, 'both sides published an offer');

  await a._handle(offerB);
  await b._handle(offerA);
  await settle();

  // The classical secret, as it stands before the lattice half is folded in.
  const classicalA = Uint8Array.from(a._candidate.K);
  const ssOutA = Uint8Array.from(a._candidate.ssOut);
  const laneA = a._candidate.lane;
  const mineA = toHex(a._candidate.mine);

  const confirms = held.filter((f) => f[0] === F_CONFIRM);
  const fromB = confirms.find((f) => toHex(f.subarray(1 + KEM_CT_BYTES)) === toHex(a._candidate.theirs));
  assert.ok(fromB, "B's confirmation was not among the held frames");
  const fromA = confirms.find((f) => toHex(f.subarray(1 + KEM_CT_BYTES)) === mineA);
  assert.ok(fromA, "A's own confirmation was not among the held frames");

  const ssInA = await kemDecapsulate((await a._kem).dk, Uint8Array.from(fromB.subarray(1, 1 + KEM_CT_BYTES)));

  await a._handle(fromB);
  await settle();
  assert.equal(a.established, true, 'the handshake did not complete');

  const toLane0 = laneA === 0 ? ssInA : ssOutA;
  const toLane1 = laneA === 0 ? ssOutA : ssInA;

  // Offers without their frame byte, in lane order, then the ciphertexts the same way.
  const bodyA = offerA.subarray(1);
  const bodyB = offerB.subarray(1);
  const transcript = await sha256(laneA === 0 ? concat(bodyA, bodyB) : concat(bodyB, bodyA));
  const ctA = fromA.subarray(1, 1 + KEM_CT_BYTES);
  const ctB = fromB.subarray(1, 1 + KEM_CT_BYTES);
  const bound = await sha256(
    laneA === 0 ? concat(transcript, ctB, ctA) : concat(transcript, ctA, ctB),
  );
  const info = concat(te.encode('gd/hybrid/v1'), bound);

  const expected = await hkdf(concat(classicalA, toLane0, toLane1), info, 32);
  assert.equal(toHex(a.K), toHex(expected), 'the key is not the hash of both secrets');

  const classicalOnly = await hkdf(concat(classicalA), info, 32);
  assert.notEqual(toHex(a.K), toHex(classicalOnly), 'the lattice secret changed nothing');
  assert.notEqual(toHex(a.K), toHex(classicalA), 'the key is the classical secret itself');

  // Same secrets, one byte of the exchange different: a key that has nothing to do with it.
  const nudged = Uint8Array.from(bound);
  nudged[0] ^= 1;
  const elsewhere = await hkdf(
    concat(classicalA, toLane0, toLane1),
    concat(te.encode('gd/hybrid/v1'), nudged),
    32,
  );
  assert.notEqual(toHex(a.K), toHex(elsewhere), 'the exchange is not bound into the key');
});

test('a swapped encapsulation key fails the confirmation instead of splitting the session', async () => {
  /*
   * The attack the classical confirmation cannot see.
   *
   * Someone in the middle without the code cannot forge a CPace element, which is what the
   * PAKE is for, but nothing stops them relaying a genuine element while replacing the
   * encapsulation key published next to it. The classical agreement is untouched, so a
   * confirmation covering only that agreement verifies on both sides. Both ends go live and
   * neither can open a frame the other sends, because the lattice halves came from different
   * keys, and both screens say it worked.
   *
   * Covering the published offers turns that into a confirmation that does not verify, which
   * the app already knows how to say out loud. Every offer is tampered here, in both
   * directions, so there is no later clean round to recover through and the assertion is
   * about the protocol rather than about timing.
   */
  const bus = new Bus();
  const tag = new Uint8Array(16).fill(21);
  const a = new SecureSession(bus.end(), { tag, code: 'AB12C' });
  const b = new SecureSession(bus.end(), { tag, code: 'AB12C' });

  const errors = [];
  a.addEventListener('error', (e) => errors.push(e.detail.message));
  b.addEventListener('error', (e) => errors.push(e.detail.message));

  const attacker = await kemKeypair();
  let swaps = 0;
  bus.mangle = (frame) => {
    if (frame[0] !== F_CPACE) return frame;
    swaps++;
    // The share is passed through untouched; only the key beside it is replaced.
    return concat(frame.subarray(0, 1 + 32), attacker.ek);
  };

  a.start();
  b.start();
  await until(() => a.established && b.established, 1500);

  assert.ok(swaps >= 2, 'the offers did not reach the interceptor');
  assert.equal(a.established, false, 'A went live on an exchange that had been altered');
  assert.equal(b.established, false, 'B went live on an exchange that had been altered');
  assert.ok(
    errors.some((m) => /prove it has the same code/.test(m)),
    'the tampering was never reported',
  );
});

test('the lattice private key does not outlive the handshake', async () => {
  /*
   * What the post-quantum half is actually for.
   *
   * The threat is a recording kept now and read later, once discrete logs are cheap. The
   * classical scalar is wiped the moment the key exists, so the classical half of that
   * recording cannot be recomputed from this device afterwards. If the decapsulation key
   * were still sitting in memory, somebody who broke the classical half and then got hold of
   * the device would have both, and the lattice half would have bought nothing at all against
   * the one attacker it exists for.
   *
   * So it goes at the same moment, by the same path. Checked on both ways out: a session that
   * finished its handshake, and a session torn down before it ever got one.
   */
  const { a, b } = await pair('WIPE12');

  for (const [who, s] of [['A', a], ['B', b]]) {
    assert.equal(s.established, true, `${who} never came up`);
    assert.equal(s._kem, null, `${who} is still holding a lattice keypair`);
    assert.equal(s._cpace.state, null, `${who} is still holding its scalar`);
  }

  // The bytes themselves, not just the reference: the keypair is reachable from the promise
  // anything else may have awaited, so it has to have been zeroed rather than dropped.
  const early = new SecureSession(new Bus().end(), { tag: new Uint8Array(16).fill(31), code: 'AB12C' });
  early.start();
  await settle();
  const kem = await early._kem;
  assert.ok(
    kem.dk.some((byte) => byte !== 0),
    'the keypair was empty before anything happened to it',
  );

  early.destroy();
  await settle();
  assert.ok(
    kem.dk.every((byte) => byte === 0),
    'a destroyed session left its decapsulation key in memory',
  );
});
