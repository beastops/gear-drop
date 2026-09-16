/**
 * Minimal QR encoder: byte mode, error-correction level L, versions 1–5 (single
 * error-correction block, so no interleaving needed). That covers ~106 characters,
 * which is more than any pairing URL needs.
 *
 * Written from the specification rather than pulled from a CDN: a file-transfer app
 * that claims "no third-party requests" cannot ship a remote script.
 */

const EC_L = 0b01;
const DATA_CODEWORDS = { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108 };
const EC_CODEWORDS = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26 };
const ALIGN_CENTER = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30] };

/* --------------------------------------------------------- GF(256) tables */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(ecLen);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecLen - 1] = 0;
    for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

/* ------------------------------------------------------------- bitstream */

function buildData(text, version) {
  const bytes = new TextEncoder().encode(text);
  const capacity = DATA_CODEWORDS[version];
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, 8); // versions 1–9 use an 8-bit count in byte mode
  for (const b of bytes) push(b, 8);

  const capacityBits = capacity * 8;
  if (bits.length > capacityBits) return null;

  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j];
    out[i] = v;
  }
  const padBytes = [0xec, 0x11];
  for (let i = Math.ceil(bits.length / 8), k = 0; i < capacity; i++, k++) out[i] = padBytes[k % 2];
  return out;
}

/* ---------------------------------------------------------------- matrix */

function newMatrix(size) {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(m, r, c) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isDark =
        inRing &&
        ((dr === 0 || dr === 6 || dc === 0 || dc === 6) ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = isDark ? 1 : 0;
    }
  }
}

function placeAlignment(m, version) {
  const centers = ALIGN_CENTER[version];
  for (const r of centers) {
    for (const c of centers) {
      if (m[r][c] !== -1) continue; // skip where a finder already sits
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          m[r + dr][c + dc] = isDark ? 1 : 0;
        }
      }
    }
  }
}

function reserveFormat(m) {
  const size = m.length;
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === -1) m[8][size - 1 - i] = 0;
    if (m[size - 1 - i][8] === -1) m[size - 1 - i][8] = 0;
  }
}

function buildSkeleton(version) {
  const size = 17 + 4 * version;
  const m = newMatrix(size);

  placeFinder(m, 0, 0);
  placeFinder(m, 0, size - 7);
  placeFinder(m, size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    m[6][i] = i % 2 === 0 ? 1 : 0;
    m[i][6] = i % 2 === 0 ? 1 : 0;
  }

  placeAlignment(m, version);
  m[size - 8][8] = 1; // dark module
  reserveFormat(m);

  const reserved = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => (m[r][c] === -1 ? 0 : 1)),
  );
  return { m, reserved, size };
}

function placeData(m, reserved, codewords) {
  const size = m.length;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
          bitIndex++;
        }
        m[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(m, reserved, maskIndex) {
  const size = m.length;
  const out = m.map((row) => Int8Array.from(row));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (MASKS[maskIndex](r, c)) out[r][c] ^= 1;
    }
  }
  return out;
}

function formatBits(maskIndex) {
  const data = (EC_L << 3) | maskIndex;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function writeFormat(m, maskIndex) {
  const size = m.length;
  const bits = formatBits(maskIndex);
  const get = (i) => (bits >> i) & 1;

  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);

  // Second copy: bits 0–6 climb the left column, bits 7–14 run along the top row.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = get(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = get(i);

  m[size - 8][8] = 1; // the always-dark module
}

function penalty(m) {
  const size = m.length;
  let score = 0;

  const runScore = (line) => {
    let run = 1;
    let s = 0;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) s += 3 + (run - 5);
    return s;
  };

  for (let r = 0; r < size; r++) score += runScore(Array.from(m[r]));
  for (let c = 0; c < size; c++) score += runScore(m.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

  return score;
}

/* ------------------------------------------------------------------- api */

/** @returns {{size:number, get:(r:number,c:number)=>0|1}|null} */
export function encodeQR(text) {
  for (let version = 1; version <= 5; version++) {
    const data = buildData(text, version);
    if (!data) continue;

    const ec = rsEncode(data, EC_CODEWORDS[version]);
    const codewords = new Uint8Array(data.length + ec.length);
    codewords.set(data, 0);
    codewords.set(ec, data.length);

    const { m, reserved, size } = buildSkeleton(version);
    placeData(m, reserved, codewords);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(m, reserved, mask);
      writeFormat(candidate, mask);
      const score = penalty(candidate);
      if (!best || score < best.score) best = { matrix: candidate, score };
    }

    return { size, get: (r, c) => best.matrix[r][c] };
  }
  return null;
}

