/**
 * What a link is allowed to do to you.
 *
 * A URL is the one input an attacker can hand a person directly, and it arrives already
 * half-trusted: somebody clicked it. So every link that asks this app to act has to be treated
 * as a request rather than an instruction.
 *
 * The app got this right twice and wrong once. A link carrying a room code called `askJoinRoom`
 * and waited. A link proposing a relay got a whole dialog explaining the cost. A link carrying a
 * *pairing* code — the most direct of the three, a one-to-one channel rather than a directory —
 * went straight into `joinWithCode`, which starts the PAKE. Nothing shown, nothing asked: open
 * the link and your browser completes a handshake with whoever was waiting on that code.
 *
 * The safety words do not save you there. They catch a third party standing *between* two
 * devices that meant to meet. They cannot catch a device you never meant to meet at all, because
 * both ends genuinely hold the same code — the attacker picked it.
 *
 * These check the boundary at the place the decision is made, not at the place it is described.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'web', 'main.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

/** `handleUrlFragment`, brace-matched, which is the whole of what a link can reach. */
function fragmentHandler() {
  const at = MAIN.indexOf('function handleUrlFragment() {');
  assert.ok(at > 0, 'handleUrlFragment has gone');
  const open = MAIN.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < MAIN.length; i++) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) return MAIN.slice(open, i + 1);
    }
  }
  throw new Error('handleUrlFragment does not close');
}

test('a link carrying a pairing code asks before it connects anybody', () => {
  const body = fragmentHandler();
  assert.match(body, /askJoinCode\(code\)/, 'a link starts a handshake without asking');
  assert.ok(
    !/\bjoinWithCode\(/.test(body),
    'the fragment reaches joinWithCode directly, which begins the PAKE with no question asked',
  );
});

test('and a link carrying a room code still asks, as it always did', () => {
  assert.match(fragmentHandler(), /askJoinRoom\(code\)/, 'a room link stopped asking');
});

test('asking is showing: nothing about it opens a session', () => {
  const at = MAIN.indexOf('function askJoinCode(code) {');
  assert.ok(at > 0, 'askJoinCode has gone');
  const body = MAIN.slice(at, MAIN.indexOf('\n}', at));
  for (const forbidden of ['new SecureSession', 'joinWithCode', 'attachSession', 'tagForCode']) {
    assert.ok(!body.includes(forbidden), `askJoinCode reaches ${forbidden}, so the question is decorative`);
  }
  assert.match(body, /showModal\(\)/, 'the question is never put on screen');
});

test('typing a code by hand still connects, because that was a decision', () => {
  // The fix must not have made the ordinary path ask twice.
  assert.match(
    MAIN,
    /bindCodeBoxes\(ui\.codeInputs, CODE_LEN, joinWithCode\)/,
    'entering six characters no longer connects',
  );
});

test('the question says what saying yes costs', () => {
  // A confirmation that does not say what it is confirming is a speed bump, not a decision.
  /*
   * Bounded by the block that follows it, not by a non-greedy `</div>`.
   *
   * `[\s\S]*?</div>` stops at the first nested close — here the code display — and hands back a
   * fragment that is missing the buttons, which then reads as "there is no way to say no". The
   * same shape of mistake has been made in this suite before, on a CSS media block.
   */
  const from = HTML.indexOf('<div id="connect-invite"');
  const to = HTML.indexOf('<div class="connect-split"', from);
  assert.ok(from > 0 && to > from, 'the invitation markup has gone');
  const invite = HTML.slice(from, to);
  assert.match(invite, /data-i18n="connect\.inviteWhat"/, 'the invitation explains nothing');
  assert.match(invite, /id="connect-invite-code"/, 'the code being accepted is not shown');
  assert.match(invite, /data-i18n="common\.cancel"/, 'there is no way to say no');
});

test('and the code never stays in the address bar', () => {
  // A pairing code in history or a referrer is the secret surviving the moment it was for.
  assert.match(
    fragmentHandler(),
    /history\.replaceState\(null, '', location\.pathname\)/,
    'the code is left in the URL after use',
  );
});
