/**
 * The radar.
 *
 * Concentric rings breathing outward from the bottom of the screen, which is the visual
 * language people associate with "devices near me". This one is reactive: it brightens when a
 * device appears, emits a burst on connect, and rides the throughput during a transfer, so
 * the background reports something rather than only moving.
 *
 * Rendering goes to an OffscreenCanvas worker when the browser allows it, so a 4 GB
 * transfer never costs a dropped frame. The same drawing code runs on the main thread
 * otherwise.
 */

import { scriptURL } from './tt.js';

/*
 * How many rings fit inside `reach`, which sets how far apart they sit.
 *
 * At nine rings they sat 97 pixels apart and only five stood above the beacon, which reads as
 * a few stray arcs rather than a field going out from a point. Thirteen brings the spacing to
 * 67 and puts nine of them above the beacon, which is the density the idea needs.
 */
const RING_COUNT = 13;

export class Radar {
  /** @param {object} opts.originEl  the element the rings radiate from, the beacon */
  constructor(canvas, { originEl } = {}) {
    this.canvas = canvas;
    this.originEl = originEl;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.state = {
      intensity: 0.24, // present enough to read as a radar, quiet enough to sit behind everything
      speed: 0.2, // cycles per second
      hue: 'accent',
      lift: 0, // share mode raises the level; nothing else does
      burst: 0, // decaying 0..1, drives the flash ring
      sweep: 0, // radians, the slow radar sweep
      flow: 0, // 0..1 transfer activity
      seeking: 0, // 1 while looking for devices and finding none yet
    };

    this.worker = null;
    this._raf = 0;
    this._last = 0;
    this._phase = 0;
    this._paused = false;

    this._setup();
    addEventListener('resize', () => this.resize(), { passive: true });
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', (e) => {
      this.reduced = e.matches;
      this._post({ t: 'reduced', reduced: this.reduced });
    });
  }

  _setup() {
    const colors = readColors();
    if (this.canvas.transferControlToOffscreen && !this.reduced) {
      try {
        const off = this.canvas.transferControlToOffscreen();
        this.worker = new Worker(scriptURL(new URL('./ripple-worker.js', import.meta.url)), {
          type: 'module',
        });
        this.worker.postMessage({ t: 'init', canvas: off, colors, rings: RING_COUNT }, [off]);
        this.resize();
        return;
      } catch {
        this.worker = null;
      }
    }
    this.ctx = this.canvas.getContext('2d');
    this.colors = colors;
    this.resize();
    this._loop(performance.now());
  }

  _post(msg) {
    if (this.worker) this.worker.postMessage(msg);
  }

  resize() {
    /*
     * Fewer fragments on a phone.
     *
     * The radar is soft rings on a dark ground: at 1.5 nobody can tell, and it is a quarter
     * less of the screen to shade on the one device that is paying for it out of the same
     * thermal budget as the modem and the display. It is the last thing in this app still
     * drawing every frame.
     */
    // `(pointer: coarse)` and not `(hover: none)`: Android Chrome answers the second one
    // `false`, so the ceiling this line exists to impose was never once applied on a phone.
    const ceiling = matchMedia('(pointer: coarse)').matches ? 1.5 : 2;
    const dpr = Math.min(ceiling, devicePixelRatio || 1);
    const w = document.documentElement.clientWidth;
    const h = document.documentElement.clientHeight;
    // Centre the rings exactly on the beacon, so the two read as one object rather than
    // as an animation that happens to sit near a logo.
    const box = this.originEl?.getBoundingClientRect();
    const originX = box ? box.left + box.width / 2 : w / 2;
    const originY = box ? box.top + box.height / 2 : h - 90;

    this.metrics = { w, h, dpr, originX, originY };

    /*
     * Size the element on every path, worker or not. The worker owns the bitmap; the box it
     * is displayed in is always the main thread's, and `style` stays writable after the
     * bitmap is transferred. Without this the canvas falls back to its intrinsic size and
     * lays out at `dpr` times the viewport: invisible at dpr 1, wrong on every phone.
     */
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    if (this.worker) {
      this._post({ t: 'resize', w, h, dpr, originX, originY });
      return;
    }
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * What the glass layer needs in order to draw the same scene this does.
   *
   * The rings are drawn on a worker, on a canvas the main thread cannot read back, so the
   * glass recomputes them rather than sampling. Both sides advance the same two numbers from
   * the same speed, so they stay in step without anything being copied. A frame of drift is
   * invisible: what the glass shows of the radar is a band a few pixels wide at the edge of a
   * button.
   */
  snapshot(now = performance.now()) {
    const dt = Math.min(0.05, (now - (this._mirrorAt || now)) / 1000);
    this._mirrorAt = now;
    if (!this.reduced && !this._paused) {
      this._mirrorPhase = ((this._mirrorPhase || 0) + dt * this.state.speed) % 1;
      this._mirrorSweep = ((this._mirrorSweep || 0) + dt * (0.34 + (this.state.seeking || 0) * 0.5)) % (Math.PI * 2);
    }
    const m = this.metrics || {};
    const reach = Math.max((m.w || innerWidth) * 0.8, (m.h || innerHeight) * 1.15);
    return {
      originX: m.originX,
      originY: m.originY,
      gap: reach / RING_COUNT,
      phase: this._mirrorPhase || 0,
      sweep: this._mirrorSweep || 0,
      seeking: this.state.seeking || 0,
    };
  }

  /** Refresh the palette after a theme change. */
  refreshColors() {
    const colors = readColors();
    this.colors = colors;
    this._post({ t: 'colors', colors });
  }

  /**
   * Stop painting entirely.
   *
   * Called whenever a modal is open. Nothing behind a modal needs to animate, and the cost
   * of leaving it running is not the canvas: every frosted surface above it then has an
   * animating backdrop, so its blur cannot be cached and is recomputed every frame. A sheet
   * dragged over a live radar is the most expensive thing this interface draws, and the one
   * that most needs to be smooth.
   */
  pause() {
    if (this._paused) return;
    this._paused = true;
    if (this.worker) this._post({ t: 'paused', paused: true });
    else if (this._raf) cancelAnimationFrame(this._raf);
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    if (this.worker) {
      this._post({ t: 'paused', paused: false });
      return;
    }
    this._last = 0; // do not integrate the time we spent asleep
    this._loop(performance.now());
  }

  /** A one-off bright ring, for a device appearing or a transfer landing. */
  burst() {
    if (this.reduced) return;
    this.state.burst = 1;
    this._post({ t: 'state', state: this.state });
  }

  /** 0 = nobody here, 1 = connected and busy. */
  setEnergy(level) {
    this.state.intensity = 0.22 + 0.1 * level;
    this.state.speed = 0.18 + 0.14 * level;
    this._post({ t: 'state', state: this.state });
  }

  /**
   * Looking, and not having found anything yet.
   *
   * At rest the sweep is barely there, deliberately, because it sits behind everything.
   * "Nothing found" is when someone is watching the screen to see whether the app is doing
   * anything, and a background that faint reads as stopped rather than searching. While there
   * is nobody on the radar and discovery is on, the sweep is brought up to something visible.
   */
  setSearching(on) {
    const next = on ? 1 : 0;
    if (this.state.seeking === next) return;
    this.state.seeking = next;
    this._post({ t: 'state', state: this.state });
  }

  /** Live transfer activity, 0..1, modulates the ring thickness. */
  setFlow(v) {
    this.state.flow = Math.max(0, Math.min(1, v));
    this._post({ t: 'state', state: this.state });
  }

  /**
   * Which discovery channel the room is about right now, in the same colour language the
   * tiles use, so the background agrees with the foreground instead of decorating it. Share
   * mode raises the level, because it is the state waiting on the user.
   */
  setMood(mood) {
    this.state.hue = mood; // 'accent' | 'verified' | 'local' | 'room' | 'share'
    this.state.lift = mood === 'share' ? 1 : 0;
    this._post({ t: 'state', state: this.state });
  }

  /* ------------------------------------------------ main-thread fallback */

  _loop(now) {
    if (this._paused) return;
    const dt = Math.min(0.05, (now - this._last) / 1000 || 0);
    this._last = now;
    if (!this.reduced) {
      this._phase = (this._phase + dt * this.state.speed) % 1;
      this.state.sweep =
        (this.state.sweep + dt * (0.34 + (this.state.seeking || 0) * 0.5)) % (Math.PI * 2);
    }
    if (this.state.burst > 0) this.state.burst = Math.max(0, this.state.burst - dt * 1.4);
    drawRadar(this.ctx, this.metrics, this.state, this._phase, this.colors, RING_COUNT);
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }
}

