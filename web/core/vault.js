/**
 * Secrets at rest.
 *
 * The device key and every pairing root are sealed under a non-extractable AES-GCM key whose
 * CryptoKey object lives in IndexedDB. The browser will encrypt with it on request but there
 * is no call that returns its bytes, so a copied database yields ciphertext and a handle that
 * does not travel with it.
 *
 * This defeats readout from a storage snapshot, a copied profile or a backup. It does not
 * defeat a live attacker inside the page, who can ask the browser to decrypt as we do.
 *
 * Where a browser refuses to store a CryptoKey the fallback is memory-only, so pairings are
 * dropped on reload rather than written in the clear.
 */
import { kv } from './store.js';

const subtle = globalThis.crypto?.subtle;
const SLOT = 'vault-key-v1';
const te = new TextEncoder();
const td = new TextDecoder();

/**
 * 'protected': a key is available, held by the browser or derived from a passphrase.
 * 'locked':    a passphrase is set and has not been given yet. Nothing can be read.
 * 'session':   memory only, lost on reload.
 */
let mode = 'unknown';
let keyPromise = null;

export const vaultMode = () => mode;

async function makeKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * A stored key is only trustworthy if it came back as a CryptoKey that still refuses to be
 * exported. Anything else, such as a structured clone that degraded to an object or an entry
 * written by something that is not us, is treated as absent.
 */
function usable(k) {
  return typeof CryptoKey !== 'undefined' && k instanceof CryptoKey && k.extractable === false;
}

async function resolveKey() {
  if (!subtle?.generateKey) {
    mode = 'session';
    return null;
  }
  // A passphrase means there is nothing here to find. Say so rather than minting a second
  // key beside the records the first one sealed.
  if (await readLock()) {
    mode = 'locked';
    return null;
  }
  try {
    const found = await kv.get(SLOT);
    if (usable(found)) {
      mode = 'protected';
      return found;
    }
  } catch {
    /* storage unreadable; fall through and try to establish one */
  }

  const fresh = await makeKey();
  try {
    await kv.set(SLOT, fresh);
    // Written is not the same as stored: some engines accept the put and hand back
    // something inert. Only a successful round trip counts as durable.
    const back = await kv.get(SLOT);
    if (usable(back)) {
      mode = 'protected';
      return back;
    }
  } catch {
    /* cannot persist a key handle here */
  }

  mode = 'session';
  return fresh;
}

function vaultKey() {
  if (!keyPromise) keyPromise = resolveKey().catch(() => null);
  return keyPromise;
}

/** Warm the key up (and settle `vaultMode`) before anything asks to read a secret. */
export async function openVault() {
  await vaultKey();
  return mode;
}

/**
 * Seal raw bytes for storage. The result is structured-cloneable and contains nothing
 * useful without the key handle.
 */
export async function seal(bytes) {
  const key = await vaultKey();
  if (!key) throw new Error('no vault key available');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, Uint8Array.from(bytes)),
  );
  return { v: 1, iv, ct };
}

/**
 * Unseal, or return null. Null is the answer for a record written under a key this
 * browser no longer has, and callers are expected to discard the record rather than guess
 * at it.
 */
export async function unseal(rec) {
  if (!rec || rec.v !== 1 || !rec.iv || !rec.ct) return null;
  const key = await vaultKey();
  if (!key) return null;
  touch();
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(rec.iv) },
      key,
      Uint8Array.from(rec.ct),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/**
 * Move a record's secret field into the vault, in place.
 *
 * Records written by an earlier version hold the secret as a plain array. Those are sealed
 * on the next read and the cleartext removed, so an upgrade repairs itself without asking
 * anyone to pair again. It cannot un-leak a database that was already copied, but it stops
 * the exposure continuing.
 */
/**
 * Which fields of a stored record hold ciphertext.
 *
 * By shape rather than by name. Re-encrypting this device's data means finding every sealed
 * field in every store, and naming them one store at a time is how a record that changes
 * shape falls out of the conversion without anything saying so: the pairings went from a
 * sealed root beside plaintext metadata to one sealed record, and a loop still looking for
 * `rootSealed` left every paired device unreadable the moment a passphrase was set.
 */
