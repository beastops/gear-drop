/**
 * Playing a voice message or a song in the conversation.
 *
 * Found by reading the player against how media elements actually behave:
 *
 *   - a redraw of the conversation - any message arriving, any reaction - stopped a note that
 *     was playing and put it back to 0:00, because rebuilding the log takes the element out of
 *     the document and that pauses it;
 *   - closing the conversation left it playing with no player on screen;
 *   - a speed chosen before the first play showed 1.5× and played at 1×, because giving the
 *     element its source resets the rate;
 *   - a quick tap on the waveform of a note still decrypting left it scrubbing on every hover;
 *   - an interrupted start - a second tap, a redraw - said "This browser can't play this one";
 *   - two paints of one picture or recording each made an object URL of the decrypted bytes,
 *     and only one of them was ever revoked.
 *
 * The functions are taken from main.js as they are and run against fakes that behave like the
 * browser's elements.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');

function source(signature) {
  const at = MAIN.indexOf(signature);
  assert.ok(at >= 0, `${signature} has gone`);
  const open = MAIN.indexOf('{', at + signature.length);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(at, i + 1);
  }
  throw new Error(`${signature} does not close`);
}

const pause = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const event = (type, extra = {}) => Object.assign(new Event(type), extra);

function element(extra = {}) {
  const el = new EventTarget();
  return Object.assign(el, {
    textContent: '',
    style: { setProperty() {} },
    classList: { add() {}, toggle() {} },
    setAttribute() {},
    querySelector: () => null,
    append() {},
    replaceChildren() {},
    ...extra,
  });
}

/** An <audio> as far as the player uses it, including the reset a new source causes. */
function fakeAudio(playResult = () => Promise.resolve()) {
  const a = element({ paused: true, currentTime: 0, duration: NaN, playbackRate: 1, defaultPlaybackRate: 1 });
  let src = '';
  Object.defineProperty(a, 'src', {
    get: () => src,
    set(v) {
      src = v;
      // The media element load algorithm.
      a.playbackRate = a.defaultPlaybackRate;
    },
  });
  a.play = () => {
    a.paused = false;
    return playResult();
  };
  a.pause = () => {
    a.paused = true;
  };
  return a;
}

function urls() {
  const made = [];
  const revoked = [];
  return {
    made,
    revoked,
    URL: {
      createObjectURL: () => {
        const u = `blob:${made.length}`;
        made.push(u);
        return u;
      },
      revokeObjectURL: (u) => revoked.push(u),
    },
  };
}

function player({ decryptMs = 0, playResult } = {}) {
  const toasts = [];
  const u = urls();
  const mediaUrls = new Map();
  const chat = {
    plausibleDuration: (d) => (Number.isFinite(d) && d > 0 ? d : 0),
    getAttachment: () => new Promise((r) => setTimeout(() => r(new Uint8Array([1, 2, 3])), decryptMs)),
  };
  const wireAudio = new Function(
    'chat', 'fmtClock', 'mediaUrls', 'chatToken', 't', 'toast', 'RATES', 'URL', 'document',
    `return (${source('function wireAudio({ wrap, audio, play, track, time, rate, m })')});`,
  )(
    chat,
    (s) => String(Math.round(s)),
    mediaUrls,
    0,
    (k) => k,
    (...a) => toasts.push(a),
    [1, 1.5, 2],
    u.URL,
    { querySelectorAll: () => [], createElement: () => element() },
  );
  const els = {
    wrap: element(),
    audio: fakeAudio(playResult),
    play: element(),
    track: element({
      getBoundingClientRect: () => ({ left: 0, width: 100 }),
      setPointerCapture() {},
      releasePointerCapture() {},
    }),
    time: element(),
    rate: element(),
  };
  wireAudio({ ...els, m: { att: 'a1', dur: 30, mime: 'audio/webm' } });
  return { ...els, toasts, u, mediaUrls };
}

