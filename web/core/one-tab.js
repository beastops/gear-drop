/**
 * One tab at a time.
 *
 * Every tab of this site in one browser is the same device: the same identity, the same
 * pairings, the same conversations on disk. Two of them running at once announced themselves to
 * the network twice, so each saw the other as a stranger carrying this device's own name, stuck
 * on "connecting…" shaking hands with itself, and a paired device's message could land in either.
 *
 * So one tab is live and any other waits. The newest wins without asking - opening the site
 * again, or sharing a file into it, is plainly where the person wants it - unless the tab it
 * would replace is in the middle of moving a file. Then the new one waits with a button, and
 * taking over is its person's call. A waiting tab comes alive by itself when the live one
 * closes. The tab that loses is told, and reloads into waiting, which is the one way to be sure
 * every socket, session and timer it had is gone.
 *
 * A browser without Web Locks runs every tab, as before.
 */

export const LOCK_NAME = 'gear-drop-live';
const CHANNEL_NAME = 'gear-drop-tabs';
/** How long a new tab waits to hear whether the live one is busy. It answers in a millisecond. */
const ASK_MS = 400;

/**
 * `live` resolves once this tab is the one running; `takeOver()` makes it so now. `onWaiting`
 * is called if it has to wait first, `onLost` if another tab later takes over from it. `asleep`
 * is for a tab that has just lost: it waits rather than taking it straight back.
 */
export function claimTab({
  locks = globalThis.navigator?.locks,
  makeChannel = (name) => new BroadcastChannel(name),
  isBusy = () => false,
  onWaiting = () => {},
  onLost = () => {},
  asleep = false,
  askMs = ASK_MS,
} = {}) {
  if (!locks?.request) return { live: Promise.resolve(), takeOver() {} };

  let channel = null;
  try {
    channel = makeChannel(CHANNEL_NAME);
  } catch {
    /* no BroadcastChannel: a newcomer cannot ask, so it takes over */
  }

  let holding = false;
  let becameLive;
  const live = new Promise((resolve) => (becameLive = resolve));
  const queued = new AbortController();

  channel?.addEventListener('message', (e) => {
    if (holding && e.data?.q === 'busy?') channel.postMessage({ a: 'busy', busy: !!isBusy() });
  });

  /** Ask for the lock. Resolves true once held, false if `ifAvailable` found it taken. */
  const request = (opts) =>
    new Promise((resolve) => {
      let got = false;
      locks
        .request(LOCK_NAME, opts, (lock) => {
          if (!lock) {
            resolve(false);
            return undefined;
          }
          got = true;
          holding = true;
          queued.abort();
          becameLive();
          resolve(true);
          // Held for the life of the page: closing it is what lets the lock go.
          return new Promise(() => {});
        })
        .catch(() => {
          if (!got) {
            resolve(false); // the queued request, withdrawn
            return;
          }
          holding = false;
          onLost();
        });
    });

  const wait = () => {
    onWaiting();
    request({ signal: queued.signal });
  };

  const askBusy = () =>
    new Promise((resolve) => {
      if (!channel) return resolve(false);
      let busy = false;
      const hear = (e) => {
        if (e.data?.a === 'busy' && e.data.busy) busy = true;
      };
      channel.addEventListener('message', hear);
      channel.postMessage({ q: 'busy?' });
      setTimeout(() => {
        channel.removeEventListener('message', hear);
        resolve(busy);
      }, askMs);
    });

  (async () => {
    if (asleep) return wait();
    if (await request({ ifAvailable: true })) return;
    if (await askBusy()) return wait();
    await request({ steal: true });
  })();

  return {
    live,
    takeOver() {
      if (!holding) request({ steal: true });
    },
  };
}
