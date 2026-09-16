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
import fs from 'node:fs';
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

/*
 * The room code.
 *
 * Every other thing this browser keeps was already sealed: the pairing records whole, the
 * conversations, the pictures in them, the device's private half. `prefs` was not, and `prefs`
 * carried the five characters that let anybody holding them into the room you are in.
 */
test('a room code is stored with none of the code in it', async () => {
  const code = 'Z6S2T';
  await kv.set('prefs', {
    discovery: 'public',
    publicCodeSealed: await seal(new TextEncoder().encode(code)),
  });

  const back = await kv.get('prefs');
  assert.ok(!JSON.stringify(back).includes(code), 'the code is legible in the stored record');
  assert.equal(new TextDecoder().decode(await unseal(back.publicCodeSealed)), code, 'and it does not come back');
});

test('the preferences are written sealed, not sealed and plain', async () => {
  const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
  const fn = /async function savePrefs\(\)\s*\{[\s\S]*?\n\}/.exec(main)?.[0];
  assert.ok(fn, 'savePrefs is gone');
  assert.match(fn, /publicCodeSealed = await seal\(/, 'the code is written in the clear');
  // Destructured out of the rest, so it cannot be written twice - once sealed, once not.
  assert.match(fn, /const \{ theme, lang, publicCode, \.\.\.rest \} = app\.prefs;/, 'the plain field is still in the record');
});

test('and a passphrase change moves it with everything else', async () => {
  // `move` finds sealed fields by shape, so this one needs no naming — but only inside a record
  // the walk visits. A sealed field in a record nobody moves is stranded under the old key the
  // first time a passphrase is set, which has happened here once already.
  const main = fs.readFileSync(new URL('../web/main.js', import.meta.url), 'utf8');
  const fn = /async function resealVault\([\s\S]*?\n\}/.exec(main)?.[0];
  assert.ok(fn, 'resealVault is gone');
  assert.match(fn, /kv\.get\('prefs'\)/, 'the preferences are never read, so the sealed code cannot move');
  assert.match(fn, /kv\.set\('prefs',/, 'the preferences are read and then not written back');
});
