/**
 * A registered custom property that does not inherit, read from somewhere it cannot reach.
 *
 * `@property` is the only way to make a custom property animatable, and it comes with a switch
 * plain custom properties do not have: `inherits`. Plain ones always inherit. Registered ones
 * inherit only if asked to, and the default in every example is `inherits: false`.
 *
 * That default is a trap when the value is set on one element and read on a descendant, which is
 * the normal shape for a progress indicator: script sets the number on the tile, and a
 * pseudo-element inside the tile draws with it. With `inherits: false` the descendant never sees
 * the number. It quietly falls back to `initial-value`, which is a real number and paints a real
 * gradient, so there is no error and nothing looks broken — the indicator simply never moves.
 *
 * This shipped exactly that way: `--p` was set on `.peer` and read in `.avatar::before`, and the
 * transfer ring sat at zero for every transfer anyone ever made. The percentage beside it was
 * correct the whole time, which is what made it invisible.
 *
 * So the rule is checked rather than remembered: if a registered property is read by a selector
 * that is not the one that sets it, it has to inherit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'app.css'), 'utf8');

/** Every `@property --x { ... }` block, as { name, inherits }. */
function registered(css) {
  const out = [];
  for (const m of css.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/gu)) {
    out.push({ name: m[1], inherits: /inherits\s*:\s*true/u.test(m[2]) });
  }
  return out;
}

/**
 * The selectors that assign `name`, and the selectors that read it through `var()`.
 * Rules are split on `}` rather than parsed properly, which is enough for a flat stylesheet
 * and wrong inside `@media`; the media blocks here only ever read, never assign, so the
 * setter list stays honest.
 */
function usage(css, name) {
  const sets = new Set();
  const reads = new Set();
  const assign = new RegExp(`(^|[;{\\s])${name}\\s*:`, 'u');
  const read = new RegExp(`var\\(\\s*${name}\\b`, 'u');

  for (const block of css.split('}')) {
    const at = block.lastIndexOf('{');
    if (at < 0) continue;
    const selector = block.slice(0, at).split('\n').pop().trim();
    const body = block.slice(at + 1);
    if (!selector || selector.startsWith('@')) continue;
    if (assign.test(body)) sets.add(selector);
    if (read.test(body)) reads.add(selector);
  }
  return { sets, reads };
}

test('a registered property read by a descendant actually inherits', () => {
  const broken = [];

  for (const { name, inherits } of registered(CSS)) {
    if (inherits) continue;
    const { sets, reads } = usage(CSS, name);
    // Read somewhere it is never assigned means it is relying on inheritance it does not have.
    const unreachable = [...reads].filter((r) => !sets.has(r));
    if (sets.size && unreachable.length) {
      broken.push(`${name}: set on [${[...sets].join(', ')}] but read by [${unreachable.join(', ')}]`);
    }
  }

  assert.deepEqual(
    broken,
    [],
    'these read a non-inheriting registered property from outside the element that sets it, so they silently get initial-value',
  );
});

test('the transfer ring reads the progress it is given', () => {
  /*
   * The specific case above, pinned on its own, because it is the one with a user-visible
   * consequence and the general check could be loosened later without anyone noticing this
   * went with it.
   */
  const p = registered(CSS).find((r) => r.name === '--p');
  assert.ok(p, '--p is no longer a registered property');
  assert.ok(p.inherits, 'the progress ring cannot see --p, so it will sit at zero for every transfer');
});
