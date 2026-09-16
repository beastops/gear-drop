/**
 * Which sockets count as "the same network".
 *
 * The relay never sees a room or a roster; the one grouping it can compute is this, and it
 * is what "devices on this network" is built on. Hashing the address was right for the
 * hosted case, where a NAT hands every device in a home the same public address, and wrong
 * for the case people reach for first: running the app on their own machine and opening it
 * on a phone. There each device arrives from its own private address, so every label
 * differed and the feature silently found nobody.
 */
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { networkOf } from '../server/network.js';

test('devices on one home network group together', () => {
  const laptop = networkOf('192.168.1.26');
  assert.equal(networkOf('192.168.1.37'), laptop, 'the phone is on the same network');
  assert.equal(networkOf('::ffff:192.168.1.200'), laptop, 'and so is an IPv4-mapped socket');
});

test('a different subnet is a different network', () => {
  assert.notEqual(networkOf('192.168.1.5'), networkOf('192.168.2.5'));
  assert.notEqual(networkOf('10.0.0.5'), networkOf('10.0.1.5'));
});

test('every private range is grouped, not just the common one', () => {
  for (const [a, b] of [
    ['10.4.5.6', '10.4.5.200'],
    ['172.16.4.9', '172.16.4.99'],
    ['172.31.0.1', '172.31.0.2'],
    ['169.254.3.4', '169.254.3.9'],
    ['100.72.1.2', '100.72.1.9'],
  ]) {
    assert.equal(networkOf(a), networkOf(b), `${a} and ${b} are on one network`);
  }
});

test('a public address is still the host, because a NAT has already grouped it', () => {
  assert.equal(networkOf('8.8.8.8'), '8.8.8.8');
  assert.notEqual(networkOf('203.0.113.9'), networkOf('203.0.113.10'), 'two homes, two labels');
  // 172.32 is outside the private range; it must not be treated as a subnet.
  assert.notEqual(networkOf('172.32.0.1'), networkOf('172.32.0.2'));
});

test('loopback is one place', () => {
  assert.equal(networkOf('127.0.0.1'), 'loopback');
  assert.equal(networkOf('::1'), 'loopback');
  assert.equal(networkOf('::ffff:127.0.0.1'), 'loopback');
  assert.equal(networkOf('127.0.1.1'), 'loopback');
});

test('IPv6 on one link groups, however it is written', () => {
  // The reason this needs expanding rather than splitting: `fe80::1` and `fe80::2` are the
  // same /64, but cutting the written form on colons puts them in different groups, and two
  // devices sitting next to each other would never see one another.
  const link = networkOf('fe80::1');
  for (const addr of ['fe80::2', 'fe80::1a2b:3c4d:5e6f:7a8b', 'fe80::aaaa:bbbb:cccc:dddd', 'fe80::1%eth0']) {
    assert.equal(networkOf(addr), link, `${addr} is on the same link`);
  }
});

test('unique-local IPv6 groups by its own /64', () => {
  assert.equal(networkOf('fd12:3456:789a:1::1'), networkOf('fd12:3456:789a:1::99'));
  assert.notEqual(networkOf('fd12:3456:789a:1::1'), networkOf('fd12:3456:789a:2::1'));
});

/*
 * The case a NAT hides on IPv4 and exposes on IPv6.
 *
 * This used to assert the opposite - that a global IPv6 address is left alone, the way a
 * public IPv4 one is. The reasoning does not carry: a public IPv4 address is one household
 * because the NAT made it one, and IPv6 has no NAT. Every device takes its own global /128
 * out of the /64 the ISP delegated, and privacy extensions change that /128 every few hours.
 *
 * Left as hosts, two phones on one sofa are two networks and local discovery finds nobody,
 * which is what happened on a real connection: a laptop at
 * 2401:4900:8f5d:2c2c:7c54:d1e9:93ec:5c3e could not see a phone on the same Wi-Fi.
 */
test('two devices in one home share a network on IPv6, where there is no NAT to group them', () => {
  const laptop = '2401:4900:8f5d:2c2c:7c54:d1e9:93ec:5c3e';
  const phone = '2401:4900:8f5d:2c2c:aaaa:bbbb:cccc:dddd';
  assert.equal(networkOf(laptop), networkOf(phone), 'same /64, so the same network');

  // And the same device after its privacy address rotates is still itself.
  const laptopLater = '2401:4900:8f5d:2c2c:0000:1111:2222:3333';
  assert.equal(networkOf(laptop), networkOf(laptopLater));
});

