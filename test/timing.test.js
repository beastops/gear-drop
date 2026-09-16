/**
 * What the clock gives away.
 *
 * Everything sensitive in this app is compared in exactly one place. AES-GCM tags are checked
 * inside WebCrypto, where the platform owns the constant-time guarantee; the scrypt and PBKDF2
 * work factors are fixed and public; the CPace scalar multiplication runs on audited curve
 * code. That leaves one comparison written here: the key-confirmation tag, the value that
 * decides whether the other device has the code.
 *
 * A comparison that stops at the first differing byte turns that decision into a search. An
 * attacker sends a guess, measures how long the refusal took, and learns how many leading
 * bytes were right: thirty-two rounds of two hundred and fifty-six guesses instead of one
 * round of 2^256. The tag is derived per session and the confirmation is refused after a
 * single wrong answer, so the attack is not reachable here even if the comparison leaked; it
 * is written constant-time anyway, and these check that it stayed that way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import fs from 'node:fs/promises';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const { equal } = await import('../web/core/bytes.js');

/** Median of a sample, which ignores the scheduler noise a mean would carry. */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Time one comparison, repeatedly, and report the median round.
 *
 * Rounds rather than one long run: a single timing picks up whatever the machine happened to
 * be doing, and the median across rounds does not. The classes are measured in the same loop
 * so that a CPU changing frequency partway through moves all of them together.
 */
function race(classes, { rounds = 40, per = 400 } = {}) {
  const out = new Map([...classes.keys()].map((k) => [k, []]));
  for (let r = 0; r < rounds; r++) {
    for (const [name, [x, y]] of classes) {
      const at = process.hrtime.bigint();
      for (let i = 0; i < per; i++) equal(x, y);
      out.get(name).push(Number(process.hrtime.bigint() - at) / per);
    }
  }
  return new Map([...out].map(([k, v]) => [k, median(v)]));
}

test('the comparison takes the same time whether the difference is early or late', () => {
  /*
   * Measured on a large buffer, where an early exit cannot hide.
   *
   * At the thirty-two bytes a real tag occupies, the cost of calling the function swamps the
   * cost of the scan, and an implementation that bailed on the first byte would still look
   * roughly like one that did not. Sixty-four kilobytes removes that cover: a scan that stops
   * at byte zero is thousands of times cheaper than one that runs to the end, and the same
   * loop is the one the thirty-two byte tags go through.
   */
  const SIZE = 64 * 1024;
  const base = new Uint8Array(SIZE).fill(0xa5);

  const same = Uint8Array.from(base);
  const early = Uint8Array.from(base);
  early[0] ^= 0xff;
  const late = Uint8Array.from(base);
  late[SIZE - 1] ^= 0xff;

  const times = race(
    new Map([
      ['identical', [base, same]],
      ['differs at the first byte', [base, early]],
      ['differs at the last byte', [base, late]],
    ]),
    { rounds: 30, per: 40 },
  );

  assert.equal(equal(base, same), true);
  assert.equal(equal(base, early), false);
  assert.equal(equal(base, late), false);

  const values = [...times.values()];
  const spread = Math.max(...values) / Math.min(...values);
  assert.ok(
    spread < 2,
    `the scan is ${spread.toFixed(1)}x slower for one input than another: ${[...times]
      .map(([k, v]) => `${k} ${v.toFixed(0)}ns`)
      .join(', ')}`,
  );
});

test('the comparison has one way out, and it is at the end', () => {
  /*
   * The measurement above is a smoke alarm; this is the lock on the door.
   *
   * A timing test on a shared machine can only ever say "nothing obvious", and it says it
   * loosely enough not to fail on a busy afternoon. What actually keeps the property is the
   * shape of the function: one accumulator, no branch inside the loop, and a single return
   * that depends on the whole of it. Reading that off the source catches the change that
   * reintroduces the leak, on the commit that makes it, whatever the machine is doing.
   */
  const src = equal.toString();
  const scan = src.slice(src.indexOf('let d'));
  assert.ok(scan.includes('for ('), 'the comparison no longer scans');

  const exits = scan.match(/return|break|continue|throw/g) || [];
  assert.deepEqual(exits, ['return'], 'the scan gained a way out before the end');
  assert.match(scan, /return d === 0;\s*}\s*$/, 'the result is not the accumulated difference');
});

test('a length mismatch is the only thing answered early, and the tags are all one length', () => {
  /*
   * The one branch that does depend on the input: two different lengths are refused without
   * looking at the bytes. That leaks the length, and the length is not a secret: every tag
   * this compares is thirty-two bytes, fixed by the derivation, and the frame carrying it is
   * refused before this point unless it is exactly that size.
   */
  assert.equal(equal(new Uint8Array(32), new Uint8Array(31)), false);
  assert.equal(equal(new Uint8Array(0), new Uint8Array(0)), true);
});

test('the confirmation tag is never compared by any other means', async () => {
  /*
   * A constant-time comparison only helps where it is the one being used.
   *
   * `equal` sits beside `cmp`, which stops at the first differing byte and is the right tool
   * for what it is pointed at, namely shares and offers, all public and all on the wire
   * in the clear. For the tag one of those two is correct and the other quietly is not, and
   * they are three characters apart. So every line of the handshake that mentions a tag and
   * compares anything is read, rather than trusted to have reached for the right one.
   */
  const src = await fs.readFile(new URL('../web/core/session.js', import.meta.url), 'utf8');
  const lines = src.split(String.fromCharCode(10));
  const compares = ['===', '!==', 'cmp(', 'indexOf(', 'includes('];

  const offenders = [];
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('//')) return; // prose, not code
    if (!code.includes('theirs') && !code.includes('.mine')) return;
    if (!compares.some((op) => code.includes(op))) return;
    if (code.includes('equal(')) return;
    offenders.push(i + 1 + ': ' + code);
  });

  assert.deepEqual(offenders, [], 'a tag is compared by something other than equal()');

  // And the one comparison that should exist still does, so this cannot pass on absence.
  assert.ok(src.includes('equal(tag, c.theirs)'), 'nothing compares the tag at all any more');
});
