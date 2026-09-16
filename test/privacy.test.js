/**
 * What leaves the machine, and what has to be asked for first.
 *
 * Every other guarantee in this app is about content: the relay sees ciphertext, the peer is
 * the only one holding the key. This file is about the one thing encryption cannot cover:
 * that connecting to somebody at all tells them where you are. A direct WebRTC connection
 * gathers a public address from a STUN server and hands it to the far end, which for a peer
 * outside your own network is a location given away as a side effect of pressing send.
 *
 * So the default is that no public address is gathered, and these assert it at the level the
 * decision is actually made rather than at the level it is described.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = (f) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', f), 'utf8');

const MAIN = web('main.js');

/* ── the default ──────────────────────────────────────────────────────────── */

test('an address is off by default, and off means the value is written down', () => {
  /*
   * `direct: false` rather than an absent key. The old code read `prefs.direct !== false`,
   * which makes "never set" mean "on", so the safe reading of a missing preference was the
   * unsafe one, and a storage failure or a fresh profile silently opted the person in.
   */
  const prefs = MAIN.slice(MAIN.indexOf('  prefs: {'), MAIN.indexOf('\n  },', MAIN.indexOf('  prefs: {')));
  assert.match(prefs, /\n\s*direct: false,/, 'the shipped default is not off');
});

test('the switch is read as an opt-in everywhere, never as an opt-out', () => {
  // `!== false` treats undefined as yes. Nothing may read the preference that way.
  const offenders = [...MAIN.matchAll(/app\.prefs\.direct\s*!==\s*false/g)];
  assert.deepEqual(
    offenders.map((m) => m[0]),
    [],
    'a missing preference is being read as permission to gather an address',
  );
  assert.ok(
    MAIN.includes('app.prefs.direct === true'),
    'nothing asks for the preference explicitly any more',
  );
});

/* ── what is gathered ─────────────────────────────────────────────────────── */

test('no ICE servers are configured unless an address was allowed', () => {
  /*
   * This is the whole mechanism. A candidate that is never gathered cannot be sent, so the
   * protection is the absence of a STUN server rather than a filter applied to the offer
   * afterwards: there is nothing to filter, and nothing to get wrong later.
   */
  const line = MAIN.match(/const iceConfig =([^;]+);/);
  assert.ok(line, 'the ICE configuration is no longer decided in one place');
  assert.match(
    line[1],
    /allowAddress\s*&&\s*!sameNetwork\s*\?/,
    'the configuration does not turn on both whether an address was allowed and whether one is needed',
  );
  assert.match(line[1], /\{\s*iceServers:\s*\[\]\s*\}/, 'the refusing branch still offers servers');
});

test('a peer on this network never has an address gathered for it, switch or no switch', () => {
  /*
   * Turning the switch on is permission to spend an address where it buys something. On your
   * own network it buys nothing, because host candidates are already the fastest pairing,
   * so the permission does not extend to it. That makes the guarantee one sentence rather
   * than two: a public address is gathered only for a peer off this network, only when asked.
   */
  const line = MAIN.match(/const iceConfig =([^;]+);/)[1];
  assert.ok(!/allowAddress\s*\?/.test(line), 'the switch alone still reaches the local case');
});

test('a peer on this network is still direct, because that costs nothing', () => {
  // The point of the design: privacy by default must not mean the common case got slower.
  assert.match(MAIN, /const sameNetwork = localReach\(connId, chan\);/);
  assert.match(MAIN, /const wantDirect = \(sameNetwork \|\| allowAddress\) && canDirect;/);
});

test('and nothing is direct in a browser that has no way to be', () => {
  /*
   * Tor Browser removes `RTCPeerConnection`, which is the right thing for it to do: a peer
   * connection is a hole punched straight through the circuit. Without this the same-network
   * branch could still ask for a direct transport - two people behind one exit share a network
   * label - and construct a class that is not there.
   *
   * Asserted apart from the line above so that changing either one fails on its own terms.
   */
  assert.match(MAIN, /const canDirect = platform\(\)\.webrtc;/, 'the direct path no longer checks that it can exist');
  assert.match(
    MAIN,
    /const transport = wantDirect \? new Transport\(session, \{ iceConfig \}\) : new RelayTransport\(session\);/,
    'the relay is no longer the answer when direct is refused',
  );
});

test('same network means met there, or known to also be there', () => {
  const fn = MAIN.slice(MAIN.indexOf('function localReach('), MAIN.indexOf('\n}', MAIN.indexOf('function localReach(')));
  assert.match(fn, /chan === 'local'/, 'a device met on this network is not counted');
  assert.match(fn, /alsoOn\.get\(connId\)\?\.has\('local'\)/, 'a paired device seen here is not counted');
});

/* ── the fallback carries no address either ───────────────────────────────── */

test('the relay path opens no peer connection at all', () => {
  /*
   * Not "opens one and blocks the candidates": none is created, so no STUN server is ever
   * contacted and the browser never learns the public address to leak in the first place.
   */
  const relay = web('core/relay-transport.js');
  assert.ok(!/RTCPeerConnection/.test(relay), 'the relay transport builds a peer connection');
  assert.ok(!/iceServers/.test(relay), 'the relay transport takes ICE servers');
  assert.ok(!/createDataChannel/.test(relay), 'the relay transport opens a data channel');
});

test('the relayed frames are the sealed ones, not a re-encoding', () => {
  // The fallback is only acceptable because it is the same ciphertext on a different wire.
  // Comments are stripped first: this module's own header names the encoding it avoids.
  const code = web('core/relay-transport.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/btoa|base64/i.test(code), 'the relay path re-encodes payloads');
  assert.match(code, /this\.signal\.forward\(/, 'the relay path no longer forwards raw frames');
});

/* ── and the copy says so ─────────────────────────────────────────────────── */

test('the setting explains what it spends, in every language', async () => {
  const { TABLES } = await import('../web/ui/i18n.js');
  for (const [code, table] of Object.entries(TABLES)) {
    for (const key of ['devices.direct', 'devices.directSub', 'devices.directOn', 'devices.directOff', 'about.addr']) {
      assert.ok(table[key], `${code} is missing ${key}`);
    }
    // Turning it on is the branch that costs something, so that is the one that must say so.
    assert.ok(
      table['devices.directOn'].length > 20,
      `${code}:devices.directOn is too short to have said what it does`,
    );
  }
});
