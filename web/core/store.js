/**
 * Local persistence. Everything here is device-local and never leaves in the clear:
 * the pairing root, the device keypair, resume bitmaps, and user preferences.
 *
 * Deliberately: no server-side counterpart exists for any of it. Clearing site data
 * is a complete and irreversible unpairing, with nothing to restore from.
 */
const DB_NAME = 'geardrop';
/*
 * Bumped to 2 for the `chats` store.
 *
 * `onupgradeneeded` only creates what is missing, so a database written by version 1 keeps
 * every pairing and every resumable transfer in it and simply gains one more store. There is
 * no migration to get wrong because nothing that already exists is touched.
 */
const DB_VERSION = 3;

let dbPromise = null;

/**
 * Somewhere to keep things when IndexedDB is unavailable.
 *
 * Locked-down browsers, some private modes and embedded WebViews either refuse to open a
 * database or throw on first use. That used to reject out of `boot()` and leave a dead page.
 * Running without persistence is better than refusing to start: a session still pairs and
 * still transfers. What is lost is remembering, meaning paired devices, the display name, and
 * resume across a reload.
 */
/*
 * The fallback for a browser that will not give us a database at all.
 *
 * Every store needs an entry here, not only in `onupgradeneeded`. A name that exists in one
 * and not the other throws the moment the fallback is used, when the database has already
 * failed and this is what was supposed to keep the app running.
 */
const memory = {
  kv: new Map(),
  peers: new Map(),
  transfers: new Map(),
  chats: new Map(),
  attachments: new Map(),
};
let persistent = true;

/** False when this browser would not give us a database. */
export const isPersistent = () => persistent;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err); // some browsers throw here rather than firing onerror
      return;
    }
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('peers')) db.createObjectStore('peers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('transfers')) db.createObjectStore('transfers', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      /*
       * Pictures live beside conversations, not inside them: a log is rewritten on every
       * message, and carrying megabytes through that would make typing cost more as the
       * chat grew. Keyed `<peer>|<random>` so a conversation's images can be dropped
       * without unsealing any of them.
       */
      if (!db.objectStoreNames.contains('attachments')) {
        db.createObjectStore('attachments', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;

      /*
       * Release the connection so another tab can upgrade. Without this it blocks forever
       * and silently falls back to an in-memory store, so nothing gets saved and nothing
       * says so. The next operation here reopens at the new version.
       */
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);

    /*
     * Blocked means some other tab is still holding the previous version. A tab running this
     * code will let go as soon as it hears about it, so the wait is worth making before
     * giving up. The alternative is an app that works but remembers nothing.
     */
    req.onblocked = () => {
      setTimeout(() => reject(new Error('indexeddb blocked')), 1500);
    };
  });
  return dbPromise;
}

/** The same handful of operations, against a Map. */
function memoryOp(store, mode, fn) {
  const map = memory[store];
  const shim = {
    get: (k) => ({ result: map.get(k) }),
    getAll: () => ({ result: [...map.values()] }),
    getAllKeys: () => ({ result: [...map.keys()] }),
    put: (value, key) => {
      map.set(key !== undefined ? key : value.id, value);
      return {};
    },
    delete: (k) => {
      map.delete(k);
      return {};
    },
    clear: () => {
      map.clear();
      return {};
    },
  };
  const out = fn(shim);
  return Promise.resolve(out && 'result' in out ? out.result : out);
}

