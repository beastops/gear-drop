/**
 * The one part of an offer that is content rather than a claim about content.
 *
 * Everything else on a manifest is a description - a name, a size, a type - and the bytes
 * wait for an answer. A preview does not: it is on the screen before Accept is pressed,
 * because it exists to inform that press. So it is the field with the most to prove, and
 * these are the things it has to prove before an image decoder is handed anything.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkThumb, canThumb, isImageMime, MAX_THUMB_B64, MAX_THUMB_BYTES } from '../web/core/thumb.js';
import { checkManifest } from '../web/core/transfer.js';

/** A short, valid base64 payload. Its contents never matter here; its alphabet does. */
const D = Buffer.from('not really a jpeg, and it does not need to be').toString('base64');
const good = () => ({ d: D, w: 320, h: 240 });

const manifest = (extra = {}) => ({
  t: 'manifest',
  transferId: 'abc123',
  total: 1000,
  files: [{ id: 0, name: 'photo.jpg', path: 'photo.jpg', size: 1000, mime: 'image/jpeg' }],
  ...extra,
});
const seen = () => new Map();

/* ------------------------------------------------------------------ shape */

test('a well-formed preview survives, with its dimensions', () => {
  const out = checkThumb(good());
  assert.deepEqual(out, { d: D, w: 320, h: 240 });
});

test('anything that is not an object is not a preview', () => {
  for (const v of [null, undefined, 0, 1, '', D, true, [], () => {}]) {
    assert.equal(checkThumb(v), null, `${JSON.stringify(v) ?? typeof v} was accepted`);
  }
});

test('a preview without usable bytes is refused', () => {
  for (const d of [undefined, null, '', 0, 123, {}, [], ['a']]) {
    assert.equal(checkThumb({ ...good(), d }), null, `d=${JSON.stringify(d)} was accepted`);
  }
});

/* --------------------------------------------------------------- alphabet */

/*
 * The payload becomes a blob URL. An alphabet check is what keeps it from being able to
 * become anything else: no `data:` prefix smuggled in front of it, no quote to break out of
 * wherever it is written, no whitespace for a parser to disagree about.
 */
test('only base64 gets through, and nothing that could read as a URL or markup', () => {
  const hostile = [
    'data:text/html,<script>bad()</script>',
    '<img src=x onerror=alert(1)>',
    'abc"def',
    "abc'def",
    'abc def',
    'abc\ndef',
    'abc/def=extra', // padding in the middle is not padding
    '../../etc/passwd',
    'javascript:alert(1)',
    '%3Cscript%3E',
  ];
  for (const d of hostile) {
    assert.equal(checkThumb({ ...good(), d }), null, `${d} was accepted`);
  }
});

test('valid base64 with padding is fine', () => {
  for (const d of ['QQ==', 'QUI=', 'QUJD']) {
    assert.ok(checkThumb({ ...good(), d }), `${d} was refused`);
  }
});

/* ------------------------------------------------------------------ limit */

test('a preview larger than the cap is refused rather than truncated', () => {
  const atCap = 'A'.repeat(MAX_THUMB_B64);
  assert.ok(checkThumb({ ...good(), d: atCap }), 'the cap itself should be allowed');
  assert.equal(checkThumb({ ...good(), d: atCap + 'A' }), null, 'one character over was accepted');
});

test('the cap is small enough that a preview cannot carry a file', () => {
  // The point of the limit: a picture nobody accepted must not be deliverable through it.
  assert.ok(MAX_THUMB_BYTES <= 32 * 1024, `${MAX_THUMB_BYTES} bytes is no longer a thumbnail`);
});

/* ------------------------------------------------------------- dimensions */

test('dimensions have to be real pixel counts', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, '320', null, undefined, {}]) {
    assert.equal(checkThumb({ ...good(), w: n }), null, `w=${String(n)} was accepted`);
    assert.equal(checkThumb({ ...good(), h: n }), null, `h=${String(n)} was accepted`);
  }
});

test('a preview cannot claim to be enormous', () => {
  // The frame is laid out from these, so an absurd ratio is a way to push the buttons off
  // the sheet that the person is about to press.
  assert.equal(checkThumb({ ...good(), w: 1e9 }), null);
  assert.equal(checkThumb({ ...good(), h: 1e9 }), null);
});

/* -------------------------------------------------------------- stability */

/*
 * The object came off the wire, so it is JSON today - but it reaches this function as an
 * object, and the value that is checked has to be the value that is used. A copy makes that
 * true whatever it turns out to be tomorrow.
 */
test('what comes back is a copy, so it cannot change its mind after being checked', () => {
  let reads = 0;
  const shifty = {
    get d() {
      reads++;
      return reads === 1 ? D : '<img src=x onerror=alert(1)>';
    },
    w: 320,
    h: 240,
  };
  const out = checkThumb(shifty);
  assert.equal(out.d, D, 'the checked value is not the value that came back');
  assert.equal(out.d, D, 'and it is still that value on a second read');
});

/* --------------------------------------------------------------- manifest */

test('an offer carries its preview through', () => {
  const out = checkManifest(manifest({ thumb: good() }), seen());
  assert.deepEqual(out.thumb, { d: D, w: 320, h: 240 });
});

test('an offer with no preview is an ordinary offer', () => {
  assert.equal(checkManifest(manifest(), seen()).thumb, null);
});

/*
 * A malformed preview drops; it does not take the transfer with it.
 *
 * Refusing the whole manifest would mean one bad field turns a file somebody is waiting for
 * into a transfer that silently never happens, and the field is decoration.
 */
test('a preview that fails its checks costs the offer nothing but the picture', () => {
  for (const thumb of ['not an object', { d: '<script>' }, { d: D, w: 0, h: 0 }, { d: D }]) {
    const out = checkManifest(manifest({ thumb }), seen());
    assert.ok(out, `${JSON.stringify(thumb)} refused the whole offer`);
    assert.equal(out.thumb, null, `${JSON.stringify(thumb)} got through`);
    assert.equal(out.files.length, 1, 'the files survived');
  }
});

/* ------------------------------------------------------------- what to do */

test('a preview is offered for pictures and for nothing else', () => {
  assert.ok(isImageMime('image/jpeg'));
  assert.ok(isImageMime('image/HEIC'));
  assert.ok(isImageMime('image/svg+xml'));
  for (const mime of ['video/mp4', 'application/pdf', 'text/plain', '', null, undefined, 'imagex/jpeg']) {
    assert.equal(isImageMime(mime), false, `${String(mime)} was treated as a picture`);
  }
});

test('an empty file, or one too big to be worth decoding, is left alone', () => {
  assert.equal(canThumb({ type: 'image/jpeg', size: 0 }), false);
  assert.equal(canThumb({ type: 'image/jpeg', size: 1 }), true);
  assert.equal(canThumb({ type: 'image/jpeg', size: 1024 ** 4 }), false);
  assert.equal(canThumb({ type: 'application/zip', size: 1000 }), false);
  assert.equal(canThumb(null), false);
});
