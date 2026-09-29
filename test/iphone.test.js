/**
 * The app on a phone, shaped and moving like an iPhone app.
 *
 * The main screen gets a large title under the toolbar, and devices that spring in and give
 * under a finger. A sheet coming up pushes the screen back into a dark rounded card behind it,
 * the way every iOS sheet does. The conversation is a page pushed in from the right, with the
 * screen behind it sliding a little to the left, and it goes back the way an iPhone page goes
 * back: a drag from its left edge that follows the finger, or the back chevron. A pushed page
 * does not also pull down like a sheet.
 *
 * On a phone only: a computer keeps its layout and its sheets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { completes, EDGE_PX } from '../web/ui/push.js';

test('a drag from the edge goes back if it went far enough, or fast enough', () => {
  assert.equal(completes(40, 0.1, 390), false, 'a short slow drag springs back');
  assert.equal(completes(160, 0.1, 390), true, 'past a third of the way');
  assert.equal(completes(50, 0.9, 390), true, 'a flick');
  assert.equal(completes(10, 2, 390), false, 'a twitch is not a flick');
  assert.ok(EDGE_PX >= 16 && EDGE_PX <= 32, 'the edge is a thumb\'s width, no more');
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const SWIPE = fs.readFileSync(path.join(ROOT, 'web', 'ui', 'swipe.js'), 'utf8');

function block(marker) {
  const at = CSS.indexOf(marker);
  assert.ok(at > 0, `no ${marker}`);
  const start = CSS.indexOf('@media', at);
  const open = CSS.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1);
  }
  throw new Error('does not close');
}

test('the main screen has a large title, on a phone', () => {
  const phone = block('/* iPhone */');
  assert.match(phone, /^@media \(max-width: 560px\)/);
  assert.match(phone, /\.brand-name\s*\{[^}]*font-size:\s*34px/);
  assert.match(phone, /\.topbar \.brand\s*\{[^}]*flex-basis:\s*100%/);
});

test('a sheet pushes the screen back into a card, and the conversation pushes in from the side', () => {
  const phone = block('/* iPhone */');
  assert.match(phone, /body\.card-behind\s*\{[^}]*scale:\s*0\.9\d/);
  assert.match(phone, /body\.pushed\s*\{[^}]*translate:/);
  assert.match(phone, /#chat-dialog\s*\{[^}]*translate:\s*100% 0/);
  assert.match(phone, /@starting-style\s*\{\s*#chat-dialog\[open\]\s*\{\s*translate:\s*100% 0/);
  // What the screen is on when it shrinks: black, as on an iPhone.
  assert.match(phone, /html\s*\{\s*background:\s*#000/);
  // The page knows which it is.
  assert.match(MAIN, /document\.body\.classList\.toggle\('card-behind'/);
  assert.match(MAIN, /document\.body\.classList\.toggle\('pushed'/);
});

test('the conversation goes back from its left edge, and not by pulling down', () => {
  assert.match(MAIN, /enableEdgeBack\(ui\.chatDialog/);
  assert.match(HTML, /<dialog id="chat-dialog" class="sheet" data-push/);
  assert.match(SWIPE, /data-push/);
  // A reply swipe does not start where the edge swipe does.
  assert.match(MAIN.slice(MAIN.indexOf('function onSwipeReply('), MAIN.indexOf('function onSwipeReply(') + 800), /EDGE_PX/);
});

test('devices spring in and give under a finger', () => {
  const phone = block('/* iPhone */');
  assert.match(phone, /\.peer\s*\{[^}]*animation:[^;]*cubic-bezier\(0\.34, 1\.56/);
  assert.match(phone, /\.peer:active \.avatar\s*\{[^}]*scale:\s*0\.9/);
});