export function sealedFields(rec) {
  return Object.keys(rec || {}).filter((k) => k === 'sealed' || k.endsWith('Sealed'));
}

export async function sealField(rec, field) {
  const plain = rec?.[field];
  if (!plain) return rec;
  const out = { ...rec, [`${field}Sealed`]: await seal(plain) };
  delete out[field];
  return out;
}

/** The inverse: hand back the record with `field` present as bytes, or null if unreadable. */
export async function unsealField(rec, field) {
  if (!rec) return null;
  const sealed = rec[`${field}Sealed`];
  if (sealed) {
    const bytes = await unseal(sealed);
    if (!bytes) return null;
    const out = { ...rec, [field]: bytes };
    delete out[`${field}Sealed`];
    return out;
  }
  // Legacy plaintext: usable, but the caller is expected to write it straight back sealed.
  if (rec[field]) return { ...rec, [field]: Uint8Array.from(rec[field]), legacy: true };
  return null;
}

/* ─────────────────────────────── the lock ──────────────────────────────── */

/**
 * A passphrase, and what it changes.
 *
 * Without one the key is a non-extractable `CryptoKey` in IndexedDB. That defeats reading a
 * copied database, since no call returns its bytes, but it does not defeat the browser it
 * belongs to: hand a forensic examiner the profile and the matching build and the records
 * open, because the browser holds a key it is willing to use and nobody has to know anything
 * to ask it.
 *
 * With a passphrase there is no key at rest. It is derived on demand from something only the
 * person knows, and what remains on disk is a salt, a round count, and ciphertext. No profile
 * copy, no browser and no amount of time with the device recovers the contents without the
 * passphrase, and nothing recovers it if the passphrase is lost.
 *
 * What it still does not defeat: a live attacker in the page while it is unlocked, and code
 * this origin serves. Those are not storage problems and a passphrase is not their answer.
 */
const LOCK = 'vault-lock-v1';

/**
 * Memory, not just time.
 *
 * PBKDF2 is pure arithmetic with a few hundred bytes of state, which is the shape of problem
 * a GPU is built for: a card runs thousands of guesses at once because each one costs almost
 * no memory. Raising the round count buys a linear increase against an attacker with a
 * quadratic advantage. Measured here, 1.2 million rounds of PBKDF2-SHA256 cost the person
 * 115 ms on a machine with SHA extensions, which is now most of them.
 *
 * scrypt makes each guess hold 128·N·r bytes. At these parameters that is 64 MiB, so a card
 * with 24 GB of memory holds a few hundred guesses at a time rather than tens of thousands.
 * The cost to the person is 150 ms.
 *
 * Argon2id was measured too: 64 MiB of hardness costs 1.1 seconds in JavaScript against
 * scrypt's 150 ms for the same memory, because the reference design leans on 64-bit
 * arithmetic that JavaScript does not have. Per second of wall-clock, scrypt here buys about
 * seven times the memory-hardness. The parameters travel in the record, so they can be raised
 * later without stranding a vault locked under the old ones.
 */
export const LOCK_SCRYPT = { N: 1 << 16, r: 8, p: 1 };

/** What a vault locked before the move to scrypt was derived with. Still readable. */
export const LOCK_ROUNDS = 1_200_000;

/**
 * How long a protected device stays open with nobody using it.
 *
 * Half an hour rather than the fifteen minutes a banking app would pick, because the cost of
 * being wrong is not symmetric here. Locking too late leaves a window on a machine somebody
 * walked away from, which the operating system's own screen lock is also covering. Locking
 * too early interrupts a person who is still there - reading a conversation, waiting on a
 * download in another tab - and charges them a passphrase and a reload for it. The second
 * mistake is the one that makes people turn the lock off altogether, and a lock nobody uses
 * protects nothing.
 *
 * Anyone who wants it shut sooner has a button that shuts it now, which is a better answer
 * than a number to configure.
 */
export const AUTO_LOCK_MS = 30 * 60 * 1000;

let lockRecord = null;
let lockLoaded = false;

