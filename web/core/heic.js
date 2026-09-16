/**
 * Showing an iPhone photo on a browser that cannot read one.
 *
 * Every picture an iPhone takes is HEIC, and Chrome and Firefox cannot draw it. Sending one
 * has always worked, because a transfer moves bytes and never looks inside them, but the
 * thumbnail on the way out was an empty square.
 *
 * Two tiers, and the cheap one belongs to the caller:
 *
 *   1. The browser itself. Safari on a Mac or an iPhone draws HEIC natively, which covers
 *      most of the photos that exist, and costs nothing. The caller tries this first with an
 *      `<img>`, so by the time anything here runs, the browser has already said no.
 *   2. The decoder, three megabytes of it, fetched only now and only once.
 *
 * `ImageDecoder` is deliberately not a tier in between. It draws through the same image
 * pipeline the `<img>` just refused, so where the element cannot decode a file the decoder
 * almost never can either, and the few builds where they differ would need this module to
 * grow a second copy of the worker's scaling and encoding to make any use of it. A tier that
 * is nearly always dead weight is not worth the code that would keep it honest.
 *
 * Nothing is downloaded until somebody actually holds a HEIC, so the cost lands on the
 * people who need it and on nobody else.
 */
import { scriptURL } from './tt.js';

/** What an iPhone, and the odd camera, calls these. */
const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

/** A type is not always set on a file the system handed over, so the name gets a say too. */
export function looksHeic(file) {
  if (!file) return false;
  const type = String(file.type || '').toLowerCase();
  if (HEIC_TYPES.has(type)) return true;
  return !type && /\.hei[cf]$/i.test(String(file.name || ''));
}

let worker = null;
let nextId = 1;
const waiting = new Map();

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(scriptURL(new URL('./heic-worker.js', import.meta.url)), { type: 'module' });
  worker.addEventListener('message', (e) => {
    const { id } = e.data || {};
    const settle = waiting.get(id);
    if (!settle) return;
    waiting.delete(id);
    settle(e.data);
  });
  worker.addEventListener('error', () => {
    // The worker could not start at all, so every request on it is dead and a new one is
    // built next time. Without this they would hang rather than fall back to the icon.
    for (const settle of waiting.values()) settle({ ok: false, error: 'the decoder could not start' });
    waiting.clear();
    worker?.terminate();
    worker = null;
  });
  return worker;
}

/**
 * A drawable preview of a HEIC, or null when this browser cannot manage one.
 *
 * Null is an ordinary answer, not a failure: the caller keeps its file icon, which is a
 * better thing to show than an empty frame.
 *
 * @param {File|Blob} file
 * @param {{maxEdge?: number, quality?: number}} opts
 * @returns {Promise<Blob|null>} a JPEG preview, or null
 */
export async function heicPreview(file, { maxEdge = 512, quality = 0.85 } = {}) {
  if (!file) return null;

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const id = nextId++;
    const reply = await new Promise((resolve) => {
      waiting.set(id, resolve);
      // Transferred, not copied: a photo is tens of megabytes and the page is done with it.
      ensureWorker().postMessage({ id, bytes, maxEdge, quality }, [bytes.buffer]);
    });
    return reply?.ok ? reply.blob : null;
  } catch {
    return null;
  }
}
