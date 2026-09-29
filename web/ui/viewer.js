/**
 * A picture from the conversation, full screen.
 *
 * Tap a photo to open it. Pinch, double-tap or scroll to zoom; drag to look around a zoomed
 * picture; drag down to put it away, with the backdrop fading as it goes, the way a phone's own
 * photo viewer does. Escape and Back close it too, because it is a dialog like every other
 * sheet here and the page already knows how to close those.
 *
 * The geometry is kept in small pure functions so it can be tested without a screen: the point
 * under the fingers stays under the fingers while zooming, and a zoomed picture can be dragged
 * to its edges and no further.
 */

export const MAX_ZOOM = 5;
const DOUBLE_TAP_ZOOM = 2.5;
const DOUBLE_TAP_MS = 300;
const DISMISS_PX = 140;
const DISMISS_SPEED = 0.8; // px per ms

/**
 * The picture's fitted size inside the box, before any zoom: `contain`, never enlarged.
 * `box` is { w, h } of the stage and { iw, ih } of the picture's natural size.
 */
function fitted(box) {
  const k = Math.min(box.w / box.iw, box.h / box.ih, 1) || 1;
  return { w: box.iw * k, h: box.ih * k };
}

/** Keep a zoomed picture covering what it can of the box: no dragging it past its edges. */
export function clampPan(state, box) {
  const f = fitted(box);
  const spareX = Math.max(0, (f.w * state.scale - box.w) / 2);
  const spareY = Math.max(0, (f.h * state.scale - box.h) / 2);
  return {
    scale: state.scale,
    x: Math.min(spareX, Math.max(-spareX, state.x)) || 0,
    y: Math.min(spareY, Math.max(-spareY, state.y)) || 0,
  };
}

/**
 * Zoom by `factor` about the screen point (cx, cy), relative to the stage's top left.
 *
 * The picture is drawn centred and then moved by (x, y) and scaled, so the content point under
 * (cx, cy) is ((cx - w/2 - x) / scale). Keeping that point where it is fixes the new offset.
 */
export function zoomAbout(state, factor, cx, cy, box) {
  const scale = Math.min(MAX_ZOOM, Math.max(1, state.scale * factor));
  const u = (cx - box.w / 2 - state.x) / state.scale;
  const v = (cy - box.h / 2 - state.y) / state.scale;
  if (scale === 1) return { scale: 1, x: 0, y: 0 };
  return { scale, x: cx - box.w / 2 - u * scale, y: cy - box.h / 2 - v * scale };
}

/** How far a downward drag has got towards putting the picture away. */
export function dismissProgress(dy, speed, height) {
  const down = Math.max(0, dy);
  return {
    dismiss: down > DISMISS_PX || (dy > 24 && speed > DISMISS_SPEED),
    fade: Math.max(0.5, 1 - down / (height || 1)),
  };
}

/* ------------------------------------------------------------------ the dialog */

let wired = null;

/**
 * Show a picture. `dialog` is the page's `#photo-viewer`, which holds an `img`, a close button
 * and a save button; `onSave` is how this particular picture is saved.
 */
export function openViewer(dialog, { src, alt = '', onSave = null } = {}) {
  if (!dialog || !src) return;
  const img = dialog.querySelector('img');
  const stage = dialog.querySelector('.viewer-stage');
  if (!wired) wired = wire(dialog, img, stage);
  wired.onSave = onSave;
  dialog.querySelector('.viewer-save').hidden = !onSave;
  img.alt = alt;
  img.src = src;
  wired.reset();
  if (!dialog.open) dialog.showModal();
}

