/**
 * Gear Drop cryptographic core.
 *
 * Everything that can be WebCrypto is WebCrypto (hardware-accelerated, constant-time).
 * The one thing WebCrypto cannot do, a password-authenticated key exchange, is built on the
 * audited @noble/curves ristretto255 group, following the CPace construction.
 *
 * Why a PAKE at all: it turns a 6-character code into a full-strength key that the
 * signalling server never learns, so the server cannot read the SDP, cannot substitute
 * its own DTLS fingerprints, and gets exactly one online guess per code.
 */
import { RistrettoPoint, hashToRistretto255 } from '../vendor/@noble/curves/ed25519.js';
import { concat, lvCat, randomBytes, te, toHex, equal, u64le } from './bytes.js';
import { SAS_WORDS } from './wordlist.js';

const subtle = crypto.subtle;

/* --------------------------------------------------------------- primitives */

export async function sha256(data) {
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

/** HKDF-SHA256 → raw bytes. */
export async function hkdf(ikm, info, length = 32, salt = new Uint8Array(32)) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: typeof info === 'string' ? te.encode(info) : info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Import raw bytes as an AES-256-GCM key. */
export async function aeadKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const EMPTY_AAD = new Uint8Array(0);

export async function seal(key, nonce, plaintext, aad) {
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad || EMPTY_AAD, tagLength: 128 },
    key,
    plaintext,
  );
  return new Uint8Array(ct);
}

export async function open(key, nonce, ciphertext, aad) {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad || EMPTY_AAD, tagLength: 128 },
    key,
    ciphertext,
  );
  return new Uint8Array(pt);
}

/** 12-byte nonce: [lane:1][reserved:3][counter:8 LE]. Unique per (key, lane, counter). */
export function nonceFor(lane, counter) {
  const n = new Uint8Array(12);
  n[0] = lane & 0xff;
  n.set(u64le(counter), 4);
  return n;
}

/* --------------------------------------------------------------- pair codes */

/**
 * Crockford base32: 32 symbols of five bits each, with I, L, O and U removed. The first
 * three are the ones people misread; U is left out so no code can spell something
 * unfortunate. Typos still resolve, because input folds O→0 and I/L→1.
 */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LEN = 6; // 30 bits of entropy

/** Rejection-sampled so every symbol is equally likely. */
export function newCode(len = CODE_LEN) {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= 256 - (256 % 32)) continue; // drop the biased tail rather than fold it
      out += CODE_ALPHABET[b % 32];
      if (out.length === len) break;
    }
  }
  return out;
}

/** Fold the lookalikes people actually type, then drop anything still unusable. */
export function normalizeCode(s) {
  return (s || '')
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('');
}

/**
 * Rendezvous tag for a code.
 *
 * A single hash is not one-way over a 30-bit secret: 1.07e9 candidates fall to a GPU in
 * about a tenth of a second, well inside the two minutes a code lives. A relay that
 * recovered the code could run CPace itself and stand in the middle.
 *
 * So the derivation is deliberately slow: 600 000 PBKDF2-SHA256 rounds, tens of milliseconds
 * once per pairing against roughly 18 GPU-hours to search. The salt carries a ten-minute
 * epoch, so no table outlives the code it was built for.
 *
 * The session key was never at risk: it comes from the two ephemeral shares, so knowing the
 * code buys a passive observer nothing. This is about an active relay, which is what the
 * safety words catch.
 */
export const TAG_ITERATIONS = 600_000;
export const CODE_EPOCH_SECONDS = 600;

export function codeEpoch(now = Date.now()) {
  return Math.floor(now / 1000 / CODE_EPOCH_SECONDS);
}

export async function tagForCode(code, epoch = codeEpoch()) {
  const key = await subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: concat(te.encode('gd/tag/v2'), u64le(epoch)),
      iterations: TAG_ITERATIONS,
    },
    key,
    128,
  );
  return new Uint8Array(bits);
}

