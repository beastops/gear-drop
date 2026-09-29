/**
 * Replying to a message, and the gestures a phone expects in a conversation.
 *
 * Swipe a message to the right and it becomes the one you are answering: a bar above the
 * keyboard says so, and the reply arrives on both devices showing what it answers. Tapping that
 * quote jumps back to the original. Holding a message on a phone lifts it over a darkened
 * screen with its actions underneath, the way the phone's own messaging apps do; on a computer
 * the small menu beside it stays.
 *
 * A reply names what it answers by the shared message id and nothing else. The words it quotes
 * are looked up on each side from that side's own copy, so a reply never carries a second copy
 * of somebody's message, and deleting the original for everyone leaves no trace of it in the
 * replies to it: they say the message is not there any more.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as chat from '../web/core/chat.js';
import { TransferManager } from '../web/core/transfer.js';

const PEER = '1a2b3c4d5e6f7081';

test('a reply is stored with the id of what it answers, and only an id', async () => {
  await chat.clear(PEER);
  const original = chat.newId();
  await chat.append(PEER, { dir: 'in', text: 'lunch?', id: original });
  const { messages } = await chat.append(PEER, { dir: 'out', text: 'yes', id: chat.newId(), re: original });
  assert.equal(messages.at(-1).re, original);
  for (const bad of ['<b>', '', 42, { id: original }, 'x']) {
    const out = await chat.append(PEER, { dir: 'out', text: 'no', re: bad });
    assert.equal(out.messages.at(-1).re, undefined, `kept ${JSON.stringify(bad)} as what a reply answers`);
  }
  await chat.clear(PEER);
});

function wired() {
  const sent = [];
  const tm = Object.create(TransferManager.prototype);
  const target = new EventTarget();
  tm.addEventListener = target.addEventListener.bind(target);
  tm.dispatchEvent = target.dispatchEvent.bind(target);
  tm._sendCtl = async (obj) => sent.push(obj);
  return { tm, sent };
}

test('a reply travels with the id it answers, and nothing of its words', async () => {
  const { tm, sent } = wired();
  const mid = chat.newId();
  const re = chat.newId();
  await tm.sendText('yes', mid, re);
  assert.deepEqual(sent[0], { t: 'text', body: 'yes', mid, re });

  const got = [];
  tm.addEventListener('text', (e) => got.push(e.detail));
  await TransferManager.prototype._onCtl.call(tm, { t: 'text', body: 'yes', mid, re });
  await TransferManager.prototype._onCtl.call(tm, { t: 'text', body: 'odd', mid, re: '../../x' });
  assert.deepEqual(got, [
    { body: 'yes', mid, re },
    { body: 'odd', mid, re: '' },
  ]);
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

function body(signature) {
  const at = MAIN.indexOf(signature);
  assert.ok(at > 0, `${signature} has gone`);
  const open = MAIN.indexOf('{', at + signature.length);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(open, i + 1);
    }
  }
  throw new Error(`${signature} does not close`);
}

test('what is being answered goes out with the message, now or from the outbox', () => {
  const say = body('async function sendChat()');
  assert.match(say, /sendText\(body, id, re\)/);
  assert.match(say, /pending: true, id: [^,]+, re/);
  assert.match(MAIN, /conn\.transfers\.sendText\(m\.text, m\.id, m\.re\)/);
  assert.match(MAIN, /chat\.append\(conn\.id, \{ dir: 'in', text: body, id: mid, re \}\)/);
});

test('a reply shows what it answers, looked up here, and says so when it has gone', () => {
  const draw = body('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})');
  assert.match(draw, /quoteFor\(m, messages\)/);
  const quote = body('function quoteFor(m, messages)');
  assert.match(quote, /messages\.find\(\(x\) => x\.id === m\.re\)/, 'the quote is not looked up by id');
  assert.match(quote, /t\('chat\.replyGone'\)/, 'a reply to a deleted message shows nothing to say so');
  assert.match(quote, /jumpTo\(/, 'tapping the quote does not go to the original');
});

test('swiping a message to the right answers it', () => {
  assert.match(body('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})'), /onSwipeReply\(row, \(\) => startReply\(m\)\)/);
  const swipe = body('function onSwipeReply(row, reply)');
  // Only sideways, only to the right, a tick at the point of no return, and no click after.
  assert.match(swipe, /Math\.abs\(mx\) > Math\.abs\(my\)/);
  assert.match(swipe, /navigator\.vibrate/);
  assert.match(swipe, /stopImmediatePropagation|preventDefault/);
  assert.match(HTML, /id="chat-reply"/, 'there is no bar saying what is being answered');
});

test('on a phone, holding a message lifts it over the whole screen', () => {
  const menu = body('function openBubbleMenu(m, row)');
  assert.match(menu, /matchMedia\('\(pointer: coarse\)'\)\.matches/);
  assert.match(menu, /openFocusMenu\(/);
  const focus = body('function openFocusMenu(m, row, actions)');
  // In the top layer, above the conversation's own dialog, and closed by Back like any menu.
  assert.match(focus, /showPopover\(\)/);
  assert.match(focus, /back\.open\(/);
  assert.match(CSS, /\.focus-layer\s*\{[^}]*inset:\s*0/, 'the layer does not cover the screen');
});

test('swiping down the conversation puts the keyboard away', () => {
  assert.match(MAIN, /ui\.chatInput\.blur\(\)/);
});