/**
 * Read a finished symbol back out: recover the mask from the format bits, unmask, walk
 * the same zigzag, and return the codewords. Used by the tests to prove that placement,
 * masking and format encoding are mutually consistent. A QR code is not something you
 * can check by looking at it.
 */
export function readBack(qr) {
  const version = (qr.size - 17) / 4;
  const { reserved } = buildSkeleton(version);

  // Recover the mask from the first copy of the format information.
  let bits = 0;
  const fmtRead = [];
  for (let i = 0; i <= 5; i++) fmtRead.push(qr.get(8, i));
  fmtRead.push(qr.get(8, 7), qr.get(8, 8), qr.get(7, 8));
  for (let i = 9; i <= 14; i++) fmtRead.push(qr.get(14 - i, 8));
  for (let i = 0; i < 15; i++) bits |= fmtRead[i] << i;
  const unmasked = bits ^ 0x5412;
  const maskIndex = (unmasked >> 10) & 0b111;
  const ecLevel = (unmasked >> 13) & 0b11;

  const total = DATA_CODEWORDS[version] + EC_CODEWORDS[version];
  const out = new Uint8Array(total);
  let bitIndex = 0;
  let upward = true;

  for (let col = qr.size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < qr.size; i++) {
      const row = upward ? qr.size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        if (bitIndex >= total * 8) continue;
        let bit = qr.get(row, c);
        if (MASKS[maskIndex](row, c)) bit ^= 1;
        out[bitIndex >> 3] |= bit << (7 - (bitIndex & 7));
        bitIndex++;
      }
    }
    upward = !upward;
  }

  return { version, maskIndex, ecLevel, codewords: out, dataCodewords: out.subarray(0, DATA_CODEWORDS[version]) };
}

/** Decode the byte-mode payload from a symbol, for round-trip testing. */
export function readBackText(qr) {
  const { dataCodewords } = readBack(qr);
  const mode = dataCodewords[0] >> 4;
  if (mode !== 0b0100) return null;
  const len = ((dataCodewords[0] & 0x0f) << 4) | (dataCodewords[1] >> 4);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = ((dataCodewords[1 + i] & 0x0f) << 4) | (dataCodewords[2 + i] >> 4);
  }
  return new TextDecoder().decode(bytes);
}

/** Draw onto a canvas with a quiet zone. Returns false if the text is too long. */
export function drawQR(canvas, text) {
  const qr = encodeQR(text);

  /*
   * A code that will not fit leaves no box behind.
   *
   * This encoder goes up to version 5, which is 106 characters, and the thing being encoded is
   * `origin + pathname + #code`. That is about 77 on the longest deployment URL worth planning
   * for - a generated preview host on a free tier - so there is room, but not a lot of it, and
   * the failure was silent: `encodeQR` returns null, this returned false, every caller ignored
   * the result, and what stayed on screen was an empty white square where a code should be.
   *
 * Hiding it is the accurate state. The pairing code is already printed above the canvas in
   * digits, so nothing is lost except a square that could not have been scanned anyway.
   */
  if (!canvas) return false;
  canvas.hidden = !qr;
  if (!qr) return false;

  const quiet = 2;
  const total = qr.size + quiet * 2;
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  const px = Math.max(2, Math.floor((displaySize(canvas) * dpr) / total));

  // Only the backing store. How large it is drawn is decided in the stylesheet, so that a
  // phone in the wrong orientation, or a window being dragged narrower, does not need a
  // redraw to look right.
  canvas.width = total * px;
  canvas.height = total * px;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.get(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    }
  }
  return true;
}

/**
 * How wide this is actually being drawn, in CSS pixels.
 *
 * Deliberately not `canvas.width`. That attribute is the design size exactly once: the draw
 * below writes the device-pixel size back into it, so reading it again on the next call takes
 * a backing store for a layout size and doubles the picture. Three presses of "New code" and
 * the QR was wider than the phone.
 *
 * The laid-out width is the truth whenever there is one. There is not one while the sheet is
 * still closed, which is when the first code is usually drawn, so the design size is put
 * somewhere it cannot be overwritten the first time through and used until the layout has an
 * opinion.
 */
function displaySize(canvas) {
  if (!canvas.dataset.qrSize) canvas.dataset.qrSize = String(canvas.width || 180);
  const laid = Math.round(canvas.getBoundingClientRect?.().width || 0);
  return laid || Number(canvas.dataset.qrSize) || 180;
}
