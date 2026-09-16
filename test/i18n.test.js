/**
 * Interface language.
 *
 * The picker prints a coverage percentage per language, so what is worth testing is that
 * the percentage is accurate, that no string can render as a raw key name, and that the only
 * markup a translator can introduce is emphasis rather than an element.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES, TABLES, t, setText, setLocale, currentLocale } from '../web/ui/i18n.js';

/** Keys that legitimately carry a {placeholder}. Everything else must not. */
const WITH_VARS = new Set([
  'incoming.many',
  'verify.asked',
  'incoming.andMore',
  'incoming.queuedStart',
  'sink.free',
  'disc.others',
  'chat.wipedByPeer',
  'devices.erasePartial',
  'chat.clearedLater',
  'chat.wipeLanded',
  'devices.unpairStrands',
  'toast.relaySwitched',
  'toast.dropped',
  'toast.relayOffer',
  'toast.relaying',
  'toast.direct',
  'toast.resume.many',
  'toast.saved',
  'toast.findable',
  'toast.offer.one',
  'toast.offer.many',
  'toast.renamed',
  'a11y.codeChar',
  'a11y.roomChar',
  'toast.accept.manyBody',
  'toast.outbox.many',
]);

test('every listed language reports its real coverage', () => {
  assert.ok(LOCALES.length >= 2, 'a picker with one language is not a picker');
  const total = Object.keys(TABLES.en).length;
  for (const l of LOCALES) {
    assert.ok(l.native && l.english, `${l.code} is missing a name`);
    assert.equal(l.coverage, Math.round((Object.keys(TABLES[l.code]).length / total) * 100));
    assert.ok(l.coverage > 0 && l.coverage <= 100, `${l.code} reports ${l.coverage}%`);
  }
  assert.equal(LOCALES.find((x) => x.code === 'en').coverage, 100, 'English is the source of truth');
});

test('a language claiming 100% really has every key', () => {
  for (const l of LOCALES.filter((x) => x.coverage === 100)) {
    for (const key of Object.keys(TABLES.en)) {
      assert.ok(TABLES[l.code][key], `${l.code} is missing ${key} but claims to be complete`);
    }
  }
});

