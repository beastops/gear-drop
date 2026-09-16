/**
 * OPFS sync-access writer.
 *
 * `createSyncAccessHandle()` is only available off the main thread, and it is the only
 * random-access OPFS write path on some engines. One handle per file, positioned writes,
 * nothing buffered.
 */
let handle = null;
let access = null;

self.onmessage = async (e) => {
  const { t, id } = e.data;
  try {
    let result = null;
    if (t === 'open') {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(e.data.dir, { create: true });
      handle = await dir.getFileHandle(e.data.name, { create: true });
      access = await handle.createSyncAccessHandle();
    } else if (t === 'write') {
      const bytes = e.data.bytes instanceof Uint8Array ? e.data.bytes : new Uint8Array(e.data.bytes);
      access.write(bytes, { at: e.data.offset });
      result = bytes.byteLength;
    } else if (t === 'close') {
      access.flush();
      access.close();
      access = null;
      result = true;
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, err: String(err && err.message ? err.message : err) });
  }
};