async function tx(store, mode, fn) {
  let db;
  try {
    db = await openDb();
  } catch {
    persistent = false;
    return memoryOp(store, mode, fn);
  }
  return new Promise((resolve, reject) => {
    let t;
    let s;
    try {
      t = db.transaction(store, mode);
      s = t.objectStore(store);
    } catch (e) {
      // A database that opened and then refuses a transaction is still a dead database.
      persistent = false;
      memoryOp(store, mode, fn).then(resolve, reject);
      return;
    }
    let out;
    try {
      out = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    // An IDBRequest resolves to its .result, including when that result is undefined, which
    // is the difference between "no stored name" and a stray request object.
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: (key) => tx('kv', 'readonly', (s) => s.get(key)),
  set: (key, value) => tx('kv', 'readwrite', (s) => s.put(value, key)),
  del: (key) => tx('kv', 'readwrite', (s) => s.delete(key)),
};

export const peers = {
  /** @returns {Promise<Array>} every paired peer */
  all: () => tx('peers', 'readonly', (s) => s.getAll()),
  get: (id) => tx('peers', 'readonly', (s) => s.get(id)),
  put: (peer) => tx('peers', 'readwrite', (s) => s.put(peer)),
  del: (id) => tx('peers', 'readwrite', (s) => s.delete(id)),
  clear: () => tx('peers', 'readwrite', (s) => s.clear()),
};

/**
 * One record per conversation, each holding a sealed blob and nothing else in the clear
 * except whose it is and when it last changed. The id is the peer's, so a device that comes
 * back finds its own history waiting.
 */
export const chats = {
  get: (id) => tx('chats', 'readonly', (s) => s.get(id)),
  put: (rec) => tx('chats', 'readwrite', (s) => s.put(rec)),
  del: (id) => tx('chats', 'readwrite', (s) => s.delete(id)),
  all: () => tx('chats', 'readonly', (s) => s.getAll()),
  clear: () => tx('chats', 'readwrite', (s) => s.clear()),
};

/**
 * The bytes of one picture, sealed, and nothing else.
 *
 * There is no name, no type and no size here in the clear - those live in the conversation
 * record, which is itself sealed. What a copy of this database shows is that some conversation
 * has some attachments, and how large they are. What they are of is not recoverable without
 * the vault key.
 */
export const attachments = {
  get: (id) => tx('attachments', 'readonly', (s) => s.get(id)),
  put: (rec) => tx('attachments', 'readwrite', (s) => s.put(rec)),
  del: (id) => tx('attachments', 'readwrite', (s) => s.delete(id)),
  /** Keys only: deleting a conversation's pictures must not read them all into memory first. */
  keys: () => tx('attachments', 'readonly', (s) => s.getAllKeys()),
  clear: () => tx('attachments', 'readwrite', (s) => s.clear()),
};

export const transfers = {
  get: (id) => tx('transfers', 'readonly', (s) => s.get(id)),
  put: (t) => tx('transfers', 'readwrite', (s) => s.put(t)),
  del: (id) => tx('transfers', 'readwrite', (s) => s.delete(id)),
  all: () => tx('transfers', 'readonly', (s) => s.getAll()),
};

/** Ask the browser to keep our data through storage pressure (matters for OPFS sinks). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch {
    /* ignore */
  }
  return false;
}

export async function estimateQuota() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Destroy everything this origin holds: database, received files, web storage, caches and
 * the service worker. Received files matter most, because they sit in origin-private storage
 * as plain bytes rather than sealed like the database.
 *
 * Every step runs regardless of the one before it, and peers are not told: a device
 * announcing that it erased itself is not disappearing.
 *
 * @returns {Promise<{ db, files, web, caches, worker }>} what actually succeeded.
 */
export async function wipe() {
  const done = { db: false, files: false, web: false, caches: false, worker: false };

  // 1. The database: close the handle first, or the delete blocks behind our own connection.
  try {
    const db = await openDb();
    db.close();
  } catch {
    /* never opened, or already gone */
  }
  dbPromise = null;
  try {
    done.db = await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
      /*
       * Another tab still has it open, so the delete is queued, not done.
       *
       * Reporting success here would be the worst possible lie this function could tell -
       * the caller would reload into an app that looks freshly installed while the records
       * are still on disk, waiting for the other tab to close. It resolves rather than
       * hanging so the remaining steps still run, and reports false so the caller says so.
       */
      req.onblocked = () => resolve(false);
    });
  } catch {
    /* reported as a failure, and the rest still runs */
  }

  // The in-memory mirror used when there is no database at all holds the same secrets.
  for (const map of Object.values(memory)) map.clear();

  /*
   * 2. Received bytes in origin-private storage.
   *
   * Recursive, and by handle rather than by name, because a partial transfer can leave a
   * directory behind and `remove({ recursive: true })` is not available everywhere this runs.
   */
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      for await (const [name, handle] of root.entries()) {
        try {
          await root.removeEntry(name, { recursive: handle.kind === 'directory' });
        } catch {
          /* held open by a live stream; the next step still runs */
        }
      }
      done.files = true;
    }
  } catch {
    /* no OPFS here */
  }

  // 3. Theme, language, and the chosen relay.
  try {
    localStorage.clear();
    sessionStorage.clear();
    done.web = true;
  } catch {
    /* private mode can refuse both */
  }

  // 4. The cached application shell. Not secret, but "everything" has to mean everything.
  try {
    if (globalThis.caches?.keys) {
      for (const key of await caches.keys()) await caches.delete(key);
      done.caches = true;
    }
  } catch {
    /* ignore */
  }

  // 5. And the worker itself, so nothing survives to re-seed a cache after the reload.
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) || [];
    for (const reg of regs) await reg.unregister();
    done.worker = true;
  } catch {
    /* ignore */
  }

  return done;
}
