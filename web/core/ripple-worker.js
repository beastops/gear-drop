/**
 * Radar renderer on a worker thread.
 *
 * The same drawing routine as the main-thread fallback, so the two paths cannot drift.
 * Running here means a multi-gigabyte transfer never steals a frame from the animation,
 * and the animation never steals a millisecond from the transfer.
 */
import { drawRadar } from './ripple.js';

let ctx = null;
let metrics = null;
let rings = 9;
let colors = { neutral: '235,235,245', accent: '10,132,255', local: '10,132,255', paired: '48,209,88', room: '255,159,10', ok: '48,209,88' };
let state = {
  intensity: 0.24,
  speed: 0.2,
  hue: 'accent',
  lift: 0,
  burst: 0,
  flow: 0,
  sweep: 0,
  seeking: 0,
};
let phase = 0;
let last = 0;
let reduced = false;
let running = false;
let paused = false;

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.t) {
    case 'init':
      ctx = msg.canvas.getContext('2d');
      self.__canvas = msg.canvas;
      colors = msg.colors || colors;
      rings = msg.rings || rings;
      if (!running) {
        running = true;
        requestAnimationFrame(loop);
      }
      break;
    case 'resize': {
      const { w, h, dpr, originX, originY } = msg;
      self.__canvas.width = Math.floor(w * dpr);
      self.__canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      metrics = { w, h, dpr, originX, originY };
      break;
    }
    case 'state':
      state = { ...state, ...msg.state };
      break;
    case 'colors':
      colors = msg.colors;
      break;
    case 'reduced':
      reduced = msg.reduced;
      break;
    case 'paused':
      paused = msg.paused;
      if (!paused && !running) {
        running = true;
        last = 0;
        requestAnimationFrame(loop);
      }
      break;
  }
};

function loop(now) {
  if (paused) {
    running = false; // 'paused' restarts it; nothing else schedules a frame
    return;
  }
  const dt = Math.min(0.05, (now - last) / 1000 || 0);
  last = now;
  if (!reduced) {
    phase = (phase + dt * state.speed) % 1;
    state.sweep = (state.sweep + dt * (0.34 + (state.seeking || 0) * 0.5)) % (Math.PI * 2);
  }
  if (state.burst > 0) state.burst = Math.max(0, state.burst - dt * 1.4);
  drawRadar(ctx, metrics, state, phase, colors, rings);
  requestAnimationFrame(loop);
}
