/**
 * Turning a drop into a list of files.
 *
 * The path this pins is the fallback one: a drop whose items expose no filesystem entry, so
 * there is no tree to walk and the plain `files` list is all there is. It used to be tagged
 * with `.map(tag)`, and `map` hands the callback the index as its second argument, so every
 * file after the first got its position where its path should be.
 *
 * That was not a cosmetic error. `checkManifest` refuses a file whose name is not a string,
 * and it refuses silently, by design, because a rejection that explains itself is a probe
 * that pays. So the sender said it had offered two files and the receiver showed nothing at
 * all: no sheet, no error, no transfer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { filesFromDataTransfer, filesFromInput } from '../web/core/picker.js';

/** Only `items` and `files` are read, so a plain object stands in for a DataTransfer. */
const drop = (files) => ({ files });

const three = () => [
  new File(['a'], 'a.txt'),
  new File(['b'], 'b.txt'),
  new File(['c'], 'c.txt'),
];

test('every dropped file is tagged with its own name, not its position', async () => {
  const out = await filesFromDataTransfer(drop(three()));
  assert.deepEqual(
    out.map((f) => f.path),
    ['a.txt', 'b.txt', 'c.txt'],
  );
});

test('a path is always a string', async () => {
  /*
   * The property the manifest check depends on, asserted on its own.
   *
   * A wrong-but-stringy path would arrive as a strangely named file. A path that is not a
   * string is refused by the receiver without a word, which is the failure nobody can debug
   * from the outside: the send reports success and nothing comes out the other end.
   */
  const out = await filesFromDataTransfer(drop(three()));
  for (const f of out) {
    assert.equal(typeof f.path, 'string', `path is ${typeof f.path} for ${f.name}`);
    assert.ok(f.path.length > 0, 'an empty path is no better than a numeric one');
  }
});

test('one dropped file still works', async () => {
  const out = await filesFromDataTransfer(drop([new File(['x'], 'only.txt')]));
  assert.deepEqual(
    out.map((f) => f.path),
    ['only.txt'],
  );
});

test('an empty or absent drop is empty, not an error', async () => {
  assert.deepEqual(await filesFromDataTransfer(drop([])), []);
  assert.deepEqual(await filesFromDataTransfer(null), []);
  assert.deepEqual(await filesFromDataTransfer({}), []);
});

test('a picker keeps the directory structure the browser gave it', () => {
  const a = new File(['a'], 'a.txt');
  const b = new File(['b'], 'b.txt');
  // `webkitRelativePath` is read-only on a real File, so it is defined here the way the
  // browser would have.
  Object.defineProperty(a, 'webkitRelativePath', { value: 'holiday/a.txt' });
  const out = filesFromInput({ files: [a, b] });
  assert.deepEqual(
    out.map((f) => f.path),
    ['holiday/a.txt', 'b.txt'],
  );
});
