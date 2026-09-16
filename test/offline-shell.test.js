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
