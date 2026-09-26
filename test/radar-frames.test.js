/**
 * How often the radar is drawn.
 *
 * The rings are the one thing on the main screen that never stops, and they were drawn on
 * every frame the display offered: sixty a second on most laptops, a hundred and twenty on a
 * lot of phones, a hundred and forty-four on a gaming monitor. Each of those is a full-screen
 * clear, a radial fill, a conic fill and a dozen gradient strokes, and the page composites the
 * result. Measured on the live site with a phone profile, that kept the GPU process's main
 * thread about 45% busy and the raster threads about 70% busy with nothing happening on the
 * screen at all; pausing the radar took both to about 2%.
 *
 * Nobody sees the difference, because nothing in it is fast. The rings drift about twenty-four
 * pixels a second, which is under a pixel a frame at thirty frames a second. What people do see
 * is everything else getting slower whenever the machine is busy with something besides this
 * tab, which is where "sometimes it lags" came from.
 *
 * So the resting rings are paced at thirty frames a second whatever the display runs at. The
 * burst ring is the exception: it crosses the screen in under a second and needs every frame
 * it can get, for as long as it lasts. And with reduced motion there is nothing to animate at
 * all, so the picture is drawn when something changes and not otherwise.
 *
 * Driven here with a fake clock and a canvas that only counts, through the same code the page
 * runs: the worker module itself, and the main-thread fallback class.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------ fakes */

/**
 * A 2D context that accepts anything and counts frames by their opening `clearRect`. It also
 * keeps the angle each sweep was drawn at, which is the one thing in a frame that says where
 * the animation has got to.
 */
function countingContext() {
  const counter = { frames: 0, sweeps: [] };
  const sink = new Proxy(function () {}, {
    get: (_, key) => (key === 'addColorStop' ? () => {} : sink),
    set: () => true,
    apply: () => sink,
  });
  const ctx = new Proxy(
    {},
    {
      get: (_, key) => {
        if (key === 'clearRect') return () => counter.frames++;
        if (key === 'createConicGradient') {
          return (angle) => {
            counter.sweeps.push(angle);
            return { addColorStop() {} };
          };
        }
        if (key === 'createLinearGradient' || key === 'createRadialGradient') {
          return () => ({ addColorStop() {} });
        }
        return () => sink;
      },
      set: () => true,
    },
  );
  return { ctx, counter };
}

/** requestAnimationFrame on a display that refreshes `hz` times a second, stepped by hand. */
function fakeDisplay() {
  let queue = [];
  let now = 1000;
  let nextId = 1;
  const raf = (fn) => {
    const id = nextId++;
    queue.push({ id, fn });
    return id;
  };
  const cancel = (id) => {
    queue = queue.filter((q) => q.id !== id);
  };
  /** Run the display for `ms` at `hz`; returns how many vsyncs had someone waiting. */
  const run = (hz, ms) => {
    const step = 1000 / hz;
    const end = now + ms;
    let busy = 0;
    while (now + step <= end + 1e-9) {
      now += step;
      const due = queue;
      queue = [];
      if (due.length) busy++;
      for (const q of due) q.fn(now);
    }
    return busy;
  };
  return { raf, cancel, run, pending: () => queue.length, now: () => now };
}

let loads = 0;
/** A fresh instance of the worker module, with its own state, talking to a fake display. */
async function loadWorker(display) {
  globalThis.self = globalThis;
  globalThis.requestAnimationFrame = display.raf;
  await import(`../web/core/ripple-worker.js?instance=${++loads}`);
  const onmessage = globalThis.self.onmessage;
  const { ctx, counter } = countingContext();
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const post = (data) => onmessage({ data });
  post({ t: 'init', canvas, rings: 13 });
  post({ t: 'resize', w: 1920, h: 1080, dpr: 1, originX: 960, originY: 990 });
  return { post, counter };
}

const REST_STATE = { intensity: 0.24, speed: 0.2, seeking: 1, burst: 0, flow: 0 };

/* ------------------------------------------------------------ the worker */

for (const hz of [60, 120, 144]) {
  test(`at rest the rings are drawn about thirty times a second on a ${hz} Hz display`, async () => {
    const display = fakeDisplay();
    const { post, counter } = await loadWorker(display);
    post({ t: 'state', state: REST_STATE });
    display.run(hz, 200); // settle
    counter.frames = 0;
    display.run(hz, 3000);
    const perSecond = counter.frames / 3;
    assert.ok(perSecond <= 31, `${perSecond.toFixed(1)} frames a second, on a ${hz} Hz display`);
    assert.ok(perSecond >= 24, `${perSecond.toFixed(1)} frames a second is visibly steppy`);
  });
}

