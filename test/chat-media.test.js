/**
 * What a conversation will hold inline, and what it hands off as an ordinary file.
 *
 * Everything the gate lets through is decrypted and handed to a player or an <img> on this
 * origin, and everything it turns away still reaches the other device as a download rather
 * than a bubble. Getting it wrong one way shows someone a broken player; the other way runs a
 * file here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_TYPES,
  IMAGE_TYPES,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  isAudio,
  isImage,
  mediaKind,
  mediaLimit,
} from '../web/core/chat.js';

test('the ordinary things people send are recognised', () => {
  assert.equal(mediaKind('audio/mpeg', 4 * 1024 * 1024), 'audio', 'an mp3 is audio');
  assert.equal(mediaKind('image/jpeg', 900_000), 'image');
  assert.equal(mediaKind('audio/mp4', 2_000_000), 'audio', 'what an iPhone records');
  assert.equal(mediaKind('audio/webm', 200_000), 'audio', 'what everything else records');
});

test('a codec parameter does not defeat the check', () => {
  // MediaRecorder reports the type it chose, parameters and all.
  assert.equal(mediaKind('audio/webm;codecs=opus', 50_000), 'audio');
  assert.equal(mediaKind('AUDIO/WEBM; CODECS=OPUS', 50_000), 'audio');
});

test('anything else travels as a file, not as a bubble', () => {
  for (const mime of ['application/zip', 'video/mp4', 'text/plain', 'application/pdf', '']) {
    assert.equal(mediaKind(mime, 1000), '', `${mime} should not be inline`);
  }
});

test('a photo from a phone arrives as a picture, not as a download', () => {
  /*
   * Every photo an iPhone takes is HEIC. Left off the list they reached a conversation as a
   * plain file with a save button, which is not what anyone means by sending a picture.
   *
   * The list is what a sender might hold, not what every receiver can draw: Chrome and
   * Firefox cannot decode one, and the bubble answers that by decoding it itself.
   */
  for (const mime of ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']) {
    assert.equal(mediaKind(mime, 3 * 1024 * 1024), 'image', `${mime} should be a picture`);
  }
  assert.equal(mediaKind('IMAGE/HEIC', 3 * 1024 * 1024), 'image', 'whatever case the sender reports');
});

test('SVG is still refused, now that audio shares the gate', () => {
  // These bytes are also offered back as a file; an SVG opened at the top level of this
  // origin would run with our storage.
  assert.equal(mediaKind('image/svg+xml', 1000), '');
  assert.ok(!IMAGE_TYPES.has('image/svg+xml'));
});

test('each kind is held to its own size limit', () => {
  assert.equal(mediaLimit('audio/mpeg'), MAX_AUDIO_BYTES);
  assert.equal(mediaLimit('image/png'), MAX_IMAGE_BYTES);
  assert.ok(MAX_AUDIO_BYTES > MAX_IMAGE_BYTES, 'a song is bigger than a photograph');

  // A song the size of a large photograph is fine; one past the audio cap is not.
  assert.equal(mediaKind('audio/mpeg', MAX_IMAGE_BYTES + 1), 'audio');
  assert.equal(mediaKind('audio/mpeg', MAX_AUDIO_BYTES + 1), '');
  assert.equal(mediaKind('image/png', MAX_IMAGE_BYTES + 1), '');
});

test('an empty or negative size is never inline', () => {
  for (const size of [0, -1, NaN]) {
    assert.equal(isAudio('audio/mpeg', size), false);
    assert.equal(isImage('image/png', size), false);
  }
});

test('the two type lists do not overlap, so a kind is never ambiguous', () => {
  for (const mime of AUDIO_TYPES) assert.ok(!IMAGE_TYPES.has(mime), `${mime} is in both lists`);
});

test('every recordable type is one the log will accept back', () => {
  // What MediaRecorder can produce here must survive its own round trip, or a voice message
  // would send and then refuse to be stored as one.
  for (const type of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    assert.equal(mediaKind(type, 10_000), 'audio', `${type} is recorded but not accepted`);
  }
});

/*
 * `voice` rides on the manifest beside `chat`.
 *
 * Without it the receiving side has only the file name to go on, and a recording's name is
 * generated, so the sender saw "Voice message" and the receiver saw
 * `voice-2026-09-15T09-00-54.webm`. Presentation only: it decides whether a title line is
 * drawn, and grants nothing.
 */