async function readLock() {
  if (lockLoaded) return lockRecord;
  lockLoaded = true;
  try {
    const rec = await kv.get(LOCK);
    const known = rec?.v === 1 || rec?.v === 2;
    lockRecord = known && rec.salt && rec.check ? rec : null;
  } catch {
    lockRecord = null;
  }
  return lockRecord;
}

/** Whether this device is protected by something the person knows. */
export async function hasPassphrase() {
  return !!(await readLock());
}

/**
 * Passphrase to key.
 *
 * The salt is per-device and random, so the work cannot be done once for everybody, and the
 * derived key is marked non-extractable, so a page that is already unlocked cannot read the
 * key out of itself and send it anywhere.
 */
async function deriveScrypt(passphrase, salt, params) {
  const { scryptAsync } = await import('../vendor/@noble/hashes/scrypt.js');
  const raw = await scryptAsync(te.encode(passphrase), Uint8Array.from(salt), {
    N: params?.N || LOCK_SCRYPT.N,
    r: params?.r || LOCK_SCRYPT.r,
    p: params?.p || LOCK_SCRYPT.p,
    dkLen: 32,
    // 64 MiB is above the library's default ceiling, which exists to catch a typo rather
    // than to cap what is deliberate.
    maxmem: 1024 ** 3,
  });
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  // The bytes are gone the moment the key object exists; only the browser holds it now, and
  // it is non-extractable, so an unlocked page still cannot read the key out of itself.
  raw.fill(0);
  return key;
}

/** Whichever derivation this particular record was written with. */
async function deriveFor(rec, passphrase) {
  return rec.v === 2
    ? deriveScrypt(passphrase, rec.salt, rec)
    : deriveKey(passphrase, rec.salt, rec.rounds || LOCK_ROUNDS);
}

/** A record describing how a fresh lock was derived, so it can be opened again. */
const scryptRecord = (salt, check) => ({ v: 2, kdf: 'scrypt', salt, ...LOCK_SCRYPT, check });

async function deriveKey(passphrase, salt, rounds) {
  const material = await subtle.importKey('raw', te.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(salt), iterations: rounds },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * A wrong passphrase has to be told apart from a corrupt record, and neither may be told
 * apart by timing or by content. Encrypting a known string under the derived key and
 * checking it decrypts does both: GCM either authenticates or it does not.
 */
async function makeCheck(key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(CHECK)));
  return { iv, ct };
}

const CHECK = 'gd/vault/check/v1';

async function verify(key, check) {
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(check.iv) },
      key,
      Uint8Array.from(check.ct),
    );
    return td.decode(pt) === CHECK;
  } catch {
    return false;
  }
}

/**
 * Open a locked vault. A wrong passphrase returns false and changes nothing. There is no
 * counter and no lockout, because both would be state an attacker with the database could
 * edit, and the cost of a guess is already a second of key derivation.
 */
export async function unlock(passphrase, reseal) {
  const rec = await readLock();
  if (!rec || !passphrase) return false;
  const key = await deriveFor(rec, passphrase);
  if (!(await verify(key, rec.check))) return false;

  keyPromise = Promise.resolve(key);
  mode = 'protected';
  touch();

  /*
   * A vault locked under the old derivation is moved across on the way in.
   *
   * The passphrase is right here and the records are readable exactly now, which is the only
   * moment this can be done without asking for it again. It is attempted once and its failure
   * is not the person's problem: they typed the right passphrase and the vault is open, which
   * is what they asked for. The old record stays until the new one is written and everything
   * has been re-sealed under it, so an interruption leaves a vault that still opens.
   */
  if (rec.v === 1 && typeof reseal === 'function') {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const next = await deriveScrypt(passphrase, salt, LOCK_SCRYPT);
      await reseal(key, next);
      await kv.set(LOCK, scryptRecord(salt, await makeCheck(next)));
      lockRecord = await kv.get(LOCK);
      keyPromise = Promise.resolve(next);
    } catch {
      /* still unlocked under the old derivation; it will be offered again next time */
    }
  }
  return true;
}

