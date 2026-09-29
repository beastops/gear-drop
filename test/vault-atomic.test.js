/**
 * Changing the passphrase moves everything or nothing.
 *
 * Turning a passphrase on, changing it or taking it off re-seals every record under a new key.
 * The records were written one at a time and the record saying which key they were under was
 * written after them, so a failure part way - storage full, the tab closed - left some records
 * under a key nothing recorded. On the next launch this device's own identity would not open;
 * a new one was made silently, and every pairing already moved was dropped.
 *
 * And while the change ran, anything else that wrote - a message arriving - sealed under the
 * old key a moment before the switch, and was unreadable after it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

import { kv } from '../web/core/store.js';

const store = new Map();
kv.get = async (key) => store.get(key);
kv.set = async (key, value) => void store.set(key, value);
kv.del = async (key) => void store.delete(key);

const vault = await import('../web/core/vault.js');
const { commit } = await import('../web/core/store.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (s) => new TextEncoder().encode(s);

test('a failure part way through changes nothing at all', async () => {
  await vault.openVault();
  const identity = await vault.seal(bytes('this device'));
  store.set('device', { priv: identity });
  const before = new Map(store);

  // The move prepares its writes; one of them cannot be made.
  const failing = async (oldKey, newKey) => [
    { store: 'kv', op: 'put', key: 'device', value: { priv: await vault.sealWith(newKey, bytes('this device')) } },
    { store: 'no-such-store', op: 'put', value: {} },
  ];
  await assert.rejects(vault.setPassphrase('a passphrase long enough to be one', failing));

  assert.deepEqual([...store.keys()].sort(), [...before.keys()].sort(), 'something was written');
  assert.equal(store.get('device'), before.get('device'), 'the identity was rewritten under a key nothing records');
  assert.equal(await vault.hasPassphrase(), false);
  assert.deepEqual(await vault.unseal(store.get('device').priv), bytes('this device'), 'and it still opens');
});

test('a successful change moves the records and the lock together', async () => {
  const move = async (oldKey, newKey) => {
    const plain = await vault.unsealWith(oldKey, store.get('device').priv);
    return [{ store: 'kv', op: 'put', key: 'device', value: { priv: await vault.sealWith(newKey, plain) } }];
  };
  assert.equal(await vault.setPassphrase('a passphrase long enough to be one', move), true);
  assert.equal(await vault.hasPassphrase(), true);
  assert.deepEqual(await vault.unseal(store.get('device').priv), bytes('this device'));
});

test('something written while the key is changing is written under the new one', async () => {
  let during = null;
  const slow = async () => {
    during = vault.seal(bytes('a message that arrived mid-change'));
    await sleep(30);
    return [];
  };
  assert.equal(
    await vault.changePassphrase('a passphrase long enough to be one', 'another one, just as long', slow),
    true,
  );
  const sealed = await during;
  assert.deepEqual(await vault.unseal(sealed), bytes('a message that arrived mid-change'), 'sealed under the old key and lost');
});

test('the page prepares the move and leaves the writing to one commit', () => {
  const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
  const fn = main.slice(main.indexOf('async function resealVault('), main.indexOf('async function savePeer('));
  assert.doesNotMatch(fn, /\.put\(moved\)|kv\.set\(/, 'records are still written one at a time');
  assert.match(fn, /return ops;/);
  assert.equal(typeof commit, 'function');
});
