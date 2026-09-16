/**
 * What a finger on a sheet actually does.
 *
 * Three rounds of this shipped on the strength of reading the code, and all three were wrong on
 * a real phone, because the thing that decided the outcome was not in the code at all: the
 * browser looked at `touch-action`, decided a downward touch was a scroll, and cancelled the
 * gesture. Prose assertions cannot catch that, and neither can a viewport. So these drive the
 * real module with real pointer events against a DOM small enough to be honest about, and ask
 * what moved.
 *
 * The four cases that matter are the switches, not the ends:
 *
 *   · at the top, pulling down          -> the sheet leaves
 *   · part-way down, pulling down       -> the list scrolls and the sheet stays
 *   · scrolled to the top mid-pull      -> the sheet takes the rest of the gesture
 *   · pushed back up mid-pull           -> the list takes it back
 *
 * A gesture that only handles the first two is the one every half-finished sheet on the web
 * has, and it is the one that feels stuck.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let seq = 0;

/*
 * The click a drag began as is swallowed by a listener the module removes on a later task, so
 * these two have to outlive every case rather than being restored with the rest.
 */
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};

/** A style object that answers both the property API and the named properties. */
function fakeStyle() {
  const props = new Map();
  return {
    props,
    setProperty(name, value) {
      props.set(name, value);
      this[name] = value;
    },
    removeProperty(name) {
      props.delete(name);
      delete this[name];
    },
  };
}

/**
 * Enough of an element to be driven and inspected.
 *
 * Not a DOM: a DOM would answer questions this test does not ask and hide the ones it does.
 * `scrollTop` is a plain number here, which is the point - the assertions are about who moves
 * it and by how much.
 */
function el(tag, { className = '', overflowY = 'visible', scrollHeight = 0, clientHeight = 0 } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    className,
    overflowY,
    scrollHeight,
    clientHeight,
    scrollTop: 0,
    dataset: {},
    style: fakeStyle(),
    children: [],
    parentElement: null,
    classes: new Set(),
    listeners: new Map(),
    closed: 0,
    captured: null,
    classList: {
      add: (c) => node.classes.add(c),
      remove: (c) => node.classes.delete(c),
      contains: (c) => node.classes.has(c),
    },
    matches: (selector) => selector.split(',').some((s) => s.trim().toLowerCase() === tag.toLowerCase()),
    closest: (selector) => {
      for (let n = node; n; n = n.parentElement) if (n.matches(selector)) return n;
      return null;
    },
    addEventListener: (type, fn) => {
      if (!node.listeners.has(type)) node.listeners.set(type, []);
      node.listeners.get(type).push(fn);
    },
    removeEventListener: () => {},
    setPointerCapture: (id) => {
      node.captured = id;
    },
    close: () => {
      node.closed += 1;
    },
    fire: (type, event) => {
      for (const fn of node.listeners.get(type) || []) fn(event);
    },
    append: (child) => {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
  };
  node.querySelectorAll = () => {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(node);
    return out;
  };
  return node;
}

/** A sheet with one scrolling body, and the clock and frame loop it runs against. */
async function sheet({ scrollHeight = 900, clientHeight = 300, scrollTop = 0 } = {}) {
  const saved = {
    matchMedia: globalThis.matchMedia,
    getComputedStyle: globalThis.getComputedStyle,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    document: globalThis.document,
    innerHeight: globalThis.innerHeight,
  };

  const frames = new Map();
  let nextFrame = 1;
  let clock = 0;

  globalThis.matchMedia = () => ({ matches: true, addEventListener: () => {} });
  globalThis.getComputedStyle = (node) => ({ overflowY: node.overflowY });
  globalThis.requestAnimationFrame = (fn) => {
    frames.set(nextFrame, fn);
    return nextFrame++;
  };
  globalThis.cancelAnimationFrame = (id) => frames.delete(id);
  globalThis.document = { body: { style: fakeStyle() } };
  globalThis.innerHeight = 800;
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock },
    configurable: true,
    writable: true,
  });

  const dialog = el('dialog');
  const body = el('div', { className: 'sheet-body', overflowY: 'auto', scrollHeight, clientHeight });
  body.scrollTop = scrollTop;
  dialog.append(body);

  const mod = await import(`../web/ui/swipe.js?case=${seq++}`);
  mod.enableSwipeToDismiss(dialog);

  /** Run every frame currently queued, once, the way the display would. */
  const flush = (ms = 16) => {
    clock += ms;
    const due = [...frames.entries()];
    frames.clear();
    for (const [, fn] of due) fn(clock);
  };

  let pointerTime = 0;
  let landsOn = body;
  const event = (y, x = 50) => ({
    pointerId: 1,
    pointerType: 'touch',
    button: 0,
    clientX: x,
    clientY: y,
    timeStamp: (pointerTime += 16),
    cancelable: true,
    target: landsOn,
    preventDefault: () => {},
  });

  return {
    dialog,
    body,
    frames,
    /** Put the finger somewhere other than the sheet body - on a message, say. */
    touching: (node) => {
      landsOn = node;
    },
    restore: () => Object.assign(globalThis, saved),
    down: (y, x) => dialog.fire('pointerdown', event(y, x)),
    move: (y, x) => {
      dialog.fire('pointermove', event(y, x));
      flush();
    },
    up: (y, x) => dialog.fire('pointerup', event(y, x)),
    flush,
    // `translate` is written as `0 <n>px`, so the number wanted is the one carrying the unit.
    /** How far down the sheet has been pulled, as the style actually reads. */
    pulled: () => Number(/(-?[\d.]+)px/.exec(dialog.style.translate || '')?.[1] ?? 0),
  };
}

