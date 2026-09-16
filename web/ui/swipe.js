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
 *
 * A sheet needs more than this, because it has to share the gesture with its own scrolling, and
 * sharing is not something the browser will do: `touch-action` decides on the first move, and
 * whatever it decides is final. So `enableSwipeToDismiss` below does not use the engine here -
 * it takes the scrolling too, and drives both from one gesture. A banner has nothing to share
 * with and still does.
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

/**
 * How much of its speed a flung list keeps, per millisecond.
 *
 * The browser is not scrolling the panel any more - it cannot, or it would claim the drag - so
 * the momentum after a flick has to come from here. 0.998 per millisecond is about 0.97 a
 * frame, which is close to what iOS does: far enough to feel thrown, short enough that it
 * stops roughly where you expected it to.
 */
const FLING_FRICTION = 0.998;
/** Below this, in px per ms, the list has stopped and the frame loop should stop with it. */
const FLING_FLOOR = 0.02;
/** A release has to beat this, in px per ms, to be a throw rather than the end of a drag. */
const FLING_MIN = 0.12;

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

  /*
   * Stop the page scrolling under a banner that is being flicked away.
   *
   * `preventDefault()` on `pointermove` is ignored once `touch-action` has permitted the pan -
   * by then the scroll belongs to the browser and this would never see another move. A
   * non-passive `touchmove` is the one place the decision is still open, and it has to be made
   * on the first move.
   *
   * It refuses only what the gesture would take anyway: one finger, past the slop, travelling
   * the way this thing dismisses. Anything else is left alone and the page scrolls normally.
   */
  el.addEventListener(
    'touchmove',
    (e) => {
      if (!armed || e.touches.length !== 1 || !e.cancelable) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy) || dy * o.sign < 0) return;
      e.preventDefault();
    },
    { passive: false },
  );

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

/**
 * Swipe a sheet down to dismiss it - and, because it has to, scroll it as well.
 *
 * A sheet cannot let the browser scroll it and still expect to be draggable: `touch-action`
 * hands the whole gesture to one side or the other on the first move. So this takes both. Each
 * scroller inside the sheet is marked `touch-action: none` when the sheet is bound, nothing is
 * ever claimed out from under the finger, and this decides - per gesture, and again mid-gesture
 * - whether the finger is moving the list or the sheet.
 */
