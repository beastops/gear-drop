/**
 * Drag something off the screen to dismiss it.
 *
 * Two things use this: a sheet, pulled down, and a banner, flicked up. They were written
 * separately and were the same hundred lines twice with the sign flipped, which cost real
 * bugs rather than just space - an empty `getCoalescedEvents()` result was mishandled in both
 * copies, and a `setPointerCapture` that can throw was guarded in one of them and not the
 * other. So the gesture lives once and the direction is an argument.
 *
 * The rules are the ones iOS established, and they are mostly about knowing when *not* to
 * take the gesture:
 *
 *   · it follows the pointer one-to-one, so it is a drag and not an animation;
 *   · it resists the direction it does not travel in, rather than refusing it outright;
 *   · it lets go on distance *or* velocity, because a short fast flick means the same thing
 *     as a long slow pull;
 *   · a sheet yields to a scroll and to text fields, because a list being read is not a sheet
 *     being dragged;
 *   · and a drag that turns out to be a drag must not also fire the click it started on.
 *
 * Pointer events, so one implementation covers touch and pen. It arms only where the primary
 * input is coarse: on a desktop a drag across a dialog is not a gesture anyone means and it
 * would fight text selection, so the close button and Escape are the ways out there. The
 * check is live, so a tablet that gains a trackpad stops offering it.
 */

const coarse = matchMedia('(pointer: coarse)');
let touchInput = coarse.matches;
coarse.addEventListener?.('change', (e) => {
  touchInput = e.matches;
});

/** How far the pointer must move before this is a drag rather than a press. */
const SLOP = 8;
/** Past this speed, in px per ms, a short drag still counts as a flick. */
const DISMISS_VELOCITY = 0.5;
/**
 * Velocity is measured across this window rather than between the last two events. Two
 * adjacent pointer samples can be a millisecond apart, and dividing by that produces a number
 * with no relationship to how fast the finger was actually moving.
 */
const VELOCITY_WINDOW_MS = 90;
/** Movement against the gesture is damped by this much rather than being refused outright. */
const RUBBER = 6;

/** A sheet is tall, so it asks for a real pull. The backdrop is clear by `FADE_OVER`. */
const SHEET_DISTANCE = 104;
const SHEET_FLICK_TRAVEL = 28;
const FADE_OVER = 280;

/** A banner is a fraction of the height, so it asks for a fraction of the pull. */
const BANNER_DISTANCE = 40;
const BANNER_FLICK_TRAVEL = 16;
const BANNER_FADE_OVER = 120;

/**
 * Stop the click this drag began as.
 *
 * It dispatches before any task we could schedule, so one capturing listener is enough, and
 * it is removed either way.
 */
function swallowNextClick() {
  const swallow = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', swallow, true), 0);
}

/**
 * The gesture itself, in whichever direction it is given.
 *
 * @param {HTMLElement} el
 * @param {object}   o
 * @param {number}   o.sign         +1 dismisses downward, -1 upward
 * @param {number}   o.distance     travel past which it goes on distance alone
 * @param {number}   o.flickTravel  travel past which speed is allowed to decide instead
 * @param {Function} o.paint        write the drag to the element, once per frame
 * @param {Function} o.dismiss      it passed: see it out, carrying on from where it was left
 * @param {Function} o.restore      it did not: put it back
 * @param {Function} [o.canStart]   refuse the gesture before it arms
 * @param {Function} [o.onGrab]     it became a drag
 * @param {boolean}  [o.holdSelection] stop the page selecting text under the finger
 */
function dragToDismiss(el, o) {
  let pointerId = null;
  let armed = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let offset = 0;
  let samples = [];
  let frame = 0;

  const stopFrame = () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
  };

  /**
   * A touch digitizer reports faster than the display refreshes, often two or three times per
   * frame. Writing the style on each of those is work the compositor throws away, so the
   * events only update the number and one frame callback writes it.
   */
  const schedulePaint = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (dragging) o.paint(offset);
    });
  };

  /** Average speed over the tail of the gesture, or 0 when the window is too short to trust. */
  const measureVelocity = () => {
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    return dt > 8 ? (last.y - first.y) / dt : 0;
  };

  el.addEventListener('pointerdown', (e) => {
    if (!touchInput) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (o.canStart && !o.canStart(e)) return;

    pointerId = e.pointerId;
    armed = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    offset = 0;
    samples = [{ t: e.timeStamp, y: e.clientY }];
  });

  el.addEventListener('pointermove', (e) => {
    if (!armed || e.pointerId !== pointerId) return;
    const raw = e.clientY - startY;

    if (!dragging) {
      if (Math.abs(raw) < SLOP) return;
      // Sideways, or against the way this one travels: not ours.
      if (Math.abs(e.clientX - startX) > Math.abs(raw) || raw * o.sign < 0) {
        armed = false;
        return;
      }
      dragging = true;
      // Throws if the pointer went up between the browser queueing this move and the handler
      // running it. Unguarded, that aborts the rest of this block and leaves the drag half
      // set up: flagged as dragging, with no transition suppressed and no samples collected.
      try {
        el.setPointerCapture?.(pointerId);
      } catch {
        /* nothing to capture any more */
      }
      el.classList.add('dragging');
      el.style.transition = 'none';
      if (o.holdSelection) document.body.style.setProperty('user-select', 'none');
      o.onGrab?.();
    }

    offset = raw * o.sign < 0 ? raw / RUBBER : raw;

    // Velocity reads every sample the browser captured, including the ones coalesced into this
    // event: the paint is throttled to the frame, the measurement is not. An empty list is
    // still a list, so `||` never fires on it; ask for the length instead.
    const coalesced = e.getCoalescedEvents?.();
    const points = coalesced && coalesced.length ? coalesced : [e];
    for (const p of points) samples.push({ t: p.timeStamp || e.timeStamp, y: p.clientY });
    while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();

    schedulePaint();
    e.preventDefault();
  });

  const release = (e) => {
    if (e.pointerId !== pointerId) return;
    armed = false;
    pointerId = null;
    if (!dragging) return;
    dragging = false;
    stopFrame();
    if (o.holdSelection) document.body.style.removeProperty('user-select');
    el.classList.remove('dragging');
    swallowNextClick();

    // Measured along the way it travels, so both directions read the same here.
    const travel = offset * o.sign;
    const speed = measureVelocity() * o.sign;
    if (travel > o.distance || (travel > o.flickTravel && speed > DISMISS_VELOCITY)) o.dismiss(offset);
    else o.restore();
  };

  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);

  return { stopFrame };
}

