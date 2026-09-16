/**
 * Turning a drop or a picker into a flat list of files, folders included.
 *
 * Dropping a folder is the thing people try first and the thing most browser transfer
 * apps quietly ignore. The DataTransfer entry API is the only way to walk one, and it
 * has to be read synchronously during the drop event before the items are neutered.
 *
 * Every file carries a `path` so the receiving side can rebuild the tree.
 */

const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 24;

/**
 * @param {DataTransfer} dt
 * @returns {Promise<File[]>} files with `path` set relative to what was dropped
 */
export async function filesFromDataTransfer(dt) {
  if (!dt) return [];

  // Grab the entries synchronously: they are invalidated once the event handler returns.
  const entries = [];
  if (dt.items) {
    for (const item of dt.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
  }

  // Not `.map(tag)`: map passes the index too, and `tag` would take it for a path.
  if (!entries.length) return [...(dt.files || [])].map((f) => tag(f, f.webkitRelativePath || f.name));

  const out = [];
  for (const entry of entries) {
    await walk(entry, '', out, 0);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** Files chosen through an <input>, keeping any directory structure the browser gave us. */
export function filesFromInput(input) {
  return [...(input.files || [])].map((f) => tag(f, f.webkitRelativePath || f.name));
}

async function walk(entry, prefix, out, depth) {
  if (out.length >= MAX_ENTRIES || depth > MAX_DEPTH) return;

  if (entry.isFile) {
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    if (file) out.push(tag(file, prefix + file.name));
    return;
  }

  if (!entry.isDirectory) return;

  const reader = entry.createReader();
  // readEntries returns at most 100 at a time and must be called until it returns none.
  for (;;) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    for (const child of batch) {
      await walk(child, `${prefix}${entry.name}/`, out, depth + 1);
      if (out.length >= MAX_ENTRIES) return;
    }
  }
}

function tag(file, path) {
  /*
   * A path is a non-empty string or it is not a path.
   *
   * `path || file.name` looks like it covers the missing case, and it covers exactly one:
   * the falsy ones. Anything else truthy is taken at its word, which is how `.map(tag)` put
   * an array index here and got away with it for the whole list except the first element,
   * where the index is 0 and the fallback happens to fire.
   *
   * What made it expensive is where a non-string surfaces. `checkManifest` refuses a file
   * whose name is not a string and refuses without a word, so the sender reported a
   * successful offer and the receiver showed nothing at all.
   */
  const value = typeof path === 'string' && path ? path : file.name;
  try {
    Object.defineProperty(file, 'path', { value, enumerable: true });
  } catch {
    /* some engines refuse; the name alone is then the path */
  }
  return file;
}
