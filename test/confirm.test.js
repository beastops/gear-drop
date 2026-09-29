/**
 * Asking before something that cannot be undone, in the app's own words and on its own screen.
 *
 * Deleting a conversation, erasing the device and unpairing in the one risky case all asked
 * with the browser's `confirm()`. Where a browser does not show that - an in-app browser, a
 * web view, an installed web app on some phones - it answers "no" at once, so the delete button
 * silently did nothing. Where it does show, it is a small grey box that says nothing about
 * which app is asking.
 *
 * The question is now a sheet of this app's own: the whole screen dims and a card holds the
 * question, what it means, a large red button to go ahead and Cancel. On a phone the card sits
 * at the bottom where a thumb reaches it. Cancel, a tap outside, Back and Escape all say no.
 *
 * And the delete button sat one button's width in from the edge on a phone, beside the close
 * button that a phone does not show but that still took up its space.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

test('nothing asks with the browser\'s own confirm box', () => {
  // The word appears in prose; a call does not.
  const calls = [...MAIN.matchAll(/(^|[^.\w'`])confirm\(/gm)].length;
  assert.equal(calls, 0, 'a question is still asked with confirm(), which some browsers answer "no" without showing');
});

test('deleting a conversation, erasing and unpairing all ask on the app\'s own sheet', () => {
  assert.match(MAIN, /await askConfirm\(\{ text: t\('chat\.clearAsk'\)/);
  assert.match(MAIN, /await askConfirm\(\{ text: t\('devices\.eraseAsk'\)/);
  assert.match(MAIN, /await askConfirm\(\{\s*text: t\('devices\.unpairStrands'/);
  assert.match(HTML, /<dialog id="confirm-dialog"/);
});

test('the question covers the whole screen, with the card where a thumb is on a phone', () => {
  assert.match(CSS, /dialog\.confirm\s*\{[^}]*inset:\s*0/);
  assert.match(CSS, /dialog\.confirm\s*\{[^}]*height:\s*100dvh/);
  assert.match(CSS, /@media \(pointer: coarse\)[^{]*\{\s*dialog\.confirm\s*\{[^}]*align-items:\s*end/);
});

test('every way out of the question is a no', () => {
  const ask = MAIN.slice(MAIN.indexOf('function askConfirm('), MAIN.indexOf('function askConfirm(') + 2500);
  assert.match(ask, /addEventListener\('close'/, 'Back or Escape leaves it unanswered forever');
  assert.match(ask, /e\.target === d/, 'a tap outside the card does not say no');
  assert.match(ask, /confirmNo/);
});

test('on a phone the delete button sits against the edge, not beside an invisible one', () => {
  assert.match(CSS, /\.chat-head-tools \.close-x\[data-close\]\s*\{\s*order:\s*-1/);
});
