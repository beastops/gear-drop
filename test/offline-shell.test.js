/**
 * The offline shell has to list everything the app actually imports.
 *
 * The service worker precaches a hand-written list. A hand-written list of a thing the
 * compiler already knows is a list that drifts, and this one had drifted twice: once when the
 * crypto was vendored into `web/vendor`, and once when the conversation module was added.
 * Both times the app still worked, because the fetch handler is stale-while-revalidate and
 * quietly fetched the missing module on first use - which hides the gap everywhere except the
 * one case the precache exists for, an install that goes offline before that first load. There
 * the cached page stopped at the first import of ristretto255 and could not key a session.
 *
 * So the list is checked against the real import graph rather than against anybody's memory.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

/** Every relative module reachable from an entry point, as web-root-relative paths. */
function importGraph(entry) {
  const seen = new Set();

  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);

    let src;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      return; // a path that does not resolve is the resolver's problem, not this test's
    }

    const follow = (spec) => {
      if (!spec.startsWith('.')) return; // bare specifiers never reach the browser
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    };

    for (const m of src.matchAll(/(?:^|[^\w])(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      follow(m[1]);
    }
    for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]/g)) follow(m[1]);
  };

  visit(entry);
  return seen;
}

/** The literal paths the worker precaches. */
function shellList() {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const block = /const SHELL = \[([\s\S]*?)\n\];/.exec(sw);
  assert.ok(block, 'sw.js no longer declares a SHELL array the way this test reads it');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every module the app imports is in the offline shell', () => {
  const shell = new Set(shellList());
  const missing = [...importGraph('main.js')].filter((f) => !shell.has(f));
  assert.deepEqual(
    missing,
    [],
    `these are imported but would not be cached for an offline start:\n  ${missing.join('\n  ')}`,
  );
});

/*
 * A language is a file fetched at runtime, so the import graph above never sees one. Missing
 * from the shell, a translation works until the network goes, and then the app falls back to
 * English - which is the designed behaviour for a missing file, so nothing would look wrong.
 * `scripts/build-lang.mjs` writes these entries; this is what notices when it was not run.
 */
test('every language, and the list of them, is in the offline shell', () => {
  const shell = new Set(shellList());
  const files = fs.readdirSync(path.join(ROOT, 'lang')).filter((f) => f.endsWith('.json'));
  const missing = files.map((f) => `lang/${f}`).filter((f) => !shell.has(f));
  assert.deepEqual(missing, [], `run scripts/build-lang.mjs; not cached for offline use:\n  ${missing.join('\n  ')}`);

  // And the picker offers exactly the languages that have a file behind them.
  const listed = JSON.parse(fs.readFileSync(path.join(ROOT, 'lang', 'index.json'), 'utf8')).map((l) => l.code);
  const onDisk = files.filter((f) => f !== 'index.json').map((f) => f.replace(/\.json$/, ''));
  assert.deepEqual([...listed].sort(), [...onDisk].sort(), 'run scripts/build-lang.mjs; index.json is out of date');
});

test('the offline shell lists nothing that is not there', () => {
  const absent = shellList()
    // './' is the app root, served as index.html; it has no file of its own.
    .filter((f) => f !== './')
    .filter((f) => !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(absent, [], `listed for precaching but missing from web/:\n  ${absent.join('\n  ')}`);
});

test('a failed precache entry cannot fail the whole install', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  // One unreachable URL must not leave the app with no shell at all, so each add is caught
  // individually rather than the whole set being handed to addAll. Matched loosely on
  // purpose: the property is that every entry has its own catch, not that the line is spelt
  // one particular way, and the exact spelling was what this asserted before.
  assert.match(sw, /SHELL\.map\(\(u\) =>[\s\S]{0,120}?\.catch\(/);
  assert.doesNotMatch(sw, /addAll\(/);
});

/*
 * The precache has to go to the network.
 *
 * `cache.add()` fetches like any other request, so it is answered by the browser's own HTTP
 * cache. With assets once served as immutable for a year at URLs that never change, a new
 * worker version could fill a brand-new cache with the previous release and then report the
 * new version number while running the old code. The headers no longer say that - there is a
 * test for it beside the other server headers - and this makes the worker not depend on them.
 */
test('precaching goes past the browser cache to the network', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /c\.add\(new Request\(u, \{ cache: 'reload' \}\)\)/);
});

// Read here: the other copy of this is scoped to the test that reads it.
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

/*
 * A load that needs nothing says nothing.
 *
 * The worker used to answer from the cache and fetch every file again anyway — forty-four
 * requests to the host each time the app was opened, with the whole shell already on disk,
 * which nobody waited on and which recorded, forty-four times, the address that opened a
 * private file-transfer app and the minute it happened.
 *
 * The risk is not that somebody deletes this. It is that somebody restores the revalidation,
 * because stale-while-revalidate is what every guide recommends: strictly better for freshness,
 * strictly worse for the one property this app is for. Updates do not come from it — the shell
 * is precached whole on install and `VERSION` changes every release.
 */
test('a cached file is served without asking the host for it again', () => {
  const handler = /addEventListener\('fetch'[\s\S]*?\n\}\);/.exec(swSrc)?.[0];
  assert.ok(handler, 'the fetch handler is gone');

  // The early return is the whole guarantee: a hit ends the handler before any fetch exists.
  assert.match(handler, /if \(hit\) return hit;/, 'a cache hit no longer ends the request');

  const hitAt = handler.indexOf('if (hit) return hit;');
  const fetchAt = handler.indexOf('fetch(e.request)');
  assert.ok(fetchAt > hitAt, 'there is a fetch that can run even when the cache answered');
});

test('an open app takes a new version the next time it is out of sight, and says which it runs', () => {
  /*
   * The worker takes a new build at once, but the page on screen is still the old one, and a
   * phone that is resumed rather than relaunched kept showing it - a title removed in one release
   * was still there after it. Meanwhile About read the version off the server and reported the
   * new one, so it could never say that this copy was the old one.
   */
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const version = /const VERSION = '([^']+)'/.exec(sw)[1];
  assert.equal(/const BUILD = '([^']+)'/.exec(main)?.[1], version, 'the page and the worker disagree on the version');
  assert.match(main, /addEventListener\('controllerchange'/);
  const idle = main.slice(main.indexOf('function reloadIfIdle()'), main.indexOf('function reloadIfIdle()') + 900);
  assert.match(idle, /document\.hidden/);
  assert.match(idle, /transferInFlight\(\)/);
  assert.match(idle, /location\.reload\(\)/);
  // A resumed app looks for one too, rather than waiting to be relaunched.
  assert.match(main, /getRegistration\(\)[\s\S]{0,40}\.update\(\)/);
  const about = main.slice(main.indexOf('async function showBuild()'), main.indexOf('function watchModals()'));
  assert.match(about, /BUILD/);
});
