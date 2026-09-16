/**
 * Light-theme contrast.
 *
 * The palette carries its measurements in comments ("it measures 4.70", "this one is 6.1:1"),
 * and those numbers were true when written, against the surface they were written for. Then
 * the ground moved a few per cent off white and every one of them moved with it: the accent
 * went from 4.70 to 4.31 without a character of it changing, which a comment cannot catch. So
 * the numbers are computed here from the tokens the stylesheet ships, against the surfaces
 * the type is printed on.
 *
 * Dark is not checked the same way. Its ground is #000 and everything on it has a large
 * margin; light is the theme where a small move matters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'app.css'),
  'utf8',
);

/** The custom properties declared in `body.theme-light { … }`. */
function lightTokens() {
  const start = CSS.indexOf('body.theme-light {');
  assert.ok(start > 0, 'the light theme block has moved');
  const end = CSS.indexOf('\n}', start);
  const block = CSS.slice(start, end);
  const out = {};
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const T = lightTokens();

/* ── colour ───────────────────────────────────────────────────────────────── */

const srgb = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);

function parse(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const p = rgb[1].split(',').map((x) => Number(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] };
  }
  throw new Error(`cannot read colour: ${value}`);
}

/** Flatten a translucent colour onto what is behind it, since contrast is of what you see. */
const flatten = (fg, bg) =>
  fg.a >= 1
    ? fg
    : { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 };

function contrast(fgValue, bgValue) {
  const bg = parse(bgValue);
  const fg = flatten(parse(fgValue), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* The three grounds type is printed on, in the order it stacks. */
const GROUND = () => T['--bg']; // the page
const SHEET = '#ffffff'; // a dialog, a menu, a card
const PANEL = () => T['--veil-solid']; // a grouped row inside one

const AA = 4.5; // ordinary text
const AA_LARGE = 3; // 18.66px bold or 24px regular

/* ── the checks ───────────────────────────────────────────────────────────── */

test('body text clears AA on every surface it is printed on', () => {
  for (const [label, bg] of [
    ['the page', GROUND()],
    ['a sheet', SHEET],
    ['a grouped row', PANEL()],
  ]) {
    const r = contrast(T['--text'], bg);
    assert.ok(r >= AA, `--text on ${label} is ${r.toFixed(2)}:1`);
  }
});

test('secondary text clears AA, which is what it is set at the alpha it is for', () => {
  for (const name of ['--muted', '--faint']) {
    for (const [label, bg] of [
      ['the page', GROUND()],
      ['a sheet', SHEET],
      ['a grouped row', PANEL()],
    ]) {
      const r = contrast(T[name], bg);
      assert.ok(r >= AA, `${name} on ${label} is ${r.toFixed(2)}:1`);
    }
  }
});

test('the accent is readable as text, not only as a fill', () => {
  // It is used both ways, and the page is the hardest of the three because it is the darkest.
  for (const [label, bg] of [
    ['the page', GROUND()],
    ['a sheet', SHEET],
    ['a grouped row', PANEL()],
  ]) {
    const r = contrast(T['--accent'], bg);
    assert.ok(r >= AA, `--accent on ${label} is ${r.toFixed(2)}:1`);
  }
});

test('white on a filled accent button clears AA', () => {
  const r = contrast('#ffffff', T['--accent']);
  assert.ok(r >= AA, `white on --accent is ${r.toFixed(2)}:1`);
});

test('the channel labels clear AA on the tinted panels they sit on', () => {
  for (const name of ['--ch-local-text', '--ch-paired-text', '--ch-room-text', '--accent-text']) {
    const r = contrast(T[name], PANEL());
    assert.ok(r >= AA, `${name} is ${r.toFixed(2)}:1`);
  }
});

test('the states that carry meaning are readable, not only coloured', () => {
  for (const name of ['--danger', '--warn-text']) {
    const r = contrast(T[name], SHEET);
    assert.ok(r >= AA, `${name} on a sheet is ${r.toFixed(2)}:1`);
  }
});

test('a hairline is faint on purpose, and still has to be visible', () => {
  // Not a contrast rule, since a border is not text, but a line nobody can see is not a border.
  const r = contrast(T['--line'], GROUND());
  assert.ok(r >= 1.1, `--line on the page is ${r.toFixed(2)}:1, which is nothing`);
  assert.ok(r <= 2.2, `--line on the page is ${r.toFixed(2)}:1, which is a rule, not a hairline`);
});

test('the page and a sheet are told apart, and not by much', () => {
  /*
 * What the ground is for: white has to mean "raised". Too close and the sheet floats
   * on nothing; too far and the page reads as a dialog backdrop that never went away.
   */
  const r = contrast(SHEET, GROUND());
  assert.ok(r > 1.02, `a sheet is ${r.toFixed(3)}:1 against the page, the same colour`);
  assert.ok(r < 1.25, `a sheet is ${r.toFixed(3)}:1 against the page, too dark a ground`);
});

test('the accent fill is the accent, so a button and its label cannot drift apart', () => {
  assert.equal(T['--accent-fill'], 'var(--accent)');
});

test('--accent-rgb is the same colour as --accent', () => {
  const { r, g, b } = parse(T['--accent']);
  assert.equal(
    T['--accent-rgb'].split(',').map((x) => Number(x.trim())).join(','),
    [r, g, b].join(','),
    'the triple used for glows and rings is a different blue from the one used for ink',
  );
});

/* ── large text ───────────────────────────────────────────────────────────── */

test('the empty-state heading is large enough for the rule it is measured by', () => {
  /*
   * This one is drawn in the accent on the page, which is the tightest pairing in the theme.
   * It passes AA outright, but it is also the only place the large-text allowance would be
   * relied on if the accent ever moved again, so the size that earns the allowance is
   * asserted here rather than left in a comment.
   */
  const rule = CSS.slice(CSS.indexOf(".empty[data-mode='local'] h1 {"));
  const size = rule.match(/font-size:\s*clamp\((\d+)px/);
  const weight = rule.match(/font-weight:\s*(\d+)/);
  assert.ok(size && Number(size[1]) >= 19, 'the heading is no longer large text');
  assert.ok(weight && Number(weight[1]) >= 600, 'the heading is no longer bold enough to be large text');
  assert.ok(contrast(T['--accent'], GROUND()) >= AA_LARGE);
});
