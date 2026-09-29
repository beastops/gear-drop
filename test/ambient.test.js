/**
 * What the app does around the page: the screen staying awake, the tab's icon, notifications.
 *
 * Three things found by reading them against how browsers behave:
 *
 *   - coming back to the tab took a screen wake lock whether or not anything was moving, and
 *     nothing let it go until the tab was hidden again, although the setting says "during
 *     transfers"; a lock asked for just as a transfer ended was kept too;
 *   - changing the theme during a transfer made the progress ring the tab's resting icon;
 *   - notifications never appeared on Android Chrome, which has no `new Notification()` and
 *     shows them only through the service worker.
 *
 * Run against the functions as main.js has them.
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

/** The wake lock, the tab title and icon, and the listener for coming back to the tab. */
function ambient() {
  const requested = [];
  const app = { prefs: { awake: true }, conns: new Map() };
  const document = { hidden: false, title: '', body: {} };
  const listeners = {};
  const navigator = {
    wakeLock: {
      request: () =>
        new Promise((resolve) =>
          setTimeout(() => {
            const lock = new EventTarget();
            lock.released = false;
            lock.release = async () => {
              lock.released = true;
              lock.dispatchEvent(new Event('release'));
            };
            requested.push(lock);
            resolve(lock);
          }, 5),
        ),
    },
  };
  const favicon = { href: 'icon.svg', getAttribute: () => favicon.href, setAttribute: (_, v) => (favicon.href = v) };
  // The page's own listener in bindUi, not the one boot uses to listen again.
  const visibility = MAIN.slice(MAIN.indexOf("\n  addEventListener('visibilitychange', () => {\n    if (document.hidden) return;") + 1);
  const onVisible = visibility.slice(visibility.indexOf('() => {'), visibility.indexOf('\n  });') + 4);
  const api = new Function(
    'app', 'document', 'navigator', 'ui', 'addEventListener',
    `let announced = null;
     let baseFavicon = null;
     ${MAIN.slice(MAIN.indexOf('let wakeLock = null;'), MAIN.indexOf('function releaseWake()'))}
     ${source('function releaseWake()')}
     ${source('function updateAmbient()')}
     function paintFavicon(p) { if (p === null) return; ui.favicon.setAttribute('href', 'data:ring'); }
     addEventListener('visibilitychange', ${onVisible});
     return { acquireWake, updateAmbient };`,
  )(app, document, navigator, { favicon }, (type, fn) => (listeners[type] = fn));
  return { api, app, requested, visible: () => listeners.visibilitychange() };
}

test('coming back to the tab keeps the screen awake only while something is moving', async () => {
  const idle = ambient();
  idle.visible();
  await pause(20);
  assert.equal(idle.requested.filter((l) => !l.released).length, 0, 'an idle page holds the screen on');

  const busy = ambient();
  busy.app.conns.set('a', { progress: { done: 1, total: 2 } });
  busy.visible();
  await pause(20);
  assert.equal(busy.requested.filter((l) => !l.released).length, 1, 'a transfer no longer keeps the screen on');
});

test('a lock that arrives after the transfer ended is let go', async () => {
  const { api, app, requested } = ambient();
  app.conns.set('a', { progress: { done: 1, total: 2 } });
  api.updateAmbient(); // asks
  app.conns.clear(); // and it finishes before the answer
  api.updateAmbient();
  await pause(20);
  assert.ok(requested.length <= 1);
  assert.ok(requested.every((l) => l.released), 'held after the transfer ended');
});

test('changing the theme mid-transfer does not make the ring the resting icon', () => {
  assert.doesNotMatch(source('function applyTheme()'), /baseFavicon = null/);
  // And the resting icon is never a picture of progress, whatever order things happen in.
  assert.match(source('function paintFavicon(p)'), /startsWith\('data:'\)/);
});

test('a notification is shown through the service worker where the page cannot show one', async () => {
  const shown = [];
  class Refusing {
    static permission = 'granted';
    constructor() {
      throw new TypeError('Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.');
    }
  }
  const navigator = {
    serviceWorker: { ready: Promise.resolve({ showNotification: async (title, opts) => shown.push({ title, opts }) }) },
  };
  const notify = new Function(
    'app', 'document', 'Notification', 'navigator',
    `let announced = null; ${source('function notify(title, body)')}; return notify;`,
  )({ prefs: { notify: true } }, { hidden: true, title: '' }, Refusing, navigator);
  notify('Phone', 'Sent you a message');
  await pause();
  assert.equal(shown.length, 1, 'Android Chrome shows nothing');
  assert.equal(shown[0].title, 'Phone');
});

test('tapping one brings the app back', () => {
  const SW = fs.readFileSync(path.join(ROOT, 'web', 'sw.js'), 'utf8');
  assert.match(SW, /addEventListener\('notificationclick'[\s\S]*\.focus\(\)[\s\S]*openWindow\(/);
});
