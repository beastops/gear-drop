/**
 * Reactions, and knowing the other person is typing.
 *
 * Double-tap a message and a heart lands on it, on both devices; double-tap again and it goes.
 * The reaction bar in the message's menu offers a fixed six. Each side has at most one reaction
 * per message, drawn in a small badge on the bubble's corner, and a reaction made while the
 * other device is away is sent when it comes back, like a message in the outbox.
 *
 * The six are fixed so that a reaction is never free text: what arrives is checked against the
 * list and anything else is dropped, so another device cannot put arbitrary words on a message
 * by calling them a reaction.
 *
 * While one side types, the other sees "typing…" and three moving dots. It is sent to the one
 * device the conversation is with, sealed like everything else, at most every few seconds, and
 * it lapses by itself if the stop never arrives.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as chat from '../web/core/chat.js';
import { TransferManager } from '../web/core/transfer.js';

const PEER = '2b3c4d5e6f708192';

test('a reaction is one of a fixed few, one per side, and can be taken back', async () => {
  await chat.clear(PEER);
  const id = chat.newId();
  await chat.append(PEER, { dir: 'in', text: 'we won', id });

  let out = await chat.react(PEER, id, 'me', '❤️');
  assert.deepEqual(out.message.rx, { me: '❤️' });
  out = await chat.react(PEER, id, 'them', '😂');
  assert.deepEqual(out.message.rx, { me: '❤️', them: '😂' });
  out = await chat.react(PEER, id, 'me', '👍'); // one per side: a new one replaces the old
  assert.deepEqual(out.message.rx, { me: '👍', them: '😂' });
  out = await chat.react(PEER, id, 'me', '');
  assert.deepEqual(out.message.rx, { them: '😂' });

  for (const bad of ['lol', '<b>', '❤️❤️', 42, null]) {
    const r = await chat.react(PEER, id, 'them', bad);
    assert.equal(r.message.rx?.them, undefined, `kept ${JSON.stringify(bad)} as a reaction`);
  }
  // Stored, not just drawn.
  assert.deepEqual((await chat.load(PEER)).messages[0].rx, undefined);
  await chat.clear(PEER);
});

test('a reaction made while the other device is away waits, and is cleared when sent', async () => {
  await chat.clear(PEER);
  const id = chat.newId();
  await chat.append(PEER, { dir: 'in', text: 'see you', id });
  await chat.react(PEER, id, 'me', '🙏', { pending: true });
  assert.deepEqual(await chat.pendingReactions(PEER), [{ id, e: '🙏' }]);
  // Taking it back while still away is a change that has to reach the other side too.
  await chat.react(PEER, id, 'me', '', { pending: true });
  assert.deepEqual(await chat.pendingReactions(PEER), [{ id, e: '' }]);
  await chat.markReactionsSent(PEER, [id]);
  assert.deepEqual(await chat.pendingReactions(PEER), []);
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

test('a reaction names its message and one of the six, and nothing else gets through', async () => {
  const { tm, sent } = wired();
  const item = { id: chat.newId(), dir: 'in', at: 5, h: '0123456789abcdef' };
  await tm.sendReaction(item, '😮');
  assert.deepEqual(sent[0], { t: 'react', item, e: '😮' });

  const got = [];
  tm.addEventListener('react', (e) => got.push(e.detail));
  await TransferManager.prototype._onCtl.call(tm, { t: 'react', item, e: '😮' });
  await TransferManager.prototype._onCtl.call(tm, { t: 'react', item, e: '' });
  await TransferManager.prototype._onCtl.call(tm, { t: 'react', item, e: 'free text' });
  await TransferManager.prototype._onCtl.call(tm, { t: 'react', item: { id: '<x>' }, e: '❤️' });
  assert.deepEqual(got, [
    { item, e: '😮' },
    { item, e: '' },
    { item, e: '' },
  ]);
});

test('typing is a yes or a no, and nothing more', async () => {
  const { tm, sent } = wired();
  await tm.sendTyping(true);
  await tm.sendTyping('anything');
  assert.deepEqual(sent, [{ t: 'typing', on: true }, { t: 'typing', on: true }]);
  const got = [];
  tm.addEventListener('typing', (e) => got.push(e.detail));
  for (const on of [true, false, 'yes', 1, null]) await TransferManager.prototype._onCtl.call(tm, { t: 'typing', on });
  assert.deepEqual(got, [true, false, false, false, false]);
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
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

test('a double tap hearts a message, or takes the heart back', () => {
  const draw = body('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})');
  assert.match(draw, /onDoubleTap\(row, /);
  assert.match(draw, /m\.rx\?\.me === '❤️' \? '' : '❤️'/);
  assert.match(body('function onDoubleTap(row, fire)'), /navigator\.vibrate/);
  // A photo waits a moment before opening, so its second tap can react instead.
  const figure = MAIN.slice(MAIN.indexOf('function photoFigure(m)'), MAIN.indexOf('function photoFigure(m)') + 3000);
  assert.match(figure, /doubleTapped/);
});

test('a finger\'s double tap is not counted twice', () => {
  /*
   * Found on the phone layout: Chrome follows a finger's double tap with a mouse-style
   * double-click. The tap had already added the heart and redrawn the message, and the
   * double-click landed on the new message and took the heart straight back off, so a double
   * tap appeared to do nothing.
   */
  const tap = body('function onDoubleTap(row, fire)');
  assert.match(tap, /if \(e\.pointerType !== 'mouse'\) touchedAt = performance\.now\(\);/);
  assert.match(tap, /performance\.now\(\) - touchedAt < 800/);
});

test('the typing dots follow the newest message, inside the conversation', () => {
  const draw = body('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})');
  assert.match(draw, /ui\.chatLog\.append\(ui\.chatTyping\)/);
});

test('the menus offer the six, and a reaction reaches the other device or waits for it', () => {
  assert.match(body('function openFocusMenu(m, row, actions)'), /reactionBar\(/);
  assert.match(body('function openBubbleMenu(m, row)'), /reactionBar\(/);
  const react = body('async function reactTo(peerId, m, emoji)');
  assert.match(react, /sendReaction\(/);
  assert.match(react, /pending: true/);
  assert.match(MAIN, /flushReactions\(conn\)\.catch/);
  assert.match(MAIN, /transfers\.addEventListener\('react'/);
});

test('typing is shown, lapses on its own, and stops when a message lands', () => {
  assert.match(HTML, /id="chat-typing"/);
  assert.match(MAIN, /transfers\.addEventListener\('typing'/);
  assert.match(body('function noteTyping()'), /sendTyping\(true\)/);
  // Not a frame per keystroke.
  assert.match(body('function noteTyping()'), /TYPING_EVERY_MS/);
  assert.match(body('async function onChatText(conn, { body, mid, re })'), /conn\.typing = 0/);
  assert.match(body('function paintTyping(conn)'), /TYPING_LAPSE_MS|typing > Date\.now\(\)/);
});
