/**
 * Re-locking after a quiet spell.
 *
 * `AUTO_LOCK_MS` and `lockIfIdle()` were written when the lock was, and nothing called either
 * of them for as long as they existed: a device protected by a passphrase stayed open from the
 * moment it was unlocked until the tab was closed. An unlocked tab is an unlocked device, so
 * the gap was the whole value of having a passphrase on a machine anybody else can reach.
 *
 * These drive the real vault rather than a copy of its arithmetic. The only thing replaced is
 * the store underneath it, because IndexedDB is a browser and this is not one - `kv` is a
 * plain object, so its three methods are swapped for a Map and every line above them is the
 * shipped one.
 *
 * The tests run in order on purpose. The vault's mode is module state, as it is in the page,
 * and the sequence here is the sequence a device goes through: no passphrase, then one, then
 * locked, then open again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { kv } from '../web/core/store.js';

/** Everything the vault stores, in memory, so nothing here needs a browser. */
const store = new Map();
kv.get = async (key) => store.get(key);
kv.set = async (key, value) => void store.set(key, value);
kv.del = async (key) => void store.delete(key);

const vault = await import('../web/core/vault.js');

/** The vault hands the old key and the new one to its caller to move records across. */
const reseal = async () => {};

/** A moment this many milliseconds from now, for `lockIfIdle`, which takes one. */
const inMs = (ms) => Date.now() + ms;

test('a device with no passphrase is never locked out of its own data', async () => {
  assert.equal(await vault.openVault(), 'protected', 'the browser holds a key when nothing else does');
  assert.equal(await vault.hasPassphrase(), false);

  // A year later, still not locked: there would be nothing to unlock it with.
  assert.equal(vault.lockIfIdle(inMs(365 * 24 * 3600_000)), false);
  assert.equal(vault.vaultMode(), 'protected');
});

test('a passphrase starts the clock rather than locking immediately', async () => {
  assert.equal(await vault.setPassphrase('a passphrase long enough to be one', reseal), true);
  assert.equal(await vault.hasPassphrase(), true);

  assert.equal(vault.lockIfIdle(Date.now()), false, 'locked the instant it was set');
  assert.equal(vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS - 1000)), false, 'locked a second early');
  assert.equal(vault.vaultMode(), 'protected');
});

/*
 * Measured against a moment that has actually passed, rather than against "now".
 *
 * Asserting that the vault is still open shortly after activity proves nothing: it was
 * already open, and the clock had just been touched by whatever set the passphrase. The
 * question is whether activity *moved* the deadline, so the test picks an instant that is
 * past the timeout as measured from before the pause, and not past it as measured from the
 * activity. Only a `noteActivity` that really writes the clock separates those two.
 */
test('activity puts the moment of locking back', async () => {
  const before = Date.now();
  await new Promise((r) => setTimeout(r, 80));
  vault.noteActivity();

  assert.equal(
    vault.lockIfIdle(before + vault.AUTO_LOCK_MS + 40),
    false,
    'the deadline did not move, so using the app does not keep it open',
  );
  assert.equal(vault.vaultMode(), 'protected');
});

/** Something real to lose access to, sealed while the vault is open. */
let sealedEarlier = null;
const SECRET = new TextEncoder().encode('the conversation, and who it was with');

test('the quiet spell ends in a locked vault', async () => {
  sealedEarlier = await vault.seal(SECRET);
  assert.deepEqual(await vault.unseal(sealedEarlier), SECRET, 'it could not read its own record');

  assert.equal(vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS + 1000)), true);
  assert.equal(vault.vaultMode(), 'locked');
});

/*
 * A real record, sealed a moment ago by this same vault, and now unreadable.
 *
 * Handing it a malformed record would prove nothing - that fails whatever the key is. This
 * is the actual claim: locking takes away the ability to read what was readable, which is
 * the one thing the feature is for.
 */
test('a locked vault cannot read what it sealed a moment ago', async () => {
  assert.equal(await vault.unseal(sealedEarlier), null);
  await assert.rejects(() => vault.seal(SECRET), 'it sealed something new while locked');
});

test('it stays locked, rather than one more check letting it through', () => {
  assert.equal(vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS * 4)), false, 'locking twice is not a thing');
  assert.equal(vault.vaultMode(), 'locked');
});

test('the passphrase opens it again, and what it sealed is there', async () => {
  assert.equal(await vault.unlock('a passphrase long enough to be one', reseal), true);
  assert.equal(vault.vaultMode(), 'protected');

  // Locking is not losing: the same record reads back under the same passphrase.
  assert.deepEqual(await vault.unseal(sealedEarlier), SECRET);
  assert.equal(vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS - 1000)), false);
});

test('a wrong passphrase leaves it shut', async () => {
  vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS + 1000));
  assert.equal(vault.vaultMode(), 'locked');
  assert.equal(await vault.unlock('not the passphrase', reseal), false);
  assert.equal(vault.vaultMode(), 'locked');
});

test('changing it needs the current one, and the new one is what opens it after', async () => {
  assert.equal(await vault.unlock('a passphrase long enough to be one', reseal), true);

  assert.equal(
    await vault.changePassphrase('the wrong current one', 'something else entirely', reseal),
    false,
    'changed without knowing the current passphrase',
  );

  assert.equal(
    await vault.changePassphrase('a passphrase long enough to be one', 'a different one, also long', reseal),
    true,
  );

  // Locked again, and only the new one gets back in.
  vault.lockIfIdle(inMs(vault.AUTO_LOCK_MS + 1000));
  assert.equal(vault.vaultMode(), 'locked');
  assert.equal(await vault.unlock('a passphrase long enough to be one', reseal), false, 'the old one still worked');
  assert.equal(await vault.unlock('a different one, also long', reseal), true);
});

test('half an hour is the window, stated where the app can read it', () => {
  // Not a number picked here: the page waits on this constant, so a change to it is a change
  // to the behaviour and should be a change to this line too. It is long on purpose - a lock
  // that interrupts someone still sitting there is a lock they will switch off.
  assert.equal(vault.AUTO_LOCK_MS, 30 * 60 * 1000);
});