function wire(dialog, img, stage) {
  let state = { scale: 1, x: 0, y: 0 };
  let drag = 0; // the downward dismissing drag, when not zoomed
  const pointers = new Map();
  let pinch = null;
  let pan = null;
  let lastTap = null;
  const api = { onSave: null, reset };

  const box = () => {
    const r = stage.getBoundingClientRect();
    return { w: r.width, h: r.height, iw: img.naturalWidth || r.width, ih: img.naturalHeight || r.height, left: r.left, top: r.top };
  };

  function paint(animate = false) {
    img.style.transition = animate ? 'transform var(--t-slow, 320ms) var(--ease, ease)' : 'none';
    img.style.transform = `translate(${state.x}px, ${state.y + drag}px) scale(${state.scale})`;
    const { fade } = dismissProgress(drag, 0, box().h);
    dialog.style.setProperty('--viewer-fade', String(fade));
  }

  function reset() {
    state = { scale: 1, x: 0, y: 0 };
    drag = 0;
    pointers.clear();
    pinch = pan = null;
    paint(false);
  }

  const close = () => dialog.close();
  dialog.querySelector('.viewer-close').addEventListener('click', close);
  dialog.querySelector('.viewer-save').addEventListener('click', () => api.onSave?.());
  dialog.addEventListener('close', () => {
    img.removeAttribute('src'); // the blob stays the conversation's; this was only a view of it
    reset();
  });

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    try {
      stage.setPointerCapture(e.pointerId); // keep the gesture when a finger leaves the picture
    } catch {
      /* a pointer the browser no longer knows about: carry on without capture */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: state.scale, start: state };
      pan = null;
    } else if (pointers.size === 1) {
      pan = { x: e.clientX, y: e.clientY, from: { ...state }, t: performance.now(), lastY: e.clientY, lastT: performance.now(), speed: 0 };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const b = box();
    if (pinch && pointers.size >= 2) {
      const [p, q] = [...pointers.values()];
      const dist = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      const mx = (p.x + q.x) / 2 - b.left;
      const my = (p.y + q.y) / 2 - b.top;
      state = zoomAbout(pinch.start, (pinch.scale * dist) / pinch.dist / pinch.start.scale, mx, my, b);
      paint(false);
      return;
    }
    if (!pan) return;
    const now = performance.now();
    pan.speed = (e.clientY - pan.lastY) / Math.max(1, now - pan.lastT);
    pan.lastY = e.clientY;
    pan.lastT = now;
    if (state.scale > 1) {
      state = clampPan({ scale: state.scale, x: pan.from.x + e.clientX - pan.x, y: pan.from.y + e.clientY - pan.y }, b);
    } else {
      drag = e.clientY - pan.y; // at fit size a drag is a drag to put it away
    }
    paint(false);
  });

  const lift = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const b = box();
    if (pinch && pointers.size < 2) {
      pinch = null;
      state = clampPan(state, b);
      paint(true);
      // The finger still down carries on as a pan from here.
      const [rest] = [...pointers.values()];
      pan = rest ? { x: rest.x, y: rest.y, from: { ...state }, lastY: rest.y, lastT: performance.now(), speed: 0 } : null;
      return;
    }
    if (!pan) return;
    const moved = Math.hypot(e.clientX - pan.x, e.clientY - pan.y);
    if (state.scale === 1 && drag) {
      const { dismiss } = dismissProgress(drag, pan.speed, b.h);
      pan = null;
      if (dismiss) return close();
      drag = 0;
      paint(true);
      return;
    }
    pan = null;
    // A tap: two in quick succession zoom in on that spot, or back out.
    if (moved < 10) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        state = state.scale > 1 ? { scale: 1, x: 0, y: 0 } : clampPan(zoomAbout(state, DOUBLE_TAP_ZOOM, e.clientX - b.left, e.clientY - b.top, b), b);
        paint(true);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
    }
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);

  // A wheel, or a trackpad's pinch (which arrives as a wheel with ctrl held), zooms at the cursor.
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const b = box();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      state = clampPan(zoomAbout(state, factor, e.clientX - b.left, e.clientY - b.top, b), b);
      paint(false);
    },
    { passive: false },
  );

  return api;
}