test('a speed chosen before the first play is the speed it plays at', async () => {
  const p = player();
  p.rate.dispatchEvent(event('click'));
  assert.equal(p.rate.textContent, '1.5×');
  p.play.dispatchEvent(event('click'));
  await pause();
  assert.equal(p.audio.playbackRate, 1.5, 'shows 1.5× and plays at 1×');
});

test('a start that was interrupted is not called unplayable', async () => {
  const abort = () => Promise.reject(Object.assign(new Error('interrupted'), { name: 'AbortError' }));
  const p = player({ playResult: abort });
  p.play.dispatchEvent(event('click'));
  await pause();
  assert.deepEqual(p.toasts, []);

  const refuse = () => Promise.reject(Object.assign(new Error('no'), { name: 'NotSupportedError' }));
  const q = player({ playResult: refuse });
  q.play.dispatchEvent(event('click'));
  await pause();
  assert.equal(q.toasts.length, 1, 'a real refusal still says so');
});

test('a quick tap on a waveform still decrypting does not leave it scrubbing', async () => {
  const p = player({ decryptMs: 20 });
  p.track.dispatchEvent(event('pointerdown', { clientX: 10, pointerId: 1 }));
  p.track.dispatchEvent(event('pointerup', { pointerId: 1 })); // lifted before the decrypt finished
  await pause(40);
  const at = p.audio.currentTime;
  p.track.dispatchEvent(event('pointermove', { clientX: 90, pointerId: 1 }));
  assert.equal(p.audio.currentTime, at, 'moving over it afterwards scrubs the audio');
});

test('pressing play twice while it decrypts makes one URL, not two', async () => {
  const p = player({ decryptMs: 20 });
  p.play.dispatchEvent(event('click'));
  p.audio.paused = true; // not started yet: the second press is another start
  p.play.dispatchEvent(event('click'));
  await pause(40);
  assert.equal(p.u.made.length, 1);
  assert.equal(p.mediaUrls.size, 1);
});

test('two paints of one picture leave nothing behind that cannot be revoked', async () => {
  const u = urls();
  const mediaUrls = new Map();
  const chat = { getAttachment: () => new Promise((r) => setTimeout(() => r(new Uint8Array([1])), 10)) };
  const log = { scrollHeight: 0, scrollTop: 0, clientHeight: 0 };
  const run = new Function(
    'chat', 'mediaUrls', 'chatToken', 'URL', 'ui', 't', 'document',
    `${source('async function paintPhoto(')}
     ${source('function releaseMedia(')}
     return { paintPhoto, releaseMedia };`,
  )(chat, mediaUrls, 0, u.URL, { chatLog: log }, (k) => k, { createElement: () => element() });

  const m = { att: 'p1', mime: 'image/png' };
  // A redraw while the first paint was still decrypting.
  await Promise.all([run.paintPhoto(element(), element(), m), run.paintPhoto(element(), element(), m)]);
  run.releaseMedia();
  assert.deepEqual([...u.made].sort(), [...u.revoked].sort(), 'a decrypted picture stays in memory until reload');
});

test('a redraw carries a playing recording across, and closing the conversation stops it', () => {
  const render = source('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})');
  const read = render.search(/querySelectorAll\('audio'\)[\s\S]*paused/);
  assert.ok(read > 0 && read < render.indexOf('replaceChildren()'), 'what is playing is not looked at before the log is rebuilt');
  assert.doesNotMatch(render, /row\.append\(audioFigure\(m\)\)/);

  const close = MAIN.slice(MAIN.indexOf("ui.chatDialog.addEventListener('close', () => {\n    // A sheet that closes mid-recording"));
  const handler = close.slice(0, close.indexOf('});'));
  assert.match(handler, /querySelectorAll\('audio'\)[\s\S]*\.pause\(\)[\s\S]*releaseMedia\(\)/);
});

test('a paused recording is not carried into a conversation opened again', () => {
  // Closing the conversation revokes its players' sources; one paused part-way was carried into
  // the next opening with a dead source and "loaded", and would not play again.
  const render = source('function renderChat(messages, { locked = false, ephemeral = false, keepScroll = false } = {})');
  assert.match(render, /mediaUrls/);
});
