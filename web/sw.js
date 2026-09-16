/**
 * Offline shell, and the receiving end of the system share sheet.
 *
 * The worker never sees file bytes from a transfer: those are peer-to-peer and sealed, and
 * nothing about them passes through fetch(). The one time it touches a file is when the
 * operating system hands one over through the share sheet, and even then it only carries
 * it across to the page. It is never uploaded, cached, or written anywhere.
 */
const VERSION = 'gd-v2.57.0';
const SHELL = [
  './',
  'index.html',
  'app.css',
  'main.js',
  'manifest.webmanifest',
  'icon.svg',
  'core/bytes.js',
  'core/gdcrypto.js',
  'core/wordlist.js',
  'core/signal.js',
  'core/ice.js',
  'core/session.js',
  'core/channel.js',
  'core/store.js',
  'core/transport.js',
  'core/transfer.js',
  'core/sink.js',
  'core/opfs-worker.js',
  'core/qr.js',
  'core/filename.js',
  'core/vault.js',
  'core/tt.js',
  'core/picker.js',
  'core/platform.js',
  'core/relay-transport.js',
  'core/ranges.js',
  'core/ripple.js',
  'core/glass-gl.js',
  'core/ripple-worker.js',
  'ui/i18n.js',
  'ui/swipe.js',
  'core/chat.js',

  /*
   * The crypto, which was never here.
   *
   * `core/gdcrypto.js` imports ristretto255 out of `vendor/`, so without these the offline
   * shell stopped at the first import and the app could not boot at all - the cache held a
   * page that could not key a session. It went unnoticed because the fetch handler is
   * stale-while-revalidate: anything missing is fetched and cached on first use, so a single
   * online load papers over the gap. What it does not cover is the case this list exists for,
   * which is an install that goes offline before that load.
   *
   * There is a test alongside this file that walks the import graph from `main.js` and fails
   * if anything reachable is absent here, because the list had already drifted twice - once
   * when the crypto was vendored, and once when the conversation module was added.
   */
  'vendor/@noble/curves/ed25519.js',
  'vendor/@noble/curves/utils.js',
  'vendor/@noble/curves/abstract/curve.js',
  'vendor/@noble/curves/abstract/edwards.js',
  'vendor/@noble/curves/abstract/hash-to-curve.js',
  'vendor/@noble/curves/abstract/modular.js',
  'vendor/@noble/curves/abstract/montgomery.js',
  'vendor/@noble/curves/abstract/utils.js',
  'vendor/@noble/hashes/sha2.js',
  'vendor/@noble/hashes/utils.js',
  'vendor/@noble/hashes/scrypt.js',
  'vendor/@noble/hashes/pbkdf2.js',
  'vendor/@noble/post-quantum/_crystals.js',
  'vendor/@noble/post-quantum/_deps/curves/abstract/fft.js',
  'vendor/@noble/post-quantum/_deps/curves/abstract/modular.js',
  'vendor/@noble/post-quantum/_deps/curves/utils.js',
  'vendor/@noble/post-quantum/_deps/hashes/_md.js',
  'vendor/@noble/post-quantum/_deps/hashes/_u64.js',
  'vendor/@noble/post-quantum/_deps/hashes/hmac.js',
  'vendor/@noble/post-quantum/_deps/hashes/sha2.js',
  'vendor/@noble/post-quantum/_deps/hashes/sha3.js',
  'vendor/@noble/post-quantum/_deps/hashes/utils.js',
  'vendor/@noble/post-quantum/ml-kem.js',
  'vendor/@noble/post-quantum/utils.js',
  'vendor/@noble/hashes/crypto.js',
  'vendor/@noble/hashes/_md.js',
  'vendor/@noble/hashes/_u64.js',
  'vendor/@noble/hashes/_assert.js',
  'vendor/@noble/hashes/hmac.js',
  'vendor/@noble/hashes/hkdf.js',
  'core/heic.js',
  'core/dust.js',
  'core/thumb.js',
];

/*
 * Fetched on first use, then kept. Never at install.
 *
 * Three megabytes of HEIC decoder, which is dead weight for everyone who does not own an
 * iPhone and is the whole feature for everyone who does. Precaching it would put that on
 * every install; refusing to cache it would re-download it for every photo, because the
 * fetch handler only stores what is on a list.
 *
 * A closed list either way. The rule it exists for is unchanged: the server answers an
 * unknown path with the app shell, so a cache that stored anything it was asked for would
 * fill the person's disk with copies of index.html.
 */
const LAZY = ['core/heic-worker.js', 'vendor/libheif/libheif.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      /*
       * `cache: 'reload'` - past the HTTP cache, to the network.
       *
       * `cache.add()` fetches like anything else, so a plain one is served by the browser's
       * own cache. Back when assets were sent as immutable for a year, that meant a new
       * worker version could fill a brand new cache with the previous release and report the
       * new version while running the old code. The headers no longer say that, and this no
       * longer depends on them.
       *
       * One bad entry must not fail the whole install and leave the app without a shell.
       */
      .then((c) =>
        Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* ------------------------------------------------------------ share target */

/**
 * Held in memory only, and handed to the first page that asks. If the worker is evicted
 * before the page loads, the share is lost, which is the right failure, because
 * the alternative is writing someone's shared file to storage they did not ask for.
 */
let pendingShare = null;

/*
 * The set of things this worker is willing to keep.
 *
 * Revalidation used to store any same-origin GET that came back, and the server answers an
 * unknown path with the app shell rather than a 404, so every made-up URL was a fresh cache
 * entry holding a copy of index.html, and a page that could be made to fetch a few thousand of
 * them would quietly fill the person's disk. The shell is a closed list, checked against the
 * app's real imports by a test, so storing exactly that list costs nothing and closes it.
 */
const KEEPABLE = new Set([...SHELL, ...LAZY].map((u) => new URL(u, self.registration.scope).href));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // never touch other origins

  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(e.request));
    return;
  }

  if (e.request.method !== 'GET') return;
  if (url.pathname === '/ice' || url.pathname === '/rv') return; // always live

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok && res.type === 'basic' && KEEPABLE.has(url.href)) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string');
    const text = [form.get('title'), form.get('text'), form.get('url')].filter(Boolean).join('\n').trim();
    pendingShare = { t: 'shared', files, text };
    // A page may already be open; give it the share straight away.
    const clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length) {
      clients[0].postMessage(pendingShare);
      pendingShare = null;
      await clients[0].focus?.().catch?.(() => {});
    }
  } catch {
    /* a malformed share is simply dropped */
  }
  return Response.redirect('./?shared=1', 303);
}

self.addEventListener('message', (e) => {
  if (e.data?.t !== 'want-shared') return;
  if (!pendingShare) return;
  e.source?.postMessage(pendingShare);
  pendingShare = null;
});
