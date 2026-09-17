/**
 * The README is the repository's front door, and its links are the part that rots silently.
 *
 * Nothing in the app breaks when a README link goes stale. No test fails, no page errors, no
 * console warning. It simply sits there on the project's most-read page pointing at a file that
 * was renamed or a heading that was reworded, and the only way anyone finds out is by clicking
 * it — which, on a public repository, means a stranger finds out first.
 *
 * Relative links and heading anchors are both checkable here without a network, so they are
 * checked here. External URLs are not: reaching out over the network would make this suite fail
 * on a train, and a test that fails for reasons unrelated to the code is a test people learn to
 * ignore.
 *
 * The anchors matter more than they look. GitHub derives them from the heading text, so
 * rewording a heading silently breaks every link pointing at it — the link keeps working as a
 * link and just lands at the top of the page instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/**
 * The anchor GitHub gives a heading: lowercased, punctuation dropped, spaces hyphenated.
 * Reimplemented rather than imported, because the rule is short and the dependency would not be.
 */
function anchorOf(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s+/gu, '-');
}

/** Every `## heading` in the file, as the anchors a link is allowed to point at. */
function headingAnchors(markdown) {
  const found = new Set();
  for (const m of markdown.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) found.add(anchorOf(m[1]));
  return found;
}

/** Every `[text](target)` link, minus the ones inside a fenced code block. */
function links(markdown) {
  const outsideFences = markdown.replace(/```[\s\S]*?```/gu, '');
  return [...outsideFences.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)].map((m) => m[1]);
}

test('every heading link lands on a heading that exists', () => {
  const anchors = headingAnchors(README);
  const broken = links(README)
    .filter((href) => href.startsWith('#'))
    .filter((href) => !anchors.has(href.slice(1)));

  assert.deepEqual(broken, [], 'these jump to the top of the page instead of a section');
});

test('every file the README points at is really there', () => {
  const broken = [];
  for (const href of links(README)) {
    if (/^[a-z]+:/iu.test(href) || href.startsWith('#')) continue;
    const target = href.split('#')[0];
    if (!target) continue;
    if (!fs.existsSync(path.join(ROOT, target))) broken.push(href);
  }
  assert.deepEqual(broken, [], 'the README links to files that do not exist');
});

test('the images the README shows are really there', () => {
  // These are raw <img> tags rather than markdown, so the link sweep above never sees them —
  // and a missing one renders as a broken-image icon at the very top of the page.
  const broken = [];
  for (const m of README.matchAll(/<img[^>]+src="([^"]+)"/gu)) {
    if (/^[a-z]+:/iu.test(m[1])) continue;
    if (!fs.existsSync(path.join(ROOT, m[1]))) broken.push(m[1]);
  }
  assert.deepEqual(broken, [], 'the README shows images that are not in the repository');
});

test('the app it tells people to open is the one this repo actually deploys', () => {
  /*
   * The headline link is the most consequential line in the file: it is where a stranger who
   * reads nothing else ends up. Two hosts serve this app and they are not equivalent — the
   * Cloudflare Worker encrypts the name of the site on the way out, and the other address does
   * not. A link that drifts to the weaker one hands the least private address to exactly the
   * audience that came here for the opposite.
   *
   * Checked against `wrangler.jsonc` rather than against a hostname written down here, because
   * the Worker's name is what decides the hostname. Rename the Worker and this fails, which is
   * the moment the README went stale.
   */
  const hero = README.match(/\[\*\*Open the app[^\]]*\]\((https:\/\/[^)]+)\)/u);
  assert.ok(hero, 'the README no longer tells anyone where to open the app');

  const worker = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gmu, ''),
  ).name;
  const host = new URL(hero[1]).hostname;

  assert.match(
    host,
    new RegExp(`^${worker}\\..+\\.workers\\.dev$`, 'u'),
    `the front door points at ${host}, which is not the "${worker}" Worker this repo deploys`,
  );
});
