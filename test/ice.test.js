/**
 * What the relay may aim the browser at.
 *
 * This is the part of WebRTC that genuinely can be turned against the person running it.
 * Not remote control, since a data channel delivers bytes into a sandbox and nothing runs
 * but an ICE server is a standing instruction to send packets to a host and port, and that
 * list arrives from the relay.
 *
 * Passed through as it came, a hostile relay could name an address inside the user's own
 * network and learn from the timing whether something was listening there, using a browser
 * it has no other access to. Aim enough browsers at one address and probing becomes
 * traffic. The fix is not clever; it is reading the list before acting on it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeIceConfig, isUsableIceUrl } from '../web/core/ice.js';

test('an ordinary configuration survives intact', () => {
  const out = sanitizeIceConfig({
    iceServers: [
      { urls: 'stun:stun.example.net:3478' },
      { urls: ['turn:turn.example.net:3478', 'turns:turn.example.net:5349'], username: 'u', credential: 'p' },
    ],
  });
  assert.equal(out.iceServers.length, 2);
  assert.deepEqual(out.iceServers[0].urls, ['stun:stun.example.net:3478']);
  assert.equal(out.iceServers[1].username, 'u');
  assert.equal(out.iceServers[1].credential, 'p');
});

test('an address inside somebody else s network is refused', () => {
  for (const url of [
    'turn:192.168.1.1:3478',
    'stun:10.0.0.5:3478',
    'turn:172.16.4.9:3478',
    'stun:127.0.0.1:3478',
    'turn:localhost:3478',
    'stun:printer.local:3478',
    'turn:169.254.169.254:80', // the cloud metadata address
    'turn:100.64.0.1:3478',
    'stun:[::1]:3478',
    'turn:[fd00::1]:3478',
    'turn:[fe80::1]:3478',
    'stun:0.0.0.0:3478',
  ]) {
    assert.equal(isUsableIceUrl(url), false, `${url} must be refused`);
  }
});

test('a port that is plainly another service is refused', () => {
  for (const url of [
    'turn:example.net:22',
    'stun:example.net:3306',
    'turn:example.net:445',
    'stun:example.net:25',
    'turn:example.net:6379',
    'turn:example.net:27017',
  ]) {
    assert.equal(isUsableIceUrl(url), false, `${url} must be refused`);
  }
  // An unusual TURN port is still allowed: people self-host, and this is not the place to
  // tell them which port to use.
  assert.equal(isUsableIceUrl('turn:example.net:34780'), true);
});

test('only the schemes an ICE server can use are accepted', () => {
  for (const url of [
    'http://example.net',
    'https://example.net',
    'ws://example.net',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,x',
    'example.net:3478',
    '',
  ]) {
    assert.equal(isUsableIceUrl(url), false, `${url} must be refused`);
  }
  for (const url of ['stun:a.example.net', 'stuns:a.example.net', 'turn:a.example.net', 'turns:a.example.net']) {
    assert.equal(isUsableIceUrl(url), true, `${url} should be allowed`);
  }
});

test('nothing but the two fields we act on gets through', () => {
  const out = sanitizeIceConfig({
    iceServers: [{ urls: 'stun:stun.example.net:3478' }],
    iceCandidatePoolSize: 255,
    certificates: ['pretend'],
    somethingAddedInAFutureBrowser: 'whatever',
    bundlePolicy: 'balanced',
  });
  assert.deepEqual(Object.keys(out).sort(), ['iceServers']);
});

test('the transport policy is taken only when it is one of the two real values', () => {
  assert.equal(sanitizeIceConfig({ iceTransportPolicy: 'relay' }).iceTransportPolicy, 'relay');
  assert.equal(sanitizeIceConfig({ iceTransportPolicy: 'all' }).iceTransportPolicy, 'all');
  assert.equal(sanitizeIceConfig({ iceTransportPolicy: 'nonsense' }).iceTransportPolicy, undefined);
});

test('the list cannot be made long enough to be traffic', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ urls: `stun:s${i}.example.net:3478` }));
  assert.ok(sanitizeIceConfig({ iceServers: many }).iceServers.length <= 8);

  const wide = [{ urls: Array.from({ length: 500 }, (_, i) => `turn:t${i}.example.net:3478`) }];
  assert.ok(sanitizeIceConfig({ iceServers: wide }).iceServers[0].urls.length <= 4);
});

test('a server whose addresses were all refused is dropped, not left empty', () => {
  const out = sanitizeIceConfig({
    iceServers: [{ urls: ['turn:10.0.0.1:3478', 'turn:192.168.0.1:22'] }, { urls: 'stun:ok.example.net' }],
  });
  assert.equal(out.iceServers.length, 1);
  assert.deepEqual(out.iceServers[0].urls, ['stun:ok.example.net']);
});

test('an absurd credential is left behind', () => {
  const out = sanitizeIceConfig({
    iceServers: [{ urls: 'turn:a.example.net', username: 'x'.repeat(10000), credential: 42 }],
  });
  assert.equal(out.iceServers[0].username, undefined);
  assert.equal(out.iceServers[0].credential, undefined);
});

test('rubbish in gives a usable object out', () => {
  for (const bad of [null, undefined, 'config', 42, [], { iceServers: 'all of them' }]) {
    const out = sanitizeIceConfig(bad);
    assert.ok(Array.isArray(out.iceServers), String(bad));
    assert.equal(out.iceServers.length, 0);
  }
});