test('a different /64 is a different home', () => {
  assert.notEqual(
    networkOf('2401:4900:8f5d:2c2c::1'),
    networkOf('2401:4900:8f5d:9999::1'),
    'two prefixes, two households',
  );
  assert.notEqual(networkOf('2606:4700::1111'), networkOf('2401:4900:8f5d:2c2c::1'));
});

/*
 * A /64 and no wider. An ISP delegates a /56 or a /48 to a customer and the router puts one
 * /64 on each LAN, so grouping any wider would start putting neighbours together.
 */
test('grouping stops at the /64 and does not widen to the delegated prefix', () => {
  assert.notEqual(networkOf('2401:4900:8f5d:0001::1'), networkOf('2401:4900:8f5d:0002::1'));
});

/*
 * Both relays have to agree on what a network is.
 *
 * The Cloudflare relay is a separate implementation of the same protocol, and it hashed the
 * raw client address instead of calling `networkOf` - so the IPv4 subnet grouping was absent
 * and every IPv6 device was its own network. Checked at the source level because the worker
 * needs a Cloudflare runtime to import, and the property worth holding is simply that it
 * asks this module rather than having an opinion of its own.
 */
test('the Cloudflare relay groups by network rather than by address', () => {
  const worker = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'cloudflare', 'worker.js'),
    'utf8',
  );
  assert.match(worker, /import \{ networkOf \} from '\.\.\/\.\.\/server\/network\.js'/);
  assert.match(worker, /networkOf\(addr\)/, 'the label is derived from the network');
  assert.ok(
    !/\$\{window\}:\$\{addr\}/.test(worker),
    'the raw address is being hashed, so every IPv6 device is its own network',
  );
});

test('nonsense in does not produce a grouping that lumps strangers together', () => {
  // Whatever arrives, two different inputs must not silently become one network.
  assert.notEqual(networkOf('not-an-address'), networkOf('also-not-an-address'));
  assert.equal(typeof networkOf(''), 'string');
  assert.equal(typeof networkOf(null), 'string');
  assert.equal(typeof networkOf(undefined), 'string');
});

/* ------------------------------------------ the machine the relay runs on */

test('the host machine counts as being on its own network', () => {
  // Self-hosting is the point, and the machine serving the app is on the same network as
  // the phone in your hand. Treating loopback as its own island made the one device
  // guaranteed to be on the network the one device that could never see anything on it.
  const self = '192.168.1.0/24';
  assert.equal(networkOf('127.0.0.1', self), self);
  assert.equal(networkOf('::1', self), self);
  assert.equal(networkOf('192.168.1.6', self), self, 'and the phone is in the same group');
});

test('with no local network of its own, loopback is still its own place', () => {
  assert.equal(networkOf('127.0.0.1', null), 'loopback');
  assert.equal(networkOf('127.0.0.1'), 'loopback');
});

test('a virtual adapter does not get mistaken for the real network', async () => {
  const { ownNetwork } = await import('../server/network.js');
  // Hyper-V, WSL, Docker and VPN clients all add private addresses, and walking the
  // interface list takes whichever is listed first. On the machine this was written on that
  // was a virtual switch on 172.19.128.0/24, while the network the phone was on was
  // 192.168.1.0/24, so the host would have been grouped with nothing at all.
  const interfaces = {
    'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.19.128.1' }],
    Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.1.26' }],
  };
  assert.equal(ownNetwork(interfaces, '192.168.1.26'), '192.168.1.0/24', 'the route decides');
  // Without that hint it falls back to the list, which is the behaviour worth knowing about.
  assert.equal(ownNetwork(interfaces, null), '172.19.128.0/24');
  assert.equal(ownNetwork({}, null), null);
});

test('finding the primary address never hangs the relay', async () => {
  const { primaryAddress } = await import('../server/network.js');
  // Reading a UDP socket's address before it binds throws, and closing an unbound socket
  // leaves a handle that keeps the process alive, so startup never finishes.
  const broken = { createSocket: () => { throw new Error('no sockets here'); } };
  assert.equal(await primaryAddress(broken), null);

  const silent = {
    createSocket: () => ({ on() {}, connect() {}, close() {}, address: () => null }),
  };
  assert.equal(await primaryAddress(silent, 20), null, 'a socket that never connects times out');
});
