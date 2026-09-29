/**
 * Recording a voice message never leaves the microphone on.
 *
 * Asking for the microphone takes a moment - a permission prompt, a headset waking - and nothing
 * on screen changes meanwhile. A second tap in that moment opened a second stream that nothing
 * held any more, so the microphone stayed on until the tab was closed. Closing the conversation
 * in that moment cancelled nothing, so the recording started behind a closed sheet, and its
 * five-minute cap later sent it anyway.
 *
 * Run against the real functions from main.js, with a microphone and a recorder faked the way
 * the browser behaves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const BLOCK = MAIN.slice(MAIN.indexOf('const MAX_RECORDING_MS'), MAIN.indexOf('/** Hand one attachment back'));

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function rig({ micDelay = 20, peer = 'p1' } = {}) {
  const tracks = [];
  const recorders = [];
  const sent = [];
  const toasts = [];
  const el = () => ({
    hidden: true,
    textContent: '',
    classList: { toggle() {} },
    setAttribute() {},
    querySelector: () => null,
  });
  const ui = { chatDialog: { open: true }, chatRec: el(), chatComposer: el(), chatMic: el(), chatRecTime: el() };

  class FakeRecorder {
    constructor(stream) {
      this.stream = stream;
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
      this.listeners = {};
      recorders.push(this);
    }
    static isTypeSupported() {
      return true;
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      setTimeout(() => {
        for (const fn of this.listeners.dataavailable || []) fn({ data: new Blob(['x']) });
        for (const fn of this.listeners.stop || []) fn();
      }, 1);
    }
  }

  const navigator = {
    mediaDevices: {
      getUserMedia: () =>
        micDelay === null ? new Promise(() => {}) : new Promise((resolve) =>
          setTimeout(() => {
            const track = { live: true, stop() { this.live = false; } };
            tracks.push(track);
            resolve({ getTracks: () => [track] });
          }, micDelay),
        ),
    },
  };

  const api = new Function(
    'navigator', 'window', 'MediaRecorder', 'ui', 'toast', 't', 'fmtClock', 'sendChatMedia', 'chatPeerId',
    `${BLOCK}
     return {
       startRecording, stopRecording, cancelRecording,
       get recorder() { return recorder; },
       // The mic button's own logic.
       tap() { if (recorder) stopRecording(); else startRecording(); },
     };`,
  )(
    navigator,
    { MediaRecorder: FakeRecorder },
    FakeRecorder,
    ui,
    (...a) => toasts.push(a),
    (k) => k,
    (s) => String(s),
    async (...a) => sent.push(a),
    peer,
  );
  return { api, ui, tracks, recorders, sent, toasts };
}

test('two quick taps on the mic open it once, and stopping turns it off', async () => {
  const { api, tracks, recorders } = rig();
  api.tap();
  api.tap(); // nothing happened yet on screen, so the finger tries again
  await pause(50);
  assert.equal(tracks.length, 1, 'a second microphone stream was opened');
  assert.equal(recorders.length, 1);

  api.tap();
  await pause(20);
  assert.ok(tracks.every((tr) => !tr.live), 'the microphone is still on');
  assert.equal(api.recorder, null);
});

test('cancelling while the microphone is being asked for leaves it off', async () => {
  const { api, tracks, recorders } = rig();
  api.startRecording();
  api.cancelRecording(); // the conversation closed, or the device went away
  await pause(50);
  assert.equal(recorders.filter((r) => r.state === 'recording').length, 0, 'recording started after the cancel');
  assert.ok(tracks.every((tr) => !tr.live), 'the microphone is still on');
  assert.equal(api.recorder, null);
});

test('a conversation closed while the microphone is being asked for does not start recording', async () => {
  const { api, ui, tracks, recorders } = rig();
  api.startRecording();
  ui.chatDialog.open = false;
  await pause(50);
  assert.equal(recorders.length, 0);
  assert.ok(tracks.every((tr) => !tr.live));
  assert.equal(api.recorder, null);
});

test('a finished recording goes to the conversation it was recorded in', async () => {
  const { api, sent } = rig({ micDelay: 1 });
  api.startRecording();
  await pause(450); // long enough to count as a recording
  api.stopRecording();
  await pause(20);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'p1');
});

test('a recording follows its conversation when the device is paired mid-way', () => {
  // Pairing re-files the conversation under a new id. The recording kept the old one and, on
  // stop, was sent to a connection that no longer answered to it - dropped without a word.
  const at = MAIN.indexOf('async function rememberPair(conn)');
  const pair = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.match(pair, /if \(recorder\?\.peer === oldId\) recorder\.peer = id;/);
});

test('a microphone request left unanswered does not block recording until a reload', () => {
  // A permission prompt dismissed into the address bar never settles. The slot it held made
  // every later tap on the mic do nothing, even in a conversation opened again.
  const { api, tracks } = rig({ micDelay: null }); // a request that never answers
  api.startRecording();
  api.cancelRecording(); // the conversation closed
  assert.equal(api.recorder, null, 'the slot stays taken');
  void tracks;
});
