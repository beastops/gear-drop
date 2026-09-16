/**
 * The document against the code.
 *
 * The protocol spec drifted a long way before anyone read it next to the implementation: a code
 * alphabet that was never the one in use, a SAS derivation with the fingerprints in the wrong
 * place and a wordlist four times its real size, no mention of the lattice half of the handshake
 * or of the control ratchet at all. None of it broke anything, because a document cannot, and
 * that is the problem. A spec nobody checks is worse than no spec, because it is read as if it
 * were true, and the one audience it exists for is the reviewer who has not read the code.
 *
 * So the parts of it that are machine-checkable are checked here. Not the prose, which is the
 * point of writing it; the numbers and the derivation labels, which are the parts that go stale
 * silently and the parts a reviewer would take at face value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const SPEC = new URL('../docs/06-gear-drop-protocol-spec.md', import.meta.url);
const spec = await fs.readFile(SPEC, 'utf8');

const {
  CODE_ALPHABET,
  CODE_LEN,
  TAG_ITERATIONS,
  EPOCH_SECONDS,
  KEM_EK_BYTES,
  KEM_CT_BYTES,
  tagForCode,
} = await import('../web/core/gdcrypto.js');
const { LIMITS } = await import('../web/core/transport.js');
const { SAS_WORDS } = await import('../web/core/wordlist.js');

/** Read `NAME  value` out of the constants block. */
function constant(name) {
  const line = spec.split(String.fromCharCode(10)).find((l) => l.trimStart().startsWith(name + ' '));
  assert.ok(line, `the spec no longer states ${name}`);
  const rest = line.trim().slice(name.length).trim();
  const quoted = rest.startsWith('"') ? rest.slice(1, rest.indexOf('"', 1)) : rest.split(/\s+/)[0];
  return quoted;
}

test('the constants block states the numbers the code actually uses', () => {
  assert.equal(constant('CODE_ALPHABET'), CODE_ALPHABET, 'the documented code alphabet is not the one in use');
  assert.equal(Number(constant('CODE_LEN')), CODE_LEN);
  assert.equal(Number(constant('TAG_ITERATIONS')), TAG_ITERATIONS);
  assert.equal(Number(constant('EPOCH_SECONDS')), EPOCH_SECONDS);
  assert.equal(Number(constant('KEM_EK_BYTES')), KEM_EK_BYTES);
  assert.equal(Number(constant('KEM_CT_BYTES')), KEM_CT_BYTES);
  assert.equal(Number(constant('CHUNK_MIN')), LIMITS.CHUNK_MIN);
  assert.equal(Number(constant('CHUNK_MAX')), LIMITS.CHUNK_MAX);
  assert.equal(Number(constant('BUF_HIGH')), LIMITS.BUF_HIGH);
  assert.equal(Number(constant('BUF_LOW')), LIMITS.BUF_LOW);
});

test('the rendezvous tag is the length the constants block claims', async () => {
  assert.equal((await tagForCode('AB12CD', 0)).length, Number(constant('TAG_LEN')));
});

test('every derivation label in the spec exists in the code', async () => {
  /*
   * The check that would have caught the drift. A label in the document that no longer appears
   * anywhere in the source is either a renamed derivation or one that was removed, and both read
   * to a reviewer as a description of what the code does.
   */
  const names = [
    'bytes.js', 'gdcrypto.js', 'session.js', 'transfer.js', 'transport.js',
    'relay-transport.js', 'channel.js', 'vault.js', 'chat.js',
  ];
  const sources = await Promise.all(
    names.map((n) => fs.readFile(new URL(`../web/core/${n}`, import.meta.url), 'utf8')),
  );
  const code = sources.join(String.fromCharCode(10));

  const labels = new Set((spec.match(/gd\/[a-z0-9/]+(?:\/v[0-9]+)?/g) || []).map((l) => l.replace(/\/$/, '')));
  assert.ok(labels.size >= 8, `only ${labels.size} labels found in the spec; the format changed`);

  const missing = [...labels].filter((l) => !code.includes(l));
  assert.deepEqual(missing, [], 'the spec names derivations the code does not have');
});

test('the safety words are drawn from the list the spec describes', () => {
  const claim = spec.match(/(\d+)-word list/);
  assert.ok(claim, 'the spec no longer says how large the wordlist is');
  assert.equal(Number(claim[1]), SAS_WORDS.length, 'the documented wordlist size is wrong');
});

test('the spec describes the handshake as it is now sent', () => {
  // Three things a reader would take at face value, and all three were wrong at once when the
  // offer grew a lattice key: the frame layout, the confirmation's inputs, and that there is a
  // post-quantum half at all.
  assert.match(spec, /0x10 ‖ cpaceMsg\(32\) ‖ ek\(1184\)/, 'the offer frame is documented without its lattice key');
  assert.match(spec, /0x14 ‖ ct\(1088\) ‖ confirm\(ownShare\)/, 'the confirmation frame is documented without its ciphertext');
  assert.match(spec, /ML-KEM-768/, 'the spec does not mention the KEM the handshake runs');
});
