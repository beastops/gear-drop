/**
 * The safety words.
 *
 * They are the only thing in the app that answers "who is on the other end" for a device
 * that has not been paired before. Encryption keeps outsiders out; it does not say who you
 * agreed a key with, and somebody in the middle holding two encrypted connections looks
 * exactly like a peer from both sides. What exposes them is that they would have to make
 * two different keys produce one set of words.
 *
 * So what is pinned here is: both ends of one key agree, any change to the key or to the
 * channel it is bound to changes the words, and there are enough of them that guessing is
 * not a strategy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sasWords, fingerprintOf } from '../web/core/gdcrypto.js';
import { SAS_WORDS } from '../web/core/wordlist.js';
import { randomBytes } from '../web/core/bytes.js';

const FP_A = 'sha-256 11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00';
const FP_B = 'sha-256 ff:ee:dd:cc:bb:aa:99:88:77:66:55:44:33:22:11:00';

test('both ends of the same connection read the same words', async () => {
  const K = randomBytes(32);
  // Each side passes its own fingerprint first, so the inputs arrive in opposite orders.
  const mine = await sasWords(K, FP_A, FP_B);
  const theirs = await sasWords(K, FP_B, FP_A);
  assert.deepEqual(mine, theirs, 'otherwise every honest pair would see a mismatch');
  assert.equal(mine.length, 4);
});

test('a different key gives different words', async () => {
  // This is the whole mechanism: somebody in the middle holds two keys, not one, and
  // cannot make both sides read the same four words.
  const a = await sasWords(randomBytes(32), FP_A, FP_B);
  const b = await sasWords(randomBytes(32), FP_A, FP_B);
  assert.notDeepEqual(a, b);
});

test('swapping one fingerprint changes the words', async () => {
  const K = randomBytes(32);
  const honest = await sasWords(K, FP_A, FP_B);
  const swapped = await sasWords(K, FP_A, 'sha-256 de:ad:be:ef:00:00:00:00:00:00:00:00:00:00:00:00');
  assert.notDeepEqual(honest, swapped, 'a substituted certificate has to show up');
});

test('a relayed path and a direct path never read alike', async () => {
  // The relayed path has no DTLS and so no fingerprints to bind to. It must still produce
  // words, and they must not be mistakable for the ones a direct path would produce under
  // the same key.
  const K = randomBytes(32);
  const direct = await sasWords(K, FP_A, FP_B);
  const relayed = await sasWords(K, '', '');
  assert.notDeepEqual(direct, relayed);
});

test('the relayed path is deterministic, so both ends still agree', async () => {
  const K = randomBytes(32);
  assert.deepEqual(await sasWords(K, '', ''), await sasWords(K, '', ''));
  assert.deepEqual(await sasWords(K, null, undefined), await sasWords(K, '', ''));
});

test('there are enough words that guessing is not a strategy', () => {
  assert.equal(SAS_WORDS.length, 256, 'one byte each');
  assert.equal(new Set(SAS_WORDS).size, 256, 'and no duplicates, or the space is smaller');
  // Four independent bytes: 2^32 possibilities, against a single attempt before a person
  // looks at the screen.
  assert.equal(SAS_WORDS.length ** 4, 2 ** 32);
});

test('every word is short, plain and hard to mishear', () => {
  for (const w of SAS_WORDS) {
    assert.match(w, /^[a-z]{3,8}$/, `${w} should be easy to read out over a phone call`);
  }
});

test('a fingerprint is read out of an SDP, and a missing one is not invented', () => {
  const sdp = ['v=0', 'a=setup:actpass', `a=fingerprint:${FP_A}`, 'a=mid:0'].join('\r\n');
  assert.equal(fingerprintOf(sdp), FP_A.toLowerCase());
  assert.equal(fingerprintOf('v=0\r\na=mid:0'), '', 'no fingerprint means no binding, not a guess');
  assert.equal(fingerprintOf(''), '');
  assert.equal(fingerprintOf(null), '');
});

test('words are drawn from the list and nothing else', async () => {
  for (let i = 0; i < 32; i++) {
    for (const w of await sasWords(randomBytes(32), FP_A, FP_B)) {
      assert.ok(SAS_WORDS.includes(w), `${w} is not in the list`);
    }
  }
});
