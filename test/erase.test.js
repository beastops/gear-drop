/**
 * "Erase everything" in a browser that never had some of what it erases.
 *
 * Private windows, some WebViews and older browsers have no origin-private file storage or no
 * Cache Storage, and the app runs there on purpose - received files go to memory instead. The
 * erase counted a store that does not exist as a store it failed to clear, so it never reloaded
 * and said "Erased, except: received files, the offline cache" on every try, and from the lock
 * screen's "Start fresh" the person stayed behind the lock sheet.
 *
 * Nothing can be in a store that is not there. Only a real failure counts as one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

test('a store this browser does not have is not a store that failed to clear', async () => {
  globalThis.indexedDB = {
    open() {
      throw new Error('not in this test');
    },
    deleteDatabase() {
      const req = {};
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  globalThis.localStorage = { clear() {} };
  globalThis.sessionStorage = { clear() {} };
  Object.defineProperty(globalThis.navigator, 'serviceWorker', { value: { getRegistrations: async () => [] }, configurable: true });
  Object.defineProperty(globalThis.navigator, 'storage', { value: {}, configurable: true }); // no getDirectory
  delete globalThis.caches;

  const { wipe } = await import('../web/core/store.js');
  assert.deepEqual(await wipe(), { db: true, files: true, web: true, caches: true, worker: true });

  // Present but refused - a private window's "not allowed here" - is the same: nothing is there.
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: { getDirectory: async () => { throw Object.assign(new Error('no'), { name: 'SecurityError' }); } },
    configurable: true,
  });
  globalThis.caches = { keys: async () => { throw Object.assign(new Error('no'), { name: 'SecurityError' }); } };
  const again = await wipe();
  assert.equal(again.files, true);
  assert.equal(again.caches, true);
});

test('a store that failed, rather than one that is not there, is still reported', async () => {
  // A private window refusing it is nothing to clear; a store that exists and threw for some
  // other reason may still hold received files, in the clear, and must not be called erased.
  Object.defineProperty(globalThis.navigator, 'storage', {
    value: { getDirectory: async () => { throw Object.assign(new Error('busy'), { name: 'UnknownError' }); } },
    configurable: true,
  });
  const { wipe } = await import('../web/core/store.js');
  assert.equal((await wipe()).files, false);
});
