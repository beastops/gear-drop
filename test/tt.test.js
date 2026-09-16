/**
 * The one door script can come through.
 *
 * Trusted Types only helps if the policy is actually narrow. A policy that mints whatever it
 * is handed is a rubber stamp with a security-sounding name, so what is pinned here is what
 * it refuses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// tt.js reads `location` to resolve relative URLs; Node has no document.
Object.defineProperty(globalThis, 'location', {
  value: new URL('https://gear.example/app/index.html'),
  configurable: true,
});

const { scriptURL, trustedTypesActive } = await import('../web/core/tt.js');

test('a module from this origin is minted', () => {
  assert.equal(scriptURL('sw.js'), 'https://gear.example/app/sw.js');
  assert.equal(scriptURL('./core/opfs-worker.js'), 'https://gear.example/app/core/opfs-worker.js');
});

test('another origin is refused, however it is spelled', () => {
  for (const bad of [
    'https://evil.example/x.js',
    '//evil.example/x.js', // protocol-relative: the classic way past a naive prefix check
    'http://gear.example/x.js', // same host, wrong scheme; a downgrade is still off-origin
    'https://gear.example.evil.test/x.js',
  ]) {
    assert.throws(() => scriptURL(bad), /off-origin/, bad);
  }
});

test('a data or blob URL is refused', () => {
  assert.throws(() => scriptURL('data:text/javascript,alert(1)'), /off-origin|non-module/);
  assert.throws(() => scriptURL('blob:https://gear.example/abc'), /off-origin|non-module/);
});

test('a same-origin path that is not a module is refused', () => {
  // An upload endpoint that echoes content, a stored file, an HTML page: none of these are
  // script we shipped, and the extension check is what says so.
  assert.throws(() => scriptURL('/uploads/avatar.png'), /non-module/);
  assert.throws(() => scriptURL('/index.html'), /non-module/);
  assert.throws(() => scriptURL('/core/opfs-worker.js/../../evil.html'), /non-module/);
});

test('a query string cannot smuggle a second target past the check', () => {
  // A URL whose query names somewhere else still resolves to our own path: the query is
  // inert, and the origin is ours.
  assert.ok(scriptURL('sw.js?v=2').startsWith('https://gear.example/app/sw.js'));
  assert.throws(() => scriptURL('sw.html?x=a.js'), /non-module/);
});

test('the policy reports whether the browser is really enforcing it', () => {
  // Node has no Trusted Types, so this is false here, and the origin check still ran above.
  assert.equal(typeof trustedTypesActive(), 'boolean');
});
