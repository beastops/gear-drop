/**
 * Messages coming apart into dust.
 *
 * Destroying a conversation used to be instant and silent: the bubbles were there, and then
 * the log was empty. Correct, and it looked like a repaint rather than like something
 * happening, which for the one irreversible thing in this app is the wrong impression to
 * leave. Telegram answers this by crumbling the message into dust, and it is worth copying
 * because it reads as *destruction* rather than as a list being emptied.
 *
 * The thing that makes theirs work, and which two earlier attempts here missed, is where the
 * grains get their colour. Telegram draws the message view into a bitmap and emits a particle
 * per pixel, each carrying that pixel's own colour, so the words themselves come apart. Dust
 * invented in the bubble's two flat colours is a different effect however carefully it moves:
 * the text blinks out and a cloud appears over the hole, which is what "premade dust" means.
 *
 * So the bubble is rasterised first and every grain is a pixel of it. Text goes to pale
 * grains, the fill goes to blue ones, a photo goes to whatever the photo was.
 *
 * Rasterising also gets the safety back. The earlier version eroded the live elements, which
 * meant keeping the messages in the document while it played; here the bitmap is taken, the
 * caller empties the log exactly as it always did, and what animates is pixels on a canvas
 * with no text, no nodes and no way back.
 */

/** The dissolve front crossing one bubble. */
const SWEEP_MS = 420;
/** How long a grain lives once the front reaches it. */
const LIFE_MS = 700;
/** Longest a single grain can outlive the others, so the tail does not end on a hard edge. */
const LIFE_SPREAD = 0.4;
const TOTAL_MS = SWEEP_MS + LIFE_MS * (1 + LIFE_SPREAD);

/**
 * How many grains the whole sweep may use.
 *
 * Measured rather than picked. A grain is one `fillRect`, and on this machine six thousand
 * cost about three milliseconds a frame against a budget of sixteen. The sampling step is
 * derived from this and the total area, so a two-line conversation and a two-hundred-line one
 * both animate at the same cost; only the grains get coarser.
 */
const BUDGET = 5200;
/** Never sample finer than this many device pixels, or a small bubble makes needless work. */
const MIN_STEP = 2;

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/**
 * Value noise over a coarse grid, so neighbouring pixels get similar numbers.
 *
 * This is what makes the dissolve edge ragged instead of a ruled line. Per-grain randomness
 * would only fuzz the line by a pixel or two and still read as a line; sampling a grid a few
 * pixels across means whole clumps go together, the way something brittle actually breaks.
 */
function clumpNoise(x, y) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

/**
 * Copy an element's appearance onto a clone, property by property.
 *
 * A `<foreignObject>` is its own document fragment: the page's stylesheets do not reach
 * inside it, so a clone dropped in there renders as unstyled markup. Every computed property
 * has to travel with it. Verbose and slow, and it runs a handful of times on a click.
 */
/**
 * What a bubble needs to look like itself, and nothing else.
 *
 * Copying every computed property works and is enormous: around three hundred and fifty of
 * them per element, which for one bubble and its children turns into hundreds of kilobytes of
 * serialised markup and a data URL the browser then has to parse before a single grain can be
 * drawn. These are the ones that paint. Layout comes along for free because each clone is
 * given the exact box its original measured.
 */
const PAINTED = [
  'box-sizing', 'display', 'position', 'overflow', 'visibility', 'opacity', 'z-index',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'gap', 'flex',
  'background-color', 'background-image', 'background-size', 'background-position',
  'background-repeat', 'background-clip', 'background-origin',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-left-radius', 'border-bottom-right-radius',
  'box-shadow', 'color', 'font-family', 'font-size', 'font-weight', 'font-style',
  'font-variant-numeric', 'letter-spacing', 'line-height', 'text-align', 'text-decoration',
  'text-transform', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap',
  'vertical-align', 'fill', 'stroke', 'stroke-width',
];

