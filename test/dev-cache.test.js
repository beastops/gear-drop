/**
 * The signal that stops a dev server serving a cached copy of itself.
 *
 * The page declines to register the service worker when it can see it is talking to a dev
 * server, which turns a change into one reload instead of two and removes a whole class of
 * false bug report: the worker answering from its cache, so the page under a change is the
 * build before it while reporting the new version.
 *
 * All of that hangs on one header, and the header is invisible until it is missing, so it is
 * pinned here against a real server on both settings. Against a real one because the point is
 * what a browser receives, and `conf.dev` is a fact about how the process was started.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Start a server on its own port and wait until it answers. */
async function serve(port, args) {
  const proc = spawn(process.execPath, [path.join(root, 'server/index.js'), ...args], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) return proc;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error(`server on ${port} never answered`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

test('a dev server says so, and an ordinary one says nothing', async (t) => {
  const devPort = 3991;
  const livePort = 3992;
  const dev = await serve(devPort, ['--dev']);
  const live = await serve(livePort, []);
  t.after(() => {
    dev.kill();
    live.kill();
  });

  const devHead = await fetch(`http://127.0.0.1:${devPort}/healthz`);
  assert.equal(devHead.headers.get('x-gear-drop-dev'), '1', 'the dev server must mark itself');

  const liveHead = await fetch(`http://127.0.0.1:${livePort}/healthz`);
  assert.equal(
    liveHead.headers.get('x-gear-drop-dev'),
    null,
    'a real deployment must never claim to be a dev server, or it would ship without a worker',
  );

  // The body is a bare `ok` and something outside this repo may be matching on it.
  assert.equal((await devHead.text()).trim(), 'ok');
  assert.equal((await liveHead.text()).trim(), 'ok');
});

test('the page only asks local origins, and can be told to register anyway', () => {
  /*
   * Read out of the source rather than run, because the decision happens at page load
   * against `location` and `navigator.serviceWorker`. What matters is that the public case
   * is answered before any request is made, and that the override exists.
   */
  const src = fs.readFileSync(path.join(root, 'web/main.js'), 'utf8');

  assert.match(src, /if \(!localOrigin\(\)\) return false;/, 'a public origin must not be probed');
  assert.match(src, /has\('sw'\)/, '?sw=1 must still force the worker on');
  assert.match(src, /X-Gear-Drop-Dev/, 'the header is what the decision rests on');
});
