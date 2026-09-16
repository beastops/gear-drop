/**
 * Sinks: where received bytes go.
 *
 * The rule that makes multi-gigabyte transfers possible on a phone: bytes must never
 * accumulate in JavaScript memory. Every sink below writes through to storage as chunks
 * arrive, so peak RAM stays flat regardless of file size.
 *
 * Preference order:
 *   0. A directory the person picked, when the transfer is a folder: one prompt for the
 *      whole thing, and the sender's structure rebuilt inside it (Chrome/Edge)
 *   1. File System Access: user picks a real path, true stream-to-disk (Chrome/Edge)
 *   2. OPFS: origin-private file, flat RAM, then a disk-backed Blob URL at the end
 *      (Firefox, Safari)
 *   3. Memory: small files only, and the last resort
 */

import { platform, downloadBlob } from './platform.js';
import { safeFileName, safePathSegments } from './filename.js';
import { scriptURL } from './tt.js';

const MEMORY_LIMIT = 64 * 1024 * 1024;

export function sinkCapabilities() {
  return {
    fsa: typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function',
    directory: typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',
    opfs: !!navigator.storage?.getDirectory,
    memory: true,
  };
}

/**
 * Ask once where a folder should land.
 *
 * Separate from `createSink` because it is asked once for a transfer and not once per file,
 * which is the whole point: fifty files used to mean fifty save dialogs, and a browser stops
 * granting those after the first anyway.
 *
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export function pickDestinationDirectory() {
  return window.showDirectoryPicker({
    mode: 'readwrite',
    // The browser reopens where this id was last used, so a second folder lands beside the
    // first without anyone navigating there again.
    id: 'gd-incoming',
    startIn: 'downloads',
  });
}

/**
 * @param {object} meta {name, size, mime}
 * @param {object} opts {prefer: 'fsa'|'opfs'|'memory'}
 */
export async function createSink(meta, opts = {}) {
  const caps = sinkCapabilities();
  const prefer = opts.prefer;

  /*
   * A folder, and somewhere to put it: the structure survives.
   *
   * The directory was granted once for the whole transfer, so this needs no gesture of its
   * own and asks for nothing. A failure here is a real path this file cannot take - a name
   * the filesystem refused, a quota - so it falls through to a sink that always works rather
   * than losing the file over its folder.
   */
  if (opts.directory && meta.path) {
    try {
      return await FsaSink.createIn(meta, opts.directory);
    } catch {
      /* fall through */
    }
  }

  if (prefer !== 'memory' && prefer !== 'opfs' && caps.fsa && opts.userGesture !== false) {
    try {
      return await FsaSink.create(meta);
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // the user cancelled the picker: respect it
      // otherwise fall through to a sink that needs no permission
    }
  }

  if (prefer !== 'memory' && caps.opfs) {
    try {
      return await OpfsSink.create(meta);
    } catch {
      /* fall through */
    }
  }

  if (meta.size > MEMORY_LIMIT && !opts.allowBigMemory) {
    throw new Error('No streaming sink available for a file this large on this browser');
  }
  return MemorySink.create(meta);
}

/* ------------------------------------------------------------------- FSA */

/**
 * Straight to a real file on disk, however that file was chosen.
 *
 * Two ways in and one write path: a save dialog for a single file, or a walk into a directory
 * the person granted for a whole folder. Everything after the handle is the same, and was
 * written twice until the second one drifted.
 */
class FsaSink {
  /** Ask where this one file should go. Needs a user gesture; may be cancelled. */
  static async create(meta) {
    const handle = await window.showSaveFilePicker({
      suggestedName: meta.name,
      types: meta.mime ? [{ description: meta.mime, accept: { [meta.mime]: guessExt(meta.name) } }] : undefined,
    });
    return FsaSink.open(handle, meta, meta.name);
  }

  /**
   * Put it at its own path inside a directory already granted.
   *
   * Every component comes from `safePathSegments`, so by the time it reaches
   * `getDirectoryHandle` it cannot climb, cannot carry a separator, and cannot name a Windows
   * device. That check is the only thing standing between a peer and a write outside the
   * folder that was granted, which is why the path is re-derived here rather than trusted
   * from the caller.
   */
  static async createIn(meta, root) {
    const segments = safePathSegments(meta.path || meta.name);
    const fileName = segments.pop();

    let dir = root;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    return FsaSink.open(handle, meta, segments.concat(fileName).join('/'));
  }

  static async open(handle, meta, name) {
    const writable = await handle.createWritable({ keepExistingData: false });
    return new FsaSink(handle, writable, meta, name);
  }

  constructor(handle, writable, meta, name) {
    this.kind = 'fsa';
    this.handle = handle;
    this.writable = writable;
    this.meta = meta;
    this.name = name;
    this.written = 0;
  }

  async write(offset, bytes) {
    await this.writable.write({ type: 'write', position: offset, data: bytes });
    this.written += bytes.byteLength;
  }

  async close() {
    await this.writable.close();
    // `kind: 'fsa'` because it is already where the person wanted it, so nothing downstream
    // offers it as a download.
    return { kind: 'fsa', name: this.name, handle: this.handle };
  }