/* ------------------------------------------------------------ drawing */

export function drawRadar(ctx, m, state, phase, colors, rings) {
  if (!ctx || !m) return;
  const { w, h, originY, originX } = m;
  ctx.clearRect(0, 0, w, h);

  const x0 = originX ?? w / 2;
  const y0 = originY;
  const reach = Math.max(w * 0.8, h * 1.15);
  const gap = reach / rings;
  // Every mood is a pair: the colour a ring is born with and the one it retires into.
  const [near, far] = MOODS[state.hue] ? MOODS[state.hue](colors) : MOODS.accent(colors);
  const lift = state.lift || 0;

  ctx.lineCap = 'round';

  /*
    * A pool of light around the origin - which is *this* device, not a peer. So it is the
    * accent, never a channel colour: the channel colours belong on the device circles, and
    * letting one of them wash the page would turn colour back into decoration.
    *
    * It is also a dark-room effect, and only a dark-room effect. Light does not pool on white
    * paper; a translucent blue wash over a pale ground does not read as a glow, it reads as a
    * stain across the bottom half of the page. So on a light theme there is no pool - the
    * accent stays where it means something, on the title and the beacon.
    */
  if (state.intensity > 0.01 && !colors.light) {
    const r = reach * 0.5;
    const pool = ctx.createRadialGradient(x0, y0, 0, x0, y0, r);
    const depth = 0.07 + state.flow * 0.06 + lift * 0.1;
    pool.addColorStop(0, `rgba(${colors.accent},${depth.toFixed(4)})`);
    pool.addColorStop(0.45, `rgba(${colors.accent},${(depth * 0.3).toFixed(4)})`);
    pool.addColorStop(1, `rgba(${colors.accent},0)`);
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.arc(x0, y0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /*
   * Bearing lines, drawn under the rings at a fraction of their weight, enough to say the
   * scan has a geometry.
   *
   * Only where the dial fits. `reach` follows the taller side, so on a phone the face
   * arrives as a few near-vertical strokes and reads as debris rather than an instrument.
   */
  const faceFits = reach * 0.46 <= w * 0.5;
  if (state.intensity > 0.01 && !colors.light && faceFits) {
    const faceAlpha = state.intensity;
    const spokes = 12;

    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      const cardinal = i % 3 === 0; // every 90 degrees carries a little more weight
      const from = 34;
      const to = reach * (cardinal ? 0.98 : 0.72);
      const line = ctx.createLinearGradient(
        x0 + Math.cos(a) * from, y0 + Math.sin(a) * from,
        x0 + Math.cos(a) * to, y0 + Math.sin(a) * to,
      );
      const peak = faceAlpha * (cardinal ? 0.44 : 0.26);
      line.addColorStop(0, `rgba(${colors.neutral},0)`);
      line.addColorStop(0.18, `rgba(${colors.neutral},${peak.toFixed(4)})`);
      line.addColorStop(1, `rgba(${colors.neutral},0)`);
      ctx.beginPath();
      ctx.moveTo(x0 + Math.cos(a) * from, y0 + Math.sin(a) * from);
      ctx.lineTo(x0 + Math.cos(a) * to, y0 + Math.sin(a) * to);
      ctx.lineWidth = cardinal ? 1 : 0.75;
      ctx.strokeStyle = line;
      ctx.stroke();
    }

    /*
     * No graduations. They landed as scattered dashes on an arc whose curve ran off-screen,
     * and claimed a resolution this app never reports.
     */
  }

  /*
   * A slow sweep, the way a radar actually reads. Costs one fill per frame.
   *
   * Dark only, and for the same reason the pool is. A sweep is a light source: on black it
   * looks like something passing over the screen, and on white the only thing a translucent
   * wedge can do is grey out a quarter of the page at a time. What reads as an instrument on
   * one ground reads as a smudge on the other, and there is no alpha that fixes that - it is
   * the wrong effect for the surface rather than too much of the right one.
   */
  if (ctx.createConicGradient && state.intensity > 0.01 && !colors.light) {
    const sweep = ctx.createConicGradient(state.sweep || 0, x0, y0);
    // Kept deliberately faint: on a light background a translucent wedge reads much
    // stronger than it does on a dark one.
    // A translucent wedge reads far stronger on a light ground than on a dark one, so
    // the sweep is halved there rather than being tuned for one theme and tolerated in the
    // other.
    const peak =
      (0.012 + state.flow * 0.03 + lift * 0.02 + (state.seeking || 0) * 0.055) *
      (state.intensity / 0.2) *
      (colors.light ? 0.28 : 1);
    sweep.addColorStop(0, `rgba(${far},${peak.toFixed(4)})`);
    sweep.addColorStop(0.14, `rgba(${far},0)`);
    sweep.addColorStop(1, `rgba(${far},0)`);
    ctx.fillStyle = sweep;
    ctx.beginPath();
    ctx.arc(x0, y0, reach, 0, Math.PI * 2);
    ctx.fill();

    /*
     * The leading edge.
     *
     * A wedge of light alone reads as a smudge that happens to rotate. What makes a sweep
     * look like a sweep is the bright line at its front, the beam itself, with the glow
     * behind it as the decay. One stroke separates a gradient from an instrument.
     */
    const a = state.sweep || 0;
    const edge = ctx.createLinearGradient(x0, y0, x0 + Math.cos(a) * reach, y0 + Math.sin(a) * reach);
    const bright = peak * 9;
    edge.addColorStop(0, `rgba(${far},0)`);
    edge.addColorStop(0.12, `rgba(${far},${bright.toFixed(4)})`);
    edge.addColorStop(1, `rgba(${far},0)`);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + Math.cos(a) * reach, y0 + Math.sin(a) * reach);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = edge;
    ctx.stroke();
  }

  for (let i = rings; i >= 0; i--) {
    const r = gap * (i + phase) + 26;
    if (r <= 0 || r > reach + gap) continue;

    // Fade with distance, and a soft fade-in for the ring being born at the centre.
    const distance = 1 - r / (reach + gap);
    let alpha = state.intensity * (1 + lift * 0.6) * (0.34 + 0.66 * Math.pow(Math.max(0, distance), 0.75));
    if (i === rings) alpha *= 1 - phase; // the outermost ring retires gently
    if (i === 0) alpha *= phase; // the newest one arrives gently

    /*
     * Ramp the first couple of gaps so rings grow out of the beacon. Brightness falls off
     * with distance, so without this the nearest ring is a vivid collar around the beacon,
     * reading as a separate piece of interface rather than the near end of the field.
     */
    alpha *= Math.min(1, r / (gap * 2.2));
    if (alpha <= 0.002) continue;

    // The rings are structure, not colour: they are drawn in the interface's own line
    // grey, and the channel colour only leans into the middle of each one. Tinting the
    // whole screen would make colour mean "there is an app running" instead of "this is
    // how that device is reachable", which is the one job colour has here.
    const mix = Math.min(1, r / reach);

    /*
     * On a light ground a ring is a pencil line, and a pencil line is one colour.
     *
     * The tinted middle works on black because a dark screen has room for a colour to sit in
     * without becoming the subject. On white it does not: four stops of blue-to-grey across
     * every ring turns a drawing into a gradient, and a page of gradients is the thing this
     * was meant to look nothing like.
     *
     * What the ring gets instead is a temperature. Each one is still a single flat colour,
     * since the objection above is to a gradient across one ring rather than to the field
     * having an origin, and the ones nearest the beacon are mixed a little toward the mood
     * before settling into grey further out. Thirteen identical circles read as a repeating
     * pattern; the same thirteen, warmer at the middle, read as radiating from a point.
     */
    ctx.beginPath();
    ctx.arc(x0, y0, r, 0, Math.PI * 2);
    ctx.lineWidth = 1 + state.flow * 1.6;
    if (colors.light) {
      const lean = 0.55 * (1 - mix) * (1 - mix);
      ctx.strokeStyle = `rgba(${blend(colors.neutral, near, lean)},${(alpha * 1.1).toFixed(4)})`;
    } else {
      const grad = ctx.createLinearGradient(x0 - r, y0, x0 + r, y0);
      grad.addColorStop(0, `rgba(${colors.neutral},${(alpha * 0.9).toFixed(4)})`);
      grad.addColorStop(0.34, `rgba(${near},${(alpha * (0.7 - mix * 0.25)).toFixed(4)})`);
      grad.addColorStop(0.66, `rgba(${far},${(alpha * (0.7 - mix * 0.25)).toFixed(4)})`);
      grad.addColorStop(1, `rgba(${colors.neutral},${(alpha * 0.9).toFixed(4)})`);
      ctx.strokeStyle = grad;
    }
    ctx.stroke();
  }

  // The burst: a single bright ring racing outward, thinning as it decays.
  if (state.burst > 0) {
    const p = 1 - state.burst;
    const r = 26 + p * reach * 0.95;
    ctx.beginPath();
    ctx.arc(x0, y0, r, 0, Math.PI * 2);
    ctx.lineWidth = 1 + state.burst * 2.4;
    ctx.strokeStyle = `rgba(${far},${(state.burst * 0.55).toFixed(3)})`;
    ctx.stroke();
  }
}