test('English is the default, and an unknown key falls back to itself rather than breaking', () => {
  assert.equal(currentLocale(), 'en');
  assert.equal(t('verify.yes'), 'They match');
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('placeholders are substituted', () => {
  assert.equal(t('incoming.many', { n: 3 }), 'Incoming 3 files');
  assert.ok(!t('incoming.many', { n: 3 }).includes('{n}'));
});

test('no string leaves a placeholder unfilled by accident, in any language', () => {
  for (const [code, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      if (WITH_VARS.has(key)) continue;
      assert.ok(!/\{\w+\}/.test(value), `${code}:${key} contains an unexpected placeholder`);
    }
  }
});

test('a key that takes a placeholder keeps it in every language', () => {
  for (const [code, table] of Object.entries(TABLES)) {
    for (const key of WITH_VARS) {
      if (!table[key]) continue;
      assert.ok(/\{\w+\}/.test(table[key]), `${code}:${key} dropped its placeholder in translation`);
    }
  }
});

test('a translation may only contain <b>, and it must be balanced', () => {
  for (const [code, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      const tags = value.match(/<[^>]*>/g) || [];
      for (const tag of tags) assert.ok(tag === '<b>' || tag === '</b>', `${code}:${key} contains ${tag}`);
      assert.equal(
        tags.filter((x) => x === '<b>').length,
        tags.filter((x) => x === '</b>').length,
        `${code}:${key} has unbalanced emphasis`,
      );
    }
  }
});

test('no translation is empty or accidentally left as the key', () => {
  for (const [code, table] of Object.entries(TABLES)) {
    for (const [key, value] of Object.entries(table)) {
      assert.ok(typeof value === 'string' && value.trim(), `${code}:${key} is empty`);
      assert.notEqual(value, key, `${code}:${key} was never translated`);
    }
  }
});

/* ------------------------------------------------------------------- setText */

test('setText builds real elements, and markup in a string stays text', () => {
  withFakeDom(() => {
    const el = element();
    setText(el, 'plain <b>bold</b> tail');
    assert.equal(el.textContent, 'plain bold tail');
    assert.equal(el.elements.length, 1);
    assert.equal(el.elements[0].tagName, 'b');
    assert.equal(el.elements[0].textContent, 'bold');

    // A hostile string produces characters, never structure.
    const hostile = element();
    setText(hostile, '<img src=x onerror=alert(1)><script>bad()</script>');
    assert.equal(hostile.elements.length, 0, 'nothing but <b> is ever built');
    assert.ok(hostile.textContent.includes('<script>'), 'it is rendered as characters');
  });
});

test('setText survives a malformed translation without losing the text', () => {
  withFakeDom(() => {
    for (const bad of ['</b>orphan close', '<b>unclosed open', '<b><b>doubled</b>']) {
      const el = element();
      setText(el, bad);
      assert.equal(el.textContent, bad.replaceAll('<b>', '').replaceAll('</b>', ''));
    }
  });
});

test('switching language changes what t() returns, and back again', () => {
  withFakeDom(() => {
    setLocale('hi');
    assert.equal(currentLocale(), 'hi');
    assert.equal(t('verify.yes'), TABLES.hi['verify.yes']);
    assert.notEqual(t('verify.yes'), TABLES.en['verify.yes']);

    setLocale('zz-not-a-language');
    assert.equal(currentLocale(), 'en', 'an unknown locale falls back rather than blanking the app');
    setLocale('en');
  });
});

/* ------------------------------------------------------------------ fixtures */

/** The two DOM calls setText makes, and the three setLocale makes. Nothing more. */
function element(tagName = 'div') {
  return {
    tagName,
    nodes: [],
    _open: null,
    get elements() {
      return this.nodes.filter((n) => n.tagName);
    },
    get textContent() {
      return this.nodes.map((n) => (n.tagName ? n.textContent : n.data)).join('');
    },
    replaceChildren() {
      this.nodes = [];
    },
    append(node) {
      this.nodes.push(node);
    },
    querySelectorAll() {
      return [];
    },
  };
}

function withFakeDom(fn) {
  const previous = globalThis.document;
  globalThis.document = {
    documentElement: {},
    createElement: (tag) => element(tag),
    createTextNode: (data) => ({ data }),
    querySelectorAll: () => [],
  };
  try {
    fn();
  } finally {
    globalThis.document = previous;
  }
}

/*
 * The markup carries English text of its own, shown until `applyTo` runs and to anyone
 * reading the page without scripts. It drifted once: the table was rewritten and the
 * markup kept the old wording, so English, the source of truth, was the one language showing
 * stale copy.
 */
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html'), 'utf8');

/** `<tag … data-i18n="key" …>text</tag>`, excluding wrappers that hold other keys. */
const TRANSLATED = /<(\w+)([^>]*\sdata-i18n="([a-zA-Z0-9._]+)"[^>]*)>([\s\S]*?)<\/\1>/g;
const plain = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

test('the English in the markup is the English in the table', () => {
  let seen = 0;
  for (const [, , , key, inner] of HTML.matchAll(TRANSLATED)) {
    if (inner.includes('data-i18n=')) continue; // a layout wrapper; applyTo skips it too
    assert.ok(key in TABLES.en, `${key} is in the markup but not in the table`);
    assert.equal(plain(inner), plain(TABLES.en[key]), `${key} has drifted from the table`);
    seen++;
  }
  assert.ok(seen > 50, `only ${seen} translated elements found; the pattern has stopped matching`);
});

test('markup fallbacks carry no markup a translation could not', () => {
  for (const [, , , key, inner] of HTML.matchAll(TRANSLATED)) {
    if (inner.includes('data-i18n=')) continue;
    const tags = (inner.match(/<\/?(\w+)/g) || []).map((s) => s.replace(/<\/?/, ''));
    for (const tag of tags) assert.equal(tag, 'b', `${key} uses <${tag}>, but only <b> survives translation`);
  }
});

/*
 * Toasts were English no matter what language the rest of the interface was in: forty-odd
 * of them were literals in main.js, so a translated app still said "Could not send".
 */
test('no toast carries its text as a literal', () => {
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'main.js'), 'utf8');
  const offenders = [];
  for (const [, arg] of main.matchAll(/\btoast\(\s*([^;]*?),\s*'(?:good|bad)'|\btoast\(\s*('[^']*'|`[^`]*`)\s*\)/g)) {
    if (!arg) continue;
    const text = arg.trim();
    if (/^['`]/.test(text) && text.length > 3) offenders.push(text.slice(0, 60));
  }
  assert.deepEqual(offenders, [], 'these toasts bypass the translation tables');
});

/*
 * And the button on a toast, which the check above never looked at.
 *
 * `toast(t('...'), 'bad', { label: 'Use the encrypted relay' })` reads as translated at a
 * glance and is not: the message came from the table and the only thing the person is meant
 * to press stayed English in all five.
 */
test('no toast action carries its label as a literal', () => {
  const main = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'main.js'), 'utf8');
  const offenders = [];
  for (const [, value] of main.matchAll(/\blabel:\s*('[^']*'|`[^`]*`)/g)) {
    offenders.push(value.slice(0, 60));
  }
  assert.deepEqual(offenders, [], 'these buttons bypass the translation tables');
});

/*
 * A label with no visible text is all a screen reader has to go on, and those were literals
 * in the markup, so the interface translated and the spoken names stayed English.
 */
test('no aria-label or title is left as English in the markup', () => {
  const TAGGED = /<\w+((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  const stranded = [];
  for (const [, attrs] of HTML.matchAll(TAGGED)) {
    const label = /\saria-label="([^"]*)"/.exec(attrs);
    const title = /\stitle="([^"]*)"/.exec(attrs);
    const keyed = attrs.includes('data-i18n-label=') || attrs.includes('data-i18n-title=');
    if (keyed) continue;
    if (label) stranded.push(`aria-label="${label[1]}"`);
    // A <title> element inside an <svg> is not the attribute we mean.
    if (title) stranded.push(`title="${title[1]}"`);
  }
  assert.deepEqual(stranded, [], 'these labels never change with the language');
});

test('a numbered label is asked for with the number it needs', () => {
  for (const [, attrs] of HTML.matchAll(/<\w+((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)) {
    const key = /\sdata-i18n-label="([^"]*)"/.exec(attrs);
    if (!key) continue;
    const needsN = /\{n\}/.test(TABLES.en[key[1]] || '');
    assert.equal(needsN, attrs.includes('data-i18n-n='), `${key[1]} and data-i18n-n disagree`);
  }
});

/*
 * House style, taken from the guides rather than from taste.
 *
 *   Microsoft: use contractions; no spaces around dashes; avoid "there is"/"there are".
 *   Material:  a switch summary reports the current status; it does not re-teach the setting.
 *   NN/g:      keep labels short and direct, and cut excess phrases.
 *
 * The spaced-dash-plus-explanation construction is what these caught most of: a status that
 * says "On" and then explains itself reads as written rather than shipped.
 */
const EN = TABLES.en;

test('no string uses a spaced dash to bolt on an explanation', () => {
  const offenders = Object.entries(EN).filter(([, v]) => /\s[—–]\s/.test(v)).map(([k]) => k);
  assert.deepEqual(offenders, [], 'these read as a label with an aside welded on');
});

test('English says it the way it is spoken', () => {
  const STIFF = /\b(cannot|do not|does not|did not|is not|are not|will not|would not|should not|could not|has not|have not)\b/i;
  const offenders = Object.entries(EN).filter(([, v]) => STIFF.test(v)).map(([k]) => k);
  assert.deepEqual(offenders, [], 'these want a contraction');
});

test('no weak opener', () => {
  const WEAK = /\b(there is|there are|there was|there were)\b/i;
  const offenders = Object.entries(EN).filter(([, v]) => WEAK.test(v)).map(([k]) => k);
  assert.deepEqual(offenders, [], 'start with the subject instead');
});

test('a status or a chip stays short', () => {
  // Read at a glance, never opened on purpose, unlike the explainers behind a disclosure.
  const GLANCED = /^(st\.|state\.|chip\.|ch\.|xfer\.|fact\.|net\.status|err\.|action\.|common\.)/;
  for (const [key, value] of Object.entries(EN)) {
    if (!GLANCED.test(key)) continue;
    assert.ok(value.length <= 48, `${key} is ${value.length} chars: "${value}"`);
  }
});

/**
 * Key families that are assembled at run time, so the literal never appears in the source.
 *
 * Named one at a time rather than matched by shape, and each one is proved below to really be
 * built that way - otherwise this list is just a second place for a dead key to hide.
 */
const BUILT_AT_RUNTIME = ['ch.', 'empty.body.', 'empty.seeking.', 'empty.title.', 'erase.part.'];

/*
 * `ui/i18n.js` is deliberately not one of the files searched.
 *
 * It used to be, and every key appears in it as its own definition, so the check passed for
 * every key that had ever existed and could not have failed for any of them. Seventeen had
 * built up behind it - a whole set of chips, three lines of a settings pane, and the label for
 * a "Lock now" button nobody had built - each translated five times and rendered nowhere.
 */
test('every key in the tables is actually used', () => {
  const src = ['main.js', 'index.html', 'ui/swipe.js']
    .map((f) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', f), 'utf8'))
    .join('\n');
  const dead = Object.keys(EN).filter(
    (k) =>
      !src.includes(`'${k}'`) &&
      !src.includes(`"${k}"`) &&
      !BUILT_AT_RUNTIME.some((prefix) => k.startsWith(prefix)),
  );
  assert.deepEqual(dead, [], 'these are translated five times and shown nowhere');
});

test('a prefix is only excused if something really does build keys from it', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'main.js'),
    'utf8',
  );
  for (const prefix of BUILT_AT_RUNTIME) {
    assert.ok(src.includes('t(`' + prefix + '${'), `nothing builds a key from ${prefix}`);
  }
  for (const prefix of BUILT_AT_RUNTIME) {
    assert.ok(
      Object.keys(EN).some((k) => k.startsWith(prefix)),
      `${prefix} excuses no key and should go`,
    );
  }
});