/**
 * The epochs a host listens on: the one it created the code in, and one either side.
 *
 * The person waiting can afford three derivations; the person typing the code should pay
 * for one. This covers ten minutes of clock skew in either direction, which is far more
 * than the two minutes a code lives.
 */
export function hostEpochs(now = Date.now()) {
  const e = codeEpoch(now);
  return [e, e - 1, e + 1];
}

/* -------------------------------------------------------------------- CPace */

const DSI = 'CPace255-gd1';

/** Input block size of SHA-512, which is the hash ristretto255's hash-to-group runs on. */
const HASH_BLOCK = 128;

/**
 * No channel identifier.
 *
 * CPace has a field for naming the two parties, and this protocol has nothing to put in it:
 * the devices are strangers until the code matches, and a name would be one more thing the
 * relay could see. It is still written out, as an empty field, so that the encoding is the
 * one the specification describes and a later version with real identities in it cannot
 * derive the same generator as this one.
 */
const CI = new Uint8Array(0);

/**
 * Zero padding, sized so the domain string and the password end exactly on a block boundary.
 *
 * The password is hashed to get the generator, and everything after it in that input is
 * public. Padding to the block boundary is what keeps those apart: the compression of the
 * first block depends on the password and nothing else, so the work done on the secret part
 * is identical no matter what the session id, the code length, or the peer contributed.
 * Without it the password and the session id share a block, and how much of each lands
 * where moves with the length of the code.
 *
 * The arithmetic is the specification's: a block, less the length-prefixed domain string,
 * less the length-prefixed password, less the byte that prefixes the padding itself.
 * @param {Uint8Array} prs  the password, as bytes
 */
function zeroPad(prs) {
  return new Uint8Array(Math.max(0, HASH_BLOCK - (1 + prs.length) - (1 + DSI.length) - 1));
}

/**
 * The exact bytes hashed to the CPace generator.
 *
 * Separated out because it is the part worth checking against the specification: five
 * length-prefixed fields, in this order, with the padding sized so the first three of them
 * fill one block.
 * @param {string} code
 * @param {Uint8Array} sid
 */
export function cpaceGeneratorString(code, sid) {
  const prs = te.encode(code);
  return lvCat(DSI, prs, zeroPad(prs), CI, sid);
}

/**
 * Start a CPace exchange.
 * @param {string} code  the short code (the PAKE password)
 * @param {Uint8Array} sid  session id, agreed out of band (we use the rendezvous tag)
 * @returns {{msg: Uint8Array, state: object}}
 */
export function cpaceStart(code, sid) {
  const gen = hashToRistretto255(cpaceGeneratorString(code, sid), { DST: DSI });
  const Fn = RistrettoPoint.Fn;
  // Random scalar in [1, ORDER)
  let y = 0n;
  while (y === 0n) {
    const r = randomBytes(64);
    let acc = 0n;
    for (let i = r.length - 1; i >= 0; i--) acc = (acc << 8n) | BigInt(r[i]);
    y = acc % Fn.ORDER;
  }
  const Y = gen.multiply(y);
  return { msg: Y.toBytes(), state: { y, mine: Y.toBytes(), sid } };
}

/**
 * Finish a CPace exchange.
 * @returns {Promise<Uint8Array>} the 32-byte intermediate session key
 * @throws if the peer's message is not a valid, non-identity group element
 */
export async function cpaceFinish(state, peerMsg) {
  if (!peerMsg || peerMsg.length !== 32) throw new Error('cpace: bad peer message');
  let P;
  try {
    P = RistrettoPoint.fromBytes(peerMsg);
  } catch {
    throw new Error('cpace: invalid group element');
  }
  if (P.is0()) throw new Error('cpace: identity element rejected');

  const K = P.multiply(state.y).toBytes();

  // Symmetric transcript: order the two public messages lexicographically so both
  // sides hash the same bytes regardless of who spoke first.
  const [a, b] = [state.mine, peerMsg].sort(cmpBytes);
  return hkdf(K, lvCat(DSI + '_ISK', state.sid, a, b), 32);
}