test('a scrolling panel inside a dismissable sheet is taken off the browser', async () => {
  const s = await sheet();
  // Without this the browser claims the first downward move as a scroll and cancels the drag,
  // which is the whole reason the gesture never worked on a phone.
  assert.equal(s.body.style.props.get('touch-action'), 'none');
  assert.equal(s.body.dataset.gdScroll, '1');
  s.restore();
});

test('a panel that does not scroll is left alone', async () => {
  const s = await sheet({ scrollHeight: 200, clientHeight: 300 });
  // It still gets marked - it may grow later - but there is nothing to take.
  assert.equal(s.body.scrollTop, 0);
  s.restore();
});

test('pulling down from the top of the list dismisses the sheet', async () => {
  const s = await sheet();
  s.down(100);
  s.move(140);
  s.move(220);
  s.move(280);
  assert.ok(s.pulled() > 100, `the sheet should be following the finger, is at ${s.pulled()}`);
  assert.equal(s.body.scrollTop, 0, 'the list must not have moved');
  s.up(280);
  s.flush(300);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.dialog.closed, 1, 'the sheet should have left');
  s.restore();
});

test('pulling down part-way through the list scrolls it and leaves the sheet alone', async () => {
  const s = await sheet({ scrollTop: 400 });
  s.down(100);
  s.move(140);
  s.move(200);
  assert.equal(s.body.scrollTop, 300, 'the list should have come down with the finger');
  assert.equal(s.pulled(), 0, 'the sheet must not have moved');
  s.up(200);
  s.flush(300);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.dialog.closed, 0, 'reading a list is not a dismissal');
  s.restore();
});

test('running out of list mid-pull hands the rest of the gesture to the sheet', async () => {
  // 40px of list left above, then 200 more of pull: the switch has to happen without lifting.
  const s = await sheet({ scrollTop: 40 });
  s.down(100);
  s.move(120);
  s.move(160);
  assert.equal(s.body.scrollTop, 0, 'the list should have reached its top');
  s.move(300);
  assert.ok(s.pulled() > 100, `the sheet should have taken over, is at ${s.pulled()}`);
  s.up(300);
  s.flush(300);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.dialog.closed, 1, 'one continuous gesture should have dismissed it');
  s.restore();
});

test('pushing back up mid-pull gives the list back', async () => {
  const s = await sheet();
  s.down(300);
  s.move(360);
  s.move(500);
  assert.ok(s.pulled() > 100, `the sheet should be pulled down, is at ${s.pulled()}`);
  s.move(400);
  s.move(300);
  assert.equal(s.pulled(), 0, 'the sheet should have gone back to rest');
  s.move(200);
  assert.ok(s.body.scrollTop > 50, `the list should be moving again, is at ${s.body.scrollTop}`);
  s.up(200);
  s.flush(300);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.dialog.closed, 0, 'a gesture that ended in the list is not a dismissal');
  s.restore();
});

test('a scroller that arrives after the sheet does still scrolls', async () => {
  const s = await sheet();
  // A received message long enough to need its own scrollbar is built when it arrives, and by
  // then the pass over the sheet's contents has long since run. Its enclosing log has already
  // refused the browser's panning, so if this is not found here it does not scroll at all.
  const bubble = el('div', { className: 'text-received', overflowY: 'auto', scrollHeight: 600, clientHeight: 120 });
  s.body.append(bubble);
  s.touching(bubble);

  s.down(400);
  s.move(360);
  s.move(300);
  assert.equal(bubble.scrollTop, 100, 'the message should have scrolled');
  assert.equal(s.body.scrollTop, 0, 'and the sheet body should not have');
  s.restore();
});

test('a short slow pull springs back instead of dismissing', async () => {
  const s = await sheet();
  s.down(100);
  s.move(130);
  s.move(150);
  s.up(150);
  s.flush(300);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(s.dialog.closed, 0, '50px is a tug, not a dismissal');
  assert.equal(s.dialog.style.translate, '', 'and it should be back where it started');
  s.restore();
});

test('a tap is not a gesture', async () => {
  const s = await sheet();
  s.down(100);
  s.move(103);
  s.up(103);
  s.flush(300);
  assert.equal(s.dialog.closed, 0);
  assert.equal(s.body.scrollTop, 0);
  assert.equal(s.dialog.classes.has('dragging'), false);
  s.restore();
});

test('a flicked list keeps going after the finger has gone', async () => {
  const s = await sheet();
  s.down(400);
  s.move(340);
  s.move(280);
  s.move(220);
  const atRelease = s.body.scrollTop;
  s.up(220);
  // The browser is not scrolling this any more, so if nothing here carries it, it stops dead.
  for (let i = 0; i < 12; i++) s.flush();
  assert.ok(
    s.body.scrollTop > atRelease + 20,
    `the throw should have carried it on from ${atRelease}, ended at ${s.body.scrollTop}`,
  );
  s.restore();
});

test('a flicked list stops, and stops asking for frames', async () => {
  const s = await sheet();
  s.down(400);
  s.move(340);
  s.move(280);
  s.move(220);
  s.up(220);
  for (let i = 0; i < 400; i++) s.flush();
  assert.equal(s.frames.size, 0, 'a frame loop that never ends is a battery leak');
  assert.ok(s.body.scrollTop <= 600, 'and it must not run past the end of the list');
  s.restore();
});

test('the sheet is promoted before it moves, and let go of afterwards', async () => {
  const s = await sheet();
  s.down(100);
  // Asking for the layer on the first move means the first frame of the drag pays for it.
  assert.equal(s.dialog.style.props.get('will-change'), 'translate');
  s.move(103);
  s.up(103);
  assert.equal(s.dialog.style.props.has('will-change'), false, 'and it is not kept for free');
  s.restore();
});
