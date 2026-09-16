/**
 * A notice has to be readable over whatever is open.
 *
 * A `<dialog>` opened with `showModal()` is promoted to the top layer, and the top layer is
 * above every z-index there is. The notices sat on the page at `z-index: 70`, so anything raised
 * while a sheet was open was drawn behind that sheet's scrim and arrived as a grey ghost.
 *
 * Which was not an edge case. `Copy link` is a button *inside* the Add-a-device sheet, so its
 * confirmation had never once been shown at full contrast — nor had a file arriving while
 * Settings was open, or a transfer finishing over the paired list.
 *
 * The fix is three things that only work together: the host is a popover, the UA's idea of what
 * a popover looks like is undone, and every notice re-promotes the host. Remove any one and the
 * notices are either invisible, in a grey box in the middle of the window, or back underneath
 * the sheet from the second one onwards. So all three are checked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const html = read('web', 'index.html');
const css = read('web', 'app.css');
const main = read('web', 'main.js');

/** The `.toast-host` rule body, brace-matched rather than guessed at. */
function hostRule() {
  const at = css.indexOf('\n.toast-host {');
  assert.ok(at > 0, 'the toast host rule has moved');
  const open = css.indexOf('{', at);
  return css.slice(open + 1, css.indexOf('}', open));
}

test('the notices live in the top layer, where the sheets are', () => {
  const tag = /<div[^>]*id="toast-host"[^>]*>/.exec(html)?.[0];
  assert.ok(tag, 'the toast host is gone from the markup');
  assert.match(tag, /popover="manual"/, 'without this a notice over an open sheet is behind its scrim');
});

test('and not wearing what the browser dresses a popover in', () => {
  // `margin: auto` and `inset: 0` are the UA default: they would centre the notices in the
  // middle of the window, inside a bordered grey box, which is worse than the bug.
  const rule = hostRule();
  for (const [prop, wrong] of [
    ['margin', 'centred in the middle of the window'],
    ['border', 'drawn with a border round it'],
    ['padding', 'padded away from its own edges'],
    ['background', 'sitting on a grey box'],
    ['inset', 'stretched to the whole window'],
  ]) {
    assert.match(rule, new RegExp(`\\b${prop}\\s*:`), `the host would be ${wrong}`);
  }
  assert.match(rule, /position:\s*fixed/, 'the host has to place itself');
});

test('every notice lifts the host above whatever opened since', () => {
  assert.match(main, /ui\.toastHost\.append\(el\);\s*\n\s*liftToasts\(\);/, 'a notice is added without lifting');

  const fn = /function liftToasts\(\)\s*\{[\s\S]*?\n\}/.exec(main)?.[0];
  assert.ok(fn, 'liftToasts is gone');
  /*
   * Hidden first, then shown. The top layer is ordered by when each thing was promoted, and
   * showing a popover that is already showing does nothing at all - so a version that only
   * called `showPopover()` would work for the first notice of a session and for none after it,
   * which is the kind of thing that looks fine when you test it once.
   */
  const hide = fn.indexOf('hidePopover');
  const show = fn.indexOf('showPopover(');
  assert.ok(hide > 0, 'nothing re-promotes the host');
  assert.ok(show > hide, 'showing without hiding first does not move it back to the front');
  assert.match(fn, /if \(!host\?\.showPopover\) return;/, 'a browser without popover support should lose nothing');
});

test('four safety words do not strand the fourth on its own line', () => {
  // At 375px they wrapped after the third, right-aligned, at the one moment the sheet is asking
  // for a careful comparison against another screen.
  const at = css.indexOf('.meta-grid > :nth-child(even)');
  assert.ok(at > 0, 'the meta grid value rule has moved');
  const rule = css.slice(css.indexOf('{', at), css.indexOf('}', at));
  assert.match(rule, /text-wrap:\s*balance/, 'the words break wherever they land');
});
