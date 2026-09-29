/**
 * The phone's Back, for the layers this app draws over itself.
 *
 * Nothing handled it, so on Android - the back button, or the back swipe - Back with a chat or
 * any sheet open left the site: every connection dropped, any transfer stopped. Every app on
 * the phone closes what is in front instead.
 *
 * Each open layer is backed by one history entry, all at the same address, so nothing about
 * them is visible or bookmarkable. Back pops one and closes the layer in front. The entries are
 * indistinguishable, so all that has to hold is that there are as many of them as there are
 * layers.
 *
 * Keeping that true is the whole difficulty, because the two ways of changing the count do not
 * land in the order they are called. `pushState` takes effect at once; `back()` takes effect
 * later, on the entry before the one that was current when it was called. Measured in Chrome:
 * choose Chat from a device menu, the menu hands its entry back just as the chat takes one, the
 * back lands behind the chat's entry, and the next Back leaves the site with the chat open. So:
 *
 *   - a layer closed by its own button, Escape, a swipe or the app does not hand its entry back
 *     at once. It becomes spare for a moment, and a layer opening in that moment - which is the
 *     common case, one sheet replacing another - simply takes it over;
 *   - a spare entry is handed back only when nothing is opening, one traversal at a time;
 *   - and nothing is pushed while one of those traversals is still on its way.
 *
 * `close` may return false to refuse, for a layer that has to be answered; Back then does
 * nothing and the entry is taken again.
 */

/** How long a spare entry is kept for a layer that may be about to open. */
const SPARE_MS = 250;

export function createBackStack({
  history = globalThis.history,
  addEventListener = globalThis.addEventListener?.bind(globalThis),
} = {}) {
  const layers = [];
  let entries = 0; // ours, above the page's own
  let returning = 0; // traversals we started and have not yet seen land
  let trimTimer = 0;

  /** Enough entries for the layers that are open. Not while one of ours is still landing. */
  const fill = () => {
    if (returning > 0) return;
    while (entries < layers.length) {
      history.pushState({ gdLayer: true }, '');
      entries += 1;
    }
  };

  /** Hand back one spare entry, after a pause in which a new layer may claim it. */
  const trimSoon = () => {
    clearTimeout(trimTimer);
    trimTimer = setTimeout(() => {
      if (returning > 0 || entries <= layers.length) return;
      returning += 1;
      entries -= 1;
      history.back();
    }, SPARE_MS);
  };

  addEventListener?.('popstate', () => {
    if (returning > 0) {
      // One of ours has landed. Now it is safe to push, or to hand back the next spare.
      returning -= 1;
      fill();
      if (entries > layers.length) trimSoon();
      return;
    }

    // The person pressed Back. It closes whatever is in front, even if the entry it used was a
    // spare one: a press that visibly does nothing reads as the button being broken.
    entries = Math.max(0, entries - 1);
    const top = layers.pop();
    if (top) {
      let refused = false;
      try {
        refused = top.close() === false;
      } catch {
        /* a layer that throws while closing is still gone */
      }
      if (refused) {
        layers.push(top);
        fill();
      }
    }
    if (entries > layers.length) trimSoon();
  });

  return {
    /** A layer has opened. Call what this returns when it closes by any other means. */
    open(close) {
      const layer = { close };
      layers.push(layer);
      clearTimeout(trimTimer); // a spare entry, if there is one, is this layer's now
      fill();
      return () => {
        const i = layers.indexOf(layer);
        if (i < 0) return; // already closed by Back
        layers.splice(i, 1);
        trimSoon();
      };
    },
    get depth() {
      return layers.length;
    },
  };
}
