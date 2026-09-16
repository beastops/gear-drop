/**
 * Decoding a HEIC, off the main thread.
 *
 * The decoder is three megabytes of asm.js. Parsing that on the main thread freezes the
 * interface for as long as it takes, and decoding a twelve-megapixel photo after it holds
 * the thread again, so both happen here and the page only ever receives a finished picture.
 *
 * What comes back is a *preview*, re-encoded and scaled down. That is the one place in this
 * app where a picture is re-encoded, and it is safe because it never touches the transfer:
 * the bytes on the wire are always the file the person picked, untouched and unexamined.
 * Nothing here is ever sent to anybody.
 */
import libheifFactory from '../vendor/libheif/libheif.js';

/** Built once and kept: the parse is the expensive part and a second photo should not pay it. */
let lib = null;

function decoder() {
  if (!lib) lib = libheifFactory();
  return lib;
}

/**
 * Fit inside a square without distorting, and never scale up.
 *
 * A preview that is larger than the box it is drawn into costs memory and download for
 * detail nobody sees, and a small photo blown up just looks wrong.
 */
function fit(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function toPreview(bytes, maxEdge, quality) {
  const heif = decoder();
  const images = new heif.HeifDecoder().decode(bytes);
  if (!images || !images.length) throw new Error('no picture inside this file');

  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!(width > 0 && height > 0)) throw new Error('the picture has no size');

  const raw = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const decoded = await new Promise((resolve, reject) => {
    // The callback is handed null rather than an error when libheif gives up.
    image.display(raw, (out) => (out ? resolve(out) : reject(new Error('the decoder gave up'))));
  });

  const full = new OffscreenCanvas(width, height);
  full.getContext('2d').putImageData(new ImageData(decoded.data, width, height), 0, 0);

  const box = fit(width, height, maxEdge);
  let canvas = full;
  if (box.width !== width || box.height !== height) {
    canvas = new OffscreenCanvas(box.width, box.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, box.width, box.height);
  }

  // JPEG, because this is a photograph and a lossless copy of one is many times the size for
  // detail that is invisible at preview scale.
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { blob, width, height };
}

self.addEventListener('message', async (e) => {
  const { id, bytes, maxEdge = 512, quality = 0.85 } = e.data || {};
  try {
    const { blob, width, height } = await toPreview(bytes, maxEdge, quality);
    self.postMessage({ id, ok: true, blob, width, height });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
