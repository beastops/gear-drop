/**
 * A picture in the conversation, full screen, the way a phone shows one.
 *
 * Tap it to open. Pinch or double-tap to zoom, drag to look around, drag down to put it away.
 * The geometry is kept apart from the gestures so it can be pinned here: the point under the
 * fingers stays under the fingers while zooming, and a zoomed picture can be dragged to its
 * edges but not past them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zoomAbout, clampPan, dismissProgress, MAX_ZOOM } from '../web/ui/viewer.js';

// A 400 x 300 picture shown in an 800 x 600 box: fitted, it fills the box exactly.
const BOX = { w: 800, h: 600, iw: 800, ih: 600 };

test('the point under the fingers stays under the fingers while zooming', () => {
  const start = { scale: 1, x: 0, y: 0 };
  // Pinch outward around a point right of centre.
  const cx = 600;
  const cy = 200;
  const next = zoomAbout(start, 2, cx, cy, BOX);
  // Where the content point that was under (cx, cy) is drawn now.
  const u = (cx - BOX.w / 2 - start.x) / start.scale;
  const v = (cy - BOX.h / 2 - start.y) / start.scale;
  assert.ok(Math.abs(BOX.w / 2 + next.x + u * next.scale - cx) < 1e-6);
  assert.ok(Math.abs(BOX.h / 2 + next.y + v * next.scale - cy) < 1e-6);
  assert.equal(next.scale, 2);
});

test('zoom stops at the ends of its range', () => {
  const big = zoomAbout({ scale: 4, x: 0, y: 0 }, 10, 400, 300, BOX);
  assert.equal(big.scale, MAX_ZOOM);
  const small = zoomAbout({ scale: 1.2, x: 50, y: 0 }, 0.1, 400, 300, BOX);
  assert.equal(small.scale, 1);
  assert.deepEqual([small.x, small.y], [0, 0], 'back at fit size, it is not left off centre');
});

test('a zoomed picture can be dragged to its edge and no further', () => {
  // At 2x the 800-wide picture is 1600 wide: 400 px can hide off each side.
  const far = clampPan({ scale: 2, x: 5000, y: -5000 }, BOX);
  assert.deepEqual(far, { scale: 2, x: 400, y: -300 });
  // At fit size nothing moves at all.
  assert.deepEqual(clampPan({ scale: 1, x: 30, y: 30 }, BOX), { scale: 1, x: 0, y: 0 });
  // A picture narrower than the box stays centred across, and pans only along its long side.
  const tall = { w: 800, h: 600, iw: 300, ih: 600 };
  assert.deepEqual(clampPan({ scale: 2, x: 300, y: 900 }, tall), { scale: 2, x: 0, y: 300 });
});

test('dragging down puts it away far enough, or fast enough, and not otherwise', () => {
  assert.equal(dismissProgress(0, 0, 600).dismiss, false);
  assert.equal(dismissProgress(60, 0.1, 600).dismiss, false);
  assert.equal(dismissProgress(160, 0.1, 600).dismiss, true, 'a long drag');
  assert.equal(dismissProgress(40, 1.2, 600).dismiss, true, 'a flick');
  assert.equal(dismissProgress(-200, -2, 600).dismiss, false, 'up is not down');
  // The backdrop fades with the drag, and never below half.
  assert.ok(dismissProgress(300, 0, 600).fade >= 0.5);
  assert.ok(dismissProgress(100, 0, 600).fade < 1);
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

test('a picture in the conversation opens full screen when tapped', () => {
  const figure = MAIN.slice(MAIN.indexOf('function photoFigure(m)'), MAIN.indexOf('function photoFigure(m)') + 2500);
  assert.match(figure, /img\.addEventListener\('click'/);
  assert.match(figure, /openViewer\(/);
  // A dialog in the page, so Back and Escape close it like every other sheet.
  assert.match(HTML, /<dialog id="photo-viewer"/);
});