test('the rings still move at the same speed when fewer frames are drawn', async () => {
  // Pacing must drop frames, not slow the animation down: phase is integrated over real time.
  const { tick } = await import('../web/core/ripple.js');
  const at = (hz) => {
    const clock = { last: 0, phase: 0 };
    const state = { ...REST_STATE, sweep: 0 };
    for (let t = 1000; t <= 3000 + 1e-9; t += 1000 / hz) tick(clock, t, state, false);
    return clock.phase;
  };
  const slow = at(144);
  const fast = at(60);
  assert.ok(Math.abs(slow - 0.4) < 0.02, `phase after two seconds at 144 Hz is ${slow.toFixed(3)}, expected 0.4`);
  assert.ok(Math.abs(fast - 0.4) < 0.02, `phase after two seconds at 60 Hz is ${fast.toFixed(3)}, expected 0.4`);
});

test('a burst gets every frame the display has, and only while it lasts', async () => {
  const display = fakeDisplay();
  const { post, counter } = await loadWorker(display);
  post({ t: 'state', state: REST_STATE });
  display.run(120, 200);
  counter.frames = 0;
  post({ t: 'state', state: { ...REST_STATE, burst: 1 } });
  display.run(120, 250);
  assert.ok(counter.frames >= 28, `${counter.frames} frames in the first quarter second of a burst at 120 Hz`);

  display.run(120, 1500); // the burst has decayed by now
  counter.frames = 0;
  display.run(120, 2000);
  assert.ok(counter.frames / 2 <= 31, 'the radar stayed at full rate after the burst ended');
});

test('with reduced motion the worker draws what changed and then stops asking for frames', async () => {
  const display = fakeDisplay();
  const { post, counter } = await loadWorker(display);
  post({ t: 'state', state: REST_STATE });
  display.run(60, 200);

  post({ t: 'reduced', reduced: true });
  display.run(60, 100);
  counter.frames = 0;
  const busy = display.run(60, 2000);
  assert.equal(counter.frames, 0, 'a picture that cannot change was redrawn');
  assert.equal(busy, 0, 'the worker is still waking up every frame to draw nothing');

  post({ t: 'state', state: { ...REST_STATE, seeking: 0 } });
  display.run(60, 1000);
  assert.equal(counter.frames, 1, 'a change of state is drawn exactly once');

  post({ t: 'resize', w: 1280, h: 720, dpr: 1, originX: 640, originY: 650 });
  display.run(60, 1000);
  assert.equal(counter.frames, 2, 'a resize cleared the canvas and nothing redrew it');

  post({ t: 'reduced', reduced: false });
  counter.frames = 0;
  display.run(60, 1000);
  assert.ok(counter.frames >= 24, 'turning reduced motion off did not bring the animation back');
});

test('a paused worker neither draws nor waits on frames, and picks up again', async () => {
  const display = fakeDisplay();
  const { post, counter } = await loadWorker(display);
  post({ t: 'state', state: REST_STATE });
  display.run(60, 200);
  post({ t: 'paused', paused: true });
  display.run(60, 50);
  counter.frames = 0;
  // Messages keep arriving while a sheet is open - progress, presence - and must not wake it.
  post({ t: 'state', state: { ...REST_STATE, flow: 0.5 } });
  post({ t: 'colors', colors: {} });
  assert.equal(display.run(60, 1000), 0, 'a paused radar is still being scheduled');
  assert.equal(counter.frames, 0);
  post({ t: 'paused', paused: false });
  display.run(60, 1000);
  assert.ok(counter.frames >= 24, 'it did not come back');
});

/* ------------------------------------------------------ the main thread */

/**
 * The fallback path: no OffscreenCanvas, or reduced motion from the start, which is when the
 * page draws the radar itself. Every frame drawn here is taken from the thread that handles
 * taps and scrolling.
 */
async function mainThreadRadar(display, { reduced }) {
  const listeners = pageGlobals(display, { reduced });
  const { Radar } = await import('../web/core/ripple.js');
  const { ctx, counter } = countingContext();
  const canvas = { style: {}, width: 0, height: 0, getContext: () => ctx };
  const radar = new Radar(canvas, {});
  const setReduced = (on) => listeners.forEach((fn) => fn({ matches: on }));
  return { radar, counter, setReduced };
}

/**
 * The page's `Radar` driving a real instance of the worker module, which is how it runs in
 * every browser with OffscreenCanvas. What crosses between them is exactly what `postMessage`
 * would carry.
 */
