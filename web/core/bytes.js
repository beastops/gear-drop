/** Byte and encoding helpers. No dependencies, no surprises. */

export const te = new TextEncoder();
export const td = new TextDecoder();

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** getRandomValues refuses more than 65536 bytes per call, so fill in slices. */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  for (let off = 0; off < n; off += 65536) {
    crypto.getRandomValues(b.subarray(off, Math.min(off + 65536, n)));
  }
  return b;
}

export function toHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** Constant-time-ish equality. Both inputs are already public-length. */
export function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Length-prefixed concatenation, as used by the CPace transcript. */
export function lvCat(...parts) {
  const out = [];
  for (const p of parts) {
    const b = typeof p === 'string' ? te.encode(p) : p;
    if (b.length > 255) throw new Error('lvCat: part too long');
    out.push(new Uint8Array([b.length]), b);
  }
  return concat(...out);
}

export function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

export function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

/** Pad a plaintext up to a multiple of `block`, length-prefixed so it can be stripped. */
export function pad(body, block = 256) {
  const total = Math.ceil((body.length + 4) / block) * block;
  const out = new Uint8Array(total);
  out.set(u32le(body.length), 0);
  out.set(body, 4);
  return out;
}

export function unpad(padded) {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, true);
  if (len > padded.length - 4) throw new Error('unpad: bad length');
  return padded.subarray(4, 4 + len);
}

export function fmtBytes(n) {
  if (n >= 1e9) return (n / 1073741824).toFixed(n >= 10 * 1073741824 ? 0 : 1) + ' GB';
  if (n >= 1e6) return (n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1) + ' MB';
  if (n >= 1e3) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

export function fmtRate(bps) {
  const bits = bps * 8;
  if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gb/s';
  if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mb/s';
  if (bits >= 1e3) return (bits / 1e3).toFixed(0) + ' kb/s';
  return Math.round(bits) + ' b/s';
}

export function fmtDuration(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return Math.ceil(seconds) + 's';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
