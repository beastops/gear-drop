/**
 * Writing a folder into a directory somebody granted.
 *
 * The sanitiser is tested on its own in `filename.test.js`. What is tested here is that the
 * sink actually calls it, which is a different claim: a path that is safe in a unit test and
 * passed through unsanitised at the call site is exactly as dangerous as no sanitiser at all.
 *
 * The fake directory handle below refuses any component a real one would refuse - a
 * separator, a climb, an empty name. That makes it the oracle rather than the test: if a
 * path ever reached it unsanitised, the fake throws and the test fails without having to
 * predict what the escape would have looked like.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Node ships its own `navigator`, and it is getter-only, so these go on by definition.
const stub = (name, value) =>
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

stub('navigator', { userAgent: 'node', storage: {} });
stub('location', { href: 'https://example.test/app/', origin: 'https://example.test' });
stub('window', {}); // neither picker exists, so nothing here can reach a real dialog

const { createSink } = await import('../web/core/sink.js');

/** A directory handle with a real one's refusals and none of its behaviour. */
function fakeDir(name = '') {
  const dirs = new Map();
  const files = new Map();

  const check = (n) => {
    if (typeof n !== 'string' || !n) throw new TypeError(`empty component: ${JSON.stringify(n)}`);
    if (/[\\/]/.test(n)) throw new TypeError(`component holds a separator: ${n}`);
    if (n === '.' || n === '..') throw new TypeError(`component is a climb: ${n}`);
  };

  return {
    name,
    dirs,
    files,
    async getDirectoryHandle(n, opts) {
      check(n);
      if (!dirs.has(n)) {
        if (!opts?.create) throw new Error('not found');
        dirs.set(n, fakeDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, opts) {
      check(n);
      if (!files.has(n)) {
        if (!opts?.create) throw new Error('not found');
        const written = [];
        files.set(n, {
          name: n,
          written,
          closed: false,
          async createWritable() {
            return {
              async write(op) {
                written.push(op);
              },
              async close() {
                files.get(n).closed = true;
              },
              async abort() {},
            };
          },
        });
      }
      return files.get(n);
    },
  };
}

/** Walk a fake tree by path, returning the file handle or undefined. */
function at(root, path) {
  const segs = path.split('/');
  const file = segs.pop();
  let dir = root;
  for (const s of segs) {
    dir = dir.dirs.get(s);
    if (!dir) return undefined;
  }
  return dir.files.get(file);
}

test('a folder lands as a folder', async () => {
  const root = fakeDir();
  const sink = await createSink(
    { name: 'a.jpg', path: 'holiday/rome/a.jpg', size: 3, mime: 'image/jpeg' },
    { directory: root },
  );

  await sink.write(0, new Uint8Array([1, 2, 3]));
  const result = await sink.close();

  const file = at(root, 'holiday/rome/a.jpg');
  assert.ok(file, 'the nested directories were not created');
  assert.equal(file.closed, true);
  assert.deepEqual(file.written[0].data, new Uint8Array([1, 2, 3]));
  assert.equal(file.written[0].position, 0);
  // 'fsa' so nothing downstream offers it as a download: it is already where they wanted it.
  assert.equal(result.kind, 'fsa');
});

test('a path from the peer cannot climb out of the granted directory', async () => {
  const root = fakeDir();
  // The fake throws on '..', so an unsanitised path fails here rather than silently escaping.
  const sink = await createSink(
    { name: 'passwd', path: '../../../etc/passwd', size: 1, mime: '' },
    { directory: root },
  );
  await sink.write(0, new Uint8Array([9]));
  await sink.close();

  assert.ok(at(root, 'etc/passwd'), 'the climb should have been flattened into the root, not followed');
  assert.equal(root.dirs.has('..'), false);
});

test('an absolute path is written inside the folder, not at its root', async () => {
  const root = fakeDir();
  const sink = await createSink({ name: 'x', path: '/etc/shadow', size: 1, mime: '' }, { directory: root });
  await sink.write(0, new Uint8Array([1]));
  await sink.close();
  assert.ok(at(root, 'etc/shadow'));
});

test('writes go to the offset they were given, in any order', async () => {
  const root = fakeDir();
  const sink = await createSink({ name: 'b.bin', path: 'd/b.bin', size: 6, mime: '' }, { directory: root });
  await sink.write(3, new Uint8Array([4, 5, 6]));
  await sink.write(0, new Uint8Array([1, 2, 3]));
  await sink.close();

  const file = at(root, 'd/b.bin');
  assert.deepEqual(
    file.written.map((w) => w.position),
    [3, 0],
    'the sink must not reorder or coalesce: the ranges bookkeeping depends on exact offsets',
  );
});

test('a loose file asks for no directory at all', async () => {
  const root = fakeDir();
  // No path means no structure to rebuild, so this must not touch the granted directory.
  const sink = await createSink({ name: 'loose.txt', path: '', size: 2, mime: '' }, { directory: root });
  await sink.write(0, new Uint8Array([1, 2]));
  await sink.close();

  assert.equal(sink.kind, 'memory', 'a file with no path should fall through to the ordinary sinks');
  assert.equal(root.dirs.size, 0);
  assert.equal(root.files.size, 0);
});

test('a directory the browser refuses falls back rather than losing the file', async () => {
  const hostile = {
    async getDirectoryHandle() {
      throw new Error('quota');
    },
    async getFileHandle() {
      throw new Error('quota');
    },
  };
  const sink = await createSink(
    { name: 'c.txt', path: 'deep/c.txt', size: 2, mime: '' },
    { directory: hostile },
  );
  assert.equal(sink.kind, 'memory', 'the file should survive its folder failing');
});