import { checkManifest } from '../web/core/transfer.js';
import { MAX_DURATION, plausibleDuration } from '../web/core/chat.js';

const manifest = (extra = {}) => ({
  t: 'manifest',
  transferId: 'abc123',
  total: 1000,
  files: [{ id: 0, name: 'voice-x.webm', path: 'voice-x.webm', size: 1000, mime: 'audio/webm' }],
  ...extra,
});

const seen = () => new Map();

test('a recording is marked as one, and anything else is not', () => {
  assert.equal(checkManifest(manifest({ chat: true, voice: true }), seen())?.voice, true);
  assert.equal(checkManifest(manifest({ chat: true }), seen())?.voice, false);
  assert.equal(checkManifest(manifest(), seen())?.voice, false);
});

test('the flag is a boolean, whatever the sender puts there', () => {
  // An authenticated channel proves who sent this, not that they meant well.
  for (const claim of ['yes', 1, {}, [], null]) {
    assert.equal(checkManifest(manifest({ voice: claim }), seen())?.voice, false, `${JSON.stringify(claim)} became true`);
  }
});

/*
 * The length travels with the file because the file cannot be asked.
 *
 * A container written while it is still being recorded has no duration in its header, and
 * browsers disagree about what to report for one. The finite-but-absurd answer is the one
 * that matters: it survives every `isFinite` check, and four seconds renders as millions of
 * minutes.
 */
test('a length that cannot be true is discarded, not displayed', () => {
  for (const claim of [Infinity, -Infinity, NaN, Number.MAX_VALUE, 1e308, -5, 0, 'soon', null, undefined]) {
    assert.equal(plausibleDuration(claim), 0, `${String(claim)} was let through`);
  }
});

test('an ordinary length survives', () => {
  for (const ok of [0.5, 4, 63, 3600, MAX_DURATION]) {
    assert.equal(plausibleDuration(ok), ok);
  }
});

test('the manifest bounds the length it is handed', () => {
  assert.equal(checkManifest(manifest({ dur: 42 }), seen())?.dur, 42);
  assert.equal(checkManifest(manifest({ dur: Number.MAX_VALUE }), seen())?.dur, 0);
  assert.equal(checkManifest(manifest({ dur: Infinity }), seen())?.dur, 0);
  assert.equal(checkManifest(manifest(), seen())?.dur, 0);
});

/*
 * Whatever `checkManifest` bounds has to actually reach the UI.
 *
 * It did not: the `incoming` event forwarded four fields by name and dropped the two new
 * ones, so the receiving side drew a recording as an ordinary file and fell back to asking
 * its own decoder how long it was, which is the guess this was meant to replace.
 */
test('every field the manifest check produces is forwarded to the UI', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'core', 'transfer.js'),
    'utf8',
  );
  const detail = /new CustomEvent\('incoming',[\s\S]*?detail:\s*\{([\s\S]*?)\},/.exec(src)?.[1] ?? '';
  for (const field of ['chat', 'voice', 'dur']) {
    assert.match(detail, new RegExp(`\\b${field}\\b`), `'incoming' drops ${field}`);
  }
});

/* ───────────────────────────── the outbox ────────────────────────────────── */

/*
 * A message written to a device that is not here.
 *
 * The composer has always said new messages go when the device is back, and nothing kept that
 * promise: the send path returned early without a connection and what was typed was dropped.
 * These cover keeping it: a waiting message is marked, delivery clears only what was actually
 * delivered, and a flush that fails partway leaves the rest waiting rather than marking them
 * sent.
 */
import { append, load, markSent, pendingFor, clear } from '../web/core/chat.js';

// A durable id. An unpaired `chan:` or `code:` peer keeps its log in memory only.
const PEER = 'a1b2c3d4e5f60718';

test('a message can be written while the device is away, and is marked as waiting', async () => {
  await clear(PEER);
  await append(PEER, { dir: 'out', text: 'while you were out', pending: true });
  const waiting = await pendingFor(PEER);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].text, 'while you were out');
  assert.equal(waiting[0].pending, true);
  await clear(PEER);
});

test('an ordinary message is not marked', async () => {
  await clear(PEER);
  await append(PEER, { dir: 'out', text: 'sent normally' });
  assert.equal((await pendingFor(PEER)).length, 0);
  await clear(PEER);
});

