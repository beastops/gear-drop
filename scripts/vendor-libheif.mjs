/**
 * Vendor the HEIC decoder, the same way the crypto is vendored: from npm, into the origin.
 *
 * The asm.js build rather than the wasm one, and that is a security decision rather than a
 * size one. Our CSP is `script-src 'self'` with no `wasm-unsafe-eval`, so WebAssembly will
 * not compile at all, and granting it would widen the policy for every line of the app to
 * buy a thumbnail. Over the wire the two are closer than the raw sizes suggest: about 485 KB
 * of asm.js against 362 KB of wasm once brotli has been at them. 123 KB is a cheap price for
 * leaving the policy alone.
 *
 * The file is a UMD bundle, so the last line makes it an ES module. That is the only edit,
 * and `supply-chain.test.js` checks the rest against what npm published.
 *
 *   node scripts/vendor-libheif.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules/libheif-js/libheif/libheif.js');
const OUT_DIR = path.join(ROOT, 'web/vendor/libheif');
const OUT = path.join(OUT_DIR, 'libheif.js');

/** Appended so a module worker can import it. Pinned here and asserted by the test. */
export const ESM_TAIL = '\nexport default libheif;\n';

/**
 * Only when run, never when imported.
 *
 * `heic-vendor.test.js` imports this file for `ESM_TAIL`, and without this guard that import
 * re-vendored the decoder from npm before the assertions ran: the test repaired the tampering
 * it exists to catch, and passed. A test that silently rewrites the file it is checking is
 * worse than no test, because it reports a guarantee nobody has.
 */
function vendor() {
  if (!fs.existsSync(SRC)) {
    console.error('libheif-js is not installed. `npm install` first.');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const src = fs.readFileSync(SRC, 'utf8');
  fs.writeFileSync(OUT, src + ESM_TAIL);

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`vendored libheif asm.js: ${kb(src.length)} + ${ESM_TAIL.trim()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) vendor();
