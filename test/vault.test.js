/**
 * Secrets at rest.
 *
 * The property under test is not "it encrypts", which any two lines can do. It is that the
 * cleartext of a long-term secret never reaches storage, that the key doing the wrapping
 * cannot be read back by the code holding it, and that a record which will not open is
 * refused rather than guessed at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { openVault, seal, unseal, sealField, unsealField, vaultMode } from '../web/core/vault.js';
import { kv } from '../web/core/store.js';

test('the wrapping key refuses to be exported, by anyone', async () => {
  await openVault();
  const key = await kv.get('vault-key-v1');
  assert.ok(key instanceof CryptoKey, 'a key handle is what is stored');
  assert.equal(key.extractable, false, 'and it is not extractable');

  await assert.rejects(
    () => crypto.subtle.exportKey('raw', key),
    'there is no call that returns its bytes: not for us, not for an attacker running as us',
  );
});

test('a sealed secret contains none of the secret', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const rec = await seal(secret);
  const blob = JSON.stringify(rec);
  const hex = [...secret].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.ok(!blob.includes(hex), 'not as hex');
  // Nor as the array of numbers a naive dump would produce.
  assert.ok(!blob.includes(JSON.stringify([...secret])), 'not as bytes');
  assert.deepEqual(await unseal(rec), secret, 'and it still comes back');
});

test('two seals of the same secret look unrelated', async () => {
  const secret = new Uint8Array(32).fill(7);
  const a = await seal(secret);
  const b = await seal(secret);
  assert.notDeepEqual(a.iv, b.iv, 'a fresh nonce each time');
  assert.notDeepEqual(a.ct, b.ct, 'so storage never shows that two records match');
});

test('a tampered record does not open', async () => {
  const rec = await seal(new Uint8Array([1, 2, 3, 4]));
  const bent = { ...rec, ct: Uint8Array.from(rec.ct) };
  bent.ct[0] ^= 0x80;
  assert.equal(await unseal(bent), null, 'null, not a wrong answer');
});

test('a record sealed under some other key is refused, not guessed at', async () => {
  const foreign = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, foreign, new Uint8Array(32)),
  );
  assert.equal(await unseal({ v: 1, iv, ct }), null);
});

test('sealing a field removes the cleartext rather than shadowing it', async () => {
  const before = { id: 'abc', root: [9, 9, 9], name: 'Laptop' };
  const after = await sealField(before, 'root');

  assert.equal(after.root, undefined, 'the plain field is gone from what gets written');
  assert.ok(after.rootSealed, 'replaced by a sealed one');
  assert.equal(after.name, 'Laptop', 'everything non-secret is untouched');
  assert.ok(!JSON.stringify(after).includes('[9,9,9]'));

  const back = await unsealField(after, 'root');
  assert.deepEqual([...back.root], [9, 9, 9]);
  assert.equal(back.rootSealed, undefined, 'and the sealed form is not left lying around in memory');
});

test('a record written by an older version is readable, and flagged for rewriting', async () => {
  const legacy = { id: 'abc', root: [1, 2, 3] }; // how it used to be stored: in the clear
  const opened = await unsealField(legacy, 'root');
  assert.deepEqual([...opened.root], [1, 2, 3], 'nobody has to pair again');
  assert.equal(opened.legacy, true, 'but the caller is told to write it back sealed');
});

test('an unreadable pairing is dropped, not treated as trusted', async () => {
  const unopenable = { id: 'abc', rootSealed: { v: 1, iv: new Uint8Array(12), ct: new Uint8Array(48) } };
  assert.equal(await unsealField(unopenable, 'root'), null, 'null means forget this device');
});

test('the vault reports honestly which mode it is in', async () => {
  assert.ok(['protected', 'session'].includes(vaultMode()), vaultMode());
});
