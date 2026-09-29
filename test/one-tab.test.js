/**
 * One tab at a time.
 *
 * Every tab of the site in one browser is the same device - one identity, one set of pairings,
 * one conversation store - so two of them running at once showed each other as a stranger with
 * this device's own name, stuck on "connecting…". One tab is live; the newest wins unless the
 * one it would replace is moving a file; a tab that is waiting comes alive when the live one
 * closes, or at once when its person says "use here".
 *
 * Driven against a fake of the Web Locks API with the semantics the spec gives it: exclusive,
 * `ifAvailable` answers null instead of queueing, `steal` takes it from the holder and rejects
 * the holder's request with an AbortError, and a queued request is granted on release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claimTab, LOCK_NAME } from '../web/core/one-tab.js';

function fakeLocks() {
  let holder = null; // { release, reject }
  const queue = [];
  const grant = (entry) => {
    let release;
    const done = new Promise((r) => (release = r));
    holder = { release, reject: entry.reject };
    Promise.resolve(entry.cb({ name: LOCK_NAME }))
      .then(() => done)
      .then(entry.resolve, entry.reject);
    // The callback's promise never settles while held; `release` stands in for the page closing.
    return done;
  };
  const next = () => {
    holder = null;
    const entry = queue.shift();
    if (entry) grant(entry);
  };
  return {
    held: () => !!holder,
    close() {
      // The live page goes away: its lock is released and the queue moves on.
      if (holder) {
        holder.release();
        next();
      }
    },
    request(name, opts, cb) {
      if (typeof opts === 'function') [opts, cb] = [{}, opts];
      return new Promise((resolve, reject) => {
        const entry = { cb, resolve, reject };
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const i = queue.indexOf(entry);
            if (i >= 0) {
              queue.splice(i, 1);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            }
          });
        }
        if (opts.steal) {
          if (holder) {
            const was = holder;
            holder = null;
            was.reject(Object.assign(new Error('stolen'), { name: 'AbortError' }));
          }
          grant(entry);
        } else if (!holder) {
          grant(entry);
        } else if (opts.ifAvailable) {
          Promise.resolve(cb(null)).then(resolve, reject);
        } else {
          queue.push(entry);
        }
      });
    },
  };
}

/** Tabs of one browser: every channel made here hears every other one, never itself. */
function fakeChannels() {
  const all = new Set();
  return (name) => {
    const listeners = new Set();
    const me = {
      name,
      addEventListener: (type, fn) => type === 'message' && listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
      postMessage(data) {
        for (const other of all) {
          if (other === me || other.name !== name) continue;
          queueMicrotask(() => other._hear({ data: structuredClone(data) }));
        }
      },
      close: () => all.delete(me),
      _hear: (e) => listeners.forEach((fn) => fn(e)),
    };
    all.add(me);
    return me;
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('without Web Locks every tab simply runs, as before', async () => {
  // null, not undefined: undefined would pick up the default, and Node has Web Locks of its own.
  const tab = claimTab({ locks: null });
  await tab.live;
});

test('the first tab is live at once', async () => {
  const locks = fakeLocks();
  let waited = false;
  const tab = claimTab({ locks, makeChannel: fakeChannels(), onWaiting: () => (waited = true) });
  await tab.live;
  assert.equal(waited, false);
  assert.ok(locks.held());
});

test('a newer tab takes over from an idle one, and the old one hears it lost', async () => {
  const locks = fakeLocks();
  const channels = fakeChannels();
  let lost = 0;
  const first = claimTab({ locks, makeChannel: channels, onLost: () => lost++ });
  await first.live;

  let waited = false;
  const second = claimTab({ locks, makeChannel: channels, askMs: 30, onWaiting: () => (waited = true) });
  await second.live;
  await tick();
  assert.equal(waited, false, 'nobody is asked anything when the old tab is doing nothing');
  assert.equal(lost, 1, 'the old tab is told, so it can stop');
});

test('a newer tab waits while the live one is moving a file, and takes over when asked', async () => {
  const locks = fakeLocks();
  const channels = fakeChannels();
  let lost = 0;
  const first = claimTab({ locks, makeChannel: channels, isBusy: () => true, onLost: () => lost++ });
  await first.live;

  let waited = 0;
  let live = false;
  const second = claimTab({ locks, makeChannel: channels, askMs: 30, onWaiting: () => waited++ });
  second.live.then(() => (live = true));
  await tick(60);
  assert.equal(waited, 1, 'shown the "open in another tab" screen');
  assert.equal(live, false);
  assert.equal(lost, 0, 'the transfer carries on');

  second.takeOver();
  await second.live;
  await tick();
  assert.equal(lost, 1);
});

test('a waiting tab comes alive by itself when the live one closes', async () => {
  const locks = fakeLocks();
  const channels = fakeChannels();
  const first = claimTab({ locks, makeChannel: channels, isBusy: () => true });
  await first.live;

  let live = false;
  const second = claimTab({ locks, makeChannel: channels, askMs: 30 });
  second.live.then(() => (live = true));
  await tick(60);
  assert.equal(live, false);

  locks.close();
  await tick();
  assert.equal(live, true);
});

test('a tab that lost starts out waiting, and does not take it straight back', async () => {
  const locks = fakeLocks();
  const channels = fakeChannels();
  const live = claimTab({ locks, makeChannel: channels });
  await live.live;

  let waited = 0;
  let lost = 0;
  const asleep = claimTab({ locks, makeChannel: channels, asleep: true, onWaiting: () => waited++ });
  let woke = false;
  asleep.live.then(() => (woke = true));
  await tick(20);
  assert.equal(waited, 1);
  assert.equal(woke, false);
  assert.equal(lost, 0);
  assert.ok(locks.held());
});

test('the tab that is live answers only while it is live', async () => {
  const locks = fakeLocks();
  const channels = fakeChannels();
  const busyAsk = [];
  const first = claimTab({ locks, makeChannel: channels, isBusy: () => (busyAsk.push(1), false) });
  await first.live;
  const second = claimTab({ locks, makeChannel: channels, askMs: 30 });
  await second.live;
  assert.equal(busyAsk.length, 1, 'asked once, by the newcomer');
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

test('nothing reaches the network, or asks for a passphrase, before this tab is the live one', () => {
  const boot = MAIN.slice(MAIN.indexOf('async function boot()'));
  const gate = boot.indexOf('await untilThisTabIsLive()');
  assert.ok(gate > 0, 'boot waits for the tab to be live');
  assert.ok(gate < boot.indexOf('askToUnlock()'), 'before the passphrase');
  assert.ok(gate < boot.indexOf('app.signal.connect()'), 'before the relay socket');
  assert.match(HTML, /id="elsewhere"/);
});

test('a browser that has Web Locks but refuses them still starts', async () => {
  /*
   * Site data blocked, or a sandboxed page: navigator.locks is there and every request is
   * refused. The tab waited for a lock it could never get and the app never started - no
   * dialog, no error. Refused is treated as not there, and the tab runs, as it did before.
   */
  const refusing = {
    request: () => Promise.reject(Object.assign(new Error('Access to the Locks API is denied in this context'), { name: 'SecurityError' })),
  };
  const tab = claimTab({ locks: refusing, makeChannel: fakeChannels(), askMs: 20 });
  const started = await Promise.race([tab.live.then(() => true), tick(300).then(() => false)]);
  assert.equal(started, true, 'the app never started');

  const throwing = { request() { throw new TypeError('not here'); } };
  const again = claimTab({ locks: throwing, makeChannel: fakeChannels(), askMs: 20 });
  assert.equal(await Promise.race([again.live.then(() => true), tick(300).then(() => false)]), true);
});

test('tabs hand over without fighting, whatever the page is doing', () => {
  const live = MAIN.slice(MAIN.indexOf('function untilThisTabIsLive()'), MAIN.indexOf('function bootStep('));
  // A tab given the lock while out of sight - the live one was only reloading - waits to be
  // looked at before it starts, so a reload does not hand the device to a hidden tab.
  assert.match(live, /if \(wasWaiting && document\.hidden\)/);
  // Where session storage cannot be written, the note that a tab lost travels in the address,
  // or two tabs would take it from each other for ever.
  assert.match(live, /searchParams\.set\('asleep', '1'\)/);
  assert.match(live, /searchParams\.has\('asleep'\)/);
  // Being taken over is not leaving the site: no "leave site?" prompt to hold the old tab open.
  assert.match(live, /tabTaken = true;/);
  const unload = MAIN.slice(MAIN.indexOf("addEventListener('beforeunload'"), MAIN.indexOf("addEventListener('beforeunload'") + 300);
  assert.match(unload, /if \(tabTaken\) return;/);
});

test('only the live tab reloads for a new version, and only when nothing would be lost', () => {
  const idle = MAIN.slice(MAIN.indexOf('async function reloadIfIdle()'), MAIN.indexOf('async function reloadIfIdle()') + 1400);
  // A waiting tab reloading comes back as a new tab and takes the device from the one in use.
  assert.match(idle, /if \(!tabLive\) return;/);
  assert.match(idle, /pageHolds\(\)/);
  // What a reload would lose: bytes moving, files picked, words typed, a recording, a code
  // waiting to be typed on the other device, the safety words on screen, any sheet open, or a
  // conversation with a device that is not paired, which lasts only as long as the tab.
  const holds = MAIN.slice(MAIN.indexOf('function pageHolds()'), MAIN.indexOf('function pageHolds()') + 900);
  for (const what of [/transferInFlight\(\)/, /app\.staged/, /chatInput\?\.value/, /recorder/, /app\.hostCode/, /verifying/, /modalStack\.length/, /!c\.peer/]) {
    assert.match(holds, what);
  }
});

test('a second tab does not take the device from one holding something a reload would lose', () => {
  // Only moving bytes counted as busy, so opening the site again reloaded the first tab from
  // under a message being typed, a recording or files picked to send.
  const live = MAIN.slice(MAIN.indexOf('function untilThisTabIsLive()'), MAIN.indexOf('function bootStep('));
  assert.match(live, /isBusy: \(\) => pageHolds\(\)/);
});