async function workerRadar(display) {
  pageGlobals(display, { reduced: false });
  globalThis.self = globalThis;
  await import(`../web/core/ripple-worker.js?instance=${++loads}`);
  const deliver = globalThis.self.onmessage;
  const { ctx, counter } = countingContext();
  globalThis.location = { href: 'file:///app/index.html', origin: 'null' };
  globalThis.Worker = class {
    postMessage(data) {
      deliver({ data: data.state ? { ...data, state: { ...data.state } } : data });
    }
  };
  const offscreen = { width: 0, height: 0, getContext: () => ctx };
  const canvas = { style: {}, transferControlToOffscreen: () => offscreen };
  const { Radar } = await import('../web/core/ripple.js');
  return { radar: new Radar(canvas, {}), counter };
}

function pageGlobals(display, { reduced }) {
  const listeners = [];
  globalThis.requestAnimationFrame = display.raf;
  globalThis.cancelAnimationFrame = display.cancel;
  globalThis.matchMedia = (q) => ({
    matches: q.includes('reduced-motion') ? reduced : false,
    addEventListener: (_, fn) => listeners.push(fn),
  });
  globalThis.addEventListener = () => {};
  globalThis.devicePixelRatio = 1;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.document = {
    documentElement: { clientWidth: 1920, clientHeight: 1080 },
    body: { classList: { contains: () => false } },
  };
  return listeners;
}

/* ------------------------------------------- what the page tells the worker */

test('a burst plays once, however often the page reports something afterwards', async () => {
  /*
   * The page used to send its whole copy of the state with every change. In worker mode that
   * copy never advances, so its `burst` stayed at 1 from the last device that arrived, and
   * every later message - five a second during a transfer - started the burst over again.
   */
  const display = fakeDisplay();
  const { radar, counter } = await workerRadar(display);
  radar.setSearching(true);
  display.run(120, 200);
  radar.burst();
  display.run(120, 1500); // long enough for it to be gone
  counter.frames = 0;
  for (let i = 0; i < 10; i++) {
    radar.setFlow(0.3); // a progress report, at the rate transfers send them
    display.run(120, 200);
  }
  const perSecond = counter.frames / 2;
  assert.ok(perSecond <= 31, `${perSecond.toFixed(1)} frames a second: the burst keeps restarting`);
});

test('the sweep carries on from where it was when the page reports something', async () => {
  // The same whole-state message carried the page's `sweep`, which in worker mode is always 0,
  // so every device-list repaint snapped the beam back to the start.
  const display = fakeDisplay();
  const { radar, counter } = await workerRadar(display);
  radar.setSearching(true);
  display.run(60, 1000);
  const before = counter.sweeps.at(-1);
  assert.ok(before > 0.3, `the sweep has not moved: ${before}`);
  radar.setMood('verified');
  radar.setEnergy(0.5);
  display.run(60, 100);
  const after = counter.sweeps.at(-1);
  const moved = (after - before + Math.PI * 2) % (Math.PI * 2);
  assert.ok(moved < 0.5, `the sweep jumped from ${before.toFixed(2)} to ${after.toFixed(2)} rad`);
});

test('reduced motion costs the main thread one draw per change, not one per frame', async () => {
  const display = fakeDisplay();
  const { radar, counter, setReduced } = await mainThreadRadar(display, { reduced: true });
  display.run(60, 200);
  assert.ok(counter.frames >= 1, 'the radar was never drawn at all');

  counter.frames = 0;
  const busy = display.run(60, 2000);
  assert.equal(counter.frames, 0, 'a still picture was redrawn on the main thread every frame');
  assert.equal(busy, 0, 'the main thread is still being woken every frame');

  radar.setMood('room');
  radar.setEnergy(1);
  display.run(60, 500);
  assert.equal(counter.frames, 1, 'two changes in one frame should be one draw');

  radar.resize();
  display.run(60, 500);
  assert.equal(counter.frames, 2, 'a resize cleared the canvas and nothing redrew it');

  setReduced(false);
  counter.frames = 0;
  display.run(60, 1000);
  assert.ok(counter.frames >= 24, 'turning reduced motion off did not bring the animation back');
});

test('the main-thread fallback is paced like the worker, and stops when paused', async () => {
  const display = fakeDisplay();
  const { radar, counter } = await mainThreadRadar(display, { reduced: false });
  display.run(144, 200);
  counter.frames = 0;
  display.run(144, 3000);
  assert.ok(counter.frames / 3 <= 31, `${(counter.frames / 3).toFixed(1)} frames a second on the main thread`);
  assert.ok(counter.frames / 3 >= 24, 'the fallback is visibly steppy');

  radar.pause();
  counter.frames = 0;
  radar.setFlow(0.5); // progress keeps arriving behind an open sheet
  assert.equal(display.run(144, 1000), 0, 'a paused radar is still being scheduled');
  assert.equal(counter.frames, 0);

  radar.resume();
  display.run(144, 1000);
  assert.ok(counter.frames >= 24, 'it did not come back');
  assert.ok(display.pending() <= 1, 'resuming started a second loop alongside the first');
});