test('delivery clears only what was delivered', async () => {
  await clear(PEER);
  const a = await append(PEER, { dir: 'out', text: 'first', pending: true });
  await append(PEER, { dir: 'out', text: 'second', pending: true });
  await append(PEER, { dir: 'out', text: 'third', pending: true });

  const all = await pendingFor(PEER);
  assert.equal(all.length, 3);

  // Only the first two go out; the link drops partway, which is the ordinary failure.
  await markSent(PEER, [all[0].id, all[1].id]);

  const left = await pendingFor(PEER);
  assert.equal(left.length, 1, 'a partial flush cleared more than it sent');
  assert.equal(left[0].text, 'third');

  // And nothing was lost: the conversation still holds all three, in order.
  const { messages } = await load(PEER);
  assert.deepEqual(messages.map((m) => m.text), ['first', 'second', 'third']);
  await clear(PEER);
});

test('clearing is by id, so a reply arriving mid-flush is not mistaken for a sent message', async () => {
  await clear(PEER);
  await append(PEER, { dir: 'out', text: 'queued', pending: true });
  const queued = (await pendingFor(PEER))[0];

  // The peer answers while the flush is in flight, landing between the two.
  await append(PEER, { dir: 'in', text: 'their reply' });

  await markSent(PEER, [queued.id]);
  const { messages } = await load(PEER);
  assert.equal((await pendingFor(PEER)).length, 0);
  assert.deepEqual(messages.map((m) => `${m.dir}:${m.text}`), ['out:queued', 'in:their reply']);
  await clear(PEER);
});

test('marking an id that is not there changes nothing', async () => {
  await clear(PEER);
  await append(PEER, { dir: 'out', text: 'still waiting', pending: true });
  await markSent(PEER, ['no-such-id']);
  assert.equal((await pendingFor(PEER)).length, 1, 'an unknown id cleared a real one');
  await clear(PEER);
});

test('a waiting message survives being read back from storage', async () => {
  await clear(PEER);
  await append(PEER, { dir: 'out', text: 'persisted', pending: true });
  const { messages } = await load(PEER);
  assert.equal(messages[0].pending, true, 'the flag did not survive the round trip');
  await clear(PEER);
});

/*
 * A burst of messages, none of them lost.
 *
 * Appending is read-modify-write with a decrypt, a parse, an encrypt and a database round trip
 * in between, so several arriving together each read the same log before any has written and
 * the last write wins. An outbox flush delivers that kind of burst (three queued messages went
 * out and one arrived, twice) but nothing about the bug needed an outbox; a
 * quick exchange had always been able to do it.
 */
test('messages appended together are all kept, in order', async () => {
  await clear(PEER);
  const texts = Array.from({ length: 12 }, (_, i) => `burst ${i}`);

  // Fired without awaiting, which is how they actually arrive.
  await Promise.all(texts.map((text) => append(PEER, { dir: 'in', text })));

  const { messages } = await load(PEER);
  assert.equal(messages.length, texts.length, 'writes were lost to each other');
  assert.deepEqual([...new Set(messages.map((m) => m.text))].length, texts.length, 'a message was duplicated');
  assert.deepEqual(messages.map((m) => m.text), texts, 'the order they were asked for was not kept');
  await clear(PEER);
});

test('a flush and the replies it provokes do not overwrite each other', async () => {
  await clear(PEER);
  // Three going out, three coming back, interleaved the way a real exchange interleaves.
  const out = [0, 1, 2].map((i) => append(PEER, { dir: 'out', text: `out ${i}`, pending: true }));
  const back = [0, 1, 2].map((i) => append(PEER, { dir: 'in', text: `in ${i}` }));
  await Promise.all([...out, ...back]);

  const { messages } = await load(PEER);
  assert.equal(messages.length, 6, 'six writes did not produce six messages');
  assert.equal((await pendingFor(PEER)).length, 3, 'the outgoing three should still be waiting');

  // And clearing the outbox mid-conversation keeps everything.
  const ids = (await pendingFor(PEER)).map((m) => m.id);
  await markSent(PEER, ids);
  const after = await load(PEER);
  assert.equal(after.messages.length, 6, 'marking as sent dropped a message');
  assert.equal((await pendingFor(PEER)).length, 0);
  await clear(PEER);
});
