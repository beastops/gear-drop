/**
 * Radar renderer on a worker thread.
 *
 * The same drawing routine as the main-thread fallback, so the two paths cannot drift.
 * Running here means a multi-gigabyte transfer never steals a frame from the animation,
 * and the animation never steals a millisecond from the transfer.
 */
import { drawRadar, tick } from './ripple.js';

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
const clock = { last: 0, phase: 0 };
let reduced = false;
let running = false;
let paused = false;

/**
 * Make sure a frame is coming. Every message goes through here, because with reduced motion the
 * loop sleeps between changes and a message is the only thing that has anything new to draw.
 */
function wake() {
  if (running || paused || !ctx) return;
  running = true;
  requestAnimationFrame(loop);
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.t) {
    case 'init':
      ctx = msg.canvas.getContext('2d');
      self.__canvas = msg.canvas;
      colors = msg.colors || colors;
      rings = msg.rings || rings;
      break;
    case 'resize': {
      const { w, h, dpr, originX, originY } = msg;
      self.__canvas.width = Math.floor(w * dpr); // which also clears it
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
      if (!paused) clock.last = 0; // do not integrate the time spent asleep
      break;
  }
  wake();
};

function loop(now) {
  if (paused) {
    running = false; // 'paused' restarts it; nothing else schedules a frame
    return;
  }
  if (tick(clock, now, state, reduced)) drawRadar(ctx, metrics, state, clock.phase, colors, rings);
  if (reduced) {
    running = false; // a still picture, drawn; the next message wakes it
    return;
  }
  requestAnimationFrame(loop);
}
