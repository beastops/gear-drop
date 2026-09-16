/**
 * What a rate limit counts against.
 *
 * `networkOf` answers "same household", and for IPv6 that is /64, because a household is
 * delegated a /64 and every device in it sits inside one. The relay used the same answer for a
 * different question — "how many sockets may one party hold" — and there it is wrong, because a
 * residential customer is not delegated a /64. They get a /56 or a /48: 256 or 65 536 distinct
 * /64s, every one of which looks like a separate household to a limit keyed that way.
 *
 * Keyed by /64, a limit of 32 sockets per network is two million per customer. The relay's own
 * ceiling — 20 000 sockets, 50 000 tag slots — is reached a long way before it, so the limit
 * meant to stop one party exhausting the relay stopped nobody who had IPv6, which is everybody
 * it was written for. The only people it ever constrained were those behind a single IPv4
 * address.
 *
 * These hold the two questions apart, because the failure was not a wrong constant. It was one
 * function answering two questions that happen to sound alike.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { networkOf, abuseKeyOf } from '../server/network.js';

/* Two devices in one home: same /64, and the same household. */
const HOME_A = '2001:db8:1234:5678::1';
const HOME_B = '2001:db8:1234:5678::9fab';
/* The same customer's next subnet along — a different /64, the same /48, the same person. */
const HOME_OTHER_64 = '2001:db8:1234:9999::1';
/* Somebody else entirely. */
const ELSEWHERE = '2001:db8:beef:5678::1';

test('grouping still says two devices in one home are in one home', () => {
  assert.equal(networkOf(HOME_A), networkOf(HOME_B), 'devices in one household stopped finding each other');
  assert.notEqual(networkOf(HOME_A), networkOf(ELSEWHERE), 'two households were merged into one');
});

test('and a household is still not the whole of a /48, for grouping', () => {
  // The /64 is the right grain for discovery: a neighbouring subnet is not your living room.
  assert.notEqual(networkOf(HOME_A), networkOf(HOME_OTHER_64), 'discovery widened past the household');
});

test('but a limit counts one customer once, however many subnets they were given', () => {
  /*
   * This is the whole finding. Every one of these is the same subscriber, and keyed by /64 each
   * would have had its own budget — 65 536 budgets for one person, against a relay that falls
   * over at 20 000 sockets.
   */
  assert.equal(abuseKeyOf(HOME_A), abuseKeyOf(HOME_OTHER_64), 'one customer still gets a budget per subnet');
  assert.equal(abuseKeyOf(HOME_A), abuseKeyOf(HOME_B));
  assert.notEqual(abuseKeyOf(HOME_A), abuseKeyOf(ELSEWHERE), 'two customers were merged into one budget');
});

test('the abuse key is a /48, stated as one', () => {
  /*
   * The groups come out in decimal, not hex: `expandV6` maps each one through `parseInt` and
   * renders the number. So this reads like an address and is not one — 2001:0db8:1234 arrives
   * as 8193:3512:4660.
   *
   * Left that way on purpose. The mapping is deterministic and cannot collide (the group count
   * is fixed and each group renders uniquely), so grouping is correct, and the value is HMAC'd
   * before anything outside the process sees it. Making it honest would re-roll every network
   * label for a cosmetic gain on a string nobody reads. Pinned here so the next person to look
   * at one of these keys does not go hunting for a bug.
   */
  assert.match(abuseKeyOf(HOME_A), /\/48$/, 'the grain changed without the name changing');
  assert.equal(abuseKeyOf(HOME_A), abuseKeyOf('2001:0db8:1234:ffff:1:2:3:4'), 'the first three groups are not what decides it');
});

test('IPv4 is left exactly as it was, because an address there is already a customer', () => {
  for (const addr of ['203.0.113.7', '192.168.1.44', '10.1.2.3', '172.16.5.6', '100.64.9.9']) {
    assert.equal(abuseKeyOf(addr), networkOf(addr), `${addr} changed meaning`);
  }
});

test('nothing malformed ever buys its own budget', () => {
  /*
   * A falsy key becomes `'unknown'` at the call site, so every unreadable address shares one
   * 32-socket bucket. That is the restrictive answer and the right one: the failure to avoid is
   * a malformed address getting a budget of its own, which is what would happen if each one
   * hashed to something different.
   *
   * So the test is not "never empty" — it is that junk never spreads out into many keys.
   */
  const junk = ['', '   ', 'not-an-address', 'aaaa', 'bbbb', '999.1.1.1', '1.2.3', 'x:y:z'];
  const keys = new Set(junk.map((j) => abuseKeyOf(j) || 'unknown'));
  assert.deepEqual([...keys], ['unknown'], `malformed addresses bought ${keys.size} budgets: ${[...keys]}`);

  // And a real address is never mistaken for junk.
  for (const addr of [HOME_A, ELSEWHERE, '203.0.113.7', 'fe80::1%eth0']) {
    assert.ok(abuseKeyOf(addr), `${addr} has no abuse key`);
    assert.notEqual(abuseKeyOf(addr), 'unknown');
  }
});