/**
 * Mix two "r,g,b" triples, `t` of the way from the first to the second.
 *
 * The palette travels as strings because alpha is applied per ring and per stop, and parsing
 * it back here is cheaper than carrying two representations of the same six numbers.
 */
function blend(a, b, t) {
  const x = a.split(',');
  const y = b.split(',');
  return [0, 1, 2]
    .map((i) => Math.round(Number(x[i]) + (Number(y[i]) - Number(x[i])) * t))
    .join(',');
}

/**
 * Mood → [near, far]. Rings are born in the near colour and retire into the far one,
 * which reads as depth rather than as a flat repeating pattern.
 */
const MOODS = {
  accent: (c) => [c.accent, c.local],
  verified: (c) => [c.paired, c.local],
  local: (c) => [c.local, c.accent],
  room: (c) => [c.room, c.accent],
  share: (c) => [c.accent, c.room],
};

/** Palette as bare "r,g,b" triples, so alpha can be applied per ring. */
export function readColors() {
  const s = getComputedStyle(document.body);
  // Read the concrete tokens, not the aliases: getPropertyValue does not resolve a
  // custom property whose value is itself a var() reference.
  const grab = (name, fallback) => {
    const v = (s.getPropertyValue(name) || '').trim();
    return /^\d/.test(v) ? v : fallback;
  };
  return {
    light: document.body.classList.contains('theme-light'),
    // The resting colour of a ring: the interface's own label colour, at low alpha.
    neutral: grab('--ring-rgb', '235,235,245'),
    accent: grab('--accent-rgb', '79,142,247'),
    local: grab('--ch-local-rgb', '56,189,248'),
    paired: grab('--ch-paired-rgb', '52,211,153'),
    room: grab('--ch-room-rgb', '251,191,36'),
    ok: grab('--ok-rgb', '52,211,153'),
  };
}
