/**
 * What this app is allowed to ask a phone for.
 *
 * A phone shares one thermal budget between the screen, the modem and the GPU, and it has no
 * fan. Ask it for too much and it does not merely drop frames: it gets hot, throttles, and
 * then everything stutters - including the parts that were cheap. That is a different failure
 * from a slow laptop, and it is not one a frame graph on a laptop will ever show.
 *
 * Three things were being asked for and are not any more:
 *
 *   - A full-screen WebGL shader, redrawn every frame at twice the device's pixel count, for
 *     as long as any control was on screen. It has an idle path, but a button is a shape, so
 *     it was never idle.
 *   - That shader kept drawing behind an opaque sheet. The radar already stopped; the glass
 *     had no way to be told.
 *   - `backdrop-filter: url('#gd-lens')` on every primary button: a real SVG refraction of
 *     live pixels, per button, per frame, which Chrome resolves and most phones run Chrome.
 *
 * These are checked at the source because the property is "the expensive path is gated", and
 * no amount of running it on a desktop GPU demonstrates that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const main = read('web', 'main.js');
const glass = read('web', 'core', 'glass-gl.js');
const css = read('web', 'app.css');

/* ------------------------------------------------------------ the shader */

test('the shader only starts on a machine with room to spare', () => {
  // A pointer that can hover is the honest test for a desktop. Without this gate the layer
  // mounts everywhere and a phone renders a full-screen shader for as long as the app is open.
  // The query has to be declared...
  assert.match(main, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
  // ...and actually stand in front of the mount. Asserting only that both appear nearby let
  // the gate be deleted while the declaration stayed, which a mutation found.
  assert.match(
    main,
    /roomToSpare && app\.glass\.mount\(\)/,
    'the WebGL glass mounts without checking what it is running on',
  );
});

test('the shader stops while something opaque is over it', () => {
  assert.match(glass, /pause\(\)\s*\{/, 'the layer cannot be told to stop');
  assert.match(glass, /if \(this\._paused\) return;/, 'it can be told, and ignores it');
  // The radar already did this; the point is that both are told together.
  assert.match(
    main,
    /anyOpen\(\)[\s\S]{0,200}?radar\?\.pause\(\)[\s\S]{0,80}?glass\?\.pause\(\)/,
    'a sheet covers the page and the shader keeps drawing behind it',
  );
  assert.match(main, /glass\?\.resume\(\)/, 'it stops and never starts again');
});

/* ----------------------------------------------------------- the materials */

test('a phone is not asked to refract live pixels behind every button', () => {
  // The lens is a real SVG filter resolved per button per frame. Apple's own guidance for the
  // material says to use it sparingly; a phone GPU is where "sparingly" means "not at all".
  const touchBlock = /@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?\n\}/g;
  const blocks = css.match(touchBlock) || [];
  const dropsLens = blocks.some((b) => /\.cta\s*\{[^}]*backdrop-filter:\s*none/.test(b));
  assert.ok(dropsLens, 'the primary button still asks for a backdrop filter on touch');

  // And it has to go solid when the blur goes, or it is a washed-out button over nothing.
  const solid = blocks.some((b) => /\.cta\s*\{[^}]*background:\s*var\(--accent-fill\)/.test(b));
  assert.ok(solid, 'the button lost its blur and kept its translucency');
});

test('the glass thins out on touch rather than staying at desktop thickness', () => {
  const desktop = /--mat-thick:\s*blur\((\d+)px\)/.exec(css);
  assert.ok(desktop, '--mat-thick is not declared');

  const touch = [...css.matchAll(/@media \(hover: none\) and \(pointer: coarse\) \{[\s\S]*?--mat-thick:\s*blur\((\d+)px\)/g)];
  assert.ok(touch.length, 'the thickest material is the same on a phone as on a desktop');

  const thinner = Number(touch[touch.length - 1][1]);
  const full = Number(desktop[1]);
  assert.ok(thinner < full, `touch blur ${thinner}px is not below desktop ${full}px`);
  // A blur's cost climbs with its radius, and 40px over a whole screen is the most expensive
  // single thing here. Less than half is the point; anything near the desktop value is not.
  assert.ok(thinner <= full / 2, `touch blur ${thinner}px is not meaningfully cheaper than ${full}px`);
});

/* ------------------------------------------------------------- not a setting */

test('none of this is a quality slider for the person to find', () => {
  // A humane default beats a setting: nobody opens an app to configure its render budget.
  assert.ok(!/quality|performanceMode|lowPower/i.test(main.match(/prefs:\s*\{[\s\S]*?\n {2}\},/)?.[0] || ''),
    'a render-quality preference appeared; the default should just be right');
});
