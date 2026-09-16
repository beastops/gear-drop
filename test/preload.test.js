/**
 * The preload hints have to match the real import graph.
 *
 * This app ships unbundled, so the browser cannot know a module exists until it has fetched
 * and parsed whichever module imports it. The chain here is four deep - the crypto sits behind
 * gdcrypto, which sits behind main - so the loader spent five round trips discovering files it
 * could have started fetching immediately. Measured against a local server, where a round trip
 * costs half a millisecond, the requests still arrived in five distinct waves; on a phone at
 * sixty milliseconds that shape is a third of a second of waiting for nothing.
 *
 * `<link rel="modulepreload">` fixes it, and like every hand-kept list of a thing the code
 * already knows, it rots. Two of them in this repo already had: the offline shell twice. So it
 * is generated from the graph and checked here in both directions - nothing missing, and
 * nothing hinted that is not really imported, because an unused hint is bandwidth spent on a
 * file nobody asked for.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const ENTRY = 'main.js';

/** Every statically imported module below the entry point, web-root-relative. */
function staticGraph() {
  const found = new Set();
  const queue = [ENTRY];
  const visited = new Set([ENTRY]);

  while (queue.length) {
    const rel = queue.shift();
    let src;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:^|[^\w])(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (visited.has(dep)) continue;
      visited.add(dep);
      found.add(dep);
      queue.push(dep);
    }
  }
  return found;
}

function hinted() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return new Set(
    [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]),
  );
}

test('every statically imported module is preloaded', () => {
  const missing = [...staticGraph()].filter((f) => !hinted().has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    `imported but not hinted, so the browser finds them a round trip late:\n  ${missing.join('\n  ')}`,
  );
});

test('nothing is preloaded that the app does not import', () => {
  const graph = staticGraph();
  const stray = [...hinted()].filter((f) => !graph.has(f)).sort();
  assert.deepEqual(stray, [], `hinted but never imported:\n  ${stray.join('\n  ')}`);
});

test('every preloaded file exists', () => {
  const absent = [...hinted()].filter((f) => !fs.existsSync(path.join(ROOT, f))).sort();
  assert.deepEqual(absent, [], `hinted but missing from web/:\n  ${absent.join('\n  ')}`);
});

test('the stylesheet is requested before the preloads', () => {
  /*
   * Ordering, because a hint is not free on a connection-limited link.
   *
   * HTTP/1.1 allows six connections to a host. Thirty-six preloads announced ahead of the
   * stylesheet would put a render-blocking resource behind them in the queue and delay the
   * first paint to buy a faster boot - the wrong trade, and an easy one to make by accident
   * by inserting the block a few lines higher.
   */
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const css = html.indexOf('rel="stylesheet"');
  const firstHint = html.indexOf('rel="modulepreload"');
  assert.ok(css > -1 && firstHint > -1, 'expected both a stylesheet and preload hints');
  assert.ok(css < firstHint, 'the stylesheet must be linked before the modulepreload block');
});
