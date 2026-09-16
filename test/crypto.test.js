/**
 * Cryptographic core tests. Run with: npm test
 *
 * These are the properties the whole privacy claim rests on, so they are asserted
 * rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cpaceStart,
  cpaceFinish,
  cpaceGeneratorString,
  hkdf,
  aeadKey,
  seal,
  open,
  nonceFor,
  sasWords,
  fingerprintOf,
  newCode,
  normalizeCode,
  tagForCode,
  pairTag,
  currentEpoch,
  CODE_ALPHABET,
  CODE_LEN,
} from '../web/core/gdcrypto.js';
import { concat, pad, unpad, equal, te, toHex } from '../web/core/bytes.js';

const sid = new Uint8Array(16).fill(7);

/** Undo lvCat: split a run of length-prefixed fields back into the fields. */
function lvSplit(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const n = buf[at];
    assert.ok(at + 1 + n <= buf.length, 'a length prefix ran past the end');
    out.push(buf.subarray(at + 1, at + 1 + n));
    at += 1 + n;
  }
  return out;
}

test('CPace: the generator input is the five fields the specification names, in order', () => {
  const fields = lvSplit(cpaceGeneratorString('ABC234', sid));
  assert.equal(fields.length, 5, 'the generator string is not five fields');

  const [dsi, prs, zpad, ci, seen] = fields;
  assert.equal(new TextDecoder().decode(dsi), 'CPace255-gd1', 'the domain string moved');
  assert.equal(new TextDecoder().decode(prs), 'ABC234', 'the password is not the second field');
  assert.ok(
    zpad.every((byte) => byte === 0),
    'the padding field is not zeroes',
  );
  assert.equal(ci.length, 0, 'something appeared in the channel identifier');
  assert.ok(equal(seen, sid), 'the session id is not the last field');
});

test('CPace: the padding puts the password and the session id in different blocks', () => {
  /*
   * The property the padding exists for: whatever the code is, the domain string, the
   * password and the padding come to exactly one SHA-512 input block, so the compression
   * that touches the password touches nothing session-specific. A fixed-size padding gets
   * this right for one code length and wrong for every other.
   */
  // 113 is the longest password the block still has room for, once the two fields around
  // it and the three length bytes are counted.
  for (const len of [0, 1, 5, 6, 8, 32, 100, 113]) {
    const [dsi, prs, zpad] = lvSplit(cpaceGeneratorString('A'.repeat(len), sid));
    const upToPad = 1 + dsi.length + 1 + prs.length + 1 + zpad.length;
    assert.equal(upToPad, 128, `a ${len}-character code did not land on the block boundary`);
  }
});

test('CPace: a password too long to pad for does not produce a negative padding', () => {
  // 'A'.repeat(200) leaves no room; the padding goes to zero rather than underflowing.
  const [, prs, zpad] = lvSplit(cpaceGeneratorString('A'.repeat(200), sid));
  assert.equal(prs.length, 200);
  assert.equal(zpad.length, 0, 'the padding did not clamp');
});

test('CPace: both sides derive the same key from the same code', async () => {
  const a = cpaceStart('ABC234', sid);
  const b = cpaceStart('ABC234', sid);
  const ka = await cpaceFinish(a.state, b.msg);
  const kb = await cpaceFinish(b.state, a.msg);
  assert.equal(ka.length, 32);
  assert.ok(equal(ka, kb), 'keys must agree');
});

test('CPace: a different code gives a different key', async () => {
  const a = cpaceStart('ABC234', sid);
  const b = cpaceStart('ABC235', sid);
  const ka = await cpaceFinish(a.state, b.msg);
  const kb = await cpaceFinish(b.state, a.msg);
  assert.ok(!equal(ka, kb), 'a wrong code must not agree');
});

test('CPace: a different session id gives a different key', async () => {
  const other = new Uint8Array(16).fill(9);
  const a = cpaceStart('ABC234', sid);
  const b = cpaceStart('ABC234', other);
  const ka = await cpaceFinish(a.state, b.msg);
  const kb = await cpaceFinish(b.state, a.msg);
  assert.ok(!equal(ka, kb));
});

test('CPace: the identity element is refused', async () => {
  const a = cpaceStart('ABC234', sid);
  const identity = new Uint8Array(32); // ristretto encoding of the identity
  await assert.rejects(() => cpaceFinish(a.state, identity), /identity/);
});