function inlineStyle(src, dst) {
  const cs = getComputedStyle(src);
  /*
   * Set one property at a time rather than assembling a `style` attribute.
   *
   * `setAttribute('style', …)` is an inline style as far as the policy is concerned, and this
   * app serves `style-src 'self'` with no `unsafe-inline`, so every one of them was refused:
   * a hundred console violations per delete and a clone that kept none of the styling it was
   * copied for. Writing through the CSSOM is the same result and is not an inline style.
   */
  for (const prop of PAINTED) {
    const value = cs.getPropertyValue(prop);
    if (value) dst.style.setProperty(prop, value);
  }

  const from = src.children;
  const to = dst.children;
  for (let i = 0; i < from.length && i < to.length; i++) inlineStyle(from[i], to[i]);
}

/**
 * Freeze an element into an SVG data URL. Must run while it is still in the document.
 *
 * This is the half that cannot wait. `getComputedStyle` on a detached node reports nothing,
 * so a snapshot taken after the caller has emptied the log inlines a stylesheet of defaults
 * and rasterises to a transparent rectangle: no colours, no text, no grains, and no error
 * either. Serialising here and decoding later is what keeps the styles real while still
 * letting the messages leave the document on the same tick they always did.
 */
function snapshot(el, w, h) {
  const clone = el.cloneNode(true);
  inlineStyle(el, clone);
  // It is positioned by the SVG, not by whatever it used to sit in.
  clone.style.margin = '0';
  clone.style.position = 'static';
  clone.style.transform = 'none';

  const xml = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px">${xml}</div>` +
    `</foreignObject></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The snapshot as pixels.
 *
 * `<foreignObject>` in an SVG is the only way a browser will draw arbitrary markup into a
 * canvas without a library. It has real limits: no external stylesheet, no webfont that is
 * not already inlined, and nothing that would taint the canvas, which is why the clone is
 * styled inline and carries no image from anywhere but this origin. Where a browser refuses,
 * the whole effect is skipped and the delete is the instant one it used to be.
 */
async function rasterise(url, w, h, dpr) {
  const img = new Image();
  img.decoding = 'sync';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('the bubble could not be drawn'));
    img.src = url;
  });

  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, c.width, c.height);
  return g.getImageData(0, 0, c.width, c.height);
}

/**
 * Take a picture of the messages and hand back a function that dissolves it.
 *
 * The measuring is synchronous so the caller's own clearing runs on the same tick it always
 * did. The drawing is not: the bitmaps are decoded after the log is already empty, which
 * costs a frame or two of nothing before the dust appears and keeps the messages out of the
 * document the whole time.
 *
 * @param {HTMLElement} host    a positioned ancestor the canvas is drawn over
 * @param {Iterable<HTMLElement>} nodes  the elements coming apart
 * @returns {() => void} start
 */
export function captureDust(host, nodes) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = [...nodes];
  /*
   * A hidden tab gets nothing. `requestAnimationFrame` does not run in one, so an animation
   * started there is frozen at its first frame and plays out stale whenever somebody returns.
   * A wipe arriving from the other device is exactly the case that happens in.
   */
  if (reduced || !items.length || !host || document.hidden) return () => {};

  const frame = host.getBoundingClientRect();
  const shots = [];
  for (const el of items) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.bottom < frame.top || r.top > frame.bottom) continue;
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    // Serialised now, while the styles are still real. Decoded later.
    shots.push({ url: snapshot(el, w, h), x: r.left - frame.left, y: r.top - frame.top, w, h });
  }
  if (!shots.length) return () => {};

  return () => {
    run(host, frame, shots).catch(() => {
      /* a browser that will not rasterise gets the plain instant delete it had before */
    });
  };
}

/** Turn the bitmaps into grains, one per sampled pixel, carrying that pixel's colour. */
function build(pictures, dpr) {
  const area = pictures.reduce((n, p) => n + p.pixels.width * p.pixels.height, 0);
  // One step for the whole sweep, so a long conversation gets coarser rather than slower.
  const step = Math.max(MIN_STEP, Math.round(Math.sqrt(area / BUDGET)));
  const dust = [];

  for (const p of pictures) {
    const { width: W, height: H, data } = p.pixels;
    for (let py = 0; py < H; py += step) {
      for (let px = 0; px < W; px += step) {
        const i = (py * W + px) * 4;
        const a = data[i + 3];
        if (a < 12) continue; // outside the bubble's rounded corners, or fully clear

        const fx = px / W;
        /*
         * When this grain goes: mostly its column, partly the clump it belongs to. All
         * column and the edge is a ruled line sweeping across; all noise and the bubble
         * dissolves everywhere at once with no sense of direction.
         */
        const clump = clumpNoise(Math.floor(px / 9), Math.floor(py / 9));
        const when = Math.min(1, Math.max(0, fx * 0.78 + clump * 0.26 - 0.04));

        dust.push({
          x: p.x + px / dpr,
          y: p.y + py / dpr,
          colour: `rgba(${data[i]},${data[i + 1]},${data[i + 2]},${(a / 255).toFixed(3)})`,
          size: (step / dpr) * rand(0.9, 1.5),
          vx: rand(-0.02, 0.1) + fx * 0.05,
          vy: rand(-0.17, -0.05),
          // Its own slow sway, so it travels on a curve instead of a ray.
          phase: rand(0, TAU),
          rate: rand(0.004, 0.011),
          sway: rand(1.2, 4.8),
          life: LIFE_MS * rand(1 - LIFE_SPREAD, 1 + LIFE_SPREAD),
          delay: when * SWEEP_MS,
        });
      }
    }
  }
  return dust;
}

async function run(host, frame, shots) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const pictures = [];
  for (const s of shots) {
    const pixels = await rasterise(s.url, s.w, s.h, dpr);
    pictures.push({ x: s.x, y: s.y, pixels });
  }
  if (!pictures.length) return;

  const dust = build(pictures, dpr);
  if (!dust.length) return;

  const canvas = document.createElement('canvas');
  canvas.className = 'dust-layer';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.width = Math.max(1, Math.round(frame.width * dpr));
  canvas.height = Math.max(1, Math.round(frame.height * dpr));
  canvas.style.width = `${frame.width}px`;
  canvas.style.height = `${frame.height}px`;
  host.append(canvas);

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  let started = 0;
  let raf = 0;
  const done = () => {
    cancelAnimationFrame(raf);
    clearTimeout(backstop);
    canvas.remove();
  };
  /*
   * Frames are what normally ends this, and frames stop if the tab is hidden part way
   * through. The clock does not, so it gets the last word and the canvas cannot be stranded.
   */
  const backstop = setTimeout(done, TOTAL_MS + 700);
  host.closest('dialog')?.addEventListener('close', done, { once: true });

  const step = (now) => {
    if (!started) started = now;
    const t = now - started;
    if (t > TOTAL_MS + 40) return done();

    ctx.clearRect(0, 0, frame.width, frame.height);

    for (const g of dust) {
      const age = t - g.delay;
      const k = age <= 0 ? 0 : age / g.life;
      if (k >= 1) continue;

      let x = g.x;
      let y = g.y;
      let alpha = 1;
      let size = g.size;

      if (age > 0) {
        const travel = age * (1 - k * 0.42);
        const sway = Math.sin(age * g.rate + g.phase) * g.sway * k;
        x += g.vx * travel + sway;
        y += g.vy * travel + k * k * 7 + Math.cos(age * g.rate * 0.7 + g.phase) * g.sway * 0.4 * k;
        // Holds for a moment, then goes. A grain that fades from the instant it detaches
        // never looks like it was part of anything solid.
        alpha = k < 0.28 ? 1 : 1 - ((k - 0.28) / 0.72) ** 1.7;
        size = g.size * (1 - k * 0.45);
      }

      if (alpha <= 0.02 || size <= 0.15) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g.colour;
      ctx.fillRect(x, y, size, size);
    }

    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);
}