function cmpBytes(x, y) {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/* ---------------------------------------------------------------------- SAS */

/**
 * Short Authentication String: four words binding the PAKE key to BOTH DTLS
 * fingerprints. If a server swapped a fingerprint, the two screens disagree.
 */
export async function sasWords(K, fpA, fpB) {
  const [a, b] = [te.encode(fpA || ''), te.encode(fpB || '')].sort(cmpBytes);
  const out = await hkdf(K, lvCat('gd/sas/v1', a, b), 4);
  return Array.from(out, (x) => SAS_WORDS[x]);
}

/** Extract the DTLS certificate fingerprint from an SDP blob. */
export function fingerprintOf(sdp) {
  const m = /^a=fingerprint:(.+)$/m.exec(sdp || '');
  return m ? m[1].trim().toLowerCase() : '';
}

/* ------------------------------------------------------------ device identity */

/**
 * A device keypair, generated locally and never transmitted in the clear.
 * X25519 via WebCrypto where available (Chrome/Firefox/Safari 17.4+), else noble.
 */
export async function newDeviceKey() {
  try {
    const kp = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
    const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
    return { kind: 'webcrypto', pub, priv };
  } catch {
    const { x25519 } = await import('../vendor/@noble/curves/ed25519.js');
    const priv = randomBytes(32);
    return { kind: 'noble', pub: x25519.getPublicKey(priv), priv };
  }
}

/* --------------------------------------------------------- pairing rendezvous */

export const EPOCH_SECONDS = 600;

export function currentEpoch(now = Date.now()) {
  return Math.floor(now / 1000 / EPOCH_SECONDS);
}

/**
 * Rotating, unlinkable rendezvous tag for a paired device.
 * The server matches equal tags; across epochs it cannot tell they are the same pair.
 */
export async function pairTag(pairRoot, epoch) {
  const out = await hkdf(pairRoot, concat(te.encode('gd/rv/v1'), u64le(epoch)), 16);
  return out;
}

/* ----------------------------------------------------------------- channels */

/**
 * A channel is a shared secret several devices can hold at once: a room code people type, or
 * the opaque network label the relay hands out. Everything below derives from that one
 * secret:
 *
 *   secret   = HKDF(label)                  never leaves the device
 *   tag      = HKDF(secret, epoch)          what the relay sees; rotates hourly
 *   key      = HKDF(secret, "presence")     seals the presence announcements
 *   pairTag  = HKDF(secret, idA‖idB)        where two members meet for the real handshake
 *
 * The relay therefore sees a rotating opaque tag and a stream of ciphertext. It cannot
 * enumerate rooms, read who is in one, or recognise the same room an hour later.
 *
 * The limit: everyone holding the secret is equal. A member of a room can attempt to
 * interpose on another pair inside it, as anyone who knows a code could. The safety words
 * make that visible, which is why a device met this way is shown as unverified until
 * someone checks them.
 */
export const ROOM_CODE_LEN = 5;
export const ROOM_EPOCH_SECONDS = 3600;

export function newRoomCode() {
  return newCode(ROOM_CODE_LEN);
}

export function roomEpoch(now = Date.now()) {
  return Math.floor(now / 1000 / ROOM_EPOCH_SECONDS);
}

export async function channelSecret(label) {
  return hkdf(te.encode(String(label)), 'gd/chan/v1', 32);
}

export async function channelTag(secret, epoch) {
  return hkdf(secret, concat(te.encode('gd/chan/tag/v1'), u64le(epoch)), 16);
}

export async function channelKey(secret) {
  return aeadKey(await hkdf(secret, 'gd/chan/presence/v1', 32));
}

/**
 * Where two members of a channel meet for their own two-party handshake. Sorted so both
 * compute the same tag without agreeing on who is "first".
 */
export async function channelPairTag(secret, idA, idB) {
  const [a, b] = [idA, idB].sort(cmpBytes);
  return hkdf(secret, lvCat('gd/chan/pair/v1', a, b), 16);
}

/**
 * A rotating hint that only a device holding the same pairing root can recognise.
 *
 * Announced on a discovery channel so an already-paired device is recognised as itself
 * instead of appearing a second time as a stranger. It is the rendezvous-tag trick reused:
 * the value changes every epoch, so to anyone without the root it is 8 unlinkable bytes.
 */
export async function pairHint(pairRoot, epoch) {
  const out = await hkdf(pairRoot, concat(te.encode('gd/hint/v1'), u64le(epoch)), 8);
  return toHex(out);
}

/** A friendly, deterministic name derived from the device's own public key. */
export async function friendlyName(pub) {
  const h = await sha256(pub);
  return `${SAS_WORDS[h[0]]}-${SAS_WORDS[h[1]]}`.replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ─────────────────────── the post-quantum half of the key ───────────────────────
 *
 * AES-256-GCM is not the part that ages. A recorder needs no break in the cipher to read
 * this traffic one day; it needs the key, and the key comes out of a Diffie-Hellman over
 * ristretto255. That is a discrete log, and a cryptographically relevant quantum computer
 * solves discrete logs, so everything sent under a purely classical agreement is readable by
 * whoever kept a copy and waited.
 *
 * The agreement therefore gets a second, unrelated half. ML-KEM-768 (FIPS 203, the
 * standardised form of Kyber) rests on module lattices rather than on any group, and the
 * session key is the hash of both secrets. An attacker needs the discrete log and the
 * lattice problem; either alone leaves them with half a preimage.
 *
 * Hybrid rather than a replacement. Lattice cryptography is a decade old where elliptic
 * curves are forty, and swapping one for the other would trade a known distant risk for an
 * unknown near one. Mixing costs 2 KB on the wire and about three milliseconds, and is at
 * least as strong as either half, including if this integration turns out to be wrong, in
 * which case the classical secret still does everything it did before.
 */

/** Wire sizes, fixed by FIPS 203 for ML-KEM-768. Frames are checked against them. */
export const KEM_EK_BYTES = 1184;
export const KEM_CT_BYTES = 1088;

/*
 * Loaded on demand, once.
 *
 * It is a quarter of a megabyte of lattice arithmetic that the first paint has no use for,
 * and a session is created well before a handshake runs, so importing it when the first
 * session opens keeps it off the boot path without ever making a handshake wait for it.
 */
let kemPromise = null;
const kem = () => (kemPromise ||= import('../vendor/@noble/post-quantum/ml-kem.js').then((m) => m.ml_kem768));

/** A fresh encapsulation key to publish, and the decapsulation key kept to open replies. */
export async function kemKeypair() {
  const { keygen } = await kem();
  const { publicKey, secretKey } = keygen();
  return { ek: publicKey, dk: secretKey };
}

/** Wrap a fresh secret to someone's published key. Returns what to send and what to keep. */
export async function kemEncapsulate(ek) {
  if (!(ek instanceof Uint8Array) || ek.length !== KEM_EK_BYTES) {
    throw new Error('kem: bad encapsulation key');
  }
  const { encapsulate } = await kem();
  const { cipherText, sharedSecret } = encapsulate(ek);
  return { ct: cipherText, ss: sharedSecret };
}

/**
 * Open one that was wrapped to us.
 *
 * ML-KEM does not report failure: a tampered ciphertext decapsulates to a different secret
 * rather than to an error. That is implicit rejection, so there is no oracle to probe, and it
 * is also the behaviour this protocol wants. A modified ciphertext gives the two sides
 * different session keys, so nothing decrypts afterwards and the connection fails closed. It
 * cannot be stripped back to classical-only.
 */
export async function kemDecapsulate(dk, ct) {
  if (!(ct instanceof Uint8Array) || ct.length !== KEM_CT_BYTES) {
    throw new Error('kem: bad ciphertext');
  }
  const { decapsulate } = await kem();
  return decapsulate(ct, dk);
}

export { equal, toHex };
