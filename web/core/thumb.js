/**
 * A look at the picture before you agree to receive it.
 *
 * An offer is a claim: a name, a size, a type, all written by the other side. For a photo
 * that is not much to decide on - the name is whatever a camera called it and the size says
 * nothing about what it is a picture of. So a single image travels with a small rendering of
 * itself, and the sheet shows what you are being asked to accept rather than describing it.
 *
 * What this costs, stated plainly because it is a real change to how the app behaves:
 *
 *   - The thumbnail arrives *before* consent. Everything else in this app waits for an
 *     answer; this does not, because it exists to inform the answer. Someone can therefore
 *     put a picture on your screen by offering you one, and you can decline it afterwards
 *     but not before you have seen it. That is the trade, and it is the same one every
 *     messaging app makes.
 *   - It is never written anywhere. The bytes live in the control frame, become an object
 *     URL for as long as the sheet is open, and are released when it closes. Declining
 *     leaves nothing behind.
 *   - It is capped hard. A thumbnail is at most {@link MAX_THUMB_BYTES}, which is what
 *     stops the preview being used as a side channel for delivering content that was never
 *     accepted, and keeps the control frame far below what any transport will carry.
 *
 * The picture is re-encoded here rather than cropped out of the original, so nothing the
 * camera wrote into the file - where it was taken, on what, and when - travels with it.
 */

/** As many bytes as a preview may take on the wire, before base64. */
export const MAX_THUMB_BYTES = 16 * 1024;

/** And the same cap expressed the way it actually arrives. */
export const MAX_THUMB_B64 = Math.ceil(MAX_THUMB_BYTES / 3) * 4;

/** Longest edge of the rendering. Large enough to be looked at, small enough to be cheap. */
const MAX_EDGE = 320;

/*
 * Quality is tried downwards until it fits.
 *
 * A photograph of a wall compresses to nothing and a photograph of leaves does not, so a
 * single quality figure either wastes the budget on the easy picture or blows it on the hard
 * one. Three attempts settle both, and the worst case is three encodes of a 320px image.
 */
const QUALITY = [0.72, 0.56, 0.42];

/** Beyond this the decode is not worth attempting; the offer should not wait on it. */
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

/** Whatever the far end claims, a preview is drawn as one of these and nothing else. */
const THUMB_MIME = 'image/jpeg';

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * A type that claims to be a picture.
 *
 * Deliberately the whole family rather than the shorter list a conversation will accept: that
 * list is about what this browser can hold in memory and draw inline, and this question is
 * only whether a preview makes any sense. Whatever the claim, the preview itself is decoded
 * as a JPEG and nothing else.
 */
export function isImageMime(mime) {
  return /^image\//i.test(String(mime || ''));
}

/** Something a preview could be made of, judged before any of the work is started. */
export function canThumb(file) {
  if (!file || !isImageMime(file.type)) return false;
  return file.size > 0 && file.size <= MAX_SOURCE_BYTES;
}

/**
 * A small JPEG of this picture, ready to put on the wire, or null.
 *
 * Null is an ordinary answer: an offer with no preview looks exactly like every offer did
 * before, so nothing here is allowed to stop a file being sent. A format this browser cannot
 * decode - HEIC on Chrome, most often - simply produces null rather than pulling in a
 * decoder, because making the person wait several seconds before the offer is even sent is a
 * worse trade than showing them a filename.
 *
 * @param {File|Blob} file
 * @returns {Promise<{d: string, w: number, h: number} | null>}
 */
export async function makeThumb(file) {
  if (!canThumb(file)) return null;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return null;

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);

    for (const quality of QUALITY) {
      const blob = await canvas.convertToBlob({ type: THUMB_MIME, quality });
      if (blob.size <= MAX_THUMB_BYTES) {
        return { d: toBase64(new Uint8Array(await blob.arrayBuffer())), w, h };
      }
    }
    return null; // three tries and it still does not fit; a filename is the honest answer
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/**
 * The same check the manifest runs on everything else, for the one field that is a picture.
 *
 * Shape, size and alphabet, in that order, and a copy is returned rather than the object that
 * arrived - so nothing else on it travels any further, and a getter on a hostile object
 * cannot hand out one value here and another later.
 *
 * @returns {{d: string, w: number, h: number} | null}
 */
export function checkThumb(v) {
  if (!v || typeof v !== 'object') return null;
  const { d, w, h } = v;
  if (typeof d !== 'string' || d.length === 0 || d.length > MAX_THUMB_B64) return null;
  if (!B64_RE.test(d)) return null;
  if (!isEdge(w) || !isEdge(h)) return null;
  return { d, w, h };
}

/** A plausible pixel count for a rendering, not for the picture it was made from. */
const isEdge = (n) => Number.isInteger(n) && n > 0 && n <= MAX_EDGE * 8;

/**
 * A blob URL for a checked preview, or null.
 *
 * The type is this module's, never the sender's: the bytes are decoded as a JPEG or not at
 * all, so a preview cannot ask the browser to open something else on its behalf. The caller
 * owns the URL and must revoke it.
 */
export function thumbUrl(thumb) {
  const safe = checkThumb(thumb);
  if (!safe) return null;
  try {
    const bin = atob(safe.d);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: THUMB_MIME }));
  } catch {
    return null;
  }
}

/** Bytes to base64, in blocks, because `String.fromCharCode` takes arguments and not arrays. */
function toBase64(bytes) {
  let s = '';
  const BLOCK = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCK));
  }
  return btoa(s);
}
