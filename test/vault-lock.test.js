/**
 * The passphrase lock.
 *
 * What is being tested is a negative: that after locking, the stored bytes are of no use to
 * anyone holding them, including this browser, which is the reason the feature exists.
 * So the assertions are mostly "this does not work", and the setup deliberately hands the
 * attacker everything a forensic copy would contain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const subtle = webcrypto.subtle;
const te = new TextEncoder();

/** The derivation the vault uses, reproduced here so the test does not trust the module. */
async function derive(passphrase, salt, rounds) {
  const material = await subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// Kept low here on purpose: this exercises the construction, not the cost. The shipped round
// count is asserted separately, against the constant the app actually uses.
const ROUNDS = 1000;

async function seal(key, text) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text)));
  return { iv, ct };
}

const open = (key, rec) =>
  subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.ct).then(
    (b) => new TextDecoder().decode(b),
    () => null,
  );

test('the right passphrase opens it and a wrong one does not', async () => {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await derive('correct horse battery staple', salt, ROUNDS);
  const rec = await seal(key, 'the conversation');

  assert.equal(await open(await derive('correct horse battery staple', salt, ROUNDS), rec), 'the conversation');
  for (const wrong of ['correct horse battery stapl', 'Correct horse battery staple', '', 'x']) {
    assert.equal(await open(await derive(wrong, salt, ROUNDS), rec), null, `"${wrong}" opened it`);
  }
});

test('the salt is what stops one answer working everywhere', async () => {
  const a = webcrypto.getRandomValues(new Uint8Array(16));
  const b = webcrypto.getRandomValues(new Uint8Array(16));
  const rec = await seal(await derive('same passphrase', a, ROUNDS), 'secret');
  // Same passphrase, different device: the work done against one buys nothing against the other.
  assert.equal(await open(await derive('same passphrase', b, ROUNDS), rec), null);
});

test('the derived key refuses to be exported, so an unlocked page cannot leak it', async () => {
  const key = await derive('anything', webcrypto.getRandomValues(new Uint8Array(16)), ROUNDS);
  assert.equal(key.extractable, false);
  await assert.rejects(() => subtle.exportKey('raw', key), 'the key came back out');
});

test('a tampered record does not open, it fails', async () => {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await derive('passphrase', salt, ROUNDS);
  const rec = await seal(key, 'the conversation');

  for (const i of [0, 3, rec.ct.length - 1]) {
    const bent = { iv: rec.iv, ct: Uint8Array.from(rec.ct) };
    bent.ct[i] ^= 1;
    assert.equal(await open(key, bent), null, `a flipped bit at ${i} was accepted`);
  }
  const movedIv = { iv: Uint8Array.from(rec.iv), ct: rec.ct };
  movedIv.iv[0] ^= 1;
  assert.equal(await open(key, movedIv), null, 'a changed nonce was accepted');
});

test('what is left on disk carries nothing of the passphrase or the text', async () => {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const key = await derive('hunter2 hunter2 hunter2', salt, ROUNDS);
  const rec = await seal(key, 'meet me at the usual place');

  const onDisk = Buffer.concat([Buffer.from(salt), Buffer.from(rec.iv), Buffer.from(rec.ct)]).toString('latin1');
  for (const fragment of ['hunter2', 'meet me', 'usual place']) {
    assert.ok(!onDisk.includes(fragment), `"${fragment}" is recoverable from storage`);
  }
});

test('the shipped round count is one an offline guesser has to pay', async () => {
  const { LOCK_ROUNDS, AUTO_LOCK_MS } = await import('../web/core/vault.js');
  // Not a number pulled from the air: OWASP's floor for PBKDF2-HMAC-SHA256 is 600,000.
  assert.ok(LOCK_ROUNDS >= 600_000, `${LOCK_ROUNDS} rounds is below the recommended floor`);
  assert.ok(AUTO_LOCK_MS > 0 && AUTO_LOCK_MS <= 60 * 60 * 1000, 'idle re-lock is unset or too long');
});

test('two seals of the same text under the same key look unrelated', async () => {
  const key = await derive('passphrase', webcrypto.getRandomValues(new Uint8Array(16)), ROUNDS);
  const a = await seal(key, 'identical');
  const b = await seal(key, 'identical');
  assert.notDeepEqual(Array.from(a.iv), Array.from(b.iv), 'a nonce was reused');
  assert.notDeepEqual(Array.from(a.ct), Array.from(b.ct));
});

/*
 * The passphrase is the weak link, not the derivation.
 *
 * A million rounds costs a guesser about a tenth of a second. Against a dictionary that is
 * nothing, so what decides the outcome is how much the passphrase could have been. The
 * suggestion is there to make that number large without asking anyone to invent it.
 */
test('the suggested passphrase carries real choice', async () => {
  const { SAS_WORDS } = await import('../web/core/wordlist.js');
  assert.equal(SAS_WORDS.length, 256, 'eight bits a word is what the arithmetic assumes');

  const WORDS = 6;
  const bits = WORDS * Math.log2(SAS_WORDS.length);
  assert.ok(bits >= 48, `${bits} bits is not enough to be worth suggesting`);

  // At the shipped round count, on hardware far faster than a browser.
  const { LOCK_ROUNDS } = await import('../web/core/vault.js');
  const guessesPerSecond = 1e9 / LOCK_ROUNDS; // a billion SHA-256/s, spent entirely on guessing
  const years = 2 ** bits / guessesPerSecond / (60 * 60 * 24 * 365);
  assert.ok(years > 1000, `exhausting it would take ${Math.round(years)} years`);
});