/** Forget the derived key. The records stay; nothing can read them until it is derived again. */
export function lockNow() {
  if (!lockRecord) return false;
  keyPromise = null;
  mode = 'locked';
  return true;
}

/**
 * Turn a passphrase on, off, or change it.
 *
 * Every one of these changes which key the records are sealed under, so every one of them
 * has to re-seal what is already stored. `reseal` is handed the old key and the new one and
 * is expected to rewrite every record. If it throws, nothing is committed and the vault is
 * left as it was, because a half-converted database has records nobody can open.
 */
export async function setPassphrase(passphrase, reseal) {
  if (!subtle?.deriveKey) throw new Error('no key derivation here');
  const old = await vaultKey();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const next = await deriveScrypt(passphrase, salt, LOCK_SCRYPT);

  await reseal(old, next);

  await kv.set(LOCK, scryptRecord(salt, await makeCheck(next)));
  // The stored handle is what a browser could have used on its own. It goes last, once the
  // records it protected are already readable under the passphrase instead.
  await kv.del(SLOT).catch(() => {});

  lockRecord = await kv.get(LOCK);
  lockLoaded = true;
  keyPromise = Promise.resolve(next);
  mode = 'protected';
  touch();
  return true;
}

/** Back to a key the browser holds. Requires the current passphrase, and re-seals. */
export async function clearPassphrase(passphrase, reseal) {
  if (!(await hasPassphrase())) return false;
  const rec = lockRecord;
  const current = await deriveFor(rec, passphrase);
  if (!(await verify(current, rec.check))) return false;

  const fresh = await makeKey();
  await reseal(current, fresh);

  await kv.set(SLOT, fresh);
  const back = await kv.get(SLOT);
  await kv.del(LOCK).catch(() => {});

  lockRecord = null;
  lockLoaded = true;
  keyPromise = Promise.resolve(usable(back) ? back : fresh);
  mode = usable(back) ? 'protected' : 'session';
  return true;
}

/** Change it, which is the same operation twice with a verified start. */
export async function changePassphrase(current, next, reseal) {
  const rec = await readLock();
  if (!rec) return false;
  const now = await deriveFor(rec, current);
  if (!(await verify(now, rec.check))) return false;

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const then = await deriveScrypt(next, salt, LOCK_SCRYPT);
  await reseal(now, then);

  await kv.set(LOCK, scryptRecord(salt, await makeCheck(then)));
  lockRecord = await kv.get(LOCK);
  keyPromise = Promise.resolve(then);
  mode = 'protected';
  touch();
  return true;
}

/* ---- re-sealing needs to read and write under a key that is not the current one ---- */

/** Seal under a specific key. Used only while converting between them. */
export async function sealWith(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, Uint8Array.from(bytes)));
  return { v: 1, iv, ct };
}

/** Unseal under a specific key, or null. */
export async function unsealWith(key, rec) {
  if (!rec || rec.v !== 1 || !rec.iv || !rec.ct) return null;
  try {
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: Uint8Array.from(rec.iv) },
      key,
      Uint8Array.from(rec.ct),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/* ---- idle re-lock ---- */

let idleAt = 0;

/** Mark the vault as in use. Called on unlock and whenever a secret is read. */
function touch() {
  idleAt = Date.now();
}

/**
 * The same, for the page.
 *
 * Reading a sealed record is one kind of use and not the only one. Someone reading a
 * conversation already on screen, dragging a file onto a device or working through settings
 * never unseals anything, and to a clock that only hears `unseal` they are indistinguishable
 * from someone who walked away. The app marks real input with this, so the fifteen minutes
 * mean what anybody would expect them to mean.
 */
export function noteActivity() {
  touch();
}

/**
 * Re-lock after a quiet spell.
 *
 * An unlocked tab left open is an unlocked device: anyone who sits down at it reads the
 * conversations without being asked. Checked lazily rather than on a timer, so a backgrounded
 * tab that is never looked at again costs nothing and is still locked when it is.
 */
export function lockIfIdle(now = Date.now()) {
  if (mode !== 'protected' || !lockRecord) return false;
  if (now - idleAt < AUTO_LOCK_MS) return false;
  return lockNow();
}