/**
 * Swipe a banner up to dismiss it.
 *
 * What is different from a sheet is what it must not break. A banner can carry a button, and
 * it removes itself on a timer. The timer stops while a finger is on it: a notice that
 * vanishes mid-drag leaves the gesture attached to nothing, and a finger on it is the one
 * moment we know for certain it is being read.
 *
 * @param {HTMLElement} el
 * @param {{onDismiss?: Function, onGrab?: Function, onLetGo?: Function}} hooks
 */
export function enableSwipeUpToDismiss(el, { onDismiss, onGrab, onLetGo } = {}) {
  if (!el || el.dataset.swipeBound) return;
  el.dataset.swipeBound = '1';

  dragToDismiss(el, {
    sign: -1,
    distance: BANNER_DISTANCE,
    flickTravel: BANNER_FLICK_TRAVEL,
    paint: (offset) => {
      el.style.translate = `0 ${offset.toFixed(1)}px`;
      el.style.opacity = Math.max(0, 1 + offset / BANNER_FADE_OVER).toFixed(3);
    },
    onGrab: () => {
      // Grabbing a banner that is still arriving: its entry animation owns `transform` and
      // would keep playing underneath the drag.
      el.style.animation = 'none';
      onGrab?.();
    },
    // Carries on from where the finger let go rather than snapping to a fixed distance,
    // which on a long drag would jump the banner backwards before it left.
    dismiss: (offset) => {
      el.style.transition = 'translate 170ms cubic-bezier(0.4, 0, 1, 1), opacity 140ms linear';
      el.style.translate = `0 ${(offset - 56).toFixed(1)}px`;
      el.style.opacity = '0';
      setTimeout(() => onDismiss?.(), 180);
    },
    restore: () => {
      el.style.transition = 'translate 200ms var(--ease-out), opacity 200ms var(--ease-out)';
      el.style.translate = '0 0';
      el.style.opacity = '1';
      onLetGo?.();
    },
  });
}

/** Swipe a sheet down to dismiss it. */
export function enableSwipeToDismiss(dialog) {
  if (!dialog || dialog.dataset.swipeBound) return;
  dialog.dataset.swipeBound = '1';

  /**
   * True when nothing between the target and the sheet is scrolled away from its top. This is
   * what stops a downward flick inside a long file list from throwing the sheet off screen
   * instead of scrolling back to the first row.
   */
  const atScrollTop = (target) => {
    for (let el = target; el && el !== dialog; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      if (el.scrollTop > 0) return false;
    }
    return true;
  };

  const gesture = dragToDismiss(dialog, {
    sign: 1,
    distance: SHEET_DISTANCE,
    flickTravel: SHEET_FLICK_TRAVEL,
    holdSelection: true,
    // A text field owns its own drag: selecting inside it is not a dismissal.
    canStart: (e) => !e.target.closest?.('input, textarea, select, [contenteditable]') && atScrollTop(e.target),
    paint: (offset) => {
      dialog.style.translate = `0 ${offset.toFixed(1)}px`;
      dialog.style.setProperty('--drag', Math.min(1, Math.max(0, offset) / FADE_OVER).toFixed(3));
    },
    dismiss: () => leave(),
    restore: () => {
      // Back to rest, on the sheet's own spring.
      dialog.style.transition = '';
      dialog.style.translate = '';
      dialog.style.setProperty('--drag', '0');
    },
  });

  const reset = () => {
    gesture.stopFrame();
    dialog.classList.remove('dragging');
    dialog.style.transition = '';
    dialog.style.translate = '';
    dialog.style.removeProperty('--drag');
    document.body.style.removeProperty('user-select');
  };

  function leave() {
    // A spring would overshoot past the bottom edge and come back, which reads as a bounce
    // rather than a dismissal. Leaving is a plain decelerating move.
    dialog.style.transition = 'translate 240ms cubic-bezier(0.32, 0.72, 0, 1), opacity 190ms linear';
    dialog.style.translate = `0 ${Math.max(innerHeight, 480)}px`;
    dialog.style.opacity = '0';
    dialog.style.setProperty('--drag', '1');

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      dialog.close();
      // Held until the dialog's own exit has finished, so clearing them cannot flash the
      // sheet back into view for a frame on its way out.
      setTimeout(() => {
        reset();
        dialog.style.opacity = '';
      }, 500);
    };
    dialog.addEventListener(
      'transitionend',
      (e) => {
        if (e.target === dialog && e.propertyName === 'translate') finish();
      },
      { once: true },
    );
    setTimeout(finish, 400);
  }

  // A sheet closed any other way (a button, Escape) must not reopen wearing a stale offset.
  dialog.addEventListener('close', () => {
    if (dialog.style.opacity === '0') return; // a dismissal is already cleaning up after itself
    reset();
  });
}