export function enableSwipeToDismiss(dialog) {
  if (!dialog || dialog.dataset.swipeBound) return;
  dialog.dataset.swipeBound = '1';

  /**
   * Does this element scroll? If it does, take the scrolling off the browser. Asked once per
   * element and remembered either way, since being a scroll container is a fact about an
   * element's styles rather than its size - it cannot go stale as content arrives, and the
   * cache is what lets the question be asked again cheaply for elements that did not exist
   * when the sheet was bound.
   */
  const claim = (el) => {
    if (el.dataset.gdScroll === undefined) {
      const scrolls =
        !el.matches('input, textarea, select, [contenteditable]') &&
        ['auto', 'scroll'].includes(getComputedStyle(el).overflowY);
      el.dataset.gdScroll = scrolls ? '1' : '0';
      // CSSOM, not a style attribute: the Trusted Types policy refuses the second.
      if (scrolls) el.style.setProperty('touch-action', 'none');
    }
    return el.dataset.gdScroll === '1';
  };

  /*
   * Everything that is already here, up front, so the browser never gets to claim a pan.
   *
   * Done from here rather than in the stylesheet for two reasons. A list of class names in CSS
   * goes stale the moment somebody adds a scrolling region and forgets to add it there, whereas
   * this asks the question directly. And if this module ever fails to load, nothing has been
   * taken: the scrollers keep `touch-action: auto`, the browser scrolls them as it always did,
   * and the sheet is merely not draggable rather than not scrollable.
   *
   * The dialog itself is left out even if it scrolls. `touch-action` is answered by the whole
   * ancestor chain, so `none` there would reach every descendant - including the text fields,
   * whose panning is their own and not ours to take.
   */
  for (const el of dialog.querySelectorAll('*')) claim(el);

  /* ---------------------------------------------------------------- state */

  let pointerId = null;
  let mode = 'idle'; // idle -> deciding -> scroll | dismiss
  let scroller = null; // the list under the finger, whichever one that is
  let smoothed = null; // a scroller whose `scroll-behavior` we are holding down
  let startX = 0;
  let startY = 0;
  let scrollFrom = 0; // where the list was when the gesture began
  let maxScroll = 0; // measured once, so no move handler reads layout
  let scrollTo = 0; // where the list should be on the next frame
  let offset = 0; // how far the sheet has been pulled
  let samples = [];
  let frame = 0;
  let fling = 0;

  const stopFrame = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const stopFling = () => {
    if (fling) cancelAnimationFrame(fling);
    fling = 0;
  };

  /**
   * The nearest thing under the finger that can actually scroll.
   *
   * A sheet can hold more than one - the chat log inside the chat sheet, the language list
   * inside Settings - and the one being touched is the one that should move. Asked per touch
   * rather than resolved once, because the deepest of them arrive later than the sheet does: a
   * received message long enough to scroll is built when it is received, and a list of scrollers
   * taken at startup would leave it stuck.
   */
  const scrollerUnder = (target) => {
    for (let el = target; el && el !== dialog; el = el.parentElement) {
      if (claim(el) && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return null;
  };

  /**
   * One write per frame, whatever the digitizer did.
   *
   * A touch screen reports two or three times per displayed frame, and a style written on each
   * of those is work the compositor throws away. The events move numbers; this moves pixels.
   */
  const paint = () => {
    frame = 0;
    if (mode === 'dismiss') {
      dialog.style.translate = `0 ${offset.toFixed(1)}px`;
      dialog.style.setProperty('--drag', Math.min(1, Math.max(0, offset) / FADE_OVER).toFixed(3));
    } else if (mode === 'scroll' && scroller) {
      scroller.scrollTop = scrollTo;
    }
  };
  const schedulePaint = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  /** Keep the tail of the gesture, and drop anything older than the window. */
  const sample = (e) => {
    // Every sample the browser captured, including the ones coalesced into this event: the
    // paint is throttled to the frame, the measurement is not. An empty list is still a list,
    // so `||` never fires on it; ask for the length instead.
    const coalesced = e.getCoalescedEvents?.();
    const points = coalesced && coalesced.length ? coalesced : [e];
    for (const p of points) samples.push({ t: p.timeStamp || e.timeStamp, y: p.clientY });
    while (samples.length > 2 && e.timeStamp - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();
  };

  /** Average speed over the tail of the gesture, in px per ms. Downward is positive. */
  const velocity = () => {
    if (samples.length < 2) return 0;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const dt = last.t - first.t;
    return dt > 8 ? (last.y - first.y) / dt : 0;
  };

  /** Give a list its smooth scrolling back; a drag has to be exactly where the finger is. */
  const freeScroller = () => {
    smoothed?.style.removeProperty('scroll-behavior');
    smoothed = null;
  };

  /** Carry a flicked list on after the finger has gone, since nothing else will. */
  const throwList = (speed) => {
    if (!scroller || Math.abs(speed) < FLING_MIN) {
      freeScroller();
      return;
    }
    const list = scroller;
    let v = speed;
    let pos = scrollTo;
    let last = performance.now();
    const step = (now) => {
      // Clamped: a frame the page was not given - a background tab, a long task - must not
      // teleport the list by however long it was away.
      const dt = Math.min(32, now - last);
      last = now;
      v *= Math.pow(FLING_FRICTION, dt);
      const next = Math.max(0, Math.min(maxScroll, pos - v * dt));
      const stuck = next === pos;
      pos = next;
      list.scrollTop = pos;
      if (Math.abs(v) > FLING_FLOOR && !stuck) {
        fling = requestAnimationFrame(step);
      } else {
        fling = 0;
        freeScroller();
      }
    };
    fling = requestAnimationFrame(step);
  };

  /* -------------------------------------------------------------- gesture */

  /** The finger is now moving the sheet rather than the list. */
  const takeSheet = (e) => {
    mode = 'dismiss';
    startY = e.clientY;
    offset = 0;
    dialog.classList.add('dragging');
    dialog.style.transition = 'none';
  };

  /** And back: the list comes with the finger again. */
  const giveBackList = (e) => {
    mode = 'scroll';
    startY = e.clientY;
    scrollFrom = 0;
    scrollTo = 0;
    offset = 0;
    dialog.classList.remove('dragging');
    dialog.style.translate = '';
    dialog.style.setProperty('--drag', '0');
  };

  dialog.addEventListener('pointerdown', (e) => {
    if (!touchInput) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A text field owns its own drag: selecting inside it is not a dismissal.
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;

    stopFling();
    freeScroller();

    pointerId = e.pointerId;
    mode = 'deciding';
    startX = e.clientX;
    startY = e.clientY;
    offset = 0;
    scroller = scrollerUnder(e.target);
    scrollFrom = scroller ? scroller.scrollTop : 0;
    scrollTo = scrollFrom;
    // Read once. Every later handler works from this, so no move ever measures anything.
    maxScroll = scroller ? scroller.scrollHeight - scroller.clientHeight : 0;
    samples = [{ t: e.timeStamp, y: e.clientY }];

    if (scroller) {
      // A log that scrolls smoothly on its own is right when it is following a new message and
      // wrong when it is following a finger: an animated `scrollTop` would lag behind the touch
      // by however long the animation takes.
      smoothed = scroller;
      scroller.style.setProperty('scroll-behavior', 'auto');
    }
    // Promoted now rather than when the drag starts. Asking for the layer at the moment of the
    // first movement means the first frame of the drag pays for the promotion.
    dialog.style.setProperty('will-change', 'translate');
  });

  dialog.addEventListener('pointermove', (e) => {
    if (mode === 'idle' || e.pointerId !== pointerId) return;

    if (mode === 'deciding') {
      const dy = e.clientY - startY;
      if (Math.abs(dy) < SLOP) {
        sample(e);
        return;
      }
      // Sideways is somebody else's gesture, or nobody's.
      if (Math.abs(e.clientX - startX) > Math.abs(dy)) {
        mode = 'idle';
        pointerId = null;
        dialog.style.removeProperty('will-change');
        freeScroller();
        return;
      }
      // Throws if the finger lifted between the browser queueing this move and it running.
      // Unguarded, that would abort the rest of the block and leave the gesture half set up.
      try {
        dialog.setPointerCapture?.(pointerId);
      } catch {
        /* nothing left to capture */
      }
      document.body.style.setProperty('user-select', 'none');
      // Pulling down with nothing above to scroll into view is the sheet. Everything else is
      // the list. That is the whole rule, and it is the one every sheet on a phone uses.
      if (dy > 0 && scrollFrom <= 0) takeSheet(e);
      else mode = 'scroll';
    }

    if (mode === 'scroll') {
      const want = scrollFrom - (e.clientY - startY);
      /*
       * Running out of list mid-gesture hands the rest of the pull to the sheet.
       *
       * Without this, scrolling to the top and carrying on pulling does nothing until you lift
       * your finger and start again - and that is the exact moment every other sheet on a phone
       * starts to move.
       */
      if (want < 0) {
        scrollTo = 0;
        if (scroller) scroller.scrollTop = 0;
        takeSheet(e);
      } else {
        scrollTo = Math.min(maxScroll, want);
      }
    }

    if (mode === 'dismiss') {
      const pulled = e.clientY - startY;
      // Pushing back up out of a pull puts the list under the finger again, rather than
      // stopping dead at the top of a sheet that has not gone anywhere.
      if (pulled < 0 && maxScroll > 0) giveBackList(e);
      // Otherwise: against the way it travels, resisted rather than refused.
      else offset = pulled < 0 ? pulled / RUBBER : pulled;
    }

    sample(e);
    schedulePaint();
    // Nothing was going to scroll on its own - the scrollers are ours - but a pen or a mouse
    // drag would still be starting a text selection.
    if (e.cancelable) e.preventDefault();
  });

  const release = (e) => {
    if (e.pointerId !== pointerId) return;
    const was = mode;
    const speed = velocity();
    mode = 'idle';
    pointerId = null;
    stopFrame();
    dialog.style.removeProperty('will-change');

    // Never past the slop: a tap, and a tap must reach whatever it was aimed at.
    if (was === 'deciding') {
      freeScroller();
      return;
    }

    document.body.style.removeProperty('user-select');
    // Whichever way it went, this was a drag, and the click it began as is not meant.
    swallowNextClick();

    if (was === 'scroll') {
      if (scroller) scroller.scrollTop = scrollTo;
      throwList(speed);
      return;
    }

    freeScroller();
    dialog.classList.remove('dragging');
    // Distance or speed: a short fast flick means the same thing as a long slow pull.
    if (offset > SHEET_DISTANCE || (offset > SHEET_FLICK_TRAVEL && speed > DISMISS_VELOCITY)) leave();
    else {
      // Back to rest, on the sheet's own spring.
      dialog.style.transition = '';
      dialog.style.translate = '';
      dialog.style.setProperty('--drag', '0');
    }
  };

  dialog.addEventListener('pointerup', release);
  dialog.addEventListener('pointercancel', release);

  const reset = () => {
    stopFrame();
    stopFling();
    freeScroller();
    dialog.classList.remove('dragging');
    dialog.style.transition = '';
    dialog.style.translate = '';
    dialog.style.removeProperty('will-change');
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