test('CPace: a malformed peer message is refused', async () => {
  const a = cpaceStart('ABC234', sid);
  await assert.rejects(() => cpaceFinish(a.state, new Uint8Array(31)), /bad peer message/);
  const notOnCurve = new Uint8Array(32).fill(0xff);
  await assert.rejects(() => cpaceFinish(a.state, notOnCurve));
});

test('CPace: two runs of the same code produce different transcripts', async () => {
  const a1 = cpaceStart('ABC234', sid);
  const a2 = cpaceStart('ABC234', sid);
  assert.ok(!equal(a1.msg, a2.msg), 'the ephemeral share must not repeat');
});

test('AEAD: seals and opens, and rejects a tampered ciphertext', async () => {
  const key = await aeadKey(await hkdf(new Uint8Array(32).fill(1), 'test', 32));
  const nonce = nonceFor(0, 42);
  const aad = te.encode('bound');
  const ct = await seal(key, nonce, te.encode('hello world'), aad);

  const pt = await open(key, nonce, ct, aad);
  assert.equal(new TextDecoder().decode(pt), 'hello world');

  const flipped = Uint8Array.from(ct);
  flipped[3] ^= 1;
  await assert.rejects(() => open(key, nonce, flipped, aad));

  // Wrong associated data must fail: this is what binds a chunk to its offset.
  await assert.rejects(() => open(key, nonce, ct, te.encode('different')));

  // Wrong nonce must fail: this is what stops a chunk being replayed at another index.
  await assert.rejects(() => open(key, nonceFor(0, 43), ct, aad));
});

test('AEAD: an absent associated data value is accepted consistently', async () => {
  const key = await aeadKey(new Uint8Array(32).fill(3));
  const ct = await seal(key, nonceFor(1, 1), te.encode('x'));
  const pt = await open(key, nonceFor(1, 1), ct);
  assert.equal(new TextDecoder().decode(pt), 'x');
});

test('nonce: lane and counter are independent axes', () => {
  assert.ok(!equal(nonceFor(0, 1), nonceFor(1, 1)));
  assert.ok(!equal(nonceFor(0, 1), nonceFor(0, 2)));
  assert.equal(nonceFor(0, 0).length, 12);
});

test('SAS: same key and fingerprints agree, and order does not matter', async () => {
  const k = new Uint8Array(32).fill(5);
  const one = await sasWords(k, 'sha-256 AA:BB', 'sha-256 CC:DD');
  const two = await sasWords(k, 'sha-256 CC:DD', 'sha-256 AA:BB');
  assert.deepEqual(one, two, 'both peers must read the same words');
  assert.equal(one.length, 4);
});

test('SAS: a swapped fingerprint changes the words', async () => {
  const k = new Uint8Array(32).fill(5);
  const honest = await sasWords(k, 'sha-256 AA:BB', 'sha-256 CC:DD');
  const mitm = await sasWords(k, 'sha-256 AA:BB', 'sha-256 EE:FF');
  assert.notDeepEqual(honest, mitm, 'this is the whole point of the safety words');
});

test('SAS: a different key changes the words even with identical fingerprints', async () => {
  const one = await sasWords(new Uint8Array(32).fill(1), 'a', 'b');
  const two = await sasWords(new Uint8Array(32).fill(2), 'a', 'b');
  assert.notDeepEqual(one, two);
});

test('fingerprintOf: pulls the DTLS fingerprint out of an SDP blob', () => {
  const sdp = 'v=0\r\na=group:BUNDLE 0\r\na=fingerprint:sha-256 AB:CD:EF\r\na=setup:actpass\r\n';
  assert.equal(fingerprintOf(sdp), 'sha-256 ab:cd:ef');
  assert.equal(fingerprintOf(''), '');
  assert.equal(fingerprintOf(undefined), '');
});

test('codes: drawn from the unambiguous alphabet, at full length', () => {
  for (let i = 0; i < 200; i++) {
    const code = newCode();
    assert.equal(code.length, CODE_LEN);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `${ch} is not in the alphabet`);
  }
});

test('codes: the alphabet drops the letters people misread', () => {
  for (const bad of ['I', 'L', 'O', 'U']) {
    assert.ok(!CODE_ALPHABET.includes(bad), `${bad} must not be in the alphabet`);
  }
  assert.equal(CODE_ALPHABET.length, 32, 'five clean bits per symbol');
  assert.equal(new Set(CODE_ALPHABET).size, 32, 'no duplicates');
});

