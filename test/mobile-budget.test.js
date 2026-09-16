/**
 * What this app is allowed to ask a phone for.
 *
 * A phone shares one thermal budget between the screen, the modem and the GPU, and it has no
 * fan. Ask it for too much and it does not merely drop frames: it gets hot, throttles, and
 * then everything stutters - including the parts that were cheap. That is a different failure
 * from a slow laptop, and it is not one a frame graph on a laptop will ever show. Every one of
 * these was found on a real handset getting warm, not here.
 *
 * What was being asked for:
 *
 *   - A full-screen WebGL shader, redrawn every frame at twice the device's pixel count, for
 *     as long as any control was on screen. It has an idle path, but a button is a shape, so
 *     it was never idle.
 *   - That shader kept drawing behind an opaque sheet. The radar already stopped; the glass
 *     had no way to be told.
 *   - `backdrop-filter: url('#gd-lens')` on every primary button: a real SVG refraction of
 *     live pixels, per button, per frame, which Chrome resolves and most phones run Chrome.
 *   - `backdrop-filter` and `overflow-y: auto` on the same element, so every frame of every
 *     scroll re-blurred the whole backdrop. Settings has the most to scroll and About is the
 *     longest page, which is exactly where it was felt.
 *
 * Checked at the source, because the property is "the expensive path is gated" and no amount
 * of running it on a desktop GPU demonstrates that.
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

/**
 * The body of every touch media block, brace-matched.
 *
 * Not a regex. `@media ... \{[\s\S]*?\n\}` is non-greedy and stops at the first nested closing
 * brace, so it returns the first rule in the block and calls it the block - which is how an
 * earlier version of this file came to scan a fragment and wave through a mutation it was
 * written to catch. Nested braces have to be counted.
 */
function touchBlocks(source) {
  const needle = '@media (pointer: coarse)';
  const out = [];
  for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
    const open = source.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    for (let j = open; j < source.length; j++) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open + 1, j));
          break;
        }
      }
    }
  }
  return out;
}

const touch = touchBlocks(css).join('\n');

/**
 * Every rule in `source` whose body matches, as [selector, body] pairs.
 *
 * Comments are stripped first, and that is not tidiness. `([^{}]*)\{` captures back to the
 * previous brace, so the comment above a rule lands in what this calls the selector - and the
 * comment above the close-button rule explains the scope by writing
 * `dialog:not([data-no-swipe])` out in full. The assertion that the selector is scoped was
 * being satisfied by the paragraph saying it should be, so deleting the actual scope changed
 * nothing. A mutation found it.
 */
function rulesWhere(source, bodyTest) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...code.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => [selector.trim(), body])
    .filter(([, body]) => bodyTest(body));
}

/* ------------------------------------------------------------ the shader */

test('the shader only starts on a machine with room to spare', () => {
  assert.match(main, /matchMedia\('\(hover: hover\) and \(pointer: fine\)'\)/);
  // And the gate has to stand in front of the mount. Asserting only that both appear nearby
  // let the gate be deleted while the declaration stayed, which a mutation found.
  assert.match(
    main,
    /roomToSpare && app\.glass\.mount\(\)/,
    'the WebGL glass mounts without checking what it is running on',
  );
});

test('the shader stops while something opaque is over it', () => {
  assert.match(glass, /pause\(\)\s*\{/, 'the layer cannot be told to stop');
  assert.match(glass, /if \(this\._paused\) return;/, 'it can be told, and ignores it');
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
  assert.ok(touch, 'there is no touch block at all');
  assert.ok(
    rulesWhere(touch, (b) => /backdrop-filter:\s*none/.test(b)).some(([s]) => /\.cta\b/.test(s)),
    'the primary button still asks for a backdrop filter on touch',
  );
  assert.ok(
    rulesWhere(touch, (b) => /background:\s*var\(--accent-fill\)/.test(b)).some(([s]) => /\.cta\b/.test(s)),
    'the button lost its blur and kept its translucency',
  );
});

test('nothing asks for a blur on a device that has to scroll it', () => {
  const cleared = rulesWhere(touch, (b) => /backdrop-filter:\s*none/.test(b))
    .map(([s]) => s)
    .join(' | ');
  for (const surface of ['.sheet-body', '.about-detail', '.menu', '.toast']) {
    assert.ok(cleared.includes(surface), `${surface} still blurs while it scrolls on touch`);
  }
  // A surface that loses its blur has to gain a background, or it is glass over nothing.
  assert.match(touch, /background-color:\s*var\(--veil-solid\)/, 'the surfaces went clear, not solid');
});

test('the glass thins out on touch rather than staying at desktop thickness', () => {
  const full = Number(/--mat-thick:\s*blur\((\d+)px\)/.exec(css)?.[1]);
  const thinner = Number(/--mat-thick:\s*blur\((\d+)px\)/.exec(touch)?.[1]);
  assert.ok(full && thinner, 'the thickest material is not declared for both');
  // A blur's cost climbs with its radius. Less than half is the point; near the desktop value
  // is not.
  assert.ok(thinner <= full / 2, `touch blur ${thinner}px is not meaningfully cheaper than ${full}px`);
});

/* ------------------------------------------------------------ the way out */

test('a sheet that cannot be swiped away keeps its close button', () => {
  /*
   * Every rule that hides a close button, however it is spelt.
   *
   * `pass-dialog` is deliberately not swipeable, so its close button is the only way out of a
   * passphrase prompt on a phone. Asserting one selector string is not that property: dropping
   * the scope left `.close-x[data-close],` - with a comma, because About shares the rule - and
   * an assertion written against one spelling went straight past it.
   */
  const hiding = rulesWhere(touch, (b) => /opacity:\s*0\s*;/.test(b))
    .filter(([s]) => s.includes('[data-close]'));

  assert.ok(hiding.length, 'nothing hides the close button, so this test proves nothing');
  for (const [selector] of hiding) {
    assert.match(
      selector,
      /dialog:not\(\[data-no-swipe\]\)/,
      `a close button is hidden without checking the sheet can be swiped away: ${selector}`,
    );
  }

  // Hidden, not removed: it has to come back for anything driving the page by focus.
  assert.ok(
    rulesWhere(touch, (b) => /opacity:\s*1/.test(b)).some(([s]) => /\[data-close\]:focus-visible/.test(s)),
    'a focused close button stays invisible',
  );

  const html = read('web', 'index.html');
  assert.match(
    html,
    /<dialog id="pass-dialog"[^>]*data-no-swipe/,
    'the passphrase sheet became swipeable, so this test no longer proves anything',
  );
});

/* ------------------------------------------------------------ not a setting */

test('none of this is a quality slider for the person to find', () => {
  // A humane default beats a setting: nobody opens a file-transfer app to configure its
  // render budget.
  const prefs = main.match(/prefs:\s*\{[\s\S]*?\n {2}\},/)?.[0] || '';
  assert.ok(!/quality|performanceMode|lowPower/i.test(prefs), 'a render-quality preference appeared');
});
