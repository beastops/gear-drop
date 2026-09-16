/**
 * What the app decides this browser can do.
 *
 * Two of these are user-agent tests, which are a liability and have to justify themselves.
 * They exist because the APIs in question are *present* on iOS and do not work:
 * `<input webkitdirectory>` accepts the attribute and never returns a directory, and an
 * `<a download>` pointing at a blob opens the file instead of saving it. Neither can be
 * feature-detected, and getting either wrong leaves a control that silently does nothing.
 *
 * A fresh module instance per case, because the real one caches its answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let seq = 0;

/** Load platform.js against a stubbed browser. */
async function withBrowser({ ua = '', touchPoints = 0, has = {} } = {}) {
  // `navigator` is a getter-only global in Node, so it has to be redefined rather than
  // assigned, and put back the same way.
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previous = {
    window: globalThis.window,
    RTCPeerConnection: globalThis.RTCPeerConnection,
    OffscreenCanvas: globalThis.OffscreenCanvas,
    HTMLInputElement: globalThis.HTMLInputElement,
    matchMedia: globalThis.matchMedia,
  };
  const setNavigator = (value) =>
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

  const win = {
    showSaveFilePicker: has.filePicker ? () => {} : undefined,
    onbeforeinstallprompt: has.installPrompt ? null : undefined,
    Notification: has.notifications ? function () {} : undefined,
    ontouchstart: has.touch ? null : undefined,
  };
  if (!has.notifications) delete win.Notification;
  if (!has.touch) delete win.ontouchstart;
  if (!has.filePicker) delete win.showSaveFilePicker;
  if (!has.installPrompt) delete win.onbeforeinstallprompt;

  globalThis.window = win;
  setNavigator({
    userAgent: ua,
    maxTouchPoints: touchPoints,
    storage: has.opfs ? { getDirectory: () => {} } : {},
    canShare: has.shareFiles ? () => true : undefined,
    wakeLock: has.wakeLock ? {} : undefined,
    share: has.shareFiles ? async () => {} : undefined,
  });
  globalThis.RTCPeerConnection = has.webrtc ? function () {} : undefined;
  globalThis.OffscreenCanvas = has.offscreenCanvas ? function () {} : undefined;
  globalThis.HTMLInputElement = { prototype: has.directoryAttr ? { webkitdirectory: false } : {} };
  globalThis.matchMedia = () => ({ matches: !!has.hover });

  const mod = await import(`../web/core/platform.js?case=${seq++}`);
  const result = mod.platform();
  Object.assign(globalThis, previous);
  if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
  return { result, mod };
}

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPADOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const MAC_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';

const FULL = {
  webrtc: true,
  opfs: true,
  directoryAttr: true,
  shareFiles: true,
  wakeLock: true,
  notifications: true,
  offscreenCanvas: true,
};

test('an iPhone is not offered folder sending, because Safari accepts it and does nothing', async () => {
  const { result } = await withBrowser({ ua: IPHONE, touchPoints: 5, has: { ...FULL, touch: true } });
  assert.equal(result.apple, true);
  assert.equal(result.folders, false, 'the control must be absent, not present and inert');
  assert.equal(result.autoSave, false, 'a synthetic download click opens the blob instead of saving');
  assert.equal(result.shareFiles, true, 'so the share sheet is how a file gets saved there');
  assert.equal(result.webrtc, true, 'everything that actually matters still works');
});

test('an iPad reporting itself as a Mac is still an iPad', async () => {
  // iPadOS 13+ sends a desktop Mac user agent. A Mac with a touchscreen does not exist,
  // so touch points are what separate them.
  const { result } = await withBrowser({ ua: IPADOS, touchPoints: 5, has: { ...FULL, touch: true } });
  assert.equal(result.apple, true);
  assert.equal(result.folders, false);
  assert.equal(result.autoSave, false);
});

test('a desktop Mac is not treated as an iPad', async () => {
  const { result } = await withBrowser({
    ua: MAC_DESKTOP,
    touchPoints: 0,
    has: { ...FULL, filePicker: true, hover: true },
  });
  assert.equal(result.apple, false, 'no touch points, so it is a real desktop');
  assert.equal(result.folders, true);
  assert.equal(result.autoSave, true);
});

test('Android Chrome gets everything', async () => {
  const { result } = await withBrowser({
    ua: ANDROID,
    touchPoints: 5,
    has: { ...FULL, installPrompt: true, touch: true },
  });
  assert.equal(result.apple, false);
  assert.equal(result.folders, true, 'Chrome on Android does return a directory');
  assert.equal(result.autoSave, true);
  assert.equal(result.installPrompt, true);
});

test('a browser with no WebRTC is detected rather than left to fail', async () => {
  const { result } = await withBrowser({ ua: ANDROID, has: { ...FULL, webrtc: false } });
  assert.equal(result.webrtc, false, 'the app has to say so; there is nothing it can do without it');
});

test('a browser with no OPFS and no picker still reports the rest honestly', async () => {
  const { result } = await withBrowser({
    ua: ANDROID,
    has: { webrtc: true, directoryAttr: true, hover: true },
  });
  assert.equal(result.opfs, false);
  assert.equal(result.filePicker, false);
  assert.equal(result.webrtc, true, 'so it falls back to memory, not to nothing');
  assert.equal(result.wakeLock, false);
  assert.equal(result.notifications, false);
});

test('capabilities are computed once and stay stable', async () => {
  const { mod } = await withBrowser({ ua: ANDROID, has: FULL });
  assert.strictEqual(mod.platform(), mod.platform(), 'the same object, not a fresh probe each call');
});