test('two suggestions do not come out the same', () => {
  const draw = () => {
    const pick = webcrypto.getRandomValues(new Uint32Array(6));
    return Array.from(pick, (n) => n % 256).join('-');
  };
  const seen = new Set(Array.from({ length: 200 }, draw));
  assert.equal(seen.size, 200, 'the generator repeats');
});

/* ------------------------------------------------- moving everything to a new key */

/*
 * Setting a passphrase re-encrypts everything this device holds. Whatever that conversion
 * misses becomes unreadable at the moment it runs, silently and permanently, so what it
 * looks for matters more than how it copies.
 */
test('every sealed field is found, whatever shape the record is', async () => {
  const { sealedFields } = await import('../web/core/vault.js');

  // The shapes the app actually writes.
  assert.deepEqual(sealedFields({ id: 'a', sealed: {} }), ['sealed'], 'a record sealed whole');
  assert.deepEqual(sealedFields({ id: 'a', rootSealed: {} }), ['rootSealed'], 'the older pairing shape');
  assert.deepEqual(sealedFields({ kind: 'laptop', pub: [], privSealed: {} }), ['privSealed'], 'the device key');
  assert.deepEqual(sealedFields({ id: 'a', at: 1, sealed: {} }), ['sealed'], 'an attachment');

  // More than one on the same record, and a record mid-migration carrying both.
  assert.deepEqual(sealedFields({ sealed: {}, rootSealed: {} }).sort(), ['rootSealed', 'sealed']);
});

test('a record with nothing sealed is left alone', async () => {
  const { sealedFields } = await import('../web/core/vault.js');
  // The resume store is the real example: an offset and a timestamp, nothing to protect.
  assert.deepEqual(sealedFields({ id: 'x:1', upto: 4096, at: 1 }), []);
  assert.deepEqual(sealedFields({}), []);
  assert.deepEqual(sealedFields(null), []);
  assert.deepEqual(sealedFields(undefined), []);
});

test('a field that merely mentions sealing is not mistaken for ciphertext', async () => {
  const { sealedFields } = await import('../web/core/vault.js');
  assert.deepEqual(sealedFields({ sealedAt: 1, unsealed: true, resealCount: 2 }), []);
});

/* ------------------------------------------------------- the cost of a guess */

/*
 * A password KDF is not judged by how slow it is for the person. It is judged by how much the
 * attacker's hardware advantage is cut, and the lever for that is memory rather than time:
 * PBKDF2 holds a few hundred bytes per guess, which is why a graphics card runs tens of
 * thousands of them at once. These fix the shape of what is shipped, not the timings, which
 * belong to whatever machine happens to run them.
 */
test('the passphrase is stretched with something memory-hard', async () => {
  const vault = await import('../web/core/vault.js');
  assert.ok(vault.LOCK_SCRYPT, 'no memory-hard parameters are exported');

  const { N, r, p } = vault.LOCK_SCRYPT;
  const bytes = 128 * N * r;
  assert.ok(bytes >= 64 * 1024 * 1024, `each guess costs only ${(bytes / 1048576).toFixed(0)} MiB`);
  assert.ok(bytes <= 256 * 1024 * 1024, `${(bytes / 1048576).toFixed(0)} MiB will fail on a phone`);
  assert.equal(p, 1);
  assert.ok(Number.isInteger(Math.log2(N)), 'N has to be a power of two');
});

test('the old derivation is still readable, because a locked vault cannot be asked to convert', async () => {
  // Someone who locked their device before this change has records only the old derivation
  // opens. Dropping it would make those unrecoverable, which is what the feature promises
  // never to do.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core', 'vault.js'),
    'utf8',
  );
  assert.match(src, /LOCK_ROUNDS = 1_200_000/, 'the old round count is gone');
  assert.match(src, /rec\.v === 2\s*\?/, 'nothing chooses a derivation by record version');
  assert.match(src, /rec\.rounds \|\| LOCK_ROUNDS/, 'a v1 record has no path to its own key');
});

test('an old vault is moved across on the way in, not left behind', async () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core', 'vault.js'),
    'utf8',
  );
  const unlock = src.slice(src.indexOf('export async function unlock('), src.indexOf('\n}', src.indexOf('export async function unlock(')));
  assert.match(unlock, /rec\.v === 1 && typeof reseal === 'function'/, 'no upgrade on unlock');
  // The new record is written only after everything has been re-sealed under the new key, so
  // an interruption leaves a vault that still opens with the same passphrase.
  const resealAt = unlock.indexOf('await reseal(');
  const writeAt = unlock.indexOf('kv.set(LOCK');
  assert.ok(resealAt > 0 && writeAt > resealAt, 'the lock is replaced before the data is moved');
});

test('scrypt derives the same key twice and a different one per salt', async () => {
  const { scryptAsync } = await import('../web/vendor/@noble/hashes/scrypt.js');
  const { LOCK_SCRYPT } = await import('../web/core/vault.js');
  // Kept small here: this exercises the construction, not the cost. The shipped parameters
  // are asserted above, against the constant the app actually uses.
  const cheap = { N: 1024, r: 8, p: 1, dkLen: 32 };
  const pass = new TextEncoder().encode('correct horse battery staple');
  const saltA = new Uint8Array(16).fill(1);
  const saltB = new Uint8Array(16).fill(2);

  const one = await scryptAsync(pass, saltA, cheap);
  const two = await scryptAsync(pass, saltA, cheap);
  const other = await scryptAsync(pass, saltB, cheap);
  assert.deepEqual(one, two, 'the same inputs gave different keys');
  assert.notDeepEqual(one, other, 'the salt changed nothing');
  assert.ok(LOCK_SCRYPT.N > cheap.N, 'the shipped cost is not the test cost');
});
