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
  // Above the conversation, and closed by Back like any menu.
  assert.match(focus, /showOverChat\(layer\)/);
  assert.match(focus, /back\.open\(/);
  /*
   * And inside the conversation's dialog, where it can be pressed. Outside a modal dialog
   * everything is inert: the menus were drawn on top and every tap fell through them. Found
   * with real touch; a scripted click had passed, because it ignores inertness.
   */
  const over = body('function showOverChat(el)');
  assert.match(over, /ui\.chatDialog\.append\(el\)/);
  assert.ok(!/document\.body\.append/.test(over), 'a menu over the chat is back outside the modal, where it is inert');
  assert.match(body('function openBubbleMenu(m, row)'), /showOverChat\(el\)/);
  assert.match(CSS, /\.focus-layer\s*\{[^}]*inset:\s*0/, 'the layer does not cover the screen');
});

test('swiping down the conversation puts the keyboard away', () => {
  assert.match(MAIN, /ui\.chatInput\.blur\(\)/);
});

test('a quote waiting to be sent goes when the message it quotes does', () => {
  // The other device deleted the message, or the conversation went: "Replying to" still showed
  // the deleted words above the keyboard, and the next message answered nothing.
  assert.match(body('async function destroyConversation(id, { tell = false, owe = true } = {})'), /cancelReply\(\)/);
  assert.match(body('function dissolveBubbles(ids, { messages, locked = false, ephemeral = false })'), /if \(replyTo && gone\.has\(replyTo\.id\)\) cancelReply\(\)/);
});

/* ─────────────── gestures that got in each other's way ─────────────── */

test('Escape closes the menu in front, and only that', () => {
  // With a message menu open over the conversation, one Escape closed both - the menu and the
  // conversation under it - and on the main screen it also threw away files picked to send.
  const esc = MAIN.slice(MAIN.indexOf("if (e.key !== 'Escape') return;"), MAIN.indexOf("ui.peers.addEventListener('scroll', closeMenu"));
  assert.match(esc, /if \(openMenu\) \{\s*closeMenu\(\);\s*e\.preventDefault\(\);\s*return;\s*\}/);
});

test('a menu goes with the message or the conversation it was opened on', () => {
  // The lifted copy in the hold menu kept a deleted message's words on screen, and its Reply
  // and Copy still worked on them.
  const dissolve = body('function dissolveBubbles(ids, { messages, locked = false, ephemeral = false })');
  assert.match(dissolve, /if \(openMenu && gone\.has\(openMenu\.tile\?\.dataset\.id\)\) closeMenu\(\);/);
  assert.match(body('async function destroyConversation(id, { tell = false, owe = true } = {})'), /closeMenu\(\)/);
  // And the words of a cancelled quote do not stay in the page, hidden.
  assert.match(body('function cancelReply()'), /ui\.chatReplyText\.textContent = ''/);
  // Every way of closing the conversation takes its menu with it - a swipe back from the edge too.
  const close = MAIN.slice(MAIN.indexOf("ui.chatDialog.addEventListener('close', () => {\n    // A sheet that closes mid-recording"));
  assert.match(close.slice(0, close.indexOf('});')), /closeMenu\(\)/);
});

test('a hold on a message that was redrawn under the finger opens nothing', () => {
  // A message arriving mid-hold rebuilt the log; the timer then opened a menu for the old row,
  // measured at nothing, at the top-left corner of the screen.
  assert.match(body('function onHold(el, open)'), /if \(!el\.isConnected\) return;/);
});

test('a second finger does not strand a drag half way', () => {
  // A second touch reset the first finger's gesture, and the page, the conversation or the
  // message stayed where it had been dragged to.
  const PUSH = fs.readFileSync(path.join(ROOT, 'web', 'ui', 'push.js'), 'utf8');
  const SWIPE = fs.readFileSync(path.join(ROOT, 'web', 'ui', 'swipe.js'), 'utf8');
  assert.match(PUSH, /'pointerdown',\s*\(e\) => \{[\s\S]{0,200}?if \(e\.isPrimary === false\) return;\s*start = null;/);
  assert.match(SWIPE, /if \(e\.isPrimary === false\) return;/);
  for (const fn of ['function onPeek(log)', 'function onSwipeReply(row, reply)']) {
    assert.match(body(fn), /if \(e\.isPrimary === false\) return;/, fn);
  }
});

test('peek and swipe-to-reply keep the gesture once they have it', () => {
  // The sheet under them took the same gesture when the finger turned, and the log stayed
  // peeked, or the message stayed pulled out, until the next full swipe.
  for (const fn of ['function onPeek(log)', 'function onSwipeReply(row, reply)']) {
    const b = body(fn);
    assert.match(b, /e\.stopPropagation\(\)/, fn);
    // Peek clears whatever a gesture the sheet took left behind; swipe-to-reply ends when the
    // capture it took is lost.
    assert.match(b, fn.includes('onPeek') ? /log\.classList\.remove\('peeking'\)/ : /lostpointercapture/, fn);
  }
});

test('the phone keeps its own long-press off messages', () => {
  // A later rule made message text selectable again on touch screens, so the phone's selection
  // and callout came up together with the app's hold menu.
  const coarse = [...CSS.matchAll(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  const selectable = coarse.slice(coarse.indexOf('-webkit-touch-callout: default') - 400, coarse.indexOf('-webkit-touch-callout: default'));
  assert.doesNotMatch(selectable, /\.bubble,/);
});
