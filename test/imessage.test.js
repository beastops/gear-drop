/**
 * The conversation on a phone, laid out the way Messages lays one out.
 *
 * Full screen, with a back chevron, the other device's monogram and name at the top, and the
 * security line under the name. Blue bubbles for what you sent and grey for what you received;
 * messages sent close together by the same side stack tightly and only the last of a run has a
 * tail. A time line sits centred over the conversation where it picks up after a quiet hour, the
 * newest message you sent says whether it has gone, and swiping the conversation to the left
 * slides your messages aside to show the exact time of each. The text box is a rounded field
 * with the send arrow inside it, and the microphone in the same place while it is empty.
 *
 * On a phone only. A computer keeps the sheet it had.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { layoutOf, stampOf, initialsOf, GROUP_MS, STAMP_MS } from '../web/ui/when.js';

const T0 = Date.UTC(2026, 8, 29, 14, 40); // a Tuesday afternoon
const msg = (dir, at) => ({ dir, at });

test('messages close together from the same side are one run, and only its last has a tail', () => {
  const list = [
    msg('out', T0),
    msg('out', T0 + 20_000),
    msg('out', T0 + 40_000),
    msg('in', T0 + 60_000),
    msg('in', T0 + 60_000 + GROUP_MS + 1), // too long after the one before
  ];
  const shape = layoutOf(list).map((x) => (x.first ? 'F' : '-') + (x.last ? 'L' : '-'));
  assert.deepEqual(shape, ['F-', '--', '-L', 'FL', 'FL']);
});

test('a time line starts the conversation and follows every quiet hour', () => {
  const list = [msg('in', T0), msg('out', T0 + 5 * 60_000), msg('in', T0 + 5 * 60_000 + STAMP_MS + 1)];
  assert.deepEqual(layoutOf(list).map((x) => x.stamp), [true, false, true]);
  // A time line also ends a run: the message after it starts afresh.
  const l = layoutOf([msg('in', T0), msg('in', T0 + STAMP_MS + 1)]);
  assert.deepEqual(l.map((x) => [x.first, x.last]), [[true, true], [true, true]]);
});

test('a time line reads the way a phone says it', () => {
  const at = (h, m, d = 0) => new Date(2026, 8, 29 - d, h, m).getTime();
  const now = at(18, 0);
  const words = { now, locale: 'en-US', today: 'Today', yesterday: 'Yesterday' };
  assert.match(stampOf(at(14, 40), words), /^Today 2:40\s?PM$/);
  assert.match(stampOf(at(9, 5, 1), words), /^Yesterday 9:05\s?AM$/);
  assert.match(stampOf(at(9, 5, 3), words), /^[A-Z][a-z]{2} 9:05\s?AM$/, 'a day this week is named');
  assert.match(stampOf(at(9, 5, 40), words), /Aug(ust)? 20/, 'further back it is a date');
});

test('the monogram is the first letters of the name', () => {
  assert.equal(initialsOf('Falcon-Frame'), 'FF');
  assert.equal(initialsOf('Elder Jewel'), 'EJ');
  assert.equal(initialsOf('bob'), 'B');
  assert.equal(initialsOf(''), '?');
  assert.equal(initialsOf('Ärger-Öl'), 'ÄÖ');
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

/** The body of the phone block that lays the conversation out as Messages does. */
function phoneBlock() {
  const at = CSS.indexOf('/* iMessage */');
  assert.ok(at > 0, 'there is no phone layout for the conversation');
  const open = CSS.indexOf('{', CSS.indexOf('@media', at));
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(CSS.indexOf('@media', at), i + 1);
  }
  throw new Error('the phone block does not close');
}

test('on a phone the conversation fills the screen, and only on a phone', () => {
  const block = phoneBlock();
  assert.match(block, /^@media \(max-width: 560px\)/);
  assert.match(block, /#chat-dialog\s*\{[^}]*height:\s*100dvh/);
  assert.match(block, /\.chat-back\s*\{[^}]*display:\s*grid/, 'no way back on a phone');
  // Outside it, the phone-only pieces are not shown.
  assert.match(CSS, /\.chat-back,\s*\.chat-avatar,\s*\.chat-stamp,\s*\.chat-status,\s*\.bubble-when\s*\{\s*display:\s*none/);
});

test('bubbles have tails on the last of a run, the times are centred, the send arrow is in the field', () => {
  const block = phoneBlock();
  assert.match(block, /\.bubble\.tail::before/);
  assert.match(block, /\.bubble-time\s*\{\s*display:\s*none/);
  assert.match(block, /\.chat-stamp\s*\{[^}]*display:\s*block/);
  assert.match(block, /#btn-chat-send\s*\{[^}]*position:\s*absolute/);
  assert.match(block, /\.chat-composer:not\(\.has-text\) #btn-chat-send\s*\{\s*display:\s*none/);
});

test('the page draws runs, time lines, the last sent message\'s state and each message\'s time', () => {
  assert.match(MAIN, /import \{ layoutOf, stampOf, initialsOf \} from '\.\/ui\/when\.js';/);
  const draw = MAIN.slice(MAIN.indexOf('function renderChat('), MAIN.indexOf('function renderChat(') + 9000);
  assert.match(draw, /layoutOf\(messages\)/);
  assert.match(draw, /row\.classList\.add\('tail'\)/);
  assert.match(draw, /chat-stamp/);
  assert.match(draw, /chat-status/);
  assert.match(draw, /bubble-when/);
  assert.match(MAIN, /ui\.chatAvatar\.textContent = initialsOf\(/);
  assert.match(MAIN, /classList\.toggle\('has-text'/);
  assert.match(MAIN, /function onPeek\(/);
  assert.match(HTML, /class="chat-back"/);
  // And Android shrinks the page for the keyboard, so the text box stays above it.
  assert.match(HTML, /interactive-widget=resizes-content/);
});

test('a voice message does not cut off its reaction, its reply arrow or its time', () => {
  // The bubble clipped everything drawn just outside it: the heart on it, the arrow a swipe
  // pulls out, the time a swipe to the left shows, its tail, and on a computer its buttons.
  const rule = CSS.slice(CSS.indexOf('.bubble.audio {'), CSS.indexOf('}', CSS.indexOf('.bubble.audio {')));
  assert.doesNotMatch(rule, /overflow:\s*hidden/);
});

test('on a phone, the recording bar sits above the text box, clear of the home bar', () => {
  // It came after the composer, the last thing on the page, in the strip the home indicator
  // covers, with the composer's own safe-area padding left empty above it.
  const phone = phoneBlock();
  assert.match(phone, /#chat-dialog \.chat-composer\s*\{[^}]*order:\s*1/);
});
