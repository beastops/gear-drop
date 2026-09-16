/**
 * The app starts, and every name it reaches for on the way is one that exists.
 *
 * `showBuild` was written directly above `watchModals`. Two commits later a patch script that
 * meant to delete a different function cut from one doc comment to `function watchModals() {`,
 * and `showBuild` was inside that range. The call to it stayed where it was.
 *
 * Every load after that threw `ReferenceError: showBuild is not defined` on the second line of
 * the tail of `boot`, and because `boot()` ends in a `.catch` that turns anything at all into one
 * sentence, the only symptom was "Something went wrong" — while six things after that line
 * silently never ran: the language list (which read as "nothing is translated yet"), the platform
 * tweaks, a link proposing a connection, the saved discovery mode, a shared link's room code, and
 * the final render.
 *
 * Nothing in the suite could see it. Every test here reads the source as text, and the source
 * still said `showBuild()` — which is exactly what was wrong with it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
/**
 * Only the code, with the comments and the string literals taken out.
 *
 * Both of them say the names of things without calling them: a comment discusses a function, and
 * a media query written as a string contains `and (`, which looks exactly like a call to
 * something named `and`. Strings go before comments, so an apostrophe inside a comment cannot
 * open one.
 */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  // Backticks first, and matched simply as "everything up to the next one". A template literal
  // may contain an apostrophe, so taking the quoted strings out first turns that apostrophe into
  // the start of a string and eats the code up to the next one - which is what the first version
  // of this did, and it hid every declaration in the file.
  .replace(/`[^`]*`/g, '``')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

/**
 * Words that are followed by a parenthesis without being a call.
 *
 * Listed rather than parsed. A real parser would be better and is not worth a dependency for
 * one file; these are the only things in JavaScript that look like `name(` and are not.
 */
const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'typeof',
  'await',
  'async',
  'function',
  'import',
  'new',
  'delete',
  'void',
  'yield',
  'do',
  'with',
  'in',
  'of',
]);

/**
 * Browser globals this file is entitled to call.
 *
 * Node does not have them, so `name in globalThis` says they are missing when they are not. A
 * new one failing this test is a one-line addition here and a moment spent asking whether the
 * API is safe to assume - which is the right amount of friction for reaching for a new global.
 */
const BROWSER = new Set([
  'matchMedia',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'getComputedStyle',
  'getSelection',
  'open',
  'close',
  'scrollTo',
  'alert',
  'confirm',
  'prompt',
  'postMessage',
]);

/** Everything the file brings into scope: declarations, imports and parameters. */
function namesInScope() {
  const declared = new Set();
  for (const [, name] of code.matchAll(/\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) declared.add(name);
  for (const [, name] of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(name);
  for (const [, names] of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g))
    for (const part of names.split(',')) declared.add(part.split(':').pop().trim());
  for (const [, names] of src.matchAll(/import\s*\{([^}]*)\}\s*from/g))
    for (const part of names.split(',')) declared.add(part.split(' as ').pop().trim());
  for (const [, name] of src.matchAll(/import\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) declared.add(name);
  // Parameters, approximately: whatever sits between the parentheses of a function or an arrow.
  // Generous on purpose - a name wrongly counted as in scope only weakens this test, while one
  // wrongly left out fails it for something that is perfectly fine. No word boundary before the
  // parenthesis: `= (a, b) =>` and `new Promise((resolve) =>` both have a non-word character
  // there, so requiring one missed every parameter of both.
  for (const [, params] of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g))
    for (const part of params.split(','))
      for (const [, name] of part.matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(name);
  return declared;
}

/** `name(`, where `name` is a bare identifier and not a property or a word in a string. */
function callsInFile() {
  const calls = new Map();
  for (const m of code.matchAll(/(^|[^.\w$'"`])([a-z_$][\w$]*)\s*\(/g)) {
    if (calls.has(m[2])) continue;
    calls.set(m[2], code.slice(0, m.index).split('\n').length);
  }
  return calls;
}

test('every function main.js calls is one that exists', () => {
  const declared = namesInScope();
  const missing = [...callsInFile()]
    .filter(([name]) => !KEYWORDS.has(name) && !BROWSER.has(name))
    .filter(([name]) => !declared.has(name) && !(name in globalThis))
    .map(([name, line]) => `${name}() near line ${line}`);
  assert.deepEqual(missing, [], 'these throw a ReferenceError the moment they are reached');
});

/*
 * And the specific shape that hid it: the end of boot.
 *
 * These run one after another with nothing between them, so the first to throw ends the
 * function and every later one never happens. Naming them is the point - if one is deleted or
 * renamed, this says which, rather than leaving the app to fail at run time with one sentence.
 */
const BOOT_TAIL = [
  'bindUi',
  'showBuild',
  'buildLangList',
  'applyPlatform',
  'askAboutProposedRelay',
  'restoreDiscovery',
  'handleUrlFragment',
  'render',
];

test('everything boot finishes with is defined', () => {
  const declared = namesInScope();
  const missing = BOOT_TAIL.filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], 'boot stops at the first of these that is missing');
});

test('and boot really does still call each of them', () => {
  // Otherwise the list above is a second place for a name to rot, checked against nothing.
  const boot = code.slice(code.indexOf('async function boot('));
  const tail = boot.slice(0, boot.indexOf('\n}\n'));
  const uncalled = BOOT_TAIL.filter((name) => !new RegExp(`\\b${name}\\(`).test(tail));
  assert.deepEqual(uncalled, [], 'this list has drifted from what boot does');
});

test('a step at the end of boot cannot take the rest of them with it', () => {
  // One missing name cost five features for three commits, and the only symptom was a toast.
  // Each of these is independent of the others, so each survives the others failing.
  const boot = code.slice(code.indexOf('async function boot('));
  const tail = boot.slice(0, boot.indexOf('\n}\n'));
  assert.match(tail, /bootStep\(/, 'the tail of boot runs unguarded, so the first throw ends it');
  assert.match(
    src,
    /function bootStep\([\s\S]*?catch[\s\S]*?console\.error/,
    'a step that fails should say what failed, not vanish',
  );
});
