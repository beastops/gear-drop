/**
 * Sharing into the app from the system share sheet.
 *
 * The worker takes the shared files and answers with a redirect to the app, and the page that
 * redirect loads asks for them. It used to hand them instead to whichever window was already
 * open, and forget them: that window is the one the redirect replaces - or, with one tab
 * running at a time, the one the new page takes over from, which reloads - so the files went
 * with it, and the page that was left had nothing to ask for.
 *
 * Run against the real worker in a sandbox.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'sw.js'), 'utf8');
const ORIGIN = 'https://gear-drop.test';

function worker({ open = [] } = {}) {
  const listeners = {};
  const self = {
    addEventListener: (type, fn) => (listeners[type] = fn),
    registration: { scope: `${ORIGIN}/` },
    location: { origin: ORIGIN },
    clients: { matchAll: async () => open, claim: async () => {} },
    skipWaiting: async () => {},
  };
  class Res extends Response {
    static redirect(url, status) {
      return Response.redirect(new URL(url, `${ORIGIN}/sw.js`), status);
    }
  }
  vm.runInContext(SRC, vm.createContext({ self, URL, Response: Res, Request, Set, Map, Promise, caches: {}, fetch: async () => new Response('') }));
  return listeners;
}

async function share(listeners, name = 'a.txt') {
  const form = new FormData();
  form.append('files', new File(['hello'], name, { type: 'text/plain' }));
  let answer;
  listeners.fetch({
    request: new Request(`${ORIGIN}/share-target`, { method: 'POST', body: form }),
    respondWith: (p) => (answer = p),
  });
  return answer;
}

test('a share reaches the page the share opens, even with the app already open', async () => {
  const old = [];
  const listeners = worker({ open: [{ id: 'old', postMessage: (m) => old.push(m), focus: async () => {} }] });
  const res = await share(listeners);
  assert.equal(res.status, 303);

  const fresh = [];
  listeners.message({ data: { t: 'want-shared' }, source: { postMessage: (m) => fresh.push(m) } });
  assert.equal(fresh.length, 1, 'the page the share opened got nothing');
  assert.equal(fresh[0].files.length, 1);
  assert.equal(old.length, 0, 'handed to the window about to be replaced');
});

test('and with nothing open, as before', async () => {
  const listeners = worker();
  await share(listeners);
  const got = [];
  listeners.message({ data: { t: 'want-shared' }, source: { postMessage: (m) => got.push(m) } });
  assert.equal(got.length, 1);
  // Once: asking again gets nothing.
  listeners.message({ data: { t: 'want-shared' }, source: { postMessage: (m) => got.push(m) } });
  assert.equal(got.length, 1);
});