test('codes: normalisation upper-cases and drops anything unusable', () => {
  assert.equal(normalizeCode('abc-234'), 'ABC234');
  assert.equal(normalizeCode(' a b c 2 3 4 '), 'ABC234');
  // Lookalikes fold the way a person means them, rather than being silently dropped.
  assert.equal(normalizeCode('O'), '0');
  assert.equal(normalizeCode('I'), '1');
  assert.equal(normalizeCode('L'), '1');
  assert.equal(normalizeCode('oil'), '011');
  assert.equal(normalizeCode('U'), '', 'U is not in the alphabet and has no obvious fold');
  assert.equal(normalizeCode(null), '');
});

test('tags: a code maps to a 16-byte tag that does not reveal the code', async () => {
  const t1 = await tagForCode('ABC234');
  const t2 = await tagForCode('ABC234');
  const t3 = await tagForCode('ABC235');
  assert.equal(t1.length, 16);
  assert.ok(equal(t1, t2));
  assert.ok(!equal(t1, t3));
});

test('pair tags: rotate per epoch and are unlinkable without the root', async () => {
  const root = new Uint8Array(32).fill(11);
  const e = currentEpoch();
  const now = await pairTag(root, e);
  const next = await pairTag(root, e + 1);
  const other = await pairTag(new Uint8Array(32).fill(12), e);

  assert.equal(now.length, 16);
  assert.ok(!equal(now, next), 'the tag must change every epoch');
  assert.ok(!equal(now, other), 'a different pair must not collide');
  assert.ok(equal(now, await pairTag(root, e)), 'and must be reproducible within the epoch');
});

test('padding: hides the true length and round-trips exactly', () => {
  for (const len of [0, 1, 100, 251, 252, 253, 600]) {
    const body = new Uint8Array(len).fill(0xab);
    const padded = pad(body, 256);
    assert.equal(padded.length % 256, 0, 'padded to a block boundary');
    assert.ok(padded.length >= len + 4);
    assert.ok(equal(unpad(padded), body));
  }
});

test('padding: a short and a long message inside one block look the same size', () => {
  assert.equal(pad(new Uint8Array(1), 256).length, pad(new Uint8Array(200), 256).length);
});

test('hkdf: different info strings give different keys', async () => {
  const ikm = new Uint8Array(32).fill(4);
  const a = await hkdf(ikm, 'gd/sig/v1', 32);
  const b = await hkdf(ikm, 'gd/ctl/v1', 32);
  assert.ok(!equal(a, b));
  assert.ok(equal(a, await hkdf(ikm, 'gd/sig/v1', 32)));
});

/* ------------------------------------------------- rendezvous tag hardness */

test('the rendezvous tag is expensive to invert, and cannot be precomputed once', async () => {
  const { codeEpoch, hostEpochs, TAG_ITERATIONS, CODE_EPOCH_SECONDS } = await import(
    '../web/core/gdcrypto.js'
  );

  const e = codeEpoch();
  const a = await tagForCode('AB12CD', e);
  const b = await tagForCode('AB12CD', e);
  assert.equal(a.length, 16);
  assert.deepEqual(a, b, 'both sides derive the same tag in the same epoch');

  assert.notDeepEqual(
    toHex(a),
    toHex(await tagForCode('AB12CE', e)),
    'a different code is a different rendezvous',
  );

  // Without this the whole 30-bit code space can be tabulated once and every tag inverted
  // for ever after. With it, a table is stale ten minutes later.
  assert.notDeepEqual(
    toHex(a),
    toHex(await tagForCode('AB12CD', e + 1)),
    'the same code in the next epoch is a different tag',
  );

  assert.equal(CODE_EPOCH_SECONDS, 600);
  assert.ok(TAG_ITERATIONS >= 300_000, `${TAG_ITERATIONS} rounds is not a speed bump`);

  const epochs = hostEpochs();
  assert.deepEqual(epochs, [e, e - 1, e + 1], 'a host covers ten minutes of skew either way');
  assert.ok(epochs.includes(codeEpoch()), 'including the joiner deriving its own current epoch');
});

test('deriving a tag costs real work, so an exhaustive search costs real money', async () => {
  // A 30-bit code is not protected by a single hash: 1.07e9 candidates is 0.1 s on a GPU.
  // This asserts the cost is still there, because the failure mode of the fix is somebody
  // quietly lowering the iteration count to make a test faster.
  const t0 = process.hrtime.bigint();
  await tagForCode('ZZ9988');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms > 3, `one derivation took ${ms.toFixed(1)} ms; the work factor is gone`);
});