  async abort() {
    try {
      await this.writable.abort();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ OPFS */

class OpfsSink {
  static async create(meta) {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('incoming', { create: true });
    /*
     * Timestamp, then something unique, then the name.
     *
     * Two files in one transfer can arrive at the same millisecond, and flattening a folder
     * means two of them can end up with the same name: `a/photo.jpg` and `b/photo.jpg` both
     * become `photo.jpg`. With only a millisecond to tell them apart, both sinks open the
     * same handle and write over each other. The integrity check then fails the transfer,
     * which is right for a corrupt file and wrong for two good ones.
     *
     * The timestamp stays first, because the startup sweep reads it back out of the name.
     */
    const unique = Math.trunc(Math.random() * 0x100000000).toString(36);
    const safe = `${Date.now().toString(36)}-${unique}-${safeFileName(meta.name)}`;
    const handle = await dir.getFileHandle(safe, { create: true });

    if (handle.createWritable) {
      const writable = await handle.createWritable({ keepExistingData: true });
      return new OpfsSink(handle, { kind: 'writable', writable }, meta, dir, safe);
    }
    // Safari/Firefox worker-only path: a sync access handle must live off the main thread.
    const worker = new Worker(scriptURL(new URL('./opfs-worker.js', import.meta.url)), {
      type: 'module',
    });
    await rpc(worker, { t: 'open', dir: 'incoming', name: safe });
    return new OpfsSink(handle, { kind: 'worker', worker }, meta, dir, safe);
  }

  constructor(handle, backend, meta, dir, filename) {
    this.kind = 'opfs';
    this.handle = handle;
    this.backend = backend;
    this.meta = meta;
    this.dir = dir;
    this.filename = filename;
    this.written = 0;
  }

  async write(offset, bytes) {
    if (this.backend.kind === 'writable') {
      await this.backend.writable.write({ type: 'write', position: offset, data: bytes });
    } else {
      await rpc(this.backend.worker, { t: 'write', offset, bytes }, [bytes.buffer]);
    }
    this.written += bytes.byteLength;
  }

  async close() {
    if (this.backend.kind === 'writable') await this.backend.writable.close();
    else {
      await rpc(this.backend.worker, { t: 'close' });
      this.backend.worker.terminate();
    }
    const file = await this.handle.getFile();
    // Blob URLs over an OPFS file stay disk-backed, so the bytes are not pulled into RAM.
    return {
      kind: 'opfs',
      name: this.meta.name,
      file: new File([file], this.meta.name, { type: this.meta.mime || 'application/octet-stream' }),
      cleanup: () => this.dir.removeEntry(this.filename).catch(() => {}),
    };
  }

  async abort() {
    try {
      if (this.backend.kind === 'writable') await this.backend.writable.abort();
      else this.backend.worker.terminate();
      await this.dir.removeEntry(this.filename);
    } catch {
      /* ignore */
    }
  }
}

/* ---------------------------------------------------------------- memory */

class MemorySink {
  static create(meta) {
    return new MemorySink(meta);
  }
  constructor(meta) {
    this.kind = 'memory';
    this.meta = meta;
    this.parts = new Map();
    this.written = 0;
  }
  async write(offset, bytes) {
    this.parts.set(offset, bytes);
    this.written += bytes.byteLength;
  }
  async close() {
    const ordered = [...this.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    this.parts.clear();
    return {
      kind: 'memory',
      name: this.meta.name,
      file: new File(ordered, this.meta.name, { type: this.meta.mime || 'application/octet-stream' }),
    };
  }
  async abort() {
    this.parts.clear();
  }
}

/* --------------------------------------------------------------- helpers */

function guessExt(name) {
  const i = (name || '').lastIndexOf('.');
  return i > 0 ? [name.slice(i)] : ['.bin'];
}

let rpcSeq = 0;
function rpc(worker, msg, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const onMsg = (e) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener('message', onMsg);
      e.data.err ? reject(new Error(e.data.err)) : resolve(e.data.result);
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ ...msg, id }, transfer);
  });
}

/**
 * Delete anything left behind in private storage by a previous visit.
 *
 * A received file is removed a minute after it has been handed over, which covers the
 * ordinary case and nothing else: close the tab, reload, or lose power before that timer
 * fires and the file stays permanently, against the quota, with no way for the person to see
 * it or remove it. A 48 MB leftover from an earlier session is what turned this up.
 *
 * The name carries the time it was created (base36 milliseconds), so a sweep needs no index
 * and cannot touch a transfer that is still running.
 */
export async function sweepIncoming(maxAgeMs = 10 * 60_000) {
  if (!navigator.storage?.getDirectory) return 0;
  let removed = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('incoming', { create: false });
    const cutoff = Date.now() - maxAgeMs;
    const stale = [];
    for await (const name of dir.keys()) {
      const stamp = parseInt(String(name).split('-')[0], 36);
      if (Number.isFinite(stamp) && stamp < cutoff) stale.push(name);
    }
    for (const name of stale) {
      try {
        await dir.removeEntry(name);
        removed++;
      } catch {
        /* still held open by something: leave it and try again next time */
      }
    }
  } catch {
    /* no directory yet, or storage refused, so there is nothing to sweep */
  }
  return removed;
}

/**
 * Offer a finished file to the user without ever materialising it in memory.
 *
 * @returns {'saved'|'needs-gesture'} 'needs-gesture' where a synthetic download click does
 * not save, as on iOS, which opens the blob in a viewer instead. There the caller has to
 * offer a Save the person taps, because the share sheet requires a real gesture.
 */
export function offerDownload(result) {
  if (result.kind === 'fsa') return 'saved'; // already on disk where they chose
  if (!platform().autoSave) return 'needs-gesture';

  downloadBlob(result.file, result.name, result.cleanup);
  return 'saved';
}
