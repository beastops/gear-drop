/**
 * The dependencies, and whether they are still the ones that were published.
 *
 * Three cryptographic libraries are vendored into `web/vendor/` so the page loads them from
 * this origin with no bundler and no CDN, which removes a third party from the trust chain
 * and replaces it with a different risk: a copied file is a file somebody can edit, and a
 * one-character change to a curve or a KDF is invisible in review and fatal in use.
 *
 * So the copies are checked against what npm published. Module specifiers are rewritten by
 * the vendoring step and are expected to differ; everything else must be identical. A file
 * that fails here has either been hand-edited or vendored from a version nobody recorded,
 * and both need an answer before it ships.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'web/vendor/@noble');
const NM = path.join(ROOT, 'node_modules/@noble');
/** ML-KEM brings its own newer hashes and curves; they live beside it, not over the top. */
const PQ_NESTED = path.join(NM, 'post-quantum/node_modules/@noble');

const installed = fs.existsSync(NM);

/**
 * The file with every module specifier blanked.
 *
 * Vendoring rewrites `@noble/hashes/sha3.js` to a relative path, and does it in doc comments
 * as well as in real imports. Blanking the specifier on both sides compares the code and
 * ignores the one thing that is meant to change.
 */
const normalise = (src) =>
  src
    .replace(/\r\n/g, '\n')
    .replace(/from\s+['"][^'"]+['"]/g, "from '…'")
    .replace(/import\(\s*['"][^'"]+['"]\s*\)/g, "import('…')")
    .replace(/\{\s*([^{}]*)\}\s*from/g, (m) => m); // shape kept, only the target blanked

/** Every place the published copy of a vendored path might live. */
function published(rel) {
  if (rel.startsWith('post-quantum/_deps/')) {
    const [, , pkg, ...rest] = rel.split('/');
    return [path.join(PQ_NESTED, pkg, ...rest)];
  }
  if (rel.startsWith('post-quantum/')) return [path.join(NM, rel)];
  const [pkg, ...rest] = rel.split('/');
  // ESM build first: that is what a browser loads, and what was vendored.
  return [path.join(NM, pkg, 'esm', ...rest), path.join(NM, pkg, ...rest)];
}

function vendoredFiles() {
  const out = [];
  (function walk(dir, base = '') {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  })(VENDOR);
  return out.sort();
}

test('every vendored file is byte-identical to the published package', { skip: !installed && 'dependencies are not installed' }, () => {
  const files = vendoredFiles();
  assert.ok(files.length >= 20, `only ${files.length} vendored files found; did the tree move?`);

  const drift = [];
  const orphan = [];
  for (const rel of files) {
    const mine = normalise(fs.readFileSync(path.join(VENDOR, rel), 'utf8'));
    const src = published(rel).find((p) => fs.existsSync(p));
    if (!src) {
      orphan.push(rel);
      continue;
    }
    if (mine !== normalise(fs.readFileSync(src, 'utf8'))) drift.push(rel);
  }

  assert.deepEqual(orphan, [], 'these are vendored but no published copy is installed to check them against');
  assert.deepEqual(drift, [], 'these differ from the published package by more than their import paths');
});

test('the vendored libraries are the versions package.json asks for', { skip: !installed && 'dependencies are not installed' }, () => {
  /*
   * Recorded rather than assumed. Without this the vendored tree has no stated provenance at
   * all, since the check above would pass against whatever happens to be installed today.
   */
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dev = pkg.devDependencies || {};
  for (const name of ['@noble/curves', '@noble/hashes', '@noble/post-quantum']) {
    assert.ok(dev[name], `${name} is vendored but not recorded in devDependencies`);
    const on_disk = JSON.parse(fs.readFileSync(path.join(NM, name.split('/')[1], 'package.json'), 'utf8'));
    const wanted = dev[name].replace(/^[\^~]/, '');
    assert.equal(
      on_disk.version.split('.')[0],
      wanted.split('.')[0],
      `${name} installed at ${on_disk.version}, recorded as ${dev[name]}`,
    );
  }
});

test('nothing in the page loads code from another origin', () => {
  /*
   * The reason the libraries are vendored at all. A CDN tag is one compromised host away from
   * running in a page that holds session keys, and the CSP forbids it, but the CSP is a
   * second line, and the first is that there is nothing to block.
   */
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(js|mjs|html)$/.test(e.name)) files.push(full);
    }
  })(path.join(ROOT, 'web'));

  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const [, url] of src.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)) {
      offenders.push(`${path.relative(ROOT, f)} → ${url}`);
    }
    for (const [, url] of src.matchAll(/import\s*\(\s*["'](https?:\/\/[^"']+)["']\s*\)/g)) {
      offenders.push(`${path.relative(ROOT, f)} → ${url}`);
    }
  }
  assert.deepEqual(offenders, [], 'these load something from another origin');
});

test('no dependency is pulled in at runtime by the server either', () => {
  // The relay has one dependency, and it is a WebSocket implementation.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), ['ws'], 'the relay grew a dependency');
});
