/**
 * The HEIC decoder: what it is, and where it is allowed to cost anything.
 *
 * Three megabytes of vendored asm.js, which is larger than the rest of the app put together.
 * It earns its place only because nobody pays for it until they hold an iPhone photo, and
 * that arrangement is made of two things a future change could quietly undo:
 *
 *   · it must not be in the offline shell, or every install downloads it;
 *   · it must still be cacheable, or every photo downloads it again.
 *
 * Both are one list each in `sw.js`, and neither is obvious from reading the code that uses
 * it, so they are pinned here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESM_TAIL } from '../scripts/vendor-libheif.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = path.join(ROOT, 'web/vendor/libheif/libheif.js');
const FROM_NPM = path.join(ROOT, 'node_modules/libheif-js/libheif/libheif.js');

const sw = fs.readFileSync(path.join(ROOT, 'web/sw.js'), 'utf8');

/** Read one string array out of sw.js by name. */
function list(name) {
  const block = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n?\\];`).exec(sw);
  assert.ok(block, `sw.js no longer declares a ${name} array the way this test reads it`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const SHELL = list('SHELL');
const LAZY = list('LAZY');

test('the decoder is not in the offline shell', () => {
  // In the shell it would be fetched at install, by everyone, forever.
  for (const entry of ['vendor/libheif/libheif.js', 'core/heic-worker.js']) {
    assert.ok(!SHELL.includes(entry), `${entry} would be downloaded by every install`);
  }
});

test('the decoder is still allowed to be cached once it has been fetched', () => {
  /*
   * The fetch handler keeps only what is on a list, deliberately: the server answers an
   * unknown path with the app shell, so caching anything asked for would fill the disk with
   * copies of index.html. Being on no list at all means re-downloading three megabytes for
   * every photo.
   */
  assert.deepEqual(LAZY, ['core/heic-worker.js', 'vendor/libheif/libheif.js']);
  assert.match(sw, /const KEEPABLE = new Set\(\[\.\.\.SHELL, \.\.\.LAZY\]/);
});

test('install fetches the shell and nothing else', () => {
  // The lazy list must not creep into the install step.
  const install = /addEventListener\('install'[\s\S]*?\n\}\);/.exec(sw)?.[0] || '';
  assert.ok(install, 'sw.js no longer has an install handler this test can read');
  assert.ok(!install.includes('LAZY'), 'the lazy list is being precached after all');
});

test('the small part of the decoder is in the shell', () => {
  // `core/heic.js` is a few kilobytes and decides whether the three megabytes are needed at
  // all, so it belongs with everything else that has to work offline.
  assert.ok(SHELL.includes('core/heic.js'));
});

test('every lazily cached path exists', () => {
  for (const entry of LAZY) {
    assert.ok(fs.existsSync(path.join(ROOT, 'web', entry)), `${entry} is listed but missing`);
  }
});

test('the vendored decoder is the published one, plus the line that makes it a module', () => {
  /*
   * Same guarantee the crypto gets: a copied file is a file somebody can edit. This one is
   * three megabytes of minified emscripten output, where a change would be invisible in any
   * review, and it runs on a file that arrived from someone else.
   */
  if (!fs.existsSync(FROM_NPM)) {
    // Nothing to compare against; `npm install` restores it.
    return;
  }
  const vendored = fs.readFileSync(VENDORED, 'utf8');
  const published = fs.readFileSync(FROM_NPM, 'utf8');

  assert.ok(vendored.endsWith(ESM_TAIL), 'the ES module export is missing or has changed');
  assert.equal(
    vendored.slice(0, vendored.length - ESM_TAIL.length),
    published,
    'the vendored decoder differs from what npm published by more than the export line',
  );
});

test('the decoder is loaded from this origin, never a CDN', () => {
  const worker = fs.readFileSync(path.join(ROOT, 'web/core/heic-worker.js'), 'utf8');
  assert.match(worker, /from '\.\.\/vendor\/libheif\/libheif\.js'/);
  assert.ok(!/https?:\/\//.test(worker.replace(/^\s*\*.*$/gm, '')), 'no off-origin URL belongs here');
});
