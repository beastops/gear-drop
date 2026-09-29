/**
 * Going back from a page pushed in from the side, the iPhone way: drag it off to the right from
 * its left edge.
 *
 * The page follows the finger, and the screen behind it slides back into place as it goes. Let
 * go past a third of the way, or with a flick, and it finishes leaving; let go short of that
 * and it springs back. Only a finger that starts within a thumb's width of the edge, and only
 * sideways: anything else on the page - a swipe to reply, a scroll - is somebody else's.
 *
 * Where the phone keeps the edge for itself (Android's back gesture), the system gets there
 * first and its Back closes the page anyway.
 */

/** How close to the left edge a drag has to start. */
export const EDGE_PX = 24;

/** Whether letting go here finishes going back. `speed` is in pixels per millisecond. */
export function completes(dx, speed, width) {
  return dx > width * 0.33 || (dx > 24 && speed > 0.45);
}

/**
 * `isPushed` says whether the page is being shown pushed right now (a phone), `onProgress`
 * hears how far across it is, 0 to 1, and `onDragging` whether a finger has it.
 */
export function enableEdgeBack(dialog, { isPushed = () => true, onProgress = () => {}, onDragging = () => {} } = {}) {
  let start = null;
  let active = false;
  let samples = [];

  const width = () => dialog.getBoundingClientRect?.().width || globalThis.innerWidth || 1;

  dialog.addEventListener(
    'pointerdown',
    (e) => {
      // A second finger is not a new drag. It used to reset the first one's, and the page stayed
      // wherever the first finger had dragged it.
      if (e.isPrimary === false) return;
      start = null;
      if (!isPushed() || e.pointerType === 'mouse' || e.clientX > EDGE_PX) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      active = false;
      samples = [{ x: e.clientX, t: performance.now() }];
    },
    true,
  );

  dialog.addEventListener(
    'pointermove',
    (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!active) {
        if (Math.hypot(dx, dy) < 8) return;
        if (dx <= 0 || Math.abs(dy) > dx) {
          start = null; // not sideways to the right: not ours
          return;
        }
        active = true;
        try {
          dialog.setPointerCapture(e.pointerId);
        } catch {
          /* the finger already lifted */
        }
        dialog.style.transition = 'none';
        onDragging(true);
      }
      const x = Math.max(0, dx);
      dialog.style.translate = `${x.toFixed(1)}px 0`;
      onProgress(Math.min(1, x / width()));
      samples.push({ x: e.clientX, t: performance.now() });
      if (samples.length > 5) samples.shift();
      // Nothing under the finger - a message, the sheet's own scrolling - takes it as well.
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    },
    true,
  );

  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const was = active;
    start = null;
    active = false;
    if (!was) return;
    e.stopPropagation();

    const first = samples[0];
    const last = samples[samples.length - 1];
    const speed = last && first && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const x = Math.max(0, (last?.x ?? 0) - (samples[0]?.x ?? 0));
    const dx = parseFloat(dialog.style.translate) || x;

    onDragging(false);
    dialog.style.transition = '';
    if (completes(dx, speed, width())) {
      // Carry on off the edge, then close: the closed page sits off the edge too, so there is
      // no jump when it does.
      dialog.style.translate = '100% 0';
      onProgress(1);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        dialog.close();
        dialog.style.removeProperty('translate');
      };
      dialog.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 420);
    } else {
      dialog.style.removeProperty('translate');
      onProgress(0);
    }
  };
  dialog.addEventListener('pointerup', end, true);
  dialog.addEventListener('pointercancel', end, true);
}
