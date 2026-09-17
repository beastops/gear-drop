/**
 * Styles waiting on something that never arrives.
 *
 * The same shape as the progress ring, which read a custom property that could not reach it: a
 * rule that is well-formed, costs nothing, throws nothing, and can never apply. The stylesheet
 * looks like it handles a case. It does not, and nobody finds out, because there is no failure
 * to observe — only an absence.
 *
 * The one this was written for is a capability gate. Script put `no-folders` and `no-drag` on
 * the body from what the platform could do, and the stylesheet hid `.folders-only` and
 * `.drag-only` when it saw them. Nothing in the app has ever carried either class. Both
 * capabilities were being handled properly somewhere else — the folder entry is not built at all
 * when the platform cannot deliver one, and the drop hint is a `.desktop-only` span — so the
 * gate was a second, broken answer sitting next to a working one, which is worse than no answer
 * at all: it is the thing a reader finds first.
 *
 * Kept narrow deliberately. A general sweep for unused classes is mostly false positives, since
 * plenty are applied from names built at runtime. A body-level gate is different: it is written
 * to switch a specific class, and if that class exists nowhere the gate is decoration.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const css = read('web', 'app.css');
const html = read('web', 'index.html');
const scripts = [
  read('web', 'main.js'),
  ...fs.readdirSync(path.join(ROOT, 'web', 'ui')).filter((f) => f.endsWith('.js')).map((f) => read('web', 'ui', f)),
  ...fs.readdirSync(path.join(ROOT, 'web', 'core')).filter((f) => f.endsWith('.js')).map((f) => read('web', 'core', f)),
].join('\n');

/** Does anything put this class on an element, in markup or in script? */
function everApplied(name) {
  if (new RegExp(`class="[^"]*\\b${name}\\b`, 'u').test(html)) return true;
  if (new RegExp(`classList\\.(?:add|remove|toggle)\\([^)]*['"\`]${name}['"\`]`, 'u').test(scripts)) return true;
  if (new RegExp(`className\\s*=\\s*[^;]*\\b${name}\\b`, 'u').test(scripts)) return true;
  // A class named inside a selector string the script queries is applied by something.
  return new RegExp(`['"\`][^'"\`]*\\.${name}\\b`, 'u').test(scripts);
}

test('a capability class the body is given actually switches something', () => {
  const gates = [...scripts.matchAll(/document\.body\.classList\.toggle\(\s*['"`]([\w-]+)['"`]/gu)].map(
    (m) => m[1],
  );
  assert.ok(gates.length, 'no body-level state classes found at all — has this moved?');

  const dead = [];
  for (const gate of gates) {
    // Every class this gate goes on to switch, from the rules that mention it.
    const rules = [...css.matchAll(new RegExp(`body\\.${gate}\\s+\\.([\\w-]+)`, 'gu'))].map((m) => m[1]);
    if (!rules.length) continue; // the gate may be read elsewhere, or style the body itself
    const orphans = rules.filter((c) => !everApplied(c));
    if (orphans.length === rules.length) {
      dead.push(`body.${gate} switches only [${[...new Set(orphans)].join(', ')}], which nothing ever carries`);
    }
  }

  assert.deepEqual(dead, [], 'these gates look like they handle a case and cannot');
});
