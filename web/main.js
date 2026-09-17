/**
 * Gear Drop: application shell.
 *
 * Devices are tiles on a radar. Click one to send, drop files on one to send, or stage files
 * first and then pick a destination. Everything peer-supplied is rendered with textContent
 * and never as markup, so a stored XSS through a peer's display name is not reachable.
 *
 * Colour in this interface means exactly one thing: how a device is reachable.
 *   blue   this network     green  paired      amber  a room      accent  a code, pairing now
 * Every channel also has its own pill shape and a written label, so the interface still
 * works for someone who cannot tell the three apart.
 */
import { fmtBytes, fmtRate, fmtDuration, toHex } from './core/bytes.js';
import {
  newCode,
  newRoomCode,
  normalizeCode,
  tagForCode,
  hostEpochs,
  newDeviceKey,
  friendlyName,
  pairTag,
  pairHint,
  currentEpoch,
  EPOCH_SECONDS,
  CODE_LEN,
  ROOM_CODE_LEN,
} from './core/gdcrypto.js';
import { SignalClient, defaultUrl, originRelay, proposedRelay, rememberRelay } from './core/signal.js';
import { SecureSession } from './core/session.js';
import { Transport } from './core/transport.js';
import { TransferManager, offerDownload, sweepResume } from './core/transfer.js';
import * as chat from './core/chat.js';
import { canThumb, isImageMime, makeThumb, thumbUrl } from './core/thumb.js';
import {
  kv,
  peers as peerStore,
  chats,
  attachments,
  requestPersistence,
  estimateQuota,
  isPersistent,
  wipe as wipeStorage,
} from './core/store.js';
import { openVault, seal, unseal, sealField, unsealField, vaultMode } from './core/vault.js';
import * as vault from './core/vault.js';
import { SAS_WORDS } from './core/wordlist.js';
import { scriptURL, trustedTypesActive } from './core/tt.js';
import { sinkCapabilities, sweepIncoming } from './core/sink.js';
import { drawQR } from './core/qr.js';
import { filesFromDataTransfer, filesFromInput } from './core/picker.js';
import { RelayTransport } from './core/relay-transport.js';
import { Radar } from './core/ripple.js';
import { platform, saveFile } from './core/platform.js';
import { safeFileName, safePathSegments, riskOf } from './core/filename.js';
import { Channel } from './core/channel.js';
import { LOCALES, currentLocale, preferredLocale, setLocale, setText, t } from './ui/i18n.js';
import { enableSwipeToDismiss, enableSwipeUpToDismiss } from './ui/swipe.js';
import { captureDust } from './core/dust.js';

const te = new TextEncoder();
const td = new TextDecoder();

const $ = (id) => document.getElementById(id);

const ui = {
  radar: $('radar'),
  footer: $('footer'),
  beacon: $('beacon'),
  linkState: $('link-state'),
  aboutBtn: $('btn-about'),
  addBtn: $('btn-add'),
  roomBtn: $('btn-room'),
  devicesBtn: $('btn-devices'),
  pairedBtn: $('btn-paired'),
  verifyPairs: $('verify-pairs'),
  verifyAsked: $('verify-asked'),
  paired: $('paired-dialog'),
  langBtn: $('btn-lang'),
  installBtn: $('btn-install'),
  peers: $('peers'),
  empty: $('empty'),
  emptySeeking: $('empty-seeking'),
  hint: $('hint'),
  addBtnEmpty: $('btn-add-empty'),
  roomBtnEmpty: $('btn-room-empty'),
  netBtnEmpty: $('btn-network-empty'),
  deviceName: $('device-name'),
  deviceNameText: $('device-name-text'),
  chipDiscovery: $('chip-discovery'),
  discLabel: $('disc-label'),
  chipPaired: $('chip-paired'),
  favicon: $('favicon'),

  shareBar: $('share-bar'),
  shareThumb: $('share-thumb'),
  shareTitle: $('share-title'),
  shareSub: $('share-sub'),
  shareCancel: $('share-cancel'),

  connect: $('connect-dialog'),
  hostBtn: $('btn-host'),
  hostCode: $('host-code'),
  hostQr: $('host-qr'),
  qrFrame: $('qr-frame'),
  codeDisplay: $('code-display'),
  codeTimer: $('code-timer'),
  copyLink: $('btn-copy-link'),
  codeInputs: $('code-inputs'),
  connectInvite: $('connect-invite'),
  connectInviteCode: $('connect-invite-code'),
  connectNormal: $('connect-normal'),
  connectInviteNo: $('btn-connect-invite-no'),
  connectInviteYes: $('btn-connect-invite-yes'),
  joinStatus: $('join-status'),

  room: $('room-dialog'),
  roomInactive: $('room-inactive'),
  roomActive: $('room-active'),
  roomCreate: $('btn-room-create'),
  roomInputs: $('room-inputs'),
  roomCodeRow: $('room-code'),
  roomQr: $('room-qr'),
  roomQrFrame: $('room-qr-frame'),
  roomCount: $('room-count'),
  roomCopy: $('btn-room-copy'),
  roomLeave: $('btn-room-leave'),

  network: $('network-dialog'),
  netStatus: $('net-status'),
  discChoices: $('discovery-choices'),
  discNotes: {
    off: $('disc-note-off'),
    local: $('disc-note-local'),
    public: $('disc-note-public'),
  },
  publicCode: $('public-code'),
  publicQr: $('public-qr'),
  publicQrFrame: $('public-qr-frame'),
  publicCount: $('public-count'),
  publicCopy: $('btn-public-copy'),
  publicNew: $('btn-public-new'),

  devices: $('devices-dialog'),
  deviceRows: $('device-rows'),
  pairedRows: $('paired-rows'),
  devicesEmpty: $('devices-empty'),

  verify: $('verify-dialog'),
  verifyWords: $('verify-words'),
  sasOk: $('btn-sas-ok'),
  sasBad: $('btn-sas-bad'),

  incoming: $('incoming-dialog'),
  incomingTitle: $('incoming-title'),
  incomingFrom: $('incoming-from'),
  incomingSas: $('incoming-sas'),
  incomingSize: $('incoming-size'),
  incomingFiles: $('incoming-files'),
  incomingHint: $('incoming-sink-hint'),
  incomingWarn: $('incoming-warn'),
  incomingPreview: $('incoming-preview'),
  incomingPreviewImg: $('incoming-preview-img'),
  roomInvite: $('room-invite'),
  roomInviteCode: $('room-invite-code'),
  roomInviteYes: $('btn-room-invite-yes'),
  roomInviteNo: $('btn-room-invite-no'),
  incomingGate: $('incoming-gate'),
  incomingConfirm: $('incoming-confirm'),
  btnAccept: $('btn-accept'),

  chatDialog: $('chat-dialog'),
  chatWho: $('chat-who'),
  chatLog: $('chat-log'),
  chatEmpty: $('chat-empty'),
  chatLocked: $('chat-locked'),
  chatEphemeral: $('chat-ephemeral'),
  chatOffline: $('chat-offline'),
  chatGone: $('chat-gone'),
  chatSecure: $('chat-secure'),
  chatSecureText: $('chat-secure-text'),
  chatSecureWarn: $('chat-secure-warn'),
  chatComposer: $('chat-composer'),
  chatInput: $('chat-input'),
  chatSend: $('btn-chat-send'),
  chatClear: $('btn-chat-clear'),
  chatAttach: $('btn-chat-attach'),
  lockDialog: $('lock-dialog'),
  lockNow: $('btn-lock-now'),
  lockChange: $('btn-lock-change'),
  lockForm: $('lock-form'),
  lockPass: $('lock-pass'),
  lockError: $('lock-error'),
  lockForgot: $('btn-lock-forgot'),
  passDialog: $('pass-dialog'),
  passTitle: $('pass-title'),
  passSub: $('pass-sub'),
  passForm: $('pass-form'),
  passOne: $('pass-one'),
  passTwo: $('pass-two'),
  passShow: $('btn-pass-show'),
  passGo: $('btn-pass-go'),
  passError: $('pass-error'),
  passSuggest: $('pass-suggest'),
  passSuggested: $('pass-suggested'),
  passUse: $('btn-pass-use'),
  lockState: $('lock-state'),
  lockSet: $('btn-lock-set'),
  chatMic: $('btn-chat-mic'),
  chatRec: $('chat-rec'),
  chatRecTime: $('chat-rec-time'),
  chatRecCancel: $('btn-rec-cancel'),


  lang: $('lang-dialog'),
  langList: $('lang-list'),

  relayDialog: $('relay-dialog'),
  relayCurrent: $('relay-current'),
  relayProposed: $('relay-proposed'),
  relayAccept: $('relay-accept'),
  relayKeep: $('relay-keep'),

  about: $('about-dialog'),
  aboutInstall: $('about-install'),
  aboutHow: $('about-how'),

  toastHost: $('toast-host'),
};

const app = {
  signal: new SignalClient(),
  device: null,
  name: '',
  kind: guessKind(),
  radar: null,

  conns: new Map(), // connId -> conn
  paired: [],
  pairSubs: new Map(), // tagHex -> { peer, session }

  channels: { local: null, room: null },
  chanPeers: new Map(), // member idKey -> { member, session, channel }
  alsoOn: new Map(), // paired peer id -> Set<'local'|'room'>

  staged: null, // share mode
  /** One session per epoch tag the host is reachable at. */
  hostSessions: [],
  hostCode: null,
  hostDeadline: 0,
  roomCode: null,

  prefs: {
    /*
     * Dark by default, rather than following the system.
     *
     * 'auto' hands the app's look to a setting made somewhere else: open it on a laptop in
     * light mode and you get the pale version of a screen designed around a dark radar. The
     * light theme is two taps away in Appearance, where 'auto' is also still on offer.
     */
    theme: 'dark',
    lang: null,
    /**
     * Who can find this device: 'off', 'local' (same network) or 'public' (a code, any
     * network). One value rather than a switch per channel, so "who can see me?" has a
     * single answer. 'local' by default, and the cost is stated where it is chosen.
     */
    discovery: 'local',
    /** The code that 'public' is currently using, so it survives a reload. */
    publicCode: null,
    /**
     * Whether a device on another network may have this one's public address.
     *
     * Off. A direct connection is a direct connection: the two ends exchange candidates and
     * each learns where the other is, which for anyone outside your own network is an address
     * and a rough location handed to whoever is at the far end. That is a reasonable trade for
     * speed and an unreasonable thing to make silently on someone's behalf, so it is asked for
     * rather than assumed.
     *
     * It costs less than it sounds. Devices on the same network still connect directly and
     * still go at full speed - see `localReach` - because on your own network a direct
     * connection needs no public address gathered at all. What this switch buys is that same
     * speed to a device somewhere else, and what it spends is the address.
     */
    direct: false,
    notify: false,
    /*
     * A tone when something lands. On by default, unlike notifications.
     *
     * It needs no permission, it cannot follow anyone anywhere, and it is the only signal that
     * works when the window is behind something else and the person is not watching the screen
     * at all. Notifications stay off until asked for because they are a permission prompt;
     * this is just a sound this page makes, so the default can be the useful one.
     */
    sound: true,
    awake: true,
    /**
     * Where a received file lands. 'sandbox' streams into origin-private storage and then
     * offers a download, holding no filesystem handle. 'ask' opens the save dialog and
     * streams into the one file chosen: faster, but a real location, so it is opt-in.
     */
    saveTo: 'sandbox',
    /**
     * Strict peer-to-peer, on by default.
     *
     * The bytes of a transfer go device to device. When a network blocks WebRTC outright
     * there is a fallback carrying the same sealed frames over the rendezvous socket, where
     * the relay handles AEAD ciphertext and stores none of it. That is still bytes passing
     * through someone else's machine, so it is never entered silently: the app asks every
     * time, and the answer is not remembered.
     */
    allowRelay: false,
  },
};

/** The resting tab icon, remembered before the progress ring ever replaces it. */
let baseFavicon = null;

/* ─────────────────────────────────── boot ─────────────────────────────── */

boot().catch((err) => toast(humanError(err?.message), 'bad'));

async function boot() {
  loadLocalPrefs();
  applyTheme();
  setLocale(app.prefs.lang || preferredLocale());

  /*
   * Nothing is read before this.
   *
   * With a passphrase set there is no key on the device, so its own identity and every
   * pairing are unreadable until one is derived. Loading first and asking afterwards would
   * generate a second identity beside the sealed one: the app would work, and every device it
   * had paired with would be gone.
   */
  if (await vault.hasPassphrase()) await askToUnlock();

  /*
   * Open the relay socket now, before anything that does not need it.
   *
   * Nothing below depends on the socket. Compiling a shader, unwrapping the vault key and
   * reading this device's identity are all local work, but the socket was queued behind them
   * and it is the one step with a network round trip in it. Started here, the handshake
   * overlaps the boot instead of following it: measured cold, the relay was ready at 460ms
   * and the page at 300ms, so most of that gap was queueing.
   *
   * The label it brings back cannot be acted on until preferences are loaded, so that is held
   * until the end of boot rather than raced.
   */
  app.signal.addEventListener('state', paintLinkState);
  app.signal.addEventListener('network', onNetworkLabel);
  app.signal.connect();

  app.radar = new Radar(ui.radar, { originEl: ui.beacon });

  /*
   * Glass behind the controls, not instead of them.
   *
   * Every button on this screen stays a real `<button>`, with tab order, Enter and Space, a
   * focus ring and a label. This draws underneath them and never takes a pointer event, so
   * nothing about operating the app changes; only what is behind it does.
   *
   * If WebGL is missing or the shader will not build, nothing is mounted and the CSS glass
   * that was always there carries on. The class is what switches the two over, so they can
   * never both be painting at once.
   */

  // Establish the wrapping key before anything reads a secret, so no code path can race
  // ahead and find the vault closed.
  await openVault();

  app.device = await loadDevice();
  app.name = (await kv.get('name')) || (await friendlyName(app.device.pub));
  ui.deviceNameText.textContent = app.name;

  const stored = (await kv.get('prefs')) || {};
  /*
   * A shut vault gives nothing back, and the room is not restored. That is the right answer:
   * being in a room is a way of being reachable, and it should not resume behind a lock.
   * A record written before this was sealed still has the code in the clear; it is read here
   * and sealed by the next write.
   */
  if (stored.publicCodeSealed) {
    const bytes = await unseal(stored.publicCodeSealed);
    stored.publicCode = bytes ? td.decode(bytes) : null;
    if (bytes) bytes.fill(0);
    delete stored.publicCodeSealed;
  }
  app.prefs = { ...app.prefs, ...stored, theme: app.prefs.theme, lang: app.prefs.lang };

  describeStorage();

  // The socket was opened at the top of boot; this is where its arrival starts being acted on.
  paintLinkState();
  booted = true;

  /*
   * Before saying hello to the network, not after.
   *
   * A presence announcement carries one rotating hint per paired device, and that is how a
   * device that already knows this one recognises it and stays on the pairing it has. Sent
   * with the list still empty - which is what happened when the relay's network frame beat
   * the first read of the database - the announcement says "stranger", and every paired
   * device on the network answers by opening a second conversation it then has to throw
   * away. Two handshakes, two arrival banners, one device.
   */
  await refreshPaired();
  if (networkArrived) onNetworkLabel();

  // Anything stored for a device that is no longer paired, or was never durable, goes now.
  chat.sweep(app.paired.map((p) => p.id)).catch(() => {});
  setInterval(resubscribePaired, RESUBSCRIBE_MS);
  setInterval(tickHostTimer, 250);
  watchIdleLock();

  /*
   * Listen again the moment there is any reason to.
   *
   * The sweep is a safety net for the epoch rolling over, not the way a device gets back in
   * touch. Waiting for it cost up to thirty seconds of a phone just out of a pocket, or a
   * laptop just woken, listening at nothing. These are the three moments where that happens.
   */
  const relisten = () => resubscribePaired().catch(() => {});
  addEventListener('online', relisten);
  addEventListener('focus', relisten);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') relisten();
  });

  bindUi();
  /*
   * The rest of the start-up, each piece on its own.
   *
   * These have nothing to do with one another - one reads the worker's version, one builds the
   * language list, one restores the discovery mode, one acts on a room code in the link - and
   * written as plain statements the first to throw ended `boot` and took the others with it.
   * That happened: `showBuild` was deleted by a patch script and the call to it left behind, so
   * for three commits the language list was empty, the saved discovery mode was never restored
   * and a shared link's room code was ignored, while the only symptom was one toast reading
   * "Something went wrong".
   *
   * Each is passed as a function rather than collected into a list, because a list would
   * evaluate all seven names before the first `try` and a missing one would throw there instead.
   */
  bootStep('showBuild', () => showBuild());
  bootStep('buildLangList', () => buildLangList());
  bootStep('applyPlatform', () => applyPlatform());
  bootStep('askAboutProposedRelay', () => askAboutProposedRelay());
  bootStep('restoreDiscovery', () => restoreDiscovery());
  bootStep('handleUrlFragment', () => handleUrlFragment());
  bootStep('render', () => render());
}

/**
 * Run one piece of start-up, and if it fails, say which one.
 *
 * Not swallowed: the whole reason this exists is that a failure here used to arrive as a single
 * sentence with no name attached to it. The console gets the name and the real error; the person
 * gets an app with everything else in it working.
 */
function bootStep(name, run) {
  try {
    run();
  } catch (err) {
    console.error(`Gear Drop: ${name} failed during start-up`, err);
  }
}

/**
 * The relay chip is written from script rather than from the document, so it must be
 * repainted after a language change as well as a state change. Otherwise switching language
 * leaves a live connection labelled "offline".
 */
function paintLinkState() {
  const state = app.signal.state;
  const online = state === 'online';
  const label = t(
    online ? 'state.online' : state === 'connecting' ? 'state.connecting' : 'state.offline',
  );
  /*
   * Into the span, not onto the chip.
   *
   * The dot is a pseudo-element on the chip and the words are a child of it, because a narrow
   * screen keeps the first and drops the second. Writing to `textContent` here would delete
   * the span on the first state change and take that arrangement with it.
   */
  const text = ui.linkState.querySelector('.chip-text') || ui.linkState;
  text.textContent = label;
  ui.linkState.className = 'chip ' + (online ? 'chip-live' : 'chip-quiet');

  /*
   * Nothing is shown for the ordinary case.
   *
   * A badge that reads "ready" whenever everything is fine is a badge that is almost always
   * on screen saying almost nothing, and it sat next to the wordmark where it read as part of
   * the name. The information it carried is not lost: while the relay is reachable the beacon
   * breathes, which is the same fact told by the thing the screen is already about. So the
   * words appear only when they would tell you something you cannot otherwise see - that the
   * app is still connecting, or that it cannot connect at all.
   */
  ui.linkState.hidden = online;
  // The beacon only breathes while the relay is reachable: it is a status light.
  document.body.classList.toggle('link-live', online);
}

async function loadDevice() {
  const saved = await kv.get('device');
  if (saved?.pub) {
    const opened = await unsealField(saved, 'priv');
    if (opened) {
      // A key written by a version that stored it in the clear is re-written sealed the
      // first time it is read, so the exposure ends at this load rather than continuing.
      if (opened.legacy) await kv.set('device', await sealField({ ...saved }, 'priv'));
      return { kind: saved.kind, pub: new Uint8Array(saved.pub), priv: opened.priv };
    }
    // Sealed under a key this browser no longer holds. The identity is unrecoverable, so
    // make a new one rather than carrying a broken record forward.
  }
  const key = await newDeviceKey();
  await kv.set(
    'device',
    await sealField({ kind: key.kind, pub: Array.from(key.pub), priv: Array.from(key.priv) }, 'priv'),
  );
  return key;
}

/**
 * Paired devices, with their roots taken out of the vault.
 *
 * A record whose root will not open is dropped: it was written under a key this browser no
 * longer has, and a pairing that cannot be proved is not a pairing. The alternative would be
 * treating an unreadable record as trusted.
 */
async function allPeers() {
  const raw = await peerStore.all();
  const out = [];
  for (const rec of raw) {
    const opened = await openPeer(rec);
    if (!opened) continue;
    // A row in the old shape is rewritten whole the first time it is read, so the metadata
    // beside the root stops sitting in the clear without anyone having to pair again.
    if (opened.legacy) {
      delete opened.legacy;
      await savePeer(opened);
    }
    out.push(opened);
  }
  return out;
}

/**
 * Move everything sealed from one key to another.
 *
 * Called whenever the key changes: a passphrase set, changed, or removed. Everything the
 * vault protects moves together (the device's own identity, the pairing roots, the
 * conversations, and every picture and recording in them), because a record left under the
 * old key cannot be opened again.
 *
 * Read and re-seal everything first, commit second. If anything fails, nothing is written and
 * the vault is as it was. The cost is holding the re-sealed set in memory in between, which
 * for a conversation full of attachments is expensive; it is also rare and initiated by the
 * person, who is watching it happen.
 */
async function resealVault(oldKey, newKey) {
  let stranded = 0;

  /* Every sealed field on a record moves, whatever the record's shape. See `sealedFields`. */
  const move = async (rec) => {
    const fields = vault.sealedFields(rec);
    if (!fields.length) return null;

    const out = { ...rec };
    let moved = 0;
    for (const field of fields) {
      const bytes = await vault.unsealWith(oldKey, rec[field]);
      // A record that was already unreadable stays unreadable; it is not made worse, and
      // refusing the whole conversion over one dead row would strand everything else.
      if (!bytes) {
        stranded++;
        continue;
      }
      out[field] = await vault.sealWith(newKey, bytes);
      bytes.fill(0);
      moved++;
    }
    return moved ? out : null;
  };

  const writes = [];

  // The device's own key, which is what every pairing is anchored to.
  const device = await kv.get('device');
  const movedDevice = await move(device);
  if (movedDevice) writes.push(() => kv.set('device', movedDevice));

  /*
   * And the preferences, which carry the sealed room code.
   *
   * `move` finds sealed fields by shape, so a new one is picked up without being named here -
   * but only inside a record this walk visits, and `prefs` was not one of them. A sealed field
   * in a record nobody moves is stranded under the old key the first time a passphrase is set.
   */
  const prefs = await kv.get('prefs');
  const movedPrefs = await move(prefs);
  if (movedPrefs) writes.push(() => kv.set('prefs', movedPrefs));

  // Paired devices, and the conversations held with them.
  for (const store of [peerStore, chats]) {
    for (const rec of await store.all()) {
      const moved = await move(rec);
      if (moved) writes.push(() => store.put(moved));
    }
  }

  // And what those conversations refer to, read one at a time: a picture store is the one
  // place here large enough that loading all of it at once would matter.
  for (const id of await attachments.keys()) {
    const moved = await move(await attachments.get(id));
    if (moved) writes.push(() => attachments.put(moved));
  }

  for (const write of writes) await write();
  if (stranded) console.warn(`vault: ${stranded} record(s) could not be moved`);
  return writes.length;
}

/**
 * Write a paired device back, sealed.
 *
 * The root was sealed and everything beside it was not, so a copied database still listed
 * every device this one had paired with, by name, with its identifier and when it was last
 * seen. The root is what would let someone impersonate a device; the list is what says who
 * you talk to, which for most people is the more sensitive half.
 *
 * `id` stays outside because it is the primary key and the database has to index on
 * something. Everything else moves inside.
 */
async function savePeer(rec) {
  const { id, ...rest } = rec;
  const body = te.encode(JSON.stringify({ ...rest, root: Array.from(rec.root) }));
  const out = { id, sealed: await seal(body) };
  body.fill(0);
  return peerStore.put(out);
}

/** The inverse. Returns null for a row this browser can no longer read. */
async function openPeer(row) {
  if (!row) return null;
  if (row.sealed) {
    const bytes = await unseal(row.sealed);
    if (!bytes) return null;
    try {
      const rec = JSON.parse(td.decode(bytes));
      bytes.fill(0);
      return { ...rec, id: row.id, root: Uint8Array.from(rec.root || []) };
    } catch {
      return null;
    }
  }
  // Written by an earlier version, with only the root sealed. Readable, and rewritten whole
  // on the next save.
  const opened = await unsealField(row, 'root');
  return opened ? { ...opened, root: Uint8Array.from(opened.root), legacy: true } : null;
}

async function describeStorage() {
  await requestPersistence();
  // Clear anything a previous visit left behind before reporting how much room there is.
  sweepIncoming()
    .then((n) => n && console.info(`Gear Drop: removed ${n} leftover file(s) from private storage`))
    .catch(() => {});
  // Progress records for transfers nobody is going to resume are residue too. Resume
  // survives a dropped link but not a reload, so at boot every record is already
  // unresumable and the cutoff is all of them. The age window stays in the API for when
  // resume across a reload lands.
  sweepResume(0)
    .then((n) => n && console.info(`Gear Drop: cleared ${n} stale transfer record(s)`))
    .catch(() => {});
  if (!isPersistent()) {
    // Running is better than refusing to start, but silently forgetting everything is not.
    toast(t('toast.noStore'), 'bad', { hold: 12_000 });
  }
  /*
   * The quota is still read, and still not shown.
   *
   * It is the number the transfer code checks before accepting a large file, so it has to be
   * known; it was also being printed under the footer as "streams to disk, 246 GB free", which
   * is a sentence about how the app is implemented rather than anything you can act on. How
   * received files are stored is a setting, and it lives in Settings.
   */
  app.quota = (await estimateQuota())?.quota || 0;
}

/** Theme and language must apply before the first paint, so they live in localStorage. */
/*
 * Theme and language load from localStorage rather than the database, because both have to
 * be applied before the first paint and IndexedDB is a round trip too late.
 *
 * The fallbacks come from the defaults declared on `app.prefs` and are not written out a
 * second time here. They used to be, and the two copies disagreed: the default said dark
 * while this said 'auto', so changing the default changed nothing at all and the app
 * silently kept following the system.
 */
function loadLocalPrefs() {
  try {
    app.prefs.theme = localStorage.getItem('theme') || app.prefs.theme;
    app.prefs.lang = localStorage.getItem('lang') || app.prefs.lang;
  } catch {
    /* private mode */
  }
}

async function savePrefs() {
  const { theme, lang, publicCode, ...rest } = app.prefs;
  /*
   * The room code is sealed; the rest of the preferences are not.
   *
   * Everything else here is a setting - which theme, whether to chime, where to save. The code
   * is a live secret: five characters that let whoever has them into the room you are in. It
   * was sitting in the clear beside the others, so a copied profile gave it up in one read.
   */
  if (publicCode) rest.publicCodeSealed = await seal(te.encode(publicCode));
  await kv.set('prefs', rest);
}

function guessKind() {
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'phone';
  return 'laptop';
}

/**
 * A link can propose a relay; only the person using the browser can accept one.
 *
 * The query parameter used to be applied and written to storage on sight, which made
 * `…/?relay=wss://attacker/rv` a permanent, silent redirection of every rendezvous that
 * browser performed afterwards. The parameter is stripped either way, so the question is
 * asked once rather than on every reload.
 */
function askAboutProposedRelay() {
  const proposed = proposedRelay();
  const strip = () => history.replaceState(null, '', location.pathname);
  if (!proposed) {
    if (location.search.includes('relay=')) strip();
    return;
  }

  const current = defaultUrl();
  ui.relayCurrent.textContent = hostOf(current) + (current === originRelay() ? ' (this site)' : '');
  ui.relayProposed.textContent = hostOf(proposed);
  strip();

  ui.relayAccept.onclick = () => {
    rememberRelay(proposed);
    ui.relayDialog.close();
    toast(t('toast.relaySwitched', { host: hostOf(proposed) }));
    setTimeout(() => location.reload(), 900);
  };
  ui.relayKeep.onclick = () => {
    ui.relayDialog.close();
    toast(t('toast.relayKept'), 'good');
  };
  ui.relayDialog.showModal();
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

/** Hide what this browser cannot do, rather than offering it and failing quietly. */
function applyPlatform() {
  const p = platform();
  /*
   * Folders and drag used to be gated from here, by putting `no-folders` and `no-drag` on the
   * body for the stylesheet to act on. Nothing ever carried the classes that stylesheet was
   * hiding, and both capabilities are handled properly elsewhere: the folder entry is not built
   * when the platform cannot deliver one, and the drop hint is a `.desktop-only` span. A second
   * answer that does nothing, sitting beside a working one, is worse than no answer - it is the
   * one a reader finds first.
   */
  /*
   * No WebRTC is a mode, not a failure.
   *
   * This used to be a red notice, held for a minute, saying files could not be sent device to
   * device - which on Tor Browser told the person who had gone to the most trouble to be
   * private that they were the one person who could not use this. They can: every transfer
   * takes the relay path, sealed end to end exactly as it is everywhere else, and nothing about
   * where they are is ever gathered because no candidate is ever collected.
   */
  if (!p.webrtc) toast(t('toast.relayOnly'), '', { hold: 12_000 });
}

/* ────────────────────────────── connections ───────────────────────────── */

/**
 * A conn is one live conversation: the sealed session, the transport, and the transfer
 * engine riding on top. Tiles are a projection of this map.
 */
function attachSession(session, { peer = null, viaCode = false, member = null, channel = null } = {}) {
  const connId = peer ? peer.id : member ? `chan:${member.idKey}` : `code:${session.tagKey}`;
  const chan = channel || (peer ? 'paired' : 'code');

  /*
   * The peer said it is on the relay, before there was anywhere to note it.
   *
   * That message is sent the moment the key is agreed, and the handler that creates the
   * connection awaits a transport first, so it regularly arrived at an empty map and was
   * dropped. The fallback timer then offered the relay six seconds later for the wrong
   * reason: the network was not blocking anything, the other device had chosen not to
   * connect directly.
   */
  let relayAsked = false;

  session.addEventListener('error', (e) => {
    if (viaCode) shakeCode();
    // Only somebody who just typed a code is waiting to hear whether it worked. Every other
    // keying failure is either routine, such as the other side leaving mid-handshake, or
    // noise anyone on the rendezvous can produce at will. A banner a stranger can raise on
    // your screen is a nuisance in itself.
    if (viaCode) toast(humanError(e.detail?.message, 'err.keying'), 'bad');
    else console.info('Gear Drop: session not keyed —', e.detail?.message || 'unknown');
  });

  session.addEventListener('secure', async () => {
    const existing = app.conns.get(connId);
    /*
     * Which path, and what it costs to take it.
     *
     * A direct connection on your own network is free: the browser pairs on host candidates,
     * which modern browsers publish as one-time `.local` names rather than addresses, and no
     * STUN server is contacted because none is offered. Nothing about where you are leaves
     * the machine, and it is the full-speed path.
     *
     * A direct connection to somewhere else is not free. It needs a public candidate, which
     * means asking a STUN server for your address and then handing that address to the peer.
     * So it happens only when it has been asked for, and otherwise the relay carries the same
     * sealed frames instead: slower, and the other end learns nothing about where you are.
     */
    const sameNetwork = localReach(connId, chan);
    const allowAddress = app.prefs.direct === true;
    /*
     * And there has to be a WebRTC to be direct with.
     *
     * Tor Browser removes `RTCPeerConnection` outright, which is the correct thing for it to do
     * - a peer connection is a hole punched straight through the circuit you went to the
     * trouble of building. Without this check `sameNetwork` could still come out true, since two
     * people behind one exit share a network label, and the line below would construct a class
     * the browser does not have.
     *
     * The relay path needs none of it: the handshake runs over the rendezvous socket and so does
     * the file. So a browser with no WebRTC is not a browser that cannot send - it is a browser
     * that is always on the path this app already treats as the private one.
     */
    const canDirect = platform().webrtc;
    const wantDirect = (sameNetwork || allowAddress) && canDirect;

    // No ICE servers unless an address was asked for. A candidate that is never gathered
    // cannot be sent, so this is the difference rather than a filter applied afterwards.
    // And not even then for a peer on this network: a public candidate buys no speed over a
    // host one and spends the address anyway, so the strict reading is also the free one.
    const iceConfig =
      allowAddress && !sameNetwork ? app.signal.iceConfig || { iceServers: [] } : { iceServers: [] };
    const transport = wantDirect ? new Transport(session, { iceConfig }) : new RelayTransport(session);

    // A path is something two devices do together. Choosing the relay on one side only
    // leaves the other one negotiating WebRTC against nobody until its fallback timer runs
    // out, so the peer is told straight away rather than left to work it out.
    if (!wantDirect) session.send({ t: 'relay-request' })?.catch?.(() => {});

    // The same session re-keying means this peer came back. Keep the transfer engine, with
    // its jobs, sinks and received ranges, and swap only the pipe underneath it. That is what
    // makes a dropped transfer continue instead of starting over.
    const resuming = !!(existing && existing.session === session && existing.transfers);

    if (resuming) {
      try {
        existing.transport.close();
      } catch {
        /* already gone */
      }
      await existing.transfers.attachTransport(transport);
      existing.transport = transport;
      existing.usingRelay = !wantDirect;
      existing.state = 'connecting';
      wireTransport(existing);
      render();
      askedForRelay(existing);
      armFallback(existing);
      try {
        await transport.start();
      } catch {
        toast(t('toast.reopenFailed'), 'bad');
        dropConn(connId);
      }
      return;
    }

    // A paired device is reachable through more than one rendezvous tag (the current
    // epoch and, briefly, the previous one), so two sessions can key with the same peer.
    // The one that got there first owns the conversation; a latecomer stands down rather
    // than replacing a connection that may be carrying a transfer.
    if (existing && existing.session !== session) {
      if (existing.state === 'ready' || hasUnfinishedWork(existing)) {
        transport.close();
        return;
      }
      dropConn(connId, { silent: true });
    }

    const transfers = new TransferManager({ transport, session });
    const conn = {
      id: connId,
      session,
      transport,
      transfers,
      peer,
      member,
      viaCode,
      channels: new Set([chan]),
      // Already on the relay by choice: nothing should later offer to move it there.
      usingRelay: !wantDirect,
      verified: !!peer,
      name: peer?.name || member?.name || 'New device',
      kind: peer?.kind || member?.kind || 'laptop',
      state: 'connecting',
      progress: null,
    };
    app.conns.set(connId, conn);
    wireTransport(conn);
    wireTransfers(conn);
    render();
    askedForRelay(conn);
    armFallback(conn);

    try {
      await transport.start();
    } catch {
      if (!member) toast(t('toast.openFailed'), 'bad');
      dropConn(connId);
    }
  });

  session.addEventListener('message', (e) => {
    const conn = app.conns.get(connId);
    if (e.detail?.t === 'relay-request') {
      if (!conn) {
        relayAsked = true;
        return;
      }
      if (conn.state !== 'ready' && !conn.usingRelay) offerRelay(conn, 'why.peer');
      return;
    }
    if (!conn) return;
    // The peer confirmed the words on its side and wants this device to hold the pairing too.
    // Nothing is remembered here until the words are read on this screen as well.
    if (e.detail?.t === 'pair-ask' && !conn.verified) promptVerify(conn, { force: true, asked: true });
  });

  /** A relay request that landed before this connection existed, acted on now. */
  function askedForRelay(conn) {
    if (!relayAsked) return;
    relayAsked = false;
    if (!conn.usingRelay) offerRelay(conn, 'why.peer');
  }

  session.addEventListener('sas', (e) => {
    const conn = app.conns.get(connId);
    if (!conn) return;
    conn.sas = e.detail.join(' · ');
    // A remembered device is verified by construction: the pairing root is folded into
    // the key, so only that device could have produced it. Do not nag about it again.
    // A device met through a channel is not nagged either, since there may be a roomful of
    // them, but it stays marked unverified and its words are one click away.
    if (!conn.verified && !member && conn.transport.ctl?.readyState === 'open') promptVerify(conn);
    render();
  });

  // A peer that vanishes mid-transfer is not gone for good: hold the engine, its sinks
  // and its progress, and wait for the session to re-key. Dropping it here is what makes
  // every other implementation restart a 4 GB file from zero.
  session.addEventListener('peer-gone', () => {
    const conn = app.conns.get(connId);
    if (!conn) return;
    if (hasUnfinishedWork(conn)) {
      try {
        conn.transport.close();
      } catch {
        /* already closing */
      }
      conn.state = 'connecting';
      conn.progress = null;
      render();
      toast(t('toast.dropped', { name: conn.name }), 'bad');
      return;
    }
    dropConn(connId);
  });
  session.start();
  return connId;
}

/**
 * The path ladder.
 *
 * Direct, always. If ICE cannot get through, whether from a corporate proxy, a VPN or WebRTC
 * being switched off, a fallback carries the same sealed frames over the rendezvous socket.
 * The relay sees AEAD ciphertext and keeps none of it, but it is still someone else's machine
 * handling your bytes, so it is never taken silently: the app asks, and asks again next time.
 */
/**
 * How often the pairing subscriptions are swept.
 *
 * This exists for the epoch rolling over, which happens every ten minutes, so a sweep is
 * cheap and the interval only needs to be well inside that. It must not be what a reconnect
 * waits for: the events above cover every moment something has actually changed, and this
 * catches the rest.
 */
const RESUBSCRIBE_MS = 15_000;

/**
 * How long a re-announce is given to be answered before another is sent.
 *
 * A round trip over the relay plus a handshake is a couple of hundred milliseconds, so this
 * is generous. It only matters when the ordinary path did not fire, such as a join notice
 * reaching a device that was briefly not listening.
 */
const RETRY_QUIET_MS = 4000;

/**
 * A reconnect that has not landed is tried again, twice, quickly.
 *
 * The join notice does the work almost every time and the connection is up in under a tenth
 * of a second. When it misses, the periodic sweep is the only thing left, and that is fifteen
 * seconds away, which reads as broken even though it works eventually. These two follow-ups
 * close the gap without becoming a poll.
 */
const RETRY_AFTER_MS = [700, 1800, 3600];

/** How long after a link opens before anything held back is sent down it. */
const FLUSH_SETTLE_MS = 400;

const FALLBACK_AFTER_MS = 9000;
/** How long before an unanswered relay prompt is put back on screen. */
const RELAY_REASK_MS = 20_000;

function armFallback(conn) {
  clearTimeout(conn.fallbackTimer);
  conn.fallbackTimer = setTimeout(() => {
    if (conn.state === 'ready' || conn.usingRelay || conn.closed) return;
    offerRelay(conn, 'why.network');
  }, conn.relayAsked ? RELAY_REASK_MS : FALLBACK_AFTER_MS);
}

/**
 * Ask about moving a stalled connection onto the relay.
 *
 * Asked more than once, because a toast disappears: anyone not looking at that moment never
 * saw the question, and both devices then sat unable to connect with nothing to act on. That
 * is common now that a device can decline direct connections, since the peer is then always
 * the one who has to answer.
 */
function offerRelay(conn, why) {
  if (conn.usingRelay || conn.closed) return;

  if (app.prefs.allowRelay) {
    conn.relayAsked = true;
    conn.session.send({ t: 'relay-request' })?.catch?.(() => {});
    useRelay(conn, why);
    return;
  }

  // Don't stack prompts: one at a time, re-offered on the fallback cadence.
  if (conn.relayAsked && Date.now() - conn.relayAsked < RELAY_REASK_MS) return;
  conn.relayAsked = Date.now();

  toast(t('toast.relayOffer', { name: conn.name, why: t(why) }), 'bad', {
    label: t('action.useRelay'),
    action: () => {
      conn.session.send({ t: 'relay-request' })?.catch?.(() => {});
      useRelay(conn, why);
    },
    hold: 14_000,
  });

  // And put the question back on screen if it is still unanswered.
  armFallback(conn);
}

async function useRelay(conn, why) {
  if (conn.usingRelay || conn.closed) return;
  conn.usingRelay = true;
  conn.rtc = conn.transport; // kept, in case it comes good later

  const relay = new RelayTransport(conn.session);
  conn.transport = relay;
  await conn.transfers.attachTransport(relay);
  wireTransport(conn, relay);
  await relay.start();

  toast(t('toast.relaying', { name: conn.name, why: t(why) }), 'bad');
  render();

  // If the direct path completes later, take it: it is faster, and the relay stops seeing
  // even ciphertext.
  conn.rtc?.addEventListener('open', async () => {
    if (conn.closed || !conn.usingRelay) return;
    conn.usingRelay = false;
    conn.transport = conn.rtc;
    await conn.transfers.attachTransport(conn.rtc);
    relay.close();
    toast(t('toast.direct', { name: conn.name }), 'good');
    render();
  });
}

function wireTransport(conn, only) {
  const transport = only || conn.transport;
  const { transfers } = conn;

  transport.addEventListener('open', () => {
    if (conn.transport !== transport) return; // a superseded path
    clearTimeout(conn.fallbackTimer);
    conn.state = 'ready';
    conn.relayAsked = false;
    transfers._sendCtl({ t: 'rename', name: app.name }).catch(() => {});
    // Anything this device was still owed is sent the moment it is reachable again.
    flushWipePending(conn);
    flushOutbox(conn).catch(() => {});
    app.radar.burst();
    render();
    if (conn.sas && !conn.verified && !conn.member) promptVerify(conn);
    if (conn.viaCode) {
      closeHost();
      ui.connect.close();
    }

    /*
     * Say who, every time, not only after typing a code.
     *
     * Which device this is matters more than the fact that something connected: it answers
     * "can I send this now", and on a screen with several devices it is the part worth
     * reading. The name leads and the state follows it.
     */
    notify(conn.name, t('toast.connectedBody'));
    toast(t('toast.connectedBody'), 'good', { title: conn.name, icon: iconForConn(conn) });

    // Anything that was in flight when the link dropped continues from where it stopped.
    transfers
      .resumeAll()
      .then((n) => {
        if (n) toast(n === 1 ? t('toast.resume.one') : t('toast.resume.many', { n }), 'good');
      })
      .catch(() => {});
  });

  transport.addEventListener('path', (e) => {
    conn.path = e.detail.pathType;
    conn.rtt = e.detail.rtt;
    // During a transfer `render` is skipped in favour of the progress painter, and the security
    // line would then sit stale for the rest of it - and that is when the path is most
    // likely to have moved.
    if (ui.chatDialog.open) paintChatState();
    if (!conn.progress) render();
  });

  transport.addEventListener('lane-open', () => {
    conn.lanes = transport.readyLanes;
    // Back before the countdown ran out: nothing was lost and nothing needs tearing down.
    if (transport.readyLanes > 0 && conn.deadTimer) {
      clearTimeout(conn.deadTimer);
      conn.deadTimer = 0;
      if (conn.state === 'offline') {
        conn.state = 'ready';
        render();
      }
    }
  });

  /*
   * The far end went away, and until now nobody was listening.
   *
   * `degraded` was dispatched and had no handler, so a device whose peer closed the tab, went
   * out of range or disconnected kept showing a healthy connection over a transport with
   * nothing behind it. It offered Send on a link that could not carry anything, and refused a
   * fresh handshake because it believed it already had one.
   *
   * A single lane dropping is not the end: the others may still be carrying traffic, and a
   * relayed path can take over underneath. Only when nothing is left is the connection over.
   */
  transport.addEventListener('degraded', () => {
    if (conn.transport !== transport || conn.closed) return;
    if (transport.readyLanes > 0) return;
    /*
     * Only a connection that was up can go down.
     *
     * A lane failing while the others are still gathering is an ordinary part of getting
     * connected: several are tried and not all of them work. Treating that as a drop would
     * tear down the handshake that was about to succeed. The fallback timer owns the
     * never-connected case.
     */
    if (conn.state !== 'ready') return;

    conn.state = 'offline';
    conn.lanes = 0;
    render();
    if (ui.chatDialog.open && chatPeerId === conn.id) paintChatState();

    /*
     * Give it a moment to come back before tearing anything down. ICE reports `disconnected`
     * for ordinary network hiccups it then recovers from, and dropping a live conversation
     * over a lost second would be its own bug.
     */
    clearTimeout(conn.deadTimer);
    conn.deadTimer = setTimeout(() => {
      if (conn.closed || conn.transport !== transport) return;
      if (transport.readyLanes > 0) return;
      /*
       * And only if this is still the connection it was armed for.
       *
       * Four seconds is long enough for the peer to have come back on a new one, and the id
       * is the same either way, so firing blind would reach into the map and drop the
       * connection that had just been established. That is the reconnect that works and then
       * immediately stops working.
       */
      if (app.conns.get(conn.id) !== conn) return;
      dropConn(conn.id);
      // Listening again is what lets the peer's next attempt land without a sweep to wait for.
      resubscribePaired().catch(() => {});
    }, DEAD_AFTER_MS);
  });
}

function wireTransfers(conn) {
  const { transfers } = conn;

  /*
   * The peer said it is going. Believe it, and be ready for it to come back.
   *
   * No grace period here, unlike a transport that merely stopped answering: this is not a
   * connection that might recover in a second, it is one the other side has finished with.
   * Re-subscribing immediately is what lets its next attempt land on a device already
   * listening, instead of one that finds out on its next sweep.
   */
  transfers.addEventListener('bye', () => {
    if (conn.closed) return;
    dropConn(conn.id);
    resubscribePaired({ force: true }).catch(() => {});
  });

  transfers.addEventListener('peer-name', async (e) => {
    const name = String(e.detail || '').slice(0, 64);
    if (!name) return;
    conn.name = name;
    if (conn.peer) {
      conn.peer.name = name;
      await savePeer(conn.peer);
      app.paired = await allPeers();
    }
    render();
  });

  transfers.addEventListener('offered', () => {
    conn.anim = { p: 0, rate: 0, targetP: 0, targetRate: 0 };
  });
  transfers.addEventListener('receiving', () => {
    conn.anim = { p: 0, rate: 0, targetP: 0, targetRate: 0 };
  });

  transfers.addEventListener('incoming', (e) => showIncoming(conn, e.detail));

  // An offer that stops being pending for any other reason must not leave its dialog up.
  for (const evt of ['receiving', 'aborted', 'complete']) {
    transfers.addEventListener(evt, (e) => {
      // A transfer that ended any way at all is no longer one we are holding a note about.
      if (evt !== 'receiving' && e.detail?.transferId) chatTransfers.delete(e.detail.transferId);
      if (!pendingIncoming || e.detail?.transferId !== pendingIncoming.manifest.transferId) return;
      pendingIncoming = null;
      if (ui.incoming.open) ui.incoming.close('handled');
    });
  }

  transfers.addEventListener('progress', (e) => {
    conn.progress = e.detail;
    app.radar.setFlow(Math.min(1, (e.detail.rate || 0) / 20e6));
    paintProgress(conn);
  });

  transfers.addEventListener('file-complete', async (e) => {
    const { transferId, file, entry } = e.detail;

    /*
     * A picture that belongs to the conversation goes there, and not to the downloads folder.
     *
     * If keeping it fails for any reason the ordinary path below still runs, so the bytes that
     * were successfully received are never simply dropped.
     */
    const note = chatTransfers.get(transferId);
    if (note?.id === conn.id) {
      chatTransfers.delete(transferId);
      if (await keepChatMedia(conn, file, entry, note)) return;
    }

    // On iOS a synthetic download click opens the file rather than saving it, and the share
    // sheet needs a real gesture, so there the toast carries the Save instead.
    if (offerDownload(file) === 'needs-gesture') {
      toast(t('toast.readyBody'), 'good', { title: entry.name, icon: '#i-install',
        label: t('common.save'),
        hold: 60_000,
        action: () => saveFile(file).catch(() => toast(t('toast.saveFailed'), 'bad')),
      });
    } else {
      toast(t('toast.saved', { name: entry.name }), 'good');
    }
    // The name stays out of it: see the note on `notify`.
    notify(conn.name, t('notify.file'));
  });

  transfers.addEventListener('complete', () => {
    finishTransfer(conn, '');
    runQueuedAccepts();
  });
  transfers.addEventListener('sent', () => finishTransfer(conn, 'xfer.sent'));
  transfers.addEventListener('declined', () => finishTransfer(conn, 'xfer.declined', 'bad'));
  transfers.addEventListener('aborted', () => {
    finishTransfer(conn, 'toast.cancelled', 'bad');
    runQueuedAccepts();
  });
  transfers.addEventListener('error', (e) => {
    finishTransfer(conn, 'xfer.failed', 'bad');
    toast(humanError(e.detail?.message, 'err.transfer'), 'bad');
    runQueuedAccepts();
  });

  /*
   * The other device has destroyed this conversation and is telling us to do the same.
   *
   * Acted on without asking. A prompt here would mean keeping the messages while somebody
   * decides, and the frame exists because the other side has already stopped
   * holding them - "are you sure?" is a question about someone else's copy.
   */
  transfers.addEventListener('wipe', async () => {
    await destroyConversation(conn.id);
    // Answered whether or not there was anything here; see `sendWipeAck`.
    conn.transfers.sendWipeAck().catch(() => {});
    toast(t('chat.wipedByPeer', { name: conn.name }), 'bad');
  });

  // The other device has confirmed. Only now is the erase finished and the debt cleared.
  transfers.addEventListener('wipe-ack', async () => {
    const owedSince = app.paired.find((p) => p.id === conn.id)?.wipePending;
    await clearWipePending(conn.id);
    /*
     * Said out loud only when it is news.
     *
     * Deleting a conversation with the device right there gets an acknowledgement back in
     * milliseconds, and announcing that would be a second toast about something already
     * reported. What is worth telling someone is the other case: an erase that has been
     * waiting - possibly for days - and has just now actually happened.
     */
    if (owedSince && Date.now() - owedSince > 10_000) {
      toast(t('chat.wipeLanded', { name: conn.name }), 'good');
    }
  });

  transfers.addEventListener('text', (e) => {
    onChatText(conn, e.detail);
    app.radar.burst();
    blip();
    notify(conn.name, t('notify.message'));
  });
}

function finishTransfer(conn, key, tone = 'good') {
  conn.progress = null;
  if (conn.anim) conn.anim.targetP = 1;
  app.radar.setFlow(0);
  app.radar.burst();
  const tile = tileFor(conn.id);
  if (tile) {
    tile.el.classList.remove('busy', 'sending', 'receiving');
    tile.el.classList.add('done');
    setTimeout(() => tile.el.classList.remove('done'), 700);
  }
  render();
  updateAmbient();
  if (key) toast(t(key), tone); // a receive already toasts per file
}

/**
 * Is this peer on the same network as us?
 *
 * Either we met it there, or it is a remembered device that also turned up on the local
 * channel - which is what `alsoOn` records when a pairing hint is recognised. Both mean the
 * two of us can reach each other over host candidates alone, with nothing public gathered.
 */
function localReach(connId, chan) {
  return chan === 'local' || !!app.alsoOn.get(connId)?.has('local');
}

/** True when this conversation still owes bytes in either direction. */
function hasUnfinishedWork(conn) {
  const t2 = conn.transfers;
  if (!t2) return false;
  for (const job of t2.in.values()) if (job.state === 'receiving') return true;
  for (const job of t2.out.values()) if (job.state === 'sending') return true;
  return false;
}

/**
 * How long a connection may be down before it is given up on.
 *
 * ICE says `disconnected` for ordinary hiccups it recovers from within a second or two, so
 * this is long enough to ride those out and short enough that a device which really has gone
 * stops being offered as though it were there.
 */
const DEAD_AFTER_MS = 4000;

function dropConn(connId, { silent = false } = {}) {
  const conn = app.conns.get(connId);
  if (!conn) return;
  try {
    conn.transport.close();
  } catch {
    /* already closing */
  }
  conn.closed = true;
  clearTimeout(conn.fallbackTimer);
  clearTimeout(conn.deadTimer);
  app.conns.delete(connId);

  /*
   * And anything still noted against this device.
   *
   * A peer that offers a picture and then leaves before the offer is answered produces no
   * ending at all - no completion, no abort, no decline - so the note about it would have
   * outlived the connection it belonged to. Dropping the connection is the last moment that
   * is guaranteed to happen, so it is the one place that can promise the note goes.
   */
  for (const [transferId, note] of chatTransfers) {
    if (note?.id === connId) chatTransfers.delete(transferId);
  }
  if (conn.viaCode && !app.hostSessions.includes(conn.session)) conn.session.destroy();
  if (!silent) render();
}

/* ──────────────────────────────── hosting ─────────────────────────────── */

async function startHost() {
  closeHost();
  const code = newCode();
  app.hostCode = code;
  app.hostDeadline = Date.now() + 120_000;

  // Show the code immediately; the tags are deliberately slow to derive and the person
  // reading it out should not wait for three key derivations to finish.
  [...ui.hostCode.children].forEach((span, i) => {
    span.textContent = code[i] ?? '·';
  });
  drawQR(ui.hostQr, pairUrl(code));
  ui.codeDisplay.hidden = false;
  ui.hostBtn.textContent = t('connect.newCode');

  // Listening on the neighbouring epochs too, so a joiner whose clock is off by up to ten
  // minutes still lands on a tag this device is holding. The joiner derives one.
  for (const epoch of hostEpochs()) {
    const tag = await tagForCode(code, epoch);
    if (app.hostCode !== code) return; // a newer code was generated while we were deriving
    const session = new SecureSession(app.signal, { tag, code, deviceKey: app.device });
    app.hostSessions.push(session);
    attachSession(session, { viaCode: true });
  }
}

function closeHost() {
  for (const session of app.hostSessions) {
    // The one that actually keyed is now carrying a conversation; the others are idle.
    const stillUsed = [...app.conns.values()].some((c) => c.session === session);
    if (!stillUsed) session.destroy();
  }
  app.hostSessions = [];
  app.hostCode = null;
  app.hostDeadline = 0;
}

function tickHostTimer() {
  if (!app.hostDeadline) return;
  const left = app.hostDeadline - Date.now();
  if (left <= 0) {
    closeHost();
    ui.codeDisplay.hidden = true;
    ui.hostBtn.textContent = t('connect.generate');
    if (ui.connect.open) toast(t('toast.codeExpired'));
    return;
  }
  const s = Math.ceil(left / 1000);
  ui.codeTimer.textContent = `valid ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function pairUrl(code) {
  return `${location.origin}${location.pathname}#${code}`;
}
function roomUrl(code) {
  return `${location.origin}${location.pathname}#r-${code}`;
}

/* ──────────────────────────────── joining ────────────────────────────── */

async function joinWithCode(raw) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LEN) return;
  setText(ui.joinStatus, t('connect.connecting'));
  const tag = await tagForCode(code);
  const session = new SecureSession(app.signal, { tag, code, deviceKey: app.device });
  attachSession(session, { viaCode: true });
}

/**
 * A pairing code that arrived in a link, shown before it is used.
 *
 * Typing six characters is a decision. Opening a link is not, and the handshake this starts is
 * one somebody else chose the password for - so the safety words, which catch a third party
 * standing between two devices that meant to meet, cannot catch it. Both ends really do hold the
 * same code. The only thing that catches it is a person being asked.
 *
 * The room invitation and the relay proposal already work this way; this was the one link that
 * did not.
 */
let pendingCodeInvite = null;

function askJoinCode(code) {
  pendingCodeInvite = code;
  const cells = [...ui.connectInviteCode.children];
  code.split('').forEach((ch, i) => {
    if (cells[i]) cells[i].textContent = ch;
  });
  ui.connectInvite.hidden = false;
  ui.connectNormal.hidden = true;
  ui.connect.showModal();
}

function closeCodeInvite() {
  pendingCodeInvite = null;
  ui.connectInvite.hidden = true;
  ui.connectNormal.hidden = false;
}

function handleUrlFragment() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return;
  history.replaceState(null, '', location.pathname); // never leave a code in the URL bar

  // App shortcuts land here too.
  if (/^add$/i.test(hash)) {
    ui.connect.showModal();
    if (!app.hostCode) startHost();
    return;
  }
  if (/^room$/i.test(hash)) {
    paintRoom();
    ui.room.showModal();
    return;
  }

  if (/^r-/i.test(hash)) {
    const code = normalizeCode(hash.slice(2));
    if (code.length === ROOM_CODE_LEN) askJoinRoom(code);
    return;
  }
  const code = normalizeCode(hash);
  if (code.length === CODE_LEN) askJoinCode(code);
}
window.addEventListener('hashchange', handleUrlFragment);

function shakeCode() {
  ui.codeInputs.classList.add('shake');
  setTimeout(() => ui.codeInputs.classList.remove('shake'), 420);
}

/**
 * A room code from a link, waiting for an answer.
 *
 * Declared here rather than beside the handler that sets it: `paintRoom` reads it and runs
 * earlier in the file, and a `let` that has not been reached yet throws rather than reading
 * as undefined. That has already cost this app one silent boot failure.
 */
let pendingRoomInvite = null;

/* ─────────────────────────── paired devices ──────────────────────────── */

async function refreshPaired() {
  app.paired = await allPeers();
  await resubscribePaired();
  render();
}

/**
 * Paired devices meet at a tag derived from their shared root and the clock. We listen
 * on the current epoch, and on the previous one only during the first minute of a new
 * epoch, which covers clock skew without doubling every connection.
 */
let resubscribing = null;

/**
 * Serialised, because it is now called from several places at once.
 *
 * Deriving a pairing tag is asynchronous, so two overlapping runs can both look at the same
 * key, both find it missing, and both build a session for it. The second replaces the first
 * in the map, leaving it subscribed, listening, and unreachable by anything that could shut
 * it down. A second caller waits for the run in flight instead.
 */
function resubscribePaired({ force = false } = {}) {
  // A deliberate retry is not the periodic sweep and is not paced like one: the cooldown is
  // there to stop the sweep talking over a reply, not to hold back a device that has just
  // been told to reconnect.
  if (force) for (const sub of app.pairSubs.values()) sub.nudgedAt = 0;
  if (!resubscribing) resubscribing = doResubscribe().finally(() => { resubscribing = null; });
  return resubscribing;
}

async function doResubscribe() {
  const epoch = currentEpoch();
  const intoEpoch = Math.floor(Date.now() / 1000) % EPOCH_SECONDS;
  const epochs = intoEpoch < 60 ? [epoch, epoch - 1] : [epoch];

  const wanted = new Map();
  for (const peer of app.paired) {
    if (peer.paused) continue; // disconnected by the user
    const root = new Uint8Array(peer.root);
    for (const e of epochs) {
      const tag = await pairTag(root, e);
      wanted.set(toHex(tag), { peer, tag, root });
    }
  }

  for (const [key, entry] of app.pairSubs) {
    if (wanted.has(key)) continue;
    // Never tear down a subscription whose session is carrying a live conversation.
    const live = [...app.conns.values()].some((c) => c.session === entry.session);
    if (live) continue;
    entry.session.destroy();
    app.pairSubs.delete(key);
  }

  for (const [key, { peer, tag, root }] of wanted) {
    if (app.pairSubs.has(key)) continue;
    const session = new SecureSession(app.signal, { tag, code: '', pairRoot: root, peer, deviceKey: app.device });
    app.pairSubs.set(key, { peer, session });
    attachSession(session, { peer });
  }

  /*
   * Say something again, for every subscription with nothing connected to it.
   *
   * Creating a subscription announces once, so a reconnect was a single frame with one chance
   * to land. It regularly missed: the device coming back announces while the other side is
   * still holding a connection it has not noticed is dead, and a share arriving then is
   * ignored. One side had spoken, the other was not listening, and neither tried again.
   *
   * `reset` rather than a bare re-announce: on a session stranded over a transport that has
   * died it starts a fresh handshake, and on one still trying it publishes the share again.
   * Either way it is a few dozen bytes, and only for devices that are not connected.
   */
  const busy = new Set([...app.conns.values()].map((c) => c.session));
  const now = Date.now();
  for (const sub of app.pairSubs.values()) {
    const { session } = sub;
    // A session with a connection against it is already connected or building a transport.
    // Announcing again into that only restarts what is in progress.
    if (busy.has(session) || session.transportLive) {
      sub.nudgedAt = 0;
      continue;
    }
    // And one that has just spoken is given time to be answered. A round trip over the relay
    // plus a handshake is a couple of seconds; retrying faster than that talks over the reply
    // it is waiting for.
    if (sub.nudgedAt && now - sub.nudgedAt < RETRY_QUIET_MS) continue;
    sub.nudgedAt = now;
    session.reset();
  }
}

/* ────────────────────────── discovery channels ───────────────────────── */

/**
 * Rotating hints we announce on a channel, one per paired device. A device holding the
 * same pairing root recognises us and does not start a second, redundant conversation;
 * to anyone else they are eight unlinkable bytes that change every ten minutes.
 */
async function announceHints() {
  const epoch = currentEpoch();
  const out = [];
  for (const peer of app.paired) {
    try {
      out.push(await pairHint(new Uint8Array(peer.root), epoch));
    } catch {
      /* a malformed record should not break the announcement */
    }
  }
  return out;
}

/** Does this member's announcement identify a device we already have paired? */
async function matchPairedHint(hints) {
  if (!hints?.length) return null;
  const set = new Set(hints);
  const epoch = currentEpoch();
  for (const peer of app.paired) {
    for (const e of [epoch, epoch - 1, epoch + 1]) {
      if (set.has(await pairHint(new Uint8Array(peer.root), e))) return peer;
    }
  }
  return null;
}

function makeChannel(kind, label) {
  const ch = new Channel(app.signal, {
    kind,
    label,
    self: { name: app.name, kind: app.kind },
    hints: announceHints,
  });

  ch.addEventListener('member', async (e) => {
    const member = e.detail;

    // Already paired with this device? Then we already reach it at its own rendezvous,
    // which is both faster and authenticated. Note the extra channel on the tile and
    // leave the conversation where it is.
    const known = await matchPairedHint(member.hints);
    if (known) {
      addAlso(known.id, kind);
      // A member can become recognisable after we first met them, by pairing with us in the
      // meantime. The channel conversation is then a duplicate of the paired one, so retire
      // it rather than show the same device twice.
      dropChannelPeer(member.idKey, { keepBusy: true });
      render();
      return;
    }

    if (app.chanPeers.has(member.idKey)) {
      const entry = app.chanPeers.get(member.idKey);
      const conn = [...app.conns.values()].find((c) => c.session === entry.session);
      if (conn && conn.name !== member.name) {
        conn.name = member.name;
        render();
      }
      return;
    }

    // Meet on a tag only the two of us compute, and run the ordinary two-party handshake
    // there. The channel secret is the PAKE password: it keeps the relay out, and inside a
    // room it keeps out anyone who does not have the code.
    const session = new SecureSession(app.signal, {
      tag: member.pairTag,
      code: ch.password,
      deviceKey: app.device,
    });
    app.chanPeers.set(member.idKey, { member, session, channel: kind });
    attachSession(session, { member, channel: kind });
  });

  ch.addEventListener('member-gone', (e) => {
    dropChannelPeer(e.detail.idKey, { keepBusy: true });
    render();
  });

  return ch;
}

/**
 * Retire the conversation we were having with a channel member. A transfer still in
 * flight is left alone: a member that walked out of the room may well walk back in, and
 * the engine survives the link either way.
 */
function dropChannelPeer(idKey, { keepBusy = true } = {}) {
  const entry = app.chanPeers.get(idKey);
  if (!entry) return;
  for (const conn of [...app.conns.values()]) {
    if (conn.session !== entry.session) continue;
    if (keepBusy && hasUnfinishedWork(conn)) return;
    dropConn(conn.id, { silent: true });
  }
  app.chanPeers.delete(idKey);
  entry.session.destroy();
}

function addAlso(peerId, channel) {
  if (!app.alsoOn.has(peerId)) app.alsoOn.set(peerId, new Set());
  app.alsoOn.get(peerId).add(channel);
}

/* ─────────────────────────── discovery mode ──────────────────────────── */

const DISCOVERY_MODES = ['off', 'local', 'public'];

/**
 * Pick exactly one way of being findable.
 *
 * Switching modes always leaves the previous one first, so the two channels can never both
 * be live and the footer chip and this dialog describe the whole state rather than half of it.
 */
async function setDiscovery(mode, { code = null } = {}) {
  if (!DISCOVERY_MODES.includes(mode)) return;

  if (mode !== 'local' && app.channels.local) await disableLocal({ quiet: true });
  if (mode !== 'public' && app.channels.room) await leaveRoom({ quiet: true });

  app.prefs.discovery = mode;
  if (mode !== 'public') app.prefs.publicCode = null;

  if (mode === 'local') {
    await enableLocal();
  } else if (mode === 'public') {
    const next = normalizeCode(code || app.prefs.publicCode || '') || newRoomCode();
    app.prefs.publicCode = next;
    await joinRoom(next, { quiet: true });
  }

  await savePrefs();
  paintDiscovery();
  render();
}

/** Re-enter whatever mode was chosen last time, once the app is up. */
function restoreDiscovery() {
  const mode = app.prefs.discovery;
  paintDiscovery();
  if (mode === 'public') setDiscovery('public', { code: app.prefs.publicCode }).catch(() => {});
  else if (mode === 'local' && app.signal.networkLabel) enableLocal().catch(() => {});
}

/**
 * The relay's network label has arrived.
 *
 * It comes with the ICE credentials, so it can land before boot has read which discovery mode
 * this device was left in. Answering with a default would either join a channel nobody asked
 * for or skip one they did, so it is held until boot says the preferences are in, then run
 * once.
 */
let booted = false;
let networkArrived = false;

function onNetworkLabel() {
  if (!booted) {
    networkArrived = true;
    return;
  }
  paintDiscovery();
  if (app.prefs.discovery === 'local' && !app.channels.local) enableLocal().catch(() => {});
}

async function enableLocal() {
  if (app.channels.local) return;
  const label = app.signal.networkLabel;
  if (!label) {
    toast(t('net.unavailable'), 'bad');
    return;
  }
  app.channels.local = makeChannel('local', `net:${label}`);
  await app.channels.local.join();
  paintDiscovery();
  render();
}

async function disableLocal({ quiet = false } = {}) {
  const ch = app.channels.local;
  app.channels.local = null;
  if (ch) await leaveChannel(ch, 'local');
  if (!quiet) {
    paintDiscovery();
    render();
  }
}

async function leaveChannel(ch, kind) {
  await ch.leave();
  for (const [key, entry] of [...app.chanPeers]) {
    if (entry.channel !== kind) continue;
    dropChannelPeer(key, { keepBusy: false });
  }
  for (const set of app.alsoOn.values()) set.delete(kind);
}

async function openRoom() {
  await setDiscovery('public');
}

/**
 * Join a code. Called from the room dialog and as the transport for 'public' mode.
 * `quiet` is what setDiscovery uses to avoid announcing a mode it is already reporting.
 */
async function joinRoom(raw, { quiet = false } = {}) {
  const code = normalizeCode(raw);
  if (code.length !== ROOM_CODE_LEN) return;
  if (app.roomCode === code) return;
  if (app.channels.room) await leaveRoom({ quiet: true });

  // Entering someone else's code is choosing to be public; say so everywhere at once.
  if (!quiet && app.prefs.discovery !== 'public') {
    await setDiscovery('public', { code });
    return;
  }

  app.roomCode = code;
  app.prefs.publicCode = code;
  app.channels.room = makeChannel('room', `room:${code}`);
  app.channels.room.addEventListener('member', paintRoom);
  app.channels.room.addEventListener('member-gone', paintRoom);
  await app.channels.room.join();

  paintRoom();
  paintDiscovery();
  render();
  if (!quiet && !ui.room.open) toast(t('toast.findable', { code }), 'good');
}

async function leaveRoom({ quiet = false } = {}) {
  const ch = app.channels.room;
  app.channels.room = null;
  app.roomCode = null;
  if (ch) await leaveChannel(ch, 'room');
  if (!quiet) {
    // Leaving the code by hand is the same thing as choosing not to be public.
    if (app.prefs.discovery === 'public') {
      app.prefs.discovery = 'off';
      app.prefs.publicCode = null;
      await savePrefs();
    }
    paintRoom();
    paintDiscovery();
    render();
    toast(t('toast.codeOff'));
  }
}

function paintRoom() {
  const active = !!app.roomCode;
  // While a link is waiting for an answer, the sheet is showing that question and nothing
  // else; repainting the ordinary panes underneath it would answer it by accident.
  if (pendingRoomInvite) return;
  ui.roomInactive.hidden = active;
  ui.roomActive.hidden = !active;
  if (!active) return;

  [...ui.roomCodeRow.children].forEach((span, i) => {
    span.textContent = app.roomCode[i] ?? '·';
  });
  if (ui.roomQr.dataset.code !== app.roomCode) {
    ui.roomQr.dataset.code = app.roomCode;
    drawQR(ui.roomQr, roomUrl(app.roomCode));
  }
  ui.roomCount.textContent = String(1 + (app.channels.room?.members.size || 0));
  if (ui.network.open) paintDiscovery();
}

/** The dialog, the footer chip and the stored preference all read from one place. */
function paintDiscovery() {
  const mode = app.prefs.discovery;

  for (const btn of ui.discChoices.querySelectorAll('.choice')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  }
  for (const [key, el] of Object.entries(ui.discNotes)) el.hidden = key !== mode;

  const on = !!app.channels.local;
  setText(
    ui.netStatus,
    t(app.signal.networkLabel ? (on ? 'net.statusOn' : 'net.statusOff') : 'net.unavailable'),
  );

  if (mode === 'public' && app.roomCode) {
    [...ui.publicCode.children].forEach((span, i) => {
      span.textContent = app.roomCode[i] ?? '·';
    });
    if (ui.publicQr.dataset.code !== app.roomCode) {
      ui.publicQr.dataset.code = app.roomCode;
      drawQR(ui.publicQr, roomUrl(app.roomCode));
    }
    const others = app.channels.room?.members.size || 0;
    ui.publicCount.textContent = others ? t('disc.others', { n: others }) : t('disc.alone');
  }

  ui.chipDiscovery.className =
    'ch-chip pointer ' + (mode === 'local' ? 'ch-local' : mode === 'public' ? 'ch-room' : 'ch-local off');
  /*
   * Into the label, not onto the button.
   *
   * The button holds the words and a chevron; writing to its `textContent` would replace both
   * with a string and take the chevron with it on the first state change.
   */
  ui.discLabel.textContent =
    mode === 'local'
      ? t('disc.pill.local')
      : mode === 'public'
        ? `${t('disc.pill.public')}${app.roomCode ? ` · ${app.roomCode}` : ''}`
        : t('disc.pill.off');
}

/* ─────────────────────────────── rendering ───────────────────────────── */

const tiles = new Map(); // connId -> { el, refs }

/** The freshest view of a device: the live conversation if there is one, else the record. */
function currentEntry(id) {
  const conn = app.conns.get(id);
  if (conn) return conn;
  const rec = app.paired.find((p) => p.id === id);
  return rec ? { ...rec, state: rec.paused ? 'paused' : 'offline', channels: new Set(['paired']) } : null;
}

function tileFor(id) {
  return tiles.get(id);
}

const CHANNEL_ORDER = ['local', 'paired', 'room', 'code'];

function channelsOf(entry) {
  const set = new Set(entry.channels || []);
  for (const c of app.alsoOn.get(entry.id) || []) set.add(c);
  if (entry.verified) set.add('paired');
  if (set.size > 1) set.delete('code'); // "pairing by code" stops being interesting once it is one
  return CHANNEL_ORDER.filter((c) => set.has(c));
}

/**
 * When a device is reachable more than one way, one of them has to be the colour. Paired
 * wins because it is the only channel that is authenticated; then the network, then a
 * room, and the plain accent while a code pairing is still in progress.
 */
function primaryChannel(channels) {
  for (const c of ['paired', 'local', 'room']) if (channels.includes(c)) return c;
  return 'code';
}

function toneFor(channels) {
  const c = primaryChannel(channels);
  return c === 'code' ? 'var(--accent-rgb)' : `var(--ch-${c}-rgb)`;
}

/**
 * A dialog about a device wears that device's colour, so the answer to "who is this
 * from?" is on screen before the text is read. Two pixels along the top says it without
 * shouting; a whole coloured header says the same thing far too loudly.
 */
function setRail(dialog, entry) {
  const body = dialog.querySelector('.sheet-body');
  if (!body) return;
  const c = entry ? primaryChannel(channelsOf(entry)) : 'code';
  body.classList.remove('rail-local', 'rail-paired', 'rail-room', 'rail-accent');
  body.classList.add(c === 'code' ? 'rail-accent' : `rail-${c}`);
}

function render() {
  // The open conversation is a view of this same state; a path that changes under it has to
  // show there too, and this is the funnel every change already runs through.
  if (ui.chatDialog.open) paintChatState();

  const live = [...app.conns.values()].sort((a, b) => a.name.localeCompare(b.name));
  const liveIds = new Set(live.map((c) => c.id));

  const offline = app.paired
    .filter((p) => !liveIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name || 'Device',
      kind: p.kind || 'laptop',
      state: p.paused ? 'paused' : 'offline',
      verified: true,
      paused: !!p.paused,
      channels: new Set(['paired']),
    }));

  const entries = [...live, ...offline];
  const keep = new Set(entries.map((e) => e.id));

  for (const [id, tile] of tiles) {
    if (keep.has(id)) continue;
    tile.el.classList.add('leaving');
    setTimeout(() => tile.el.remove(), 300);
    tiles.delete(id);
  }

  let arriving = 0;
  for (const entry of entries) {
    let tile = tiles.get(entry.id);
    if (!tile) {
      tile = buildTile(entry);
      // A roomful of devices appearing on the same frame reads as a pop; a few tens of
      // milliseconds between them reads as them arriving. Capped, so a big room does not
      // turn into a slow reveal.
      tile.el.style.setProperty('--i', String(Math.min(arriving++, 7)));
      tiles.set(entry.id, tile);
      ui.peers.append(tile.el);
    }
    paintTile(tile, entry);
  }

  ui.empty.hidden = entries.length > 0;
  ui.hint.hidden = live.length === 0 || !!app.staged;

  paintDiscoveryChips(live.length);

  /*
   * Nobody here yet, but still looking. This is the state the app spends most of its time in,
   * so the radar keeps running: a still screen full of buttons reads as "nothing here" rather
   * than "still listening".
   *
   * With discovery off it says something else, because opening the app elsewhere will not
   * make a device appear.
   */
  const seeking = app.prefs.discovery;
  setText(ui.emptySeeking.querySelector('span'), t(`empty.seeking.${seeking}`));
  ui.emptySeeking.dataset.mode = seeking;
  /*
   * On this network, an empty screen is the normal resting state rather than a prompt.
   *
   * Nothing is required of anyone: the other device only has to be opened, and then it
   * appears. A heading and three buttons made the ordinary case look like a problem to solve,
   * and made the app look stopped rather than listening. Local mode shows the scan and
   * nothing else.
   *
   * The other two modes do need an answer, either a code to share or a setting to change
   * before anything can happen, so they keep the full prompt.
   */
  ui.empty.dataset.mode = seeking;
  // The words change with the mode as well as the layout: on this network the one thing
  // that helps is opening the app elsewhere, in public it is sharing a code, and with
  // discovery off the message is that nothing will arrive at all.
  setText(ui.empty.querySelector('h1'), t(`empty.title.${seeking}`));
  setText(ui.empty.querySelector('p:not(.seeking)'), t(`empty.body.${seeking}`));
  app.radar.setSearching(live.length === 0 && seeking !== 'off');
  app.radar.setEnergy(Math.min(1, live.length / 2));
  app.radar.setMood(app.staged ? 'share' : live.some((c) => c.verified) ? 'verified' : 'accent');
}

function paintDiscoveryChips(liveCount) {
  paintDiscovery();
  // The footer chip is a count, so it only appears once there is one to show. The toolbar
  // button is a way in, and stays put: hidden at zero, the sheet that explains pairing could
  // only be reached by someone who had already paired something.
  ui.chipPaired.hidden = app.paired.length === 0;
  ui.chipPaired.textContent = `${app.paired.length} ${t('chip.paired')}`;
  ui.linkState.title = `${liveCount} connected`;
}

function buildTile(entry) {
  const el = document.createElement('button');
  el.className = 'peer';
  el.type = 'button';

  const avatar = document.createElement('span');
  avatar.className = 'avatar';

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'dev');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', iconFor(entry.kind));
  icon.append(use);

  const check = document.createElement('span');
  check.className = 'badge-check';
  const checkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const checkUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  checkUse.setAttribute('href', '#i-check');
  checkSvg.append(checkUse);
  check.append(checkSvg);

  avatar.append(icon, check);

  const channels = document.createElement('span');
  channels.className = 'channels';

  const name = document.createElement('span');
  name.className = 'pname';
  const meta = document.createElement('span');
  meta.className = 'pmeta';

  const menuBtn = document.createElement('span');
  menuBtn.className = 'peer-menu-btn';
  menuBtn.setAttribute('role', 'button');
  menuBtn.tabIndex = 0;
  // The attribute too, so a tile already on screen re-translates when the language changes.
  menuBtn.dataset.i18nTitle = 'tile.options';
  menuBtn.title = t('tile.options');
  const menuSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const menuUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  menuUse.setAttribute('href', '#i-dots');
  menuSvg.append(menuUse);
  menuBtn.append(menuSvg);
  const openIt = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openDeviceMenu(currentEntry(entry.id) || entry, menuBtn, el);
  };
  menuBtn.addEventListener('click', openIt);
  menuBtn.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') openIt(ev);
  });

  el.append(avatar, channels, name, meta, menuBtn);

  /*
   * Hold opens the menu, and the tap that ends the hold must not also send a file.
   *
   * Releasing after a long press still produces a click, so the tile used to open its menu
   * and the file picker together. The dots made that easy to miss, because nobody held a
   * tile when a button was right there. On a phone the dots are gone and holding is the
   * only way in, so the stray click became the common case rather than the odd one.
   *
   * The flag clears on the next press rather than on a timer. A right-click opens the menu
   * and never produces a click of its own, so anything that cleared the flag on a click
   * would leave it set and swallow the next real one.
   */
  let holdTimer = 0;
  let opened = false;

  const openMenu = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = 0;
    opened = true;
    openDeviceMenu(currentEntry(entry.id) || entry, el, el);
  };

  el.addEventListener('click', (e) => {
    if (opened) {
      opened = false;
      return;
    }
    onTileClick(entry.id, e.shiftKey);
  });

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openMenu();
  });

  el.addEventListener('pointerdown', (e) => {
    opened = false;
    if (e.button !== 0) return; // a right-click has its own event, and it fires first
    holdTimer = setTimeout(openMenu, 500);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    el.addEventListener(ev, () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = 0;
    });
  }

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drop-target');
  });
  for (const ev of ['dragleave', 'dragend']) {
    el.addEventListener(ev, () => el.classList.remove('drop-target'));
  }
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    document.body.classList.remove('dragging');
    // Read the entries before awaiting anything: a DataTransfer is emptied once the drop
    // handler returns, which is why folders vanish in most implementations.
    const files = await filesFromDataTransfer(e.dataTransfer);
    sendFiles(entry.id, files);
  });

  return { el, refs: { avatar, name, meta, use, channels } };
}

function paintTile(tile, entry) {
  const { el, refs } = tile;
  refs.name.textContent = entry.name; // peer-supplied: textContent only
  refs.use.setAttribute('href', iconFor(entry.kind));

  const channels = channelsOf(entry);
  el.style.setProperty('--tone', toneFor(channels));
  paintChannelPills(refs.channels, channels);

  el.classList.toggle('offline', entry.state === 'offline' || entry.state === 'paused');
  el.classList.toggle('connecting', entry.state === 'connecting');
  el.classList.toggle('ready', entry.state === 'ready');
  el.classList.toggle('verified', !!entry.verified);

  if (entry.progress) {
    paintProgress(entry);
    return;
  }

  el.classList.remove('busy', 'sending', 'receiving');
  el.style.removeProperty('--p');
  refs.meta.textContent =
    entry.state === 'paused'
      ? t('st.paused')
      : entry.state === 'offline'
        ? t('st.offline')
        : entry.state === 'connecting'
          ? t('st.connecting')
          : entry.usingRelay || entry.path === 'relay'
            ? t('st.relayed')
            : entry.path === 'local'
              ? t('st.local')
              : entry.verified
                ? t('st.verified')
                : t('st.connected');

  el.title =
    entry.state === 'offline'
      ? `${entry.name} — not reachable right now`
      : `${app.staged ? 'Send to' : 'Send to'} ${entry.name}${entry.sas ? ` · safety words: ${entry.sas}` : ''}`;
}

function paintChannelPills(host, channels) {
  const want = channels.filter((c) => c !== 'code').join(',');
  if (host.dataset.ch === want) return;
  host.dataset.ch = want;
  host.replaceChildren();
  for (const c of channels) {
    if (c === 'code') continue;
    const i = document.createElement('i');
    i.className = c;
    i.title = t(`ch.${c}`);
    host.append(i);
  }
}

/**
 * Progress arrives about five times a second. Writing it straight to the DOM makes the
 * ring jump and the rate number flicker, so each tile carries an animated value that eases
 * toward the latest reading on every frame.
 */
function paintProgress(conn) {
  const tile = tiles.get(conn.id);
  const p = conn.progress;
  if (!tile || !p) return;

  tile.el.classList.add('busy');
  tile.el.classList.toggle('sending', p.direction === 'send');
  tile.el.classList.toggle('receiving', p.direction === 'recv');
  tile.el.title = `${p.direction === 'send' ? 'Sending' : 'Receiving'} ${fmtBytes(p.done)} of ${fmtBytes(
    p.total,
  )} · ${fmtDuration(p.eta)} left · ${p.lanes} lane${p.lanes > 1 ? 's' : ''} · ${p.path}`;

  conn.anim = conn.anim || { p: 0, rate: p.rate || 0 };
  conn.anim.targetP = p.total ? Math.min(1, p.done / p.total) : 0;
  conn.anim.targetRate = p.rate || 0;
  startAnimator();
}

let animating = false;
let ambientTick = 0;
let lastFrame = 0;
function startAnimator() {
  if (animating) return;
  animating = true;
  lastFrame = 0;
  requestAnimationFrame(stepAnimator);
}

/**
 * Rates of approach, per second rather than per frame.
 *
 * `p += (target - p) * 0.18` every frame is a different curve on every display: it settles
 * twice as fast on a 120 Hz phone as on a 60 Hz laptop, and slows down under load, which is
 * exactly when the ring should look calmest. Converting to `1 - e^(-k·dt)` makes the motion
 * a property of time instead of a property of the machine. k = 12 reproduces the old feel
 * at 60 Hz, so the constant is the same curve, now correctly.
 */
const RING_K = 12;
const RATE_K = 8;

function stepAnimator(now = performance.now()) {
  const dt = lastFrame ? Math.min(0.05, (now - lastFrame) / 1000) : 1 / 60;
  lastFrame = now;
  const ringStep = 1 - Math.exp(-RING_K * dt);
  const rateStep = 1 - Math.exp(-RATE_K * dt);

  let live = false;
  for (const conn of app.conns.values()) {
    const a = conn.anim;
    const tile = tiles.get(conn.id);
    if (!a || !tile) continue;

    if (!conn.progress) {
      // Let a finished transfer run the ring to full, then hand the tile back to the
      // resting renderer so it stops showing a stale percentage.
      if (a.p > 0.999) {
        conn.anim = null;
        paintTile(tile, conn);
        continue;
      }
      a.textAt = 0; // a finishing transfer should show its last number, not a stale one
      a.targetP = 1;
    }

    // Fast when far, gentle on arrival, and identical on any refresh rate.
    a.p += (a.targetP - a.p) * ringStep;
    a.rate += (a.targetRate - a.rate) * rateStep;

    // The ring wants every frame; the label does not. Rewriting text 120 times a second
    // costs a layout each time and produces a number nobody can read, and on a 120 Hz phone
    // it is the difference between a smooth ring and a stuttering one.
    const p = a.p.toFixed(4);
    if (p !== a.lastP) {
      a.lastP = p;
      tile.el.style.setProperty('--p', p);
    }
    if (now - (a.textAt || 0) >= 90) {
      a.textAt = now;
      tile.refs.meta.textContent = `${Math.round(a.p * 100)}% · ${fmtRate(a.rate)}`;
    }
    live = true;
  }

  if (live && ++ambientTick % 12 === 0) updateAmbient();
  if (live) requestAnimationFrame(stepAnimator);
  else {
    animating = false;
    lastFrame = 0;
  }
}

function iconFor(kind) {
  return kind === 'phone' ? '#i-phone' : kind === 'tablet' ? '#i-tablet' : '#i-laptop';
}

/* ───────────────── the tab itself reports what is happening ───────────── */

function updateAmbient() {
  const busy = [...app.conns.values()].filter((c) => c.progress);
  if (!busy.length) {
    // An announcement outranks the resting title until the tab is actually looked at.
    document.title = announced ? `${announced} · Gear Drop` : 'Gear Drop';
    paintFavicon(null);
    releaseWake();
    return;
  }
  const p =
    busy.reduce((acc, c) => acc + (c.progress.total ? c.progress.done / c.progress.total : 0), 0) / busy.length;
  document.title = `${Math.round(p * 100)}% · Gear Drop`;
  paintFavicon(p);
  acquireWake();
}

/**
 * A tab that is minimised is the normal case during a long transfer, so the favicon
 * carries the progress ring. It is the only place the number is visible when the window
 * is not.
 */
function paintFavicon(p) {
  if (baseFavicon === null) baseFavicon = ui.favicon.getAttribute('href');
  if (p === null) {
    if (ui.favicon.getAttribute('href') !== baseFavicon) ui.favicon.setAttribute('href', baseFavicon);
    return;
  }
  const c = paintFavicon._c || (paintFavicon._c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }));
  const g = c.getContext('2d');
  const style = getComputedStyle(document.body);
  g.clearRect(0, 0, 32, 32);
  g.lineWidth = 5;
  g.strokeStyle = style.getPropertyValue('--line') || '#333';
  g.beginPath();
  g.arc(16, 16, 12, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = (style.getPropertyValue('--accent') || '#4f8ef7').trim();
  g.lineCap = 'round';
  g.beginPath();
  g.arc(16, 16, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
  g.stroke();
  ui.favicon.setAttribute('href', c.toDataURL('image/png'));
}

let wakeLock = null;
async function acquireWake() {
  if (!app.prefs.awake || wakeLock || !navigator.wakeLock || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // denied, or not permitted in this context
  }
}
function releaseWake() {
  try {
    wakeLock?.release?.();
  } catch {
    /* already released */
  }
  wakeLock = null;
}

/*
 * Say something arrived, in the two places someone might be looking.
 *
 * The tab title is the one that matters and it was missing. If this tab is in the background -
 * which is the whole situation worth designing for, because if you were looking at it you
 * would have seen the sheet open - then the only thing about this app still on screen is its
 * entry in the tab strip, and it went on saying "Gear Drop" as though nothing had happened.
 * Retitling it is what makes the tab strip carry the news.
 *
 * The title is set whether or not system notifications are switched on, because it costs
 * nothing and asks for no permission; the notification itself still respects the setting.
 */
/*
 * Arrival tone, synthesised rather than shipped: no file to fetch, no decode, no `media-src`
 * in the policy. Sine dropping an octave over 200ms. Plays on the receiving end only, since
 * the sender already watched it leave.
 */
let audio = null;

function blip() {
  if (!app.prefs.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audio ||= new Ctx();
    // Before any gesture the context is suspended; browsers will not let a page make noise at
    // someone who has not touched it yet, which is correct, so this simply stays quiet.
    if (audio.state !== 'running') return;

    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(760, t);
    osc.frequency.exponentialRampToValueAtTime(500, t + 0.22);

    /*
     * Attack, then two stages of decay, and the second stage is the one that matters.
     *
     * A single exponential from full down to silence falls off a cliff - rendered offline and
     * measured, the first attempt was at a sixth of its peak by 60ms and inaudible by 120,
     * which is not a tone, it is a click. Dropping to a quarter first and only then to nothing
     * gives it a tail: 0.17 at 20ms, 0.12 at 60, 0.07 at 120, gone by 300. The ramps start and
     * end a hair above zero because an exponential one cannot touch it.
     */
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.045, t + 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);

    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.36);
  } catch {
    /* no audio here, and nothing depends on it */
  }
}

let announced = null;

/**
 * A nudge that something arrived, carrying no part of what arrived.
 *
 * An OS notification is the one thing this app produces that it no longer controls: drawn on a
 * lock screen, kept in a notification centre, on some platforms synced to other machines. So
 * the title says who from and the body says only that something came. Padding file names on
 * the wire and then printing them here would have made the padding pointless.
 */
function notify(title, body) {
  if (!document.hidden) return;

  announced = title;
  document.title = `${title} · Gear Drop`;

  if (!app.prefs.notify) return;
  try {
    if (Notification?.permission === 'granted') new Notification(title, { body, icon: 'icon.svg', silent: true });
  } catch {
    /* not supported here */
  }
}

/* ───────────────────────────── share mode ────────────────────────────── */

/**
 * Stage first, choose second.
 *
 * Files dropped on the page, or handed over by the system share sheet, wait in a banner
 * until a destination is picked, instead of being refused because no device was under the
 * cursor. While something is staged the whole interface reads as "pick a target": the radar
 * changes mood and every reachable tile is outlined.
 */
function stageFiles(files, label) {
  const arr = [...(files || [])];
  if (!arr.length) return;
  clearStagedThumb();
  const total = arr.reduce((a, f) => a + (f.size || 0), 0);
  app.staged = { files: arr, total };

  ui.shareTitle.textContent = label || (arr.length === 1 ? arr[0].name : `${arr.length} files`);
  ui.shareSub.textContent = `${fmtBytes(total)} · ${t('share.pick')}`;

  const first = arr[0];
  if (first && /^image\//.test(first.type || '') && first.size < 12e6) {
    const url = URL.createObjectURL(first);
    app.staged.thumb = url;
    /*
     * The icon steps aside only once the browser has actually decoded the picture.
     *
     * `image/heic` is what an iPhone hands over and what Chrome and Firefox cannot draw, so
     * setting the background first left an empty square where the photo should have been. An
     * AVIF on an older browser and a half-copied JPEG both fail the same way, which is why
     * the test is whether it decoded rather than what its type claims.
     */
    const show = (href) => {
      ui.shareThumb.style.backgroundImage = `url("${href}")`;
      ui.shareThumb.firstElementChild.style.display = 'none';
    };

    const probe = new Image();
    probe.addEventListener('load', () => {
      // Staged again while this was decoding: that transfer owns the thumbnail now.
      if (app.staged?.thumb !== url) return;
      show(url);
    });
    /*
     * The browser cannot draw it, which for a photo off a phone means HEIC.
     *
     * The decoder is three megabytes, so it is fetched here and nowhere else: not at boot,
     * not on a picture the browser was always going to manage, and never at all for someone
     * who does not own an iPhone. `heic.js` itself is a few kilobytes and decides whether
     * this is a HEIC at all before any of that weight is asked for.
     */
    probe.addEventListener('error', async () => {
      if (app.staged?.thumb !== url) return;
      let preview = null;
      try {
        const heic = await import('./core/heic.js');
        if (!heic.looksHeic(first)) return;
        preview = await heic.heicPreview(first);
      } catch {
        return; // the icon is already there, and it is the honest answer
      }
      // Staged again while three megabytes were downloading, which is long enough to happen.
      if (!preview || app.staged?.thumb !== url) return;

      const shown = URL.createObjectURL(preview);
      URL.revokeObjectURL(url);
      app.staged.thumb = shown; // so the same cleanup that revokes the original revokes this
      show(shown);
    });
    probe.src = url;
  }

  ui.shareBar.classList.remove('leaving');
  ui.shareBar.hidden = false;
  document.body.classList.add('share-mode');
  app.radar.setMood('share');
  app.radar.burst();
  render();
}

function clearStagedThumb() {
  if (app.staged?.thumb) URL.revokeObjectURL(app.staged.thumb);
  ui.shareThumb.style.backgroundImage = '';
  if (ui.shareThumb.firstElementChild) ui.shareThumb.firstElementChild.style.display = '';
}

function clearStage() {
  clearStagedThumb();
  app.staged = null;
  document.body.classList.remove('share-mode');

  const bar = ui.shareBar;
  bar.classList.add('leaving');
  setTimeout(() => {
    bar.hidden = true;
    bar.classList.remove('leaving');
  }, 190);

  render();
}

/* ─────────────────────────── device menu ─────────────────────────────── */

let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  const { el, tile } = openMenu;
  openMenu = null;
  tile?.classList.remove('menu-open');

  // Let it animate out, but never leave a node behind if the animation does not run, whether
  // from reduced motion, a backgrounded tab, or a browser that skipped the frame.
  el.classList.add('closing');
  const drop = () => el.remove();
  el.addEventListener('animationend', drop, { once: true });
  setTimeout(drop, 240);
}

/**
 * Per-device controls, with the connection facts that actually matter next to them: which
 * path is carrying the bytes, the round trip, the negotiated chunk size. If a transfer is
 * running, the first item stops it.
 */
function openDeviceMenu(entry, anchor, tile) {
  closeMenu();
  const conn = app.conns.get(entry.id);
  const paired = app.paired.find((p) => p.id === entry.id);

  const el = document.createElement('div');
  el.className = 'menu';
  el.setAttribute('role', 'menu');
  el.style.setProperty('--tone', toneFor(channelsOf(entry)));

  const head = document.createElement('div');
  head.className = 'menu-head';
  const title = document.createElement('div');
  title.className = 'menu-title';
  title.textContent = entry.name; // peer-supplied
  head.append(title);

  const facts = document.createElement('dl');
  facts.className = 'menu-facts';
  for (const [k, v] of deviceFacts(conn, entry, paired)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    facts.append(dt, dd);
  }
  head.append(facts);
  el.append(head);

  const item = (label, icon, fn, opts = {}) => {
    const b = document.createElement('button');
    b.className = 'menu-item' + (opts.danger ? ' danger' : '');
    b.type = 'button';
    b.disabled = !!opts.disabled;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', icon);
    svg.append(use);
    const span = document.createElement('span');
    span.textContent = label;
    b.append(svg, span);
    b.addEventListener('click', () => {
      closeMenu();
      fn();
    });
    el.append(b);
    return b;
  };
  const sep = () => el.append(Object.assign(document.createElement('div'), { className: 'menu-sep' }));

  if (conn?.progress) {
    item(t('menu.stop'), '#i-stop', () => conn.transfers.abort(conn.progress.transferId, 'user'), { danger: true });
    sep();
  }

  const online = !!conn && conn.state === 'ready';
  item(t('menu.sendFiles'), '#i-file', () => onTileClick(entry.id, false), { disabled: !online });
  // Safari accepts `webkitdirectory` and then never returns a directory, so on iOS the
  // control is absent rather than present and inert.
  if (platform().folders) {
    item(t('menu.sendFolder'), '#i-folder', () => onTileClick(entry.id, true), { disabled: !online });
  }
  /*
   * Not disabled when offline.
   *
   * There may be a conversation here worth reading even when the other device is not around,
   * and keeping it is only useful if it survives the device going away. The composer
   * is what gets disabled, with a line saying why.
   */
  item(t('menu.chat'), '#i-message', () => openChat(entry.id));

  sep();

  /*
   * Say what this actually does.
   *
   * Confirming the safety words is also how a device found on the network becomes one this
   * device remembers: the pairing root is derived and written, and from then on the two meet
   * without a code and the device is on the radar whether it is switched on or not. Labelled
   * "Check the safety words" nobody would guess that, so an unpaired device is offered
   * pairing and a paired one is offered the check.
   */
  if (conn?.sas && !conn.verified) {
    item(t(paired ? 'menu.verify' : 'menu.pair'), '#i-shield', () => promptVerify(conn, { force: true }));
  }

  if (paired?.paused) {
    item(t('menu.reconnect'), '#i-link', () => setPeerPaused(entry.id, false));
  } else if (conn) {
    item(t('menu.disconnect'), '#i-unplug', () => setPeerPaused(entry.id, true));
  }

  if (paired) {
    item(t('menu.forget'), '#i-trash', () => forgetDevice(entry.id), { danger: true });
  }

  document.body.append(el);

  // Anchor below the button, kept inside the viewport.
  const r = anchor.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const left = Math.min(Math.max(8, r.right - box.width), innerWidth - box.width - 8);
  const top = r.bottom + box.height + 8 > innerHeight ? r.top - box.height - 6 : r.bottom + 6;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(8, top))}px`;

  tile?.classList.add('menu-open');
  openMenu = { el, tile };
}

function deviceFacts(conn, entry, paired) {
  const out = [];
  const state = paired?.paused
    ? t('st.disconnectedByYou')
    : conn?.state === 'ready'
      ? t('st.connected')
      : conn
        ? t('st.connecting')
        : t('st.offline');
  out.push([t('fact.status'), state]);

  const channels = channelsOf(entry);
  if (channels.length) out.push([t('fact.found'), channels.map((c) => t(`ch.${c}`)).join(', ')]);

  if (conn?.state === 'ready') {
    out.push([
      t('fact.path'),
      conn.usingRelay
        ? 'relayed (ciphertext)'
        : conn.path === 'local'
          ? t('st.local')
          : conn.path === 'relay'
            ? 'TURN relay'
            : conn.path === 'direct'
              ? 'direct'
              : 'negotiating',
    ]);
    if (conn.rtt) out.push([t('fact.rtt'), `${Math.round(conn.rtt)} ms`]);
    out.push([t('fact.chunk'), fmtBytes(conn.transport.chunkSize)]);
    out.push([t('fact.lanes'), String(conn.transport.readyLanes || 1)]);
  }
  if (conn?.sas) out.push([t('fact.sas'), conn.sas]);
  out.push([t('fact.trust'), entry.verified ? t('st.verified') : t('st.unverified')]);
  return out;
}

async function setPeerPaused(id, paused) {
  const rec = app.paired.find((p) => p.id === id);
  if (rec) {
    rec.paused = paused;
    await savePeer(rec);
  }
  if (paused) {
    // Say so first, while there is still something to say it over. The frame is best-effort:
    // if it cannot be sent the peer falls back to noticing, which is what it used to do.
    const conn = app.conns.get(id);
    if (conn?.state === 'ready') {
      try {
        await conn.transfers.sendBye();
      } catch {
        /* going anyway */
      }
    }

    // Drop the live conversation and stop meeting this device at its rendezvous tag until
    // the user asks for it again.
    for (const [key, sub] of app.pairSubs) {
      if (sub.peer?.id !== id) continue;
      sub.session.destroy();
      app.pairSubs.delete(key);
    }
    dropConn(id);
    toast(t('toast.disconnected'));
  } else {
    /*
     * Start listening again immediately.
     *
     * Subscribing to a pairing tag happened only on the thirty-second sweep, so "Reconnecting"
     * was followed by up to half a minute of a device that was not listening at the one
     * address its peer was calling. Nothing was broken and nothing was happening, which is the
     * worst thing a status line can be saying.
     */
    toast(t('toast.reconnecting'));
    await refreshPaired();
    await resubscribePaired();
    for (const delay of RETRY_AFTER_MS) {
      setTimeout(() => {
        // Only if it is still not up; a connected device needs nothing said to it.
        if (!app.conns.has(id)) resubscribePaired({ force: true }).catch(() => {});
      }, delay);
    }
    paintDevicesDialog();
    return;
  }
  await refreshPaired();
  paintDevicesDialog();
}

async function forgetDevice(id) {
  /*
   * Unpairing is the one action that can strand an erase.
   *
   * Reaching a paired device at all depends on the pairing root in this record: it is what
   * derives the rotating tags the two of them meet at. Delete the record and there is no way
   * to find that device again, so an erase it still owes can never be delivered - not now,
   * not later. Nothing in the protocol can fix that, so it is said before it happens
   * rather than after.
   */
  const rec = app.paired.find((p) => p.id === id);
  if (rec?.wipePending && !confirm(t('devices.unpairStrands', { name: rec.name || t('tile.unnamed') }))) return;

  /*
   * Unpairing is meant to leave nothing behind, and a conversation is the most of something
   * that could be left - on either machine. The other device is told first, while there is
   * still a connection to tell it over, and nothing is noted as owed: after this there is no
   * root left to reach it with.
   */
  await destroyConversation(id, { tell: true, owe: false });
  await peerStore.del(id);
  for (const [key, sub] of app.pairSubs) {
    if (sub.peer?.id !== id) continue;
    sub.session.destroy();
    app.pairSubs.delete(key);
  }
  app.alsoOn.delete(id);
  dropConn(id);
  await refreshPaired();
  paintDevicesDialog();
  toast(t('toast.forgotten'));
}

function onTileClick(connId, wantFolder = false) {
  const conn = app.conns.get(connId);
  if (!conn) {
    const rec = app.paired.find((p) => p.id === connId);
    toast(t(rec?.paused ? 'toast.reconnectHint' : 'toast.notOnline'));
    return;
  }

  // Something staged? Then the tile is the destination picker.
  if (app.staged) {
    const files = app.staged.files;
    clearStage();
    sendFiles(connId, files);
    return;
  }

  // While a transfer is running, the tile is the cancel control.
  if (conn.progress) {
    conn.transfers.abort(conn.progress.transferId, 'user').catch(() => {});
    return;
  }

  pickFiles(wantFolder).then((files) => sendFiles(connId, files));
}

function pickFiles(wantFolder = false, { multiple = true, accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    // A hint to the system picker, never a guarantee: everything it hands back is still
    // checked on the way in.
    if (accept) input.accept = accept;
    if (wantFolder) input.webkitdirectory = true; // Shift-click sends a folder, structure intact
    input.addEventListener('change', () => resolve(filesFromInput(input)));
    input.click();
  });
}

/**
 * A rendering to send with the offer, or null.
 *
 * Only for a single picture: a preview answers "what is this?", and a sheet listing nine
 * files is not asking that. Failure is silent by design - a browser that cannot decode the
 * format, a picture that will not compress small enough, an older engine with no
 * `OffscreenCanvas` - because none of those are reasons not to send a file.
 */
async function offerPreview(files) {
  if (files.length !== 1 || !canThumb(files[0])) return null;
  try {
    return await makeThumb(files[0]);
  } catch {
    return null;
  }
}

async function sendFiles(connId, fileList) {
  const conn = app.conns.get(connId);
  if (!conn) return toast(t('toast.notConnected'), 'bad');
  const files = [...(fileList || [])];
  if (!files.length) return;

  /*
   * The words, before the first file goes to a device nobody has checked.
   *
   * Receiving from an unchecked device already puts Accept behind a gate. Sending to that same
   * device asked nothing, which is the asymmetry the design exists to avoid: somebody standing
   * in the middle does not care which way the file is travelling, and the sending direction is
   * the worse of the two, because the thing at risk is a file you chose rather than one you
   * were offered.
   *
   * The condition is the receive gate's, not a second opinion about it — `sasConfirmed`
   * compares against the words currently in force, so a re-key asks again and a confirmation
   * cannot be carried across one. A paired device is exempt: the pairing root is the proof, and
   * asking twice for the same fact is how a check becomes a thing people click through.
   *
   * This is the only place it can go. The tile, the picker, the share target and the chat
   * attachment all arrive here; put on any one of them, the other three would be the hole.
   */
  if (!conn.verified && !sasConfirmed(conn)) {
    heldSend = { connId, files };
    promptVerify(conn, { force: true });
    return;
  }

  try {
    await conn.transfers.offer(files, { thumb: await offerPreview(files) });
    toast(files.length === 1 ? t('toast.offer.one', { name: conn.name }) : t('toast.offer.many', { n: files.length, name: conn.name }));
  } catch (err) {
    toast(humanError(err?.message, 'toast.sendFailed'), 'bad');
  }
}

/**
 * Has this person already checked the words *for the key that is in use right now*?
 *
 * Confirming the safety words says something about one key agreement and nothing about the
 * next one. Sessions re-key on a reconnect and whenever the peer restarts, and the words
 * change with the key. Recording the answer as a plain flag on the connection carried a check
 * made against one key over to a different one, which is what the check exists to prevent.
 */
function sasConfirmed(conn) {
  return !!conn && !!conn.sasCheckedFor && conn.sasCheckedFor === conn.sas;
}

/**
 * Acceptances that are waiting for the line to clear.
 *
 * Emptied when a transfer finishes, and also when one fails or is cancelled. Otherwise a
 * transfer that never completes strands everything queued behind it.
 */
const queuedAccepts = [];

/** Offers waiting for the sheet to be free. */
const incomingQueue = [];

async function runQueuedAccepts() {
  const next = queuedAccepts.shift();
  if (!next) return;
  if (next.conn.closed || !next.conn.transfers.in.has(next.manifest.transferId)) {
    return runQueuedAccepts(); // gone while it waited
  }
  try {
    await next.conn.transfers.accept(next.manifest.transferId, {
      userGesture: false, // the person's answer was given a while ago; no picker now
      prefer: 'opfs',
    });
    toast(t('incoming.queuedStart', { name: next.conn.name }));
  } catch (err) {
    if (err?.name === 'BusyError') queuedAccepts.unshift(next);
    else toast(humanError(err?.message, 'toast.queueFailed'), 'bad');
  }
}

/* ──────────────────────────────── incoming ───────────────────────────── */

let pendingIncoming = null;

/**
 * Whether an offer is a picture meant for the conversation.
 *
 * The flag on the manifest is the sender's claim about intent; everything that decides what
 * actually happens is checked here. A batch is not a chat picture however it is labelled - the
 * composer sends one - and neither is a type this app will not draw or a size it will not
 * keep. The claim can only ever get an offer treated as *less* surprising, never as more
 * trusted.
 */
function isChatPhotoOffer(conn, manifest) {
  if (!conn || manifest?.chat !== true) return false;
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1) return false;
  const f = manifest.files[0];
  return !!chat.mediaKind(f.mime, f.size);
}

async function showIncoming(conn, manifest) {
  /*
   * Where a picture in an open conversation stops needing a confirmation sheet.
   *
   * Being asked to approve every photograph in a chat is not how a conversation works, but
   * accepting bytes with nobody in the loop is exactly the thing this app is careful about, so
   * the two are separated: the silent path is for a device whose safety words have actually
   * been checked - a paired one, or one confirmed in this session - and nothing else. An
   * unverified device on the network can still send a picture; it just asks first, like any
   * other file, and lands in the conversation once the answer is yes.
   */
  if (isChatPhotoOffer(conn, manifest)) {
    chatTransfers.set(manifest.transferId, { id: conn.id, voice: manifest.voice === true, dur: manifest.dur || 0 });
    if (conn.verified) {
      try {
        // Straight into memory, never onto the disk.
        //
        // These bytes are about to be sealed and kept. Staging them in origin-private
        // storage first wrote the plaintext to the filesystem, and deleting a file does not
        // remove the bytes, which is what a forensic tool looks for. A chat attachment is
        // capped small enough to hold in memory.
        await conn.transfers.accept(manifest.transferId, { userGesture: false, prefer: 'memory' });
        return;
      } catch {
        /* busy, or storage refused: fall through and ask, as any other offer would */
      }
    }
  }

  // A device you own, marked auto-accept, should not ask. It writes to private storage
  // rather than opening a save dialog, because a save dialog needs a click anyway.
  const rec = conn.peer && app.paired.find((p) => p.id === conn.peer.id);
  // Auto-accept belongs to a device whose pairing root matched, and nothing else. The check
  // is redundant today, since a record only exists after verification, but this is the one
  // place a file lands with no human in the loop, so it states its condition.
  if (rec?.autoAccept && (conn.verified || conn.member)) {
    try {
      await conn.transfers.accept(manifest.transferId, { userGesture: false, prefer: 'memory' });
      toast(
      manifest.files.length === 1
        ? t('toast.accept.oneBody')
        : t('toast.accept.manyBody', { n: manifest.files.length }),
      '',
      { title: conn.name, icon: '#i-file' },
    );
      notify(conn.name, `Receiving ${fmtBytes(manifest.total)}`);
      return;
    } catch {
      /* fall through to asking */
    }
  }

  /*
   * One sheet at a time, and the rest wait.
   *
   * Two offers arriving close together used to overwrite each other. The second painted over
   * the first and took its place as the pending one, so whatever the person agreed to was the
   * second offer while the first sat in the engine as "offered": no sheet, no notification,
   * and a sender waiting on an answer that could no longer be given. Reproduced by sending
   * two batches a third of a second apart.
   */
  incomingQueue.push({ conn, manifest });
  if (!ui.incoming.open) presentNextIncoming();
}

/** What this offer is, in three words: a picture, a file, or a number of files. */
function incomingHeading(manifest) {
  if (manifest.files.length !== 1) return t('incoming.many', { n: manifest.files.length });
  return offeredPicture(manifest) ? t('incoming.image') : t('incoming.one');
}

/** The single image this offer is, or null. A preview belongs to nothing else. */
function offeredPicture(manifest) {
  if (!manifest.thumb || manifest.files.length !== 1) return null;
  const file = manifest.files[0];
  return isImageMime(file.mime) ? file : null;
}

/**
 * Draw the preview, or make sure the last one is gone.
 *
 * Called for every offer, including the ones with no picture in them, because the sheet is
 * reused: a photo from one device followed by a spreadsheet from another would otherwise be
 * shown under the photo. Revoking first also means the bytes of a declined offer stop being
 * reachable the moment the next one appears, rather than whenever the page happens to end.
 */
function showIncomingPreview(manifest) {
  clearIncomingPreview();
  if (!offeredPicture(manifest)) return;

  const url = thumbUrl(manifest.thumb);
  if (!url) return;

  /*
   * The frame is given the picture's own proportions before it loads.
   *
   * Without them the sheet is laid out at nothing, then again at the image's height, and the
   * buttons jump under a finger already moving towards Decline. `w` and `h` were bounded on
   * the way in, so this is a shape and not an instruction.
   */
  ui.incomingPreview.style.setProperty('--ratio', `${manifest.thumb.w} / ${manifest.thumb.h}`);
  ui.incomingPreviewImg.alt = t('a11y.preview');
  ui.incomingPreviewImg.src = url;
  ui.incomingPreview.hidden = false;
}

/** Let go of the object URL. The sheet keeps no picture between offers. */
function clearIncomingPreview() {
  const previous = ui.incomingPreviewImg.src;
  ui.incomingPreviewImg.removeAttribute('src');
  ui.incomingPreview.hidden = true;
  if (previous.startsWith('blob:')) URL.revokeObjectURL(previous);
}

/** Paint the next waiting offer onto the sheet and show it. */
function presentNextIncoming() {
  let next = incomingQueue.shift();
  // Skip anything that was withdrawn, or whose connection went away, while it waited.
  while (next && (next.conn.closed || !next.conn.transfers.in.has(next.manifest.transferId))) {
    next = incomingQueue.shift();
  }
  if (!next) return;

  const { conn, manifest } = next;
  pendingIncoming = next;
  ui.incomingTitle.textContent = incomingHeading(manifest);
  ui.incomingFrom.textContent = conn.name;
  ui.incomingSas.textContent = conn.sas || '—';

  // Encryption settles who *else* can read this; it does not settle who the other end is.
  // For a device met through a code or a room, the only thing that answers that is the
  // safety words, and words nobody reads are decoration. So when the peer has not been
  // verified, Accept stays inert until the person says the words match. A device that was
  // paired earlier is already proved by its pairing root and is not asked again.
  // Note what is not in this condition: whether any words exist yet. Requiring them let a
  // connection that produced none, as the relayed path did, through with the gate hidden and
  // Accept live. No words is not a reason to skip the check.
  const needsSas = !conn.verified && !sasConfirmed(conn);
  ui.incomingGate.hidden = !needsSas;
  ui.incomingConfirm.checked = false;
  ui.btnAccept.disabled = needsSas;
  ui.incomingSize.textContent = fmtBytes(manifest.total);
  ui.incomingFiles.replaceChildren();

  // The protocol caps an offer at a few thousand files. A list that long is not read, and
  // building it costs more than showing it is worth. The count stays exact; only the
  // rendering stops.
  const SHOW = 200;
  let risky = 0;

  /*
   * Whether this offer will keep its folders, worked out here so the list and the hint below
   * both describe what `accept` is about to do. The same three conditions it uses: a path to
   * rebuild, a browser that can grant a directory, and a person who asked to choose where
   * things land. Guessing differently in either place is a lie about where a file is going.
   */
  const caps = sinkCapabilities();
  const toDisk = app.prefs.saveTo === 'ask' && caps.fsa;
  const keepsFolders = toDisk && caps.directory && manifest.files.some((f) => /[\\/]/.test(f.path || ''));

  manifest.files.slice(0, SHOW).forEach((f, i) => {
    const li = document.createElement('li');
    li.style.animationDelay = `${i * 0.04}s`;

    // The name shown is the name that will be written. Anything else is how a file called
    // "holiday<RLO>gnp.exe" gets read as a photo and saved as a program.
    const shown = keepsFolders
      ? safePathSegments(f.path || f.name).join('/')
      : safeFileName(f.path || f.name);
    const risk = riskOf(shown);
    if (risk) risky++;

    const n = document.createElement('span');
    n.textContent = shown; // peer-supplied: textContent only
    if (risk) {
      const tag = document.createElement('b');
      tag.className = 'risk';
      tag.textContent = t(risk === 'active' ? 'risk.active' : 'risk.runs');
      n.append(' ', tag);
    }

    const s = document.createElement('span');
    s.textContent = fmtBytes(f.size);
    li.append(n, s);
    ui.incomingFiles.append(li);
  });

  if (manifest.files.length > SHOW) {
    const more = document.createElement('li');
    more.className = 'muted';
    more.textContent = t('incoming.andMore', { n: manifest.files.length - SHOW });
    ui.incomingFiles.append(more);
  }

  showIncomingPreview(manifest);

  ui.incomingWarn.hidden = risky === 0;
  if (risky) setText(ui.incomingWarn, t('risk.note'));

  setText(
    ui.incomingHint,
    t(
      keepsFolders
        ? 'sink.hintFolder'
        : toDisk
          ? 'sink.hintDisk'
          : caps.opfs
            ? 'sink.hintSandbox'
            : 'sink.hintMemory',
    ),
  );

  app.radar.burst();
  blip();
  notify(conn.name, `Wants to send ${fmtBytes(manifest.total)}`);
  setRail(ui.incoming, conn);
  ui.incoming.showModal();
}

ui.roomInviteYes.addEventListener('click', () => {
  const code = pendingRoomInvite;
  closeRoomInvite();
  ui.room.close();
  if (code) joinRoom(code);
});
ui.roomInviteNo.addEventListener('click', () => {
  closeRoomInvite();
  ui.room.close();
});
// Dismissing the sheet any other way, by Escape, the close button or a swipe, is also a no.
ui.room.addEventListener('close', () => {
  if (pendingRoomInvite) closeRoomInvite();
});

ui.incomingConfirm.addEventListener('change', () => {
  ui.btnAccept.disabled = !ui.incomingConfirm.checked;
});

ui.incoming.addEventListener('close', async () => {
  const ctx = pendingIncoming;
  pendingIncoming = null;
  // The preview goes when the sheet does, accepted or not. `presentNextIncoming` clears it
  // too, but nothing says another offer is waiting, and the picture should not outlive the
  // question it was asked to answer.
  clearIncomingPreview();
  // Whatever happens to this one, the next offer gets its turn.
  setTimeout(presentNextIncoming, 0);
  if (!ctx) return;

  /*
   * An offer that is not going to arrive stops being remembered.
   *
   * `chatTransfers` is a note saying "if this one lands, it belongs in the conversation", and
   * it was only ever torn up when a file actually completed. Every other ending - declined,
   * dismissed, aborted, failed - left the note behind, and the offers come from the peer, so
   * the set of notes grew with nothing but their patience bounding it. Offering pictures that
   * get declined is not an attack anyone would bother with, but a map that only a remote
   * device can add to and only a success can remove from is the wrong shape to leave lying
   * around.
   */
  if (ui.incoming.returnValue !== 'accept') {
    chatTransfers.delete(ctx.manifest.transferId);
    await ctx.conn.transfers.decline(ctx.manifest.transferId);
    return;
  }

  // Re-checked at the moment of acceptance rather than trusted from when the sheet opened:
  // a dialog can be closed by a key, a swipe, or a script, and only one of those went
  // through the checkbox.
  if (!ctx.conn.verified && !sasConfirmed(ctx.conn) && !ui.incomingConfirm.checked) {
    chatTransfers.delete(ctx.manifest.transferId);
    await ctx.conn.transfers.decline(ctx.manifest.transferId);
    toast(t('incoming.needWords'), 'bad');
    return;
  }
  // Said once, it holds for the rest of this conversation: the words are a property of the
  // session key, and that has not changed.
  // Recorded as the words themselves, not as a flag. They change whenever the key
  // changes and whenever the path they are bound to changes, so storing them is what makes
  // "already checked" mean "already checked *this*".
  ctx.conn.sasCheckedFor = ctx.conn.sas;
  try {
    await ctx.conn.transfers.accept(ctx.manifest.transferId, {
      userGesture: true,
      // A picture bound for the conversation has to come back as bytes this app can seal, so
      // it never goes through the save dialog even when that is the standing preference - it
      // is not being saved anywhere yet.
      prefer:
        app.prefs.saveTo === 'ask' && !chatTransfers.has(ctx.manifest.transferId)
          ? undefined
          : 'opfs',
    });
  } catch (err) {
    if (err?.name === 'BusyError') {
      /*
       * A chunk header carries a file id but no transfer id, so only one transfer can be
       * arriving at a time, which the engine now enforces rather than assumes. The person has
       * already said yes, though, so the acceptance waits its turn rather than being dropped
       * over a format detail.
       */
      queuedAccepts.push(ctx);
      toast(t('incoming.queued'));
    } else if (err?.name === 'AbortError') {
      chatTransfers.delete(ctx.manifest.transferId);
      await ctx.conn.transfers.decline(ctx.manifest.transferId);
      toast(t('toast.cancelled'));
    } else {
      toast(humanError(err?.message, 'toast.saveDialogFailed'), 'bad');
    }
  }
});

/**
 * A room code that arrived in a link, rather than from the person holding the device.
 *
 * Joining a room announces a device name and the fact that it is online to everyone else in
 * it, and switches discovery to public, which this app asks people to choose. A link did all
 * of that on its own, so following one from anywhere, including a page that never showed it,
 * put someone in a stranger's room without a word.
 *
 * Typing a code is already an answer to this question. Clicking a link is not, so it gets
 * asked. The room sheet is reused rather than adding another one.
 */
function askJoinRoom(code) {
  const cells = [...ui.roomInviteCode.children];
  code.split('').forEach((ch, i) => {
    if (cells[i]) cells[i].textContent = ch;
  });
  ui.roomInvite.hidden = false;
  ui.roomInactive.hidden = true;
  ui.roomActive.hidden = true;
  pendingRoomInvite = code;
  ui.room.showModal();
}


function closeRoomInvite() {
  pendingRoomInvite = null;
  ui.roomInvite.hidden = true;
  paintRoom();
}

/* ──────────────────────────────── verify ─────────────────────────────── */

let verifying = null;

/**
 * Files picked for a device whose words have not been read yet.
 *
 * Held here for as long as the question is on screen, so that answering it sends what was
 * already chosen instead of asking for it again. Cleared whichever way the question is answered,
 * and on any other path out, so a refused check cannot leave a send queued behind it.
 */
let heldSend = null;

/**
 * Deal with whatever was waiting, now that a question has been answered.
 *
 * Three cases, and the middle one is the reason this exists. If the answer was about the device
 * the files were picked for, they go. If it was about some other device, the question for ours
 * was never asked - `promptVerify` turns away anything raised while a dialog is open, and
 * nothing used to come back to it - so it is asked now. And if the device has gone in the
 * meantime there is nothing to send to and nothing to ask.
 *
 * Without the middle case a send could be lost in silence: answer a question about one device
 * and the file you picked for another is waiting on a question nobody will ever ask.
 */
function releaseHeldSend(answered) {
  if (!heldSend) return;

  if (heldSend.connId === answered.id) {
    const waiting = heldSend;
    heldSend = null;
    if (waiting.files?.length) sendFiles(waiting.connId, waiting.files);
    return;
  }

  const other = app.conns.get(heldSend.connId);
  if (!other) {
    heldSend = null;
    return;
  }
  if (!other.verified && !sasConfirmed(other)) {
    promptVerify(other, { force: true });
    return;
  }
  const waiting = heldSend;
  heldSend = null;
  if (waiting.files?.length) sendFiles(waiting.connId, waiting.files);
}

function promptVerify(conn, { force = false, asked = false } = {}) {
  if (verifying || (!force && conn.verified) || !conn.sas) return;
  verifying = conn;
  ui.verifyWords.textContent = conn.sas;
  // Only a device that is not already remembered is about to be.
  ui.verifyPairs.hidden = !!conn.peer;
  // A dialog nobody opened needs to say where it came from.
  ui.verifyAsked.hidden = !asked;
  if (asked) setText(ui.verifyAsked, t('verify.asked', { name: conn.name }));
  setRail(ui.verify, conn);
  ui.verify.showModal();
}

async function resolveVerify(matched) {
  const conn = verifying;
  verifying = null;
  ui.verify.close();
  if (!conn) return;

  /*
   * Words that do not match mean the key this session agreed is not the key the other device
   * agreed, so something is in the middle. The conversation goes with it: a log from a session
   * that failed its own identity check is a log of talking to a stranger.
   *
   * The wipe frame is sent first, for what it is worth; if someone really is in the middle,
   * they receive it. Destroying our own copy is the part that depends on nobody else.
   */
  if (!matched) {
    // Whatever was waiting for *this* device is not going anywhere. Anything held for another
    // one is none of this answer's business and stays where it is.
    if (heldSend?.connId === conn.id) heldSend = null;
    else releaseHeldSend(conn);
    await destroyConversation(conn.id, { tell: true });
    toast(t('chat.wipedUnverified'), 'bad');
    dropConn(conn.id);
    return;
  }

  const root = await conn.session.derivePairRoot();
  const id = toHex(root).slice(0, 16);
  const record = {
    id,
    root: Array.from(root),
    name: conn.name,
    kind: conn.kind,
    verified: true,
    autoAccept: false,
    at: Date.now(),
  };
  await savePeer(record);

  /*
   * And ask the other device to do the same.
   *
   * Pairing is one root held twice: this side derives it from the session key and so can the
   * peer, but only if it is told to. Confirming alone left this device remembering one that
   * had never heard of it - a tile stuck on "offline" beside the very peer it stood for,
   * because a pairing the other end does not hold is a rendezvous nobody else attends.
   *
   * It is a request, not an instruction. The words still have to be read on that screen.
   */
  conn.session.send({ t: 'pair-ask' })?.catch?.(() => {});

  // Re-key the conn under its durable identity so the paired-device path adopts it.
  const oldId = conn.id;
  app.conns.delete(oldId);
  const tile = tiles.get(oldId);
  if (tile) {
    tiles.delete(oldId);
    tile.el.remove();
  }
  if (conn.member) {
    for (const c of app.alsoOn.get(oldId) || []) addAlso(id, c);
    addAlso(id, [...conn.channels][0]);
  }
  conn.id = id;
  conn.peer = record;
  conn.verified = true;
  conn.channels.add('paired');
  app.conns.set(id, conn);

  await refreshPaired();
  app.radar.burst();
  toast(t('toast.verified'), 'good');

  /*
   * And now, last, whatever was picked for this device before the question was asked.
   *
   * It has to be last. Run any earlier — it used to run sixteen lines up, right after the
   * pairing request — and `sendFiles` re-enters against a connection that is not yet marked
   * verified, meets the gate it has just satisfied, and puts the files back on hold. The same
   * question about the same device, and a send that silently never happens.
   *
   * The id moves with it. This function re-keys the connection under its pairing id, so a record
   * held against the old one would be looking for a connection that no longer answers to it.
   */
  if (heldSend?.connId === oldId) heldSend.connId = id;
  releaseHeldSend(conn);
}

/* ───────────────────────────────── text ──────────────────────────────── */

/*
 * The conversation.
 *
 * One peer at a time, because the sheet is modal and a conversation you cannot see is not one
 * you are having. `chatPeerId` is what everything else keys off: a message arriving for
 * somebody else must not land in the window that is open.
 */
let chatPeerId = null;

/**
 * Transfers that belong to a conversation rather than to the disk.
 *
 * Keyed by transfer id, which the engine mints randomly, and set when the offer arrives - not
 * when it is accepted - because the same answer is needed whether it was taken silently or
 * agreed to on the sheet.
 */
const chatTransfers = new Map();

/**
 * Object URLs for the pictures currently on screen, kept rather than remade.
 *
 * A conversation redraws in full on every message, and rebuilding these each time would mean
 * unsealing and decrypting every picture in the log to add one line of text - and a visible
 * flicker as each one reloaded. They are released together when the conversation is closed or
 * changes to a different peer, which is the only moment they stop being needed.
 */
const mediaUrls = new Map();

/**
 * Bumped whenever the conversation on screen changes.
 *
 * Reading a picture is asynchronous - a database round trip and a decrypt - and the window can
 * be closed or pointed at somebody else before it finishes. A paint that comes back holding a
 * stale token has nowhere to go and stops.
 */
let chatToken = 0;

function releaseMedia() {
  for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
  mediaUrls.clear();
}

/**
 * Drop handles for pictures the conversation no longer refers to.
 *
 * The cache exists so that redrawing does not mean decrypting every picture again. What it
 * must never do is outlive what it points at: a message that has aged out of the log, or a
 * conversation that has been deleted, would otherwise leave behind a handle perfectly happy
 * to keep displaying bytes this app has promised to have forgotten.
 *
 * Pruning against the messages actually being drawn costs one pass over a list and no
 * decryption at all - and, unlike hanging the cleanup on a sheet closing, it does not depend
 * on an event arriving to be correct.
 */
function pruneMedia(messages) {
  if (!mediaUrls.size) return;
  const live = new Set(messages.map((m) => m.att).filter(Boolean));
  for (const [att, url] of [...mediaUrls]) {
    if (live.has(att)) continue;
    URL.revokeObjectURL(url);
    mediaUrls.delete(att);
  }
}

/** The mark that suits a device: what it is, or how it is reached. */
function iconForConn(conn) {
  if (conn.usingRelay) return '#i-unplug';
  return conn.verified ? '#i-shield' : '#i-link';
}

/** A short, local time for a bubble. Dates are not shown: these are minutes-old things. */
function clockOf(at) {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** A message that is nothing but a link is one someone wants opened. */
function soleUrl(text) {
  const trimmed = String(text).trim();
  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

function bubbleTool(iconId, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bubble-tool';
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', iconId);
  svg.append(use);
  b.append(svg);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Draw the log.
 *
 * Rebuilt from the array every time rather than appended to incrementally. A conversation is
 * capped at a few hundred short strings, so the cost is nothing, and the alternative - keeping
 * the DOM and the stored log in step by hand across sending, receiving, clearing and
 * reopening - is exactly the kind of bookkeeping that ends up showing somebody a message
 * twice.
 */
function renderChat(messages, { locked = false, ephemeral = false } = {}) {
  // Whatever is about to be drawn is the whole truth about this conversation; anything the
  // cache is still holding that is not in it has no message left to belong to.
  pruneMedia(messages);
  ui.chatLog.replaceChildren();
  ui.chatEmpty.hidden = messages.length > 0 || locked;
  ui.chatLocked.hidden = !locked;
  // Nothing to delete, nothing to offer: a destructive button on an empty log is just alarming.
  ui.chatClear.hidden = messages.length === 0;
  // Say so when this one will not be kept, rather than letting someone assume it will.
  ui.chatEphemeral.hidden = !ephemeral;

  messages.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = `bubble ${m.dir}`;
    // Written, not yet gone. The mark is on the bubble rather than in a status line, because
    // it is a fact about this message and not about the conversation.
    if (m.pending) row.classList.add('waiting');

    const tools = document.createElement('div');
    tools.className = 'bubble-tools';

    if (m.kind === 'image') {
      row.classList.add('photo');
      row.append(photoFigure(m));
      // Saving is an action on the message, so it lives where the message's other actions
      // are rather than becoming a control drawn over the picture.
      tools.append(bubbleTool('#i-install', t('chat.save'), () => saveChatMedia(m)));
    } else if (m.kind === 'audio') {
      row.classList.add('audio');
      row.append(audioFigure(m));
      tools.append(bubbleTool('#i-install', t('chat.saveAudio'), () => saveChatMedia(m)));
    } else {
      // Peer text, always as a text node. Never innerHTML, on either side.
      row.textContent = m.text;
      tools.append(
        bubbleTool('#i-file', t('chat.copy'), async () => {
          try {
            await navigator.clipboard.writeText(m.text);
            toast(t('chat.copied'), 'good');
          } catch {
            toast(t('toast.copyFailed'), 'bad');
          }
        }),
      );
      const url = soleUrl(m.text);
      if (url) {
        tools.append(
          bubbleTool('#i-link', t('recv.open'), () => window.open(url, '_blank', 'noopener,noreferrer')),
        );
      }
    }
    row.append(tools);
    ui.chatLog.append(row);

    // One timestamp per run, under the last of it.
    const next = messages[i + 1];
    if (!next || next.dir !== m.dir || next.at - m.at > 120_000) {
      const time = document.createElement('div');
      time.className = `bubble-time ${m.dir}`;
      time.textContent = clockOf(m.at);
      ui.chatLog.append(time);
    }
  });

  // The rows are in the document now, so their tracks have a width to be fitted to.
  fitWaveforms();

  // Newest last, so the bottom is where the conversation is.
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

/**
 * The picture itself, drawn into the bubble.
 *
 * The element goes in immediately and the bytes arrive later, because they have to be fetched
 * and decrypted. The sizing lives in the stylesheet rather than here so a log full of pictures
 * does not reflow line by line as each one resolves.
 */
function photoFigure(m) {
  const wrap = document.createElement('span');
  wrap.className = 'photo-wrap';
  const label = [m.name, m.size ? fmtBytes(m.size) : ''].filter(Boolean).join(' \u00b7 ');
  if (label) wrap.title = label;

  const img = document.createElement('img');
  img.className = 'bubble-photo';
  // The file name is the only description there is; an empty alt is better than a wrong one.
  img.alt = m.name || '';
  img.decoding = 'async';

  /*
   * A picture this browser will not decode.
   *
   * The types a conversation accepts are the types a sender might have, not the ones every
   * receiver can draw - AVIF on an older iPhone is the everyday case. Left alone the img
   * falls back to the broken-image glyph with the file name spilling out beside it, which
   * reads as the app being broken rather than as this browser being old. The bytes are still
   * here and still savable; only the preview is missing, so that is what it says.
   */
  /*
   * One recovery attempt, then the honest note.
   *
   * `tried` is what keeps this from looping: the recovered preview is handed to the same
   * element, so if that fails to decode as well the handler runs a second time and must fall
   * through rather than start again.
   */
  let tried = false;
  img.addEventListener('error', async () => {
    if (!img.src) return; // nothing has been handed to it yet
    if (tried) return showUndrawable(wrap, img);
    tried = true;

    const token = chatToken;
    const recovered = await recoverPhoto(m);
    if (token !== chatToken) return; // closed, or now showing somebody else
    if (recovered) {
      img.src = recovered;
      return;
    }
    showUndrawable(wrap, img);
  });
  wrap.append(img);

  paintPhoto(wrap, img, m);
  return wrap;
}

/**
 * The bytes are here and this browser will not draw them.
 *
 * Said plainly rather than left as the broken-image glyph with the file name spilling out
 * beside it, which reads as the app being broken instead of this browser being old. Saving
 * still works: only the preview is missing.
 */
function showUndrawable(wrap, img) {
  if (!img.isConnected) return; // already replaced by a previous attempt
  img.remove();
  const note = document.createElement('span');
  note.className = 'photo-gone';
  note.textContent = t('chat.photoKind');
  wrap.append(note);
}

/**
 * A second try at a picture the browser refused, for the one format where that is worth it.
 *
 * Only HEIC, and only after the browser has already said no, so Safari never pays for this
 * and neither does anyone whose conversation holds no iPhone photos. The three megabytes of
 * decoder arrive at this point and nowhere earlier.
 *
 * The bytes are fetched again rather than held from the first attempt: a conversation full of
 * pictures would otherwise keep every one of them in memory against the chance that one
 * fails to decode, and failing is the rare case.
 *
 * @returns {Promise<string|null>} an object URL for the preview, or null
 */
async function recoverPhoto(m) {
  try {
    const heic = await import('./core/heic.js');
    if (!heic.looksHeic({ type: m.mime, name: m.name })) return null;

    const bytes = await chat.getAttachment(m.att).catch(() => null);
    if (!bytes?.length) return null;

    // Wider than the share thumbnail: this one is looked at rather than glanced at, and the
    // bubble can be most of a phone's width.
    const preview = await heic.heicPreview(new Blob([bytes], { type: m.mime || 'image/heic' }), {
      maxEdge: 1280,
    });
    if (!preview) return null;

    const url = URL.createObjectURL(preview);
    // Replace the cached original, so scrolling back does not decode it a second time and
    // so the one cleanup that revokes these revokes this too.
    const stale = mediaUrls.get(m.att);
    if (stale) URL.revokeObjectURL(stale);
    mediaUrls.set(m.att, url);
    return url;
  } catch {
    return null;
  }
}

async function paintPhoto(wrap, img, m) {
  const cached = mediaUrls.get(m.att);
  if (cached) {
    img.src = cached;
    return;
  }

  const token = chatToken;
  const bytes = await chat.getAttachment(m.att).catch(() => null);
  if (token !== chatToken) return; // closed, or now showing somebody else

  /*
   * A picture the log refers to and the storage no longer holds.
   *
   * It happens for one reason, a record sealed under a vault key this browser has since
   * lost, and saying so is better than an image that silently fails to load and looks
   * like a bug. The message stays in the conversation either way: something was sent, and
   * pretending otherwise would be editing history to hide a storage problem.
   */
  if (!bytes?.length) {
    img.remove();
    const gone = document.createElement('span');
    gone.className = 'photo-gone';
    gone.textContent = t('chat.photoGone');
    wrap.append(gone);
    return;
  }

  /*
   * Keep the view where it was, unless it was at the bottom.
   *
   * A picture has no height until it decodes, so the log grows underneath whatever is on
   * screen the moment it does. At the bottom - reading the newest thing - that should follow
   * the picture down. Anywhere else somebody is reading back through the conversation and
   * having it jump under them is the worst thing it could do.
   */
  const atBottom =
    ui.chatLog.scrollHeight - ui.chatLog.scrollTop - ui.chatLog.clientHeight < 40;
  img.addEventListener(
    'load',
    () => {
      if (atBottom) ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
    },
    { once: true },
  );

  const url = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'application/octet-stream' }));
  mediaUrls.set(m.att, url);
  img.src = url;
}

/**
 * A recording, drawn rather than handed to the browser's own transport.
 *
 * The native control is keyboard-operable, labelled, and comes with lock-screen controls for
 * free. It is not quiet: every engine draws it as a panel with its own background and
 * rounding, which inside a tinted bubble reads as a second surface bolted into the first.
 *
 * Replacing it means replacing what it did. The play control is a real button, the waveform is
 * a slider that answers to arrow keys and Home and End, and both carry names.
 */
function audioFigure(m) {
  const wrap = document.createElement('span');
  wrap.className = 'audio-wrap' + (m.voice ? ' voice' : '');

  // A song keeps a title line. A voice message has a generated file name that says nothing,
  // so it goes straight to the player and the row carries the length.
  if (!m.voice) {
    const head = document.createElement('span');
    head.className = 'audio-head';
    head.append(iconSvg('#i-note'));
    const name = document.createElement('span');
    name.className = 'audio-name';
    name.textContent = m.name || t('chat.audio');
    const size = document.createElement('span');
    size.className = 'audio-meta';
    size.textContent = m.size ? fmtBytes(m.size) : '';
    head.append(name, size);
    wrap.append(head);
  }

  const audio = document.createElement('audio');
  audio.preload = 'none';

  const row = document.createElement('span');
  row.className = 'audio-row';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'audio-play';
  play.setAttribute('aria-label', t('chat.play'));
  play.append(iconSvg('#i-play'));

  const track = document.createElement('span');
  track.className = 'audio-track';
  track.tabIndex = 0;
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', m.voice ? t('chat.voiceNote') : m.name || t('chat.audio'));
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', String(m.dur || 0));
  track.setAttribute('aria-valuenow', '0');

  /*
   * Bars where the shape is known, one flat line where it is not.
   *
   * A long track has no peaks stored, because measuring it would mean decoding the whole
   * thing, and forty-four identical bars would be a waveform that lies. A progress line shows
   * position without claiming to know the sound.
   */
  const bars = Array.isArray(m.peaks) && m.peaks.length ? m.peaks : null;
  if (bars) {
    /*
     * The same bars twice: one row faded, one full, the second clipped to how far playback
     * has got. Two rows of identical geometry line up exactly, and moving the boundary is
     * one custom property rather than a style write per bar per frame.
     */
    track.classList.add('wave');
    // Nothing has a width until it is in the document, so the shape is kept on the element
    // and drawn by `fitWaveforms` once the log has been laid out.
    track._peaks = bars;
  } else {
    track.classList.add('line');
    track.append(document.createElement('i'));
  }

  const time = document.createElement('span');
  time.className = 'audio-time';
  time.textContent = fmtClock(m.dur || 0);

  row.append(play, track, time);
  wrap.append(row);

  /*
   * Speed is a voice-message habit rather than a music one, but the space it takes is kept
   * either way.
   *
   * Two things were moving. Revealing the badge on play took its width from the bars, so the
   * shape someone was watching jumped sideways mid-sentence. A song, having no badge at all,
   * laid its waveform and clock out at different positions from the voice message above it,
   * so a column of audio messages was a column of almost-aligned rows.
   *
   * The slot is always there and only its contents differ: a song gets a span holding the
   * space, a recording gets a real button in it.
   */
  let rate = null;
  if (m.voice) {
    rate = document.createElement('button');
    rate.type = 'button';
    rate.className = 'audio-rate';
    rate.textContent = '1×';
    rate.setAttribute('aria-label', t('chat.speed'));
    row.append(rate);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'audio-rate spacer';
    spacer.setAttribute('aria-hidden', 'true');
    row.append(spacer);
  }

  wireAudio({ wrap, audio, play, track, time, rate, m });
  return wrap;
}

/** One row of waveform bars. `played` marks the copy that gets clipped over the top. */
function barRow(peaks, played = false) {
  const row = document.createElement('span');
  row.className = 'bars' + (played ? ' played' : '');
  for (const p of peaks) {
    const bar = document.createElement('i');
    // A silent stretch still needs to be visible as part of the shape.
    bar.style.height = `${Math.max(14, (p / 15) * 100)}%`;
    row.append(bar);
  }
  return row;
}

/** A bar and the space beside it, in pixels. What "as many as fit" is measured against. */
const BAR_PITCH = 5;

/** The stored shape at a lower resolution, keeping the loudest sample in each new slice. */
function resample(peaks, n) {
  if (n >= peaks.length) return peaks;
  const out = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    let max = 0;
    for (let j = from; j < to; j++) if (peaks[j] > max) max = peaks[j];
    out.push(max);
  }
  return out;
}

/**
 * Fit every waveform in the log. Cheap: one layout read and, usually, no rebuild.
 *
 * Called from more than one place on purpose. `renderChat` runs while the sheet may still be
 * closed, and a closed sheet has no width, so a track measured then is zero wide and gets no
 * bars. Opening it calls this again, and so does a resize.
 */
function fitWaveforms() {
  for (const track of ui.chatLog.querySelectorAll('.audio-track.wave')) {
    if (track._peaks) fitBars(track, track._peaks);
  }
}

/**
 * Draw as many bars as the track is actually wide enough for.
 *
 * A fixed count cannot work. Forty-four bars at their minimum width need about 175 pixels,
 * and the track is whatever the bubble has left after the button, the clock and the speed
 * badge, which is 128 on a phone. Flex items will not shrink below their minimum, so the row
 * overflowed its container and the tail of the waveform drew across the time.
 *
 * The count is measured rather than assumed, and the stored shape is resampled down to it.
 * The waveform still spans the whole recording, in fewer strokes.
 */
function fitBars(track, peaks) {
  const width = track.clientWidth;
  if (!width) return;
  const fit = Math.max(8, Math.min(peaks.length, Math.floor(width / BAR_PITCH)));
  if (track.dataset.bars === String(fit)) return;
  track.dataset.bars = String(fit);
  const shape = resample(peaks, fit);
  track.replaceChildren(barRow(shape), barRow(shape, true));
}

/** One `<use>` in one `<svg>`, which is four lines every time it is written out. */
function iconSvg(href) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', href);
  svg.append(use);
  return svg;
}

const RATES = [1, 1.5, 2];

function wireAudio({ wrap, audio, play, track, time, rate, m }) {
  let loaded = false;
  let seeking = false;

  /**
   * The length to scrub against.
   *
   * What was stored wins over what the element says. The stored number was measured by the
   * recorder with a clock; the element is reading a header a live recording never had, and
   * browsers disagree about what to report when it is missing. Some say `Infinity`, some a
   * large finite number, and the finite one passes an `isFinite` check and renders four
   * seconds as several million minutes.
   */
  const total = () => m.dur || chat.plausibleDuration(audio.duration);

  const paint = () => {
    const dur = total();
    const at = audio.currentTime || 0;
    const frac = dur ? Math.min(1, at / dur) : 0;
    track.style.setProperty('--played', `${frac * 100}%`);
    track.setAttribute('aria-valuemax', String(Math.round(dur)));
    track.setAttribute('aria-valuenow', String(Math.round(at)));
    track.setAttribute('aria-valuetext', fmtClock(at));
    // Counting up while it plays, and the full length at rest.
    time.textContent = fmtClock(audio.paused && !at ? dur : at);
  };

  /** Decrypt on demand. Nothing is read until somebody asks to hear it. */
  const ensure = async () => {
    if (loaded) return true;
    const cached = mediaUrls.get(m.att);
    if (cached) {
      audio.src = cached;
      loaded = true;
      return true;
    }
    const token = chatToken;
    const bytes = await chat.getAttachment(m.att).catch(() => null);
    if (token !== chatToken) return false;
    if (!bytes?.length) {
      // Same treatment as a picture the storage no longer holds.
      wrap.replaceChildren();
      const gone = document.createElement('span');
      gone.className = 'photo-gone';
      gone.textContent = t('chat.audioGone');
      wrap.append(gone);
      return false;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: m.mime || 'audio/mpeg' }));
    mediaUrls.set(m.att, url);
    audio.src = url;
    loaded = true;
    return true;
  };

  play.addEventListener('click', async () => {
    if (!audio.paused) return audio.pause();
    if (!(await ensure())) return;
    // One at a time. Two voice messages playing over each other is never what was meant.
    for (const other of document.querySelectorAll('#chat-log audio')) {
      if (other !== audio) other.pause();
    }
    audio.play().catch(() => toast(t('chat.audioKind'), 'bad'));
  });

  const setPlaying = (on) => {
    play.querySelector('use')?.setAttribute('href', on ? '#i-pause' : '#i-play');
    play.setAttribute('aria-label', t(on ? 'chat.pause' : 'chat.play'));
  };

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('pause', () => setPlaying(false));
  audio.addEventListener('ended', () => {
    // Back to the start, so the next press plays it again rather than doing nothing.
    audio.currentTime = 0;
    setPlaying(false);
    paint();
  });
  audio.addEventListener('timeupdate', () => !seeking && paint());
  audio.addEventListener('loadedmetadata', paint);
  audio.addEventListener('error', () => {
    // A container this browser will not decode. The bytes are still here and still savable.
    wrap.classList.add('undecodable');
    time.textContent = t('chat.audioKind');
  });

  /* ---- scrubbing, by pointer and by key ---- */

  const seekTo = (clientX) => {
    const box = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
    const dur = total();
    if (dur) audio.currentTime = frac * dur;
    paint();
  };

  track.addEventListener('pointerdown', async (e) => {
    if (!(await ensure())) return;
    seeking = true;
    track.setPointerCapture(e.pointerId);
    seekTo(e.clientX);
  });
  track.addEventListener('pointermove', (e) => seeking && seekTo(e.clientX));
  track.addEventListener('pointerup', (e) => {
    seeking = false;
    track.releasePointerCapture?.(e.pointerId);
  });
  track.addEventListener('pointercancel', () => {
    seeking = false;
  });

  track.addEventListener('keydown', async (e) => {
    const step = { ArrowLeft: -5, ArrowRight: 5, ArrowDown: -5, ArrowUp: 5 }[e.key];
    const jump = { Home: 0, End: total() }[e.key];
    if (step === undefined && jump === undefined) return;
    e.preventDefault();
    if (!(await ensure())) return;
    audio.currentTime =
      jump !== undefined ? jump : Math.max(0, Math.min(total(), (audio.currentTime || 0) + step));
    paint();
  });

  rate?.addEventListener('click', () => {
    const next = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length] ?? 1;
    audio.playbackRate = next;
    rate.textContent = `${next}×`;
  });

  paint();
  wrap.append(audio);
}


/** Seconds as m:ss, for something a few minutes long at most. */
function fmtClock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How long a piece of audio runs, asked of the decoder rather than parsed out of the file.
 *
 * Zero when it cannot be known, and the label simply omits it. Two ways that happens: a
 * container the browser will not decode, and a live-recorded WebM, whose header is written
 * before the length is known and reports `Infinity` forever. Our own recordings pass the
 * elapsed time in instead, which is the number this would have been.
 */
function audioDuration(bytes, mime) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mpeg' }));
    const probe = new Audio();
    const done = (value) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(chat.plausibleDuration(value));
    };
    const timer = setTimeout(() => done(0), 4000);
    probe.addEventListener('loadedmetadata', () => done(probe.duration), { once: true });
    probe.addEventListener('error', () => done(0), { once: true });
    probe.preload = 'metadata';
    probe.src = url;
  });
}

/**
 * The shape of a recording, measured once when the bytes arrive.
 *
 * Forty-four buckets, each the loudest sample in its slice, scaled so the loudest bucket is
 * full height. Peak rather than average on purpose: an average flattens speech into a low
 * even ridge, because most of a spoken sentence is quiet and the consonants that give it a
 * shape are brief.
 *
 * Returns null rather than throwing for everything that can go wrong here: a codec this
 * browser will not decode, a file too big to be worth decoding, or a device with no audio
 * context. The player then falls back to a plain progress line.
 */
async function audioPeaks(bytes, mime) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !bytes?.length || bytes.length > chat.PEAK_MAX_BYTES) return null;

  let ctx;
  try {
    ctx = new Ctx();
    // `decodeAudioData` takes ownership of the buffer it is given, and these bytes are on
    // their way to storage, so it gets a copy.
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const data = buf.getChannelData(0);
    const per = Math.max(1, Math.floor(data.length / chat.PEAK_BARS));

    const peaks = [];
    let loudest = 0;
    for (let i = 0; i < chat.PEAK_BARS; i++) {
      let max = 0;
      const from = i * per;
      for (let j = from; j < from + per && j < data.length; j++) {
        const v = Math.abs(data[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
      if (max > loudest) loudest = max;
    }
    if (!loudest) return null; // silence has no shape worth drawing
    return peaks.map((p) => Math.round((p / loudest) * 15));
  } catch {
    return null;
  } finally {
    ctx?.close?.().catch?.(() => {});
  }
}

/* ──────────────────────────── voice messages ─────────────────────────── */

/** The longest one recording will run before it stops itself. */
const MAX_RECORDING_MS = 5 * 60 * 1000;

/** Null unless a recording is running. */
let recorder = null;

/**
 * What this browser will record into, best first.
 *
 * Opus in WebM everywhere except Safari, which records AAC in MP4 and plays neither Ogg nor
 * WebM. Both ends run this app, so whatever comes out is a type the list in `chat.js`
 * accepts, but the receiving browser still has to decode it, and a Safari phone sent Opus
 * shows a player it cannot fill. This picks the format the device records most naturally and
 * leaves the player to say so if it cannot play it.
 */
function recordingType() {
  const wanted = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  for (const type of wanted) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
  }
  return '';
}

const canRecord = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

async function startRecording() {
  if (recorder || !chatPeerId) return;
  if (!canRecord()) return toast(t('chat.noMic'), 'bad');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    // A refusal is a decision, not a fault: say which it was and stop.
    return toast(t(err?.name === 'NotFoundError' ? 'chat.noMic' : 'chat.micBlocked'), 'bad');
  }

  const type = recordingType();
  const chunks = [];
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const startedAt = Date.now();

  recorder = { mr, stream, chunks, startedAt, cancelled: false, timer: 0, cap: 0 };

  mr.addEventListener('dataavailable', (e) => {
    if (e.data?.size) chunks.push(e.data);
  });
  mr.addEventListener('stop', () => finishRecording());

  mr.start();
  // The microphone stays live until every track is stopped, so the cap is a real one: a
  // forgotten recording must not keep the indicator lit indefinitely.
  recorder.cap = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
  recorder.timer = setInterval(paintRecording, 200);
  paintRecording();
}

/** Stop and send. The `stop` event does the work, so cancelling can use the same path. */
function stopRecording() {
  if (recorder?.mr.state === 'recording') recorder.mr.stop();
}

function cancelRecording() {
  if (!recorder) return;
  recorder.cancelled = true;
  stopRecording();
}

async function finishRecording() {
  const rec = recorder;
  if (!rec) return;
  recorder = null;

  clearInterval(rec.timer);
  clearTimeout(rec.cap);
  for (const track of rec.stream.getTracks()) track.stop();
  paintRecording();

  if (rec.cancelled) return;

  const seconds = (Date.now() - rec.startedAt) / 1000;
  const blob = new Blob(rec.chunks, { type: rec.mr.mimeType || 'audio/webm' });
  // A tap that never became a recording is a tap, not an empty message.
  if (!blob.size || seconds < 0.4) return;

  const stamp = new Date(rec.startedAt).toISOString().slice(0, 19).replaceAll(':', '-');
  const file = new File([blob], `voice-${stamp}.${extensionFor(blob.type)}`, { type: blob.type });
  await sendChatMedia(chatPeerId, file, { voice: true, dur: seconds });
}

/** A file name wants an extension, and the recorder only hands back a media type. */
function extensionFor(mime) {
  const t2 = String(mime || '').toLowerCase();
  if (t2.includes('mp4')) return 'm4a';
  if (t2.includes('ogg')) return 'ogg';
  if (t2.includes('mpeg')) return 'mp3';
  return 'webm';
}

/** The composer while a recording is running: elapsed time, and the two ways out of it. */
function paintRecording() {
  const on = !!recorder;
  ui.chatRec.hidden = !on;
  ui.chatComposer.classList.toggle('recording', on);
  ui.chatMic.setAttribute('aria-pressed', String(on));
  ui.chatMic.querySelector('use')?.setAttribute('href', on ? '#i-stop' : '#i-mic');
  if (on) ui.chatRecTime.textContent = fmtClock((Date.now() - recorder.startedAt) / 1000);
}

/** Hand one attachment back as an ordinary file, out of this app's storage and into theirs. */
async function saveChatMedia(m) {
  const bytes = await chat.getAttachment(m.att).catch(() => null);
  if (!bytes?.length) return toast(t(m.kind === 'audio' ? 'chat.audioGone' : 'chat.photoGone'), 'bad');

  const name = m.name || m.kind || 'file';
  const file = new File([bytes], name, { type: m.mime || 'application/octet-stream' });
  const result = { kind: 'memory', name, file };
  if (offerDownload(result) === 'needs-gesture') {
    await saveFile(result).catch(() => toast(t('toast.saveFailed'), 'bad'));
  }
}

/** Whether the composer can be used, and the line that explains it when it cannot. */
/*
 * The security line, from the live connection rather than from a snapshot.
 *
 * `usingRelay` is checked before `path` because they can disagree for a moment: the swap to
 * the relay sets the flag immediately and the new transport only reports its path once it is
 * open, and during that gap `path` still holds the dead direct route. The flag is the one that
 * is true now.
 */
function paintChatSecure() {
  const conn = app.conns.get(chatPeerId);
  ui.chatSecure.hidden = !conn || conn.state !== 'ready';
  if (ui.chatSecure.hidden) return;

  const relayed = conn.usingRelay || conn.path === 'relay';
  const key = relayed
    ? 'chat.sec.relay'
    : conn.path === 'local'
      ? 'chat.sec.local'
      : conn.path === 'direct'
        ? 'chat.sec.direct'
        : 'chat.sec.linking';
  ui.chatSecureText.textContent = t(key);

  const tip = t(relayed ? 'chat.sec.tipRelay' : 'chat.sec.tipDirect');
  ui.chatSecure.title = conn.sas ? `${tip} ${t('fact.sas')}: ${conn.sas}` : tip;

  // A paired device was verified when it was paired; anything else has to be checked once.
  const entry = currentEntry(chatPeerId);
  const unverified = !!conn.sas && !entry?.verified;
  ui.chatSecureWarn.hidden = !unverified;
  if (unverified) ui.chatSecureWarn.textContent = t('chat.sec.unverified');
}

function paintChatState() {
  const online = !!app.conns.get(chatPeerId);
  paintChatSecure();

  /*
   * Offline and gone are not the same state, and only one of them is worth waiting in.
   *
   * A paired device keeps its id, so its window can say the conversation carries on
   * when it returns. An unpaired one is addressed by an identity it re-rolls on every join,
   * so when its connection ends this window is pointed at nobody - permanently, however
   * quickly that same machine reappears on the radar. Telling someone to wait there means
   * telling them to wait for something that has already happened and did not help.
   */
  const durable = chat.isDurable(chatPeerId);
  ui.chatOffline.hidden = online || !durable;
  ui.chatGone.hidden = online || durable;
  // Two notes saying "pair them" one under the other is one note too many.
  if (!ui.chatGone.hidden) ui.chatEphemeral.hidden = true;

  /*
   * A paired device can be written to while it is away.
   *
   * The note under this composer said new messages go when the device is back while the
   * composer was disabled, so nothing kept that promise. What is typed is now stored against
   * the conversation and sent the moment the device is reachable. Paired devices only: an
   * unpaired device is addressed by an identity it throws away when it leaves, so a queued
   * message has nobody to reach.
   *
   * Attachments and recordings still need the device present: those are a transfer rather than
   * a line of text, and holding one open across an absence of unknown length is a different
   * piece of work.
   */
  ui.chatInput.disabled = !online && !durable;
  ui.chatAttach.disabled = !online;
  ui.chatMic.disabled = !online;
  // Going offline mid-sentence is one thing; going offline mid-recording would otherwise
  // leave the microphone live with nowhere to send what it captures.
  if (!online && recorder) cancelRecording();
  ui.chatSend.disabled = (!online && !durable) || !ui.chatInput.value.trim();
}

async function openChat(peerId) {
  const entry = currentEntry(peerId);
  if (!entry) return;
  chatPeerId = peerId;
  ui.chatWho.textContent = entry.name;
  ui.chatInput.value = '';
  ui.chatInput.style.height = '';

  const conn = app.conns.get(peerId);
  if (conn) setRail(ui.chatDialog, conn);

  chatToken++;

  const { messages, locked, ephemeral } = await chat.load(peerId);
  renderChat(messages, { locked, ephemeral });
  paintChatState();

  ui.chatDialog.showModal();
  // The log was built while the sheet was still closed, so nothing in it had a width to be
  // measured against. It does now.
  fitWaveforms();
  if (!ui.chatInput.disabled) setTimeout(() => ui.chatInput.focus(), 60);
}

async function sendChat() {
  const conn = app.conns.get(chatPeerId);
  const body = ui.chatInput.value.trim();
  if (!body) return;

  /*
   * Nowhere to send it right now, and somewhere to send it later.
   *
   * Stored against the conversation and marked as waiting. It shows in the log immediately,
   * because it has been written and the person should see it where they wrote it, and the
   * mark is what says it has not left yet.
   */
  if (!conn) {
    if (!chat.isDurable(chatPeerId)) return;
    ui.chatInput.value = '';
    ui.chatInput.style.height = '';
    const held = await chat.append(chatPeerId, { dir: 'out', text: body, pending: true });
    renderChat(held.messages, { locked: held.locked, ephemeral: held.ephemeral });
    paintChatState();
    return;
  }

  ui.chatInput.value = '';
  ui.chatInput.style.height = '';
  paintChatState();

  try {
    await conn.transfers.sendText(body);
  } catch {
    toast(t('toast.sendFailed'), 'bad');
    // Put it back rather than losing what was typed.
    ui.chatInput.value = body;
    paintChatState();
    return;
  }

  const { messages, locked, ephemeral } = await chat.append(chatPeerId, { dir: 'out', text: body });
  renderChat(messages, { locked, ephemeral });
}

/**
 * Send whatever was written while this device was away.
 *
 * In order, and one at a time, so the conversation arrives in the order it was written. A
 * message that will not go stays marked and the rest are left for next time. A half-sent
 * flush that cleared its flags anyway would lose a message without delivering it.
 */
async function flushOutbox(conn) {
  const waiting = await chat.pendingFor(conn.id).catch(() => []);
  if (!waiting.length) return;

  /*
   * Not on the instant the transport opens.
   *
   * This side calls a transport open as soon as its own channel is usable, which is not when
   * the other side has attached a receiver to theirs. A frame sent into that gap is carried
   * and dropped silently, because a control frame has no acknowledgement to miss. Measured:
   * the first of two queued messages never arrived, while the second, a few hundred
   * milliseconds behind it, always did.
   */
  await new Promise((r) => setTimeout(r, FLUSH_SETTLE_MS));
  if (conn.closed || conn.state !== 'ready') return;

  const sent = [];
  for (const m of waiting) {
    if (conn.closed || !m.text) break;
    try {
      await conn.transfers.sendText(m.text);
      sent.push(m.id);
    } catch {
      break;
    }
  }
  if (!sent.length) return;

  await chat.markSent(conn.id, sent);
  if (ui.chatDialog.open && chatPeerId === conn.id) {
    const { messages, locked, ephemeral } = await chat.load(conn.id);
    renderChat(messages, { locked, ephemeral });
  }
  toast(sent.length === 1 ? t('toast.outbox.one') : t('toast.outbox.many', { n: sent.length }), 'good');
}

/**
 * Remember that a device still owes us an erase.
 *
 * Kept on the peer's own record, which already exists and already names them, so this adds a
 * flag to a row that was on disk anyway rather than starting a new list of who has been
 * talked to.
 *
 * There is nothing to remember for a device that was never paired: its conversation was never
 * written down on either side, and the identity it was held under is re-rolled the moment it
 * leaves, so there is nobody to go back to.
 */
async function markWipePending(id) {
  const rec = app.paired.find((p) => p.id === id);
  if (!rec || rec.wipePending) return false;
  rec.wipePending = Date.now();
  await savePeer(rec);
  app.paired = await allPeers();
  return true;
}

async function clearWipePending(id) {
  const rec = app.paired.find((p) => p.id === id);
  if (!rec?.wipePending) return;
  delete rec.wipePending;
  await savePeer(rec);
  app.paired = await allPeers();
  render();
}

/**
 * Send any erase this device still owes, and keep owing it until it is confirmed.
 *
 * Called every time a paired device connects. The frame is cheap, the far side treats it as
 * idempotent, and re-sending one that already landed costs a round trip, which is cheaper
 * than deciding it arrived because the socket accepted it.
 */
async function flushWipePending(conn) {
  const rec = app.paired.find((p) => p.id === conn.id);
  if (!rec?.wipePending) return;
  try {
    await conn.transfers.sendWipe();
  } catch {
    /* it will be tried again on the next connection */
  }
}

/**
 * Destroy a conversation, and optionally ask the other device to destroy its copy too.
 *
 * The frame goes out first, while the transport is still up, because the callers that want it
 * sent are the ones about to tear the connection down. The local delete then runs regardless:
 * a device that is off cannot be made to forget anything now, and refusing to delete our own
 * copy over that would leave the one machine we control holding the conversation.
 */
async function destroyConversation(id, { tell = false, owe = true } = {}) {
  /*
   * Whether the other device was actually told, which is not the same as having tried.
   *
   * Reported back so the interface can say which of the two happened instead of claiming the
   * stronger one every time. A frame handed to an open channel is as close to delivered as
   * this side can know; no connection at all is a different outcome, and saying a conversation
   * is gone from both devices when one was asleep would be false reassurance.
   */
  let told = false;
  const conn = app.conns.get(id);
  if (tell && conn?.transfers) {
    try {
      await conn.transfers.sendWipe();
      told = true;
    } catch {
      /* not reachable: our own copy still goes */
    }
  }

  /*
   * An erase that could not be delivered is owed, not abandoned.
   *
   * The other device is asleep, out of range, or its tab is closed. Their copy is still
   * there, and wanting it gone has not changed because they were not listening.
   *
   * There is no server to leave the instruction with, so it stays here and goes out every
   * time that device connects until it says it has done it. `told` above only means the
   * socket accepted the frame, so the flag is kept even then; the acknowledgement clears it.
   *
   * Not when there will be nothing left to deliver it with. Unpairing deletes the pairing
   * root, which is the only way to reach that device again, so an erase noted as owed at the
   * same moment can never be sent. Noting it also writes the record back: `forgetDevice`
   * deleted the row, this saved it again, and the device stayed paired after being told it
   * had been forgotten.
   */
  if (tell && owe) await markWipePending(id);

  await chat.clear(id);

  /*
   * And out of the document, not just off the screen.
   *
   * The redraw used to be conditional on the sheet being open, which looked reasonable - there
   * is nothing to repaint if nobody is looking - and left the messages sitting in the closed
   * dialog's DOM afterwards. Storage was empty and the text was still in the page, readable by
   * anything that can reach it and ready to flash up if that dialog were ever shown without
   * going through the loader. A conversation that has been destroyed should not still be
   * somewhere, and a closed dialog is somewhere.
   */
  if (chatPeerId === id) {
    /*
     * Measured now, drawn after. The order is the whole point.
     *
     * `captureDust` reads the geometry and the colours while the bubbles are still in the
     * document and hands back a function that starts the animation. `renderChat([])` then
     * takes them out for real, and only then does anything draw. What the person watches is
     * coloured dust on a canvas, which holds no text and no picture: the messages are gone
     * from the page before the first frame, exactly as they were before there was an
     * animation here at all.
     */
    const dust = captureDust(ui.chatLog.closest('.chat-sheet'), ui.chatLog.children);
    releaseMedia();
    renderChat([]);
    paintChatState();
    dust();
  }

  return told;
}

/**
 * Send one picture into the conversation.
 *
 * It travels exactly as any other file does - the same per-transfer key, the same sealed
 * frames, the same integrity check at the far end - and the only difference is a flag on the
 * manifest saying where it is meant to end up. Nothing about it is uploaded: there is no
 * server in this path at all, and on the rare occasion the relay is carrying the connection it
 * is carrying the same ciphertext it carries for everything else.
 */
async function sendChatMedia(peerId, file, { voice = false, dur = 0 } = {}) {
  const conn = app.conns.get(peerId);
  if (!conn || !file) return;

  /*
   * Something a conversation should not be holding still gets sent.
   *
   * A file that is too large, or not a type the log can show or play, goes the ordinary way -
   * offered, accepted, saved - rather than being refused. The person asked for it to reach
   * the other device, and it does; it simply arrives as a file rather than inline, and they
   * are told which.
   */
  const kind = chat.mediaKind(file.type, file.size);
  if (!kind) {
    toast(t(file.size > chat.mediaLimit(file.type) ? 'chat.tooBig' : 'chat.wrongKind'));
    return sendFiles(peerId, [file]);
  }

  /*
   * Our own copy is kept here rather than read back from the other device.
   *
   * The sender has the bytes already; asking for them back would double the transfer to show
   * something that is sitting in memory. It is sealed with the same vault key the conversation
   * is, so this side stores it exactly as carefully as the receiving side does.
   */
  const bytes = new Uint8Array(await file.arrayBuffer());

  /*
   * The length is measured here, before the offer, because it travels on it.
   *
   * A recording already knows how long it ran, because it was timed against a clock. Only a
   * chosen file has to be asked, and it is asked once, on the side that has the bytes.
   */
  const known = kind === 'audio' ? dur || (await audioDuration(bytes, file.type)) : 0;

  try {
    await conn.transfers.offer([file], { chat: true, voice, dur: known });
  } catch (err) {
    return toast(t(err?.name === 'BusyError' ? 'chat.photoBusy' : 'toast.sendFailed'), 'bad');
  }

  const att = await chat.putAttachment(peerId, bytes);
  const { messages, locked, ephemeral } = await chat.append(peerId, {
    dir: 'out',
    media: {
      kind,
      att,
      name: safeFileName(file.name),
      mime: file.type,
      size: file.size,
      dur: known,
      peaks: kind === 'audio' ? await audioPeaks(bytes, file.type) : null,
      voice,
    },
  });
  if (ui.chatDialog.open && chatPeerId === peerId) renderChat(messages, { locked, ephemeral });
}

/**
 * Keep an attachment that has finished arriving, and put it in the conversation.
 *
 * The transfer streamed it into origin-private storage, which is scratch space and is not
 * encrypted. This reads it back, seals it under the vault key, and removes the staging copy -
 * so what remains on this disk is ciphertext, and it lives exactly as long as the conversation
 * that refers to it.
 *
 * Returns false rather than throwing if any of that cannot be done, and the caller then treats
 * it as the ordinary file it also is: better to hand someone a download they did not expect
 * than to lose what they were sent.
 */
async function keepChatMedia(conn, result, entry, { voice = false, dur = 0 } = {}) {
  try {
    const blob = result?.file;
    // Only the shapes that carry their bytes; a save-dialog sink wrote straight to a place of
    // the person's choosing and is already where they wanted it.
    const kind = blob ? chat.mediaKind(entry.mime, blob.size) : '';
    if (!kind) return false;

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const att = await chat.putAttachment(conn.id, bytes);
    if (!att) return false;
    await result.cleanup?.();

    const { messages, locked, ephemeral } = await chat.append(conn.id, {
      dir: 'in',
      media: {
        kind,
        att,
        name: safeFileName(entry.name),
        mime: entry.mime,
        size: blob.size,
        // The sender timed it. Only fall back to asking this browser, which for a
        // live-recorded container is guesswork.
        dur: dur || (kind === 'audio' ? await audioDuration(bytes, entry.mime) : 0),
        peaks: kind === 'audio' ? await audioPeaks(bytes, entry.mime) : null,
        voice,
      },
    });

    app.radar.burst();
    blip();
    notify(conn.name, t(kind === 'audio' ? 'chat.audio' : 'chat.photo'));

    if (ui.chatDialog.open && chatPeerId === conn.id) renderChat(messages, { locked, ephemeral });
    else if (!ui.chatDialog.open) await openChat(conn.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * A message arrived.
 *
 * It is written to that peer's log whether or not their window is open - the storage is the
 * record, the window is only a view of it. If the window happens to be open on that same
 * peer, it is redrawn; otherwise the conversation is brought up, which is what the old
 * one-shot dialog did and is still the right answer for something that just arrived.
 */
async function onChatText(conn, text) {
  const { messages, locked, ephemeral } = await chat.append(conn.id, { dir: 'in', text });

  if (ui.chatDialog.open && chatPeerId === conn.id) {
    renderChat(messages, { locked, ephemeral });
    return;
  }
  if (ui.chatDialog.open) return; // mid-conversation with someone else; do not yank the view
  await openChat(conn.id);
}

/* ──────────────────────── paired devices dialog ──────────────────────── */

function paintDevicesDialog() {
  /*
   * Two lists, because they are two different things.
   *
   * What the app does and which devices it remembers were rendered into one container and so
   * could not be labelled separately, which put a "Paired devices" heading above "Ask where
   * to save". Settings come first, since they apply whether or not anything is paired.
   */
  ui.deviceRows.replaceChildren();
  ui.pairedRows.replaceChildren();
  ui.devicesEmpty.hidden = app.paired.length > 0;

  for (const peer of app.paired) {
    const row = document.createElement('div');
    row.className = 'device-row';

    const who = document.createElement('div');
    who.className = 'who';
    const b = document.createElement('b');
    b.textContent = peer.name || 'Device'; // peer-supplied
    const sub = document.createElement('span');
    const conn = app.conns.get(peer.id);
    /*
     * An erase still owed outranks everything else this line could say.
     *
     * It is the one state here that is going to change the moment that device appears, and
     * somebody who asked for a conversation to be destroyed should be able to see that it has
     * not happened yet rather than having to take it on trust.
     */
    sub.textContent = peer.wipePending
      ? t('devices.wipeWaiting')
      : peer.paused
        ? t('st.disconnectedByYou')
        : conn?.state === 'ready'
          ? t('st.connected')
          : `${t('st.offline')} · ${new Date(peer.at || Date.now()).toLocaleDateString()}`;
    if (peer.wipePending) sub.classList.add('owed');
    who.append(b, sub);

    const tools = document.createElement('div');
    tools.className = 'row-tools';

    const label = document.createElement('span');
    label.className = 'small muted';
    label.textContent = t('devices.autoAccept');

    const sw = document.createElement('button');
    sw.className = 'switch';
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', `${t('devices.autoAccept')} — ${peer.name || 'Device'}`);
    sw.setAttribute('aria-checked', String(!!peer.autoAccept));
    sw.addEventListener('click', async () => {
      peer.autoAccept = !peer.autoAccept;
      sw.setAttribute('aria-checked', String(!!peer.autoAccept));
      await savePeer(peer);
      app.paired = await allPeers();
    });

    const unpair = document.createElement('button');
    unpair.className = 'icon-btn';
    unpair.type = 'button';
    unpair.title = t('devices.unpair');
    unpair.setAttribute('aria-label', `${t('devices.unpair')} — ${peer.name || 'Device'}`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-trash');
    svg.append(use);
    unpair.append(svg);
    unpair.addEventListener('click', () => forgetDevice(peer.id));

    tools.append(label, sw, unpair);
    row.append(who, tools);
    ui.pairedRows.append(row);
  }

  ui.deviceRows.append(directRow());
  ui.deviceRows.append(saveToRow());
  ui.deviceRows.append(prefRow('devices.sound', 'devices.soundSub', 'sound'));
  ui.deviceRows.append(prefRow('devices.notify', 'devices.notifySub', 'notify', onNotifyToggle));
  ui.deviceRows.append(prefRow('devices.awake', 'devices.awakeSub', 'awake'));
  ui.deviceRows.append(relayRow());
  ui.deviceRows.append(eraseRow());
}

/**
 * Erase everything on this device.
 *
 * A button rather than a switch, because everything else in this sheet can be changed back.
 * It asks once and names what goes instead of "are you sure", and there is no word to type.
 */
function eraseRow() {
  const row = document.createElement('div');
  row.className = 'device-row danger-row';

  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  setText(b, t('devices.erase'));
  const sub = document.createElement('span');
  setText(sub, t('devices.eraseSub'));
  who.append(b, sub);

  const tools = document.createElement('div');
  tools.className = 'row-tools';
  const btn = document.createElement('button');
  btn.className = 'danger-btn';
  btn.type = 'button';
  btn.id = 'btn-erase-all';
  setText(btn, t('devices.eraseGo'));
  btn.addEventListener('click', eraseEverything);
  tools.append(btn);

  row.append(who, tools);
  return row;
}

async function eraseEverything() {
  if (!confirm(t('devices.eraseAsk'))) return;

  /*
   * Stop everything that could write before anything is deleted.
   *
   * A live transfer holds an open file in origin-private storage, and a conversation that is
   * still receiving would happily write a message back into a database this is in the middle
   * of destroying. Tearing the connections down first means nothing is racing the erase.
   */
  for (const id of [...app.conns.keys()]) dropConn(id, { silent: true });
  for (const [key, sub] of app.pairSubs) {
    try {
      sub.session.destroy();
    } catch {
      /* already gone */
    }
    app.pairSubs.delete(key);
  }
  try {
    app.signal?.close?.();
  } catch {
    /* ignore */
  }
  releaseMedia();
  chatTransfers.clear();

  const done = await wipeStorage();

  /*
   * Reload rather than trying to carry on.
   *
   * Every module here is holding state that came from what was just destroyed - the device
   * key, the vault handle, the peer list - and rebuilding all of that in place is a much
   * larger surface for a mistake than starting again. `location.replace` also drops this page
   * out of session history, so Back cannot return to a view of the data.
   */
  if (Object.values(done).every(Boolean)) {
    location.replace(location.pathname);
    return;
  }

  // Something refused. Say which rather than reloading into a clean-looking app that is not.
  const left = Object.entries(done)
    .filter(([, ok]) => !ok)
    .map(([k]) => t(`erase.part.${k}`))
    .join(', ');
  toast(t('devices.erasePartial', { left }), 'bad', { hold: 20_000 });
}

/**
 * Direct connections: the fast path, on which the other device learns your public address,
 * since that is what a direct connection is. Local addresses stay hidden behind one-time
 * `.local` names, because this page never requests camera or microphone.
 *
 * Off routes everything through the relay: slower, spends someone's bandwidth, and the other
 * end learns nothing about where you are.
 */
function directRow() {
  const row = document.createElement('div');
  row.className = 'device-row';

  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  setText(b, t('devices.direct'));
  const sub = document.createElement('span');
  setText(sub, t('devices.directSub'));
  who.append(b, sub);

  const tools = document.createElement('div');
  tools.className = 'row-tools';
  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('devices.direct'));
  sw.setAttribute('aria-checked', String(app.prefs.direct === true));
  sw.addEventListener('click', async () => {
    app.prefs.direct = app.prefs.direct !== true;
    sw.setAttribute('aria-checked', String(app.prefs.direct === true));
    await savePrefs();
    toast(t(app.prefs.direct === true ? 'devices.directOn' : 'devices.directOff'));
  });
  tools.append(sw);
  row.append(who, tools);
  return row;
}

/**
 * Where received files land.
 *
 * Off means the app never asks the browser for a filesystem handle: the bytes go into
 * origin-private storage and come back out as an ordinary download. On means the save dialog,
 * which streams into the one file the person picks. Sending is unaffected either way, because
 * it only reads what was handed to the file input.
 */
function saveToRow() {
  const row = document.createElement('div');
  row.className = 'device-row';

  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  setText(b, t('devices.saveTo'));
  const sub = document.createElement('span');
  setText(sub, t(sinkCapabilities().fsa ? 'devices.saveToSub' : 'devices.saveToUnavailable'));
  who.append(b, sub);

  const tools = document.createElement('div');
  tools.className = 'row-tools';
  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t('devices.saveTo'));
  sw.setAttribute('aria-checked', String(app.prefs.saveTo === 'ask'));
  sw.disabled = !sinkCapabilities().fsa;
  sw.addEventListener('click', async () => {
    if (!sinkCapabilities().fsa) return;
    app.prefs.saveTo = app.prefs.saveTo === 'ask' ? 'sandbox' : 'ask';
    sw.setAttribute('aria-checked', String(app.prefs.saveTo === 'ask'));
    await savePrefs();
  });
  tools.append(sw);
  row.append(who, tools);
  return row;
}

/**
 * Which relay this browser is using, and a way back to the default.
 *
 * Worth showing even when it is the ordinary one: the relay is the only third party in the
 * design, and a setting that can be changed by a link should never be invisible.
 */
function relayRow() {
  const row = document.createElement('div');
  row.className = 'device-row';

  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  setText(b, t('devices.relay'));
  const sub = document.createElement('span');
  const current = defaultUrl();
  const isDefault = current === originRelay();
  sub.textContent = hostOf(current) + (isDefault ? ` · ${t('devices.relayDefault')}` : '');
  who.append(b, sub);

  const tools = document.createElement('div');
  tools.className = 'row-tools';
  if (!isDefault) {
    const reset = document.createElement('button');
    reset.className = 'ghost-btn';
    reset.type = 'button';
    setText(reset, t('devices.relayReset'));
    reset.addEventListener('click', () => {
      rememberRelay(null);
      toast(t('toast.relayOwn'), 'good');
      setTimeout(() => location.reload(), 700);
    });
    tools.append(reset);
  }

  row.append(who, tools);
  return row;
}

function prefRow(titleKey, subKey, prefKey, before) {
  const row = document.createElement('div');
  row.className = 'device-row';
  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  setText(b, t(titleKey));
  const sub = document.createElement('span');
  setText(sub, t(subKey));
  who.append(b, sub);

  const tools = document.createElement('div');
  tools.className = 'row-tools';
  const sw = document.createElement('button');
  sw.className = 'switch';
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', t(titleKey));
  sw.setAttribute('aria-checked', String(!!app.prefs[prefKey]));
  sw.addEventListener('click', async () => {
    const next = !app.prefs[prefKey];
    if (next && before) {
      const ok = await before();
      if (!ok) return;
    }
    app.prefs[prefKey] = next;
    sw.setAttribute('aria-checked', String(next));
    await savePrefs();
    if (prefKey === 'awake' && !next) releaseWake();
  });
  tools.append(sw);
  row.append(who, tools);
  return row;
}

/**
 * Permission is only requested from a click on this switch, never on load and never as a
 * side effect of receiving something.
 */
async function onNotifyToggle() {
  if (!('Notification' in window)) {
    toast(t('toast.noNotifications'), 'bad');
    return false;
  }
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') {
    toast(t('toast.notifyBlocked'), 'bad');
    return false;
  }
  const res = await Notification.requestPermission();
  if (res !== 'granted') {
    toast(t('toast.notifyOff'));
    return false;
  }
  return true;
}

/* ──────────────────────────────── language ───────────────────────────── */

function buildLangList() {
  ui.langList.replaceChildren();
  for (const l of LOCALES) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = 'lang-row';
    b.type = 'button';
    b.lang = l.code;
    b.setAttribute('aria-current', String(l.code === currentLocale()));

    const native = document.createElement('span');
    native.textContent = l.native;
    const en = document.createElement('span');
    en.className = 'en';
    en.textContent = l.coverage >= 100 ? l.english : `${l.english} · ${l.coverage}%`;
    b.append(native, en);

    b.addEventListener('click', async () => {
      setLocale(l.code);
      app.prefs.lang = l.code;
      try {
        localStorage.setItem('lang', l.code);
      } catch {
        /* private mode */
      }
      buildLangList();
      relabel();
      ui.lang.close();
    });

    li.append(b);
    ui.langList.append(li);
  }
}

/** Re-render everything that is built in script rather than declared in the document. */
function relabel() {
  render();
  paintLinkState();
  paintRoom();
  paintDiscovery();
  if (ui.devices.open || ui.paired.open) paintDevicesDialog();
  ui.hostBtn.textContent = app.hostCode ? t('connect.newCode') : t('connect.generate');
  if (app.staged) {
    ui.shareSub.textContent = `${fmtBytes(app.staged.total)} · ${t('share.pick')}`;
  }
}

/* ──────────────────────────────── binding ───────────────────────────── */

let deferredInstall = null;
/** Bound in bindUi; the discovery dialog and the room dialog copy the same link. */
let copyRoomLink = () => {};
let copyPublicLink = () => {};

function bindUi() {
  // Every sheet can be swiped away on a touch device. The exception is the safety-word
  // check: that one has to be answered, not dismissed, which is also why it refuses the
  // Escape key.
  for (const dlg of document.querySelectorAll('dialog:not([data-no-swipe])')) {
    enableSwipeToDismiss(dlg);
  }

  /*
   * Focus the panel, not the first button in it.
   *
   * `showModal()` focuses the first focusable descendant, which is the close button in the
   * corner - and Chrome counts that as `:focus-visible`, so the rule that brings a focused
   * close button back for keyboard users fired on every single open and the button was never
   * once hidden on a phone. It also meant a screen reader opened every sheet by announcing
   * "Close" instead of what the sheet is.
   *
   * A panel with `tabindex="-1"` takes the focus instead: reachable by script, skipped by Tab,
   * and the first thing read out is the heading.
   */
  for (const body of document.querySelectorAll('dialog .sheet-body, dialog .about-body')) {
    body.tabIndex = -1;
    body.setAttribute('autofocus', '');
  }
  watchModals();

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.closest('dialog')?.close();
    });
  }

  const openConnect = () => {
    ui.connect.showModal();
    if (!app.hostCode) startHost().catch(() => toast(t('toast.codeFailed'), 'bad'));
    setTimeout(() => ui.codeInputs.firstElementChild?.focus(), 80);
  };
  ui.addBtnEmpty.addEventListener('click', openConnect);
  ui.addBtn.addEventListener('click', openConnect);
  ui.roomBtn.addEventListener('click', () => {
    paintRoom();
    ui.room.showModal();
  });
  ui.hostBtn.addEventListener('click', () => startHost().catch(() => {}));

  ui.roomBtnEmpty.addEventListener('click', () => ui.room.showModal());
  const openDiscovery = () => {
    paintDiscovery();
    ui.network.showModal();
  };
  ui.netBtnEmpty.addEventListener('click', openDiscovery);
  ui.chipDiscovery.addEventListener('click', openDiscovery);

  ui.discChoices.addEventListener('click', (e) => {
    const choice = e.target.closest('.choice');
    if (choice) setDiscovery(choice.dataset.mode);
  });

  ui.publicCopy.addEventListener('click', copyPublicLink);
  ui.publicQrFrame.addEventListener('click', copyPublicLink);
  ui.publicNew.addEventListener('click', () => setDiscovery('public', { code: newRoomCode() }));
  /* The list moved to its own sheet; this used to open Settings, where it no longer is. */
  ui.chipPaired.addEventListener('click', () => {
    paintDevicesDialog();
    ui.paired.showModal();
  });


  ui.devicesBtn.addEventListener('click', () => {
    paintDevicesDialog();
    ui.devices.showModal();
  });
  ui.pairedBtn.addEventListener('click', () => {
    paintDevicesDialog();
    ui.paired.showModal();
  });
  ui.langBtn.addEventListener('click', () => ui.lang.showModal());
  /*
   * The About page opens out of the button you pressed.
   *
   * A circle grows from the centre of the control until it covers the screen. It is worth
   * having for a reason beyond looking good: a full-screen takeover that simply fades in
   * leaves no trace of where it came
   * from, and the way back is a small × in a corner you then have to find. Growing it out of
   * the button says where the page came from and, when it closes the same way, where it went.
   *
   * The radius has to reach the furthest corner from that origin, or the circle stops growing
   * with the far edge of the screen still uncovered.
   */
  ui.aboutBtn.addEventListener('click', () => {
    const r = ui.aboutBtn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const reach = Math.max(
      Math.hypot(x, y),
      Math.hypot(innerWidth - x, y),
      Math.hypot(x, innerHeight - y),
      Math.hypot(innerWidth - x, innerHeight - y),
    );
    ui.about.style.setProperty('--from-x', `${Math.round(x)}px`);
    ui.about.style.setProperty('--from-y', `${Math.round(y)}px`);
    ui.about.style.setProperty('--reveal-r', `${Math.ceil(reach)}px`);
    ui.about.showModal();
  });

  const copyPairLink = async () => {
    if (!app.hostCode) return;
    try {
      await navigator.clipboard.writeText(pairUrl(app.hostCode));
      toast(t('toast.pairLinkCopied'), 'good');
    } catch {
      toast(t('toast.copyFailed'), 'bad');
    }
  };
  ui.copyLink.addEventListener('click', copyPairLink);
  ui.qrFrame.addEventListener('click', copyPairLink);

  ui.roomCreate.addEventListener('click', () => openRoom());
  ui.roomLeave.addEventListener('click', () => leaveRoom());
  copyRoomLink = async () => {
    if (!app.roomCode) return;
    try {
      await navigator.clipboard.writeText(roomUrl(app.roomCode));
      toast(t('toast.roomLinkCopied'), 'good');
    } catch {
      toast(t('toast.copyFailed'), 'bad');
    }
  };
  ui.roomCopy.addEventListener('click', copyRoomLink);
  ui.roomQrFrame.addEventListener('click', copyRoomLink);
  copyPublicLink = copyRoomLink;



  bindCodeBoxes(ui.codeInputs, CODE_LEN, joinWithCode);

  ui.connectInviteNo.addEventListener('click', () => {
    closeCodeInvite();
    ui.connect.close();
  });
  ui.connectInviteYes.addEventListener('click', () => {
    const code = pendingCodeInvite;
    closeCodeInvite();
    if (code) joinWithCode(code);
  });
  bindCodeBoxes(ui.roomInputs, ROOM_CODE_LEN, (code) => {
    joinRoom(code);
    ui.room.close();
  });

  ui.sasOk.addEventListener('click', () => resolveVerify(true));
  ui.sasBad.addEventListener('click', () => resolveVerify(false));
  ui.verify.addEventListener('cancel', (e) => {
    e.preventDefault(); // a verification must be answered, not dismissed
  });

  ui.chatComposer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });

  /*
   * Enter sends; Shift+Enter starts a line.
   *
   * Which way round this goes is the one thing every chat has an opinion about, and the
   * majority answer is also the right one here: these are short messages and reaching for a
   * modifier to send every one of them is the wrong tax. A newline is the rarer intent, so it
   * is the one that takes the modifier.
   */
  ui.chatInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    sendChat();
  });

  // The field grows with what is in it, up to the cap the stylesheet sets.
  ui.chatInput.addEventListener('input', () => {
    ui.chatInput.style.height = 'auto';
    ui.chatInput.style.height = `${ui.chatInput.scrollHeight}px`;
    paintChatState();
  });

  /*
   * Deleting a conversation asks first.
   *
   * It is the one control in here that destroys something, it cannot be undone, and it now
   * sits a few pixels from Close - so the cost of a mis-click is the whole history and the
   * cost of a confirmation is one tap. That trade only goes one way.
   */
  ui.chatClear.addEventListener('click', async () => {
    if (!chatPeerId) return;
    const { messages } = await chat.load(chatPeerId);
    if (!messages.length) return;
    if (!confirm(t('chat.clearAsk'))) return;
    /*
     * Deleting a conversation deletes it for both people in it.
     *
     * The alternative - removing it here and leaving the other copy where it is - makes the
     * button mean something much weaker than what it says, and weaker than what anyone pressing
     * it is likely to want: a conversation is a thing two devices hold, and tidying away your
     * own half of it does not make it gone. The confirmation says so plainly beforehand, since
     * this reaches a device that is not yours to tidy.
     */
    const name = currentEntry(chatPeerId)?.name || '';
    const told = await destroyConversation(chatPeerId, { tell: true });
    /*
     * "Not reachable" used to be the end of the sentence. It is not any more: the erase is
     * kept and sent the next time that device appears, so what is said is when it
     * will happen rather than that it did not.
     */
    toast(told ? t('chat.cleared') : t('chat.clearedLater', { name }), 'good');
  });

  /*
   * A picture, sent from the conversation.
   *
   * It goes through exactly the same `offer` the device tile uses - the same per-transfer key,
   * the same sealed frames, the same integrity check - and carries one extra flag saying it
   * belongs in the chat. That flag is what decides where it lands at the far end: drawn in the
   * conversation and sealed into this app's own storage, rather than written to the disk as a
   * download. Anything that is not a picture this conversation can hold falls back to the
   * ordinary path, so the file still arrives either way.
   */
  ui.chatAttach.addEventListener('click', async () => {
    if (!chatPeerId || ui.chatAttach.disabled) return;
    // One at a time: the engine carries one transfer at a time, and a picture is a gesture
    // rather than a batch. Sending several files is what the tile's own menu is for.
    const files = await pickFiles(false, { multiple: false, accept: 'image/*,audio/*' });
    if (files?.length) await sendChatMedia(chatPeerId, files[0]);
  });

  // Only where there is something to record with. A button that can only ever apologise is
  // worse than no button.
  ui.lockSet.addEventListener('click', () => onLockSetting());
  ui.lockChange.addEventListener('click', () => onLockChange());
  ui.lockNow.addEventListener('click', () => onLockNow());
  paintLockRow();

  ui.chatMic.hidden = !canRecord();
  ui.chatMic.addEventListener('click', () => {
    if (ui.chatMic.disabled) return;
    if (recorder) stopRecording();
    else startRecording();
  });
  ui.chatRecCancel.addEventListener('click', () => cancelRecording());

  // A window that changes width changes the bubble, and with it how many bars fit.
  addEventListener('resize', () => ui.chatDialog.open && fitWaveforms(), { passive: true });

  // Nothing on screen is holding them open any more.
  ui.chatDialog.addEventListener('close', () => {
    // A sheet that closes mid-recording must not leave the microphone running behind it.
    cancelRecording();
    releaseMedia();
    chatToken++;
  });

  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.addEventListener('click', () => setTheme(b.dataset.themeChoice));
  }
  matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (app.prefs.theme === 'auto') applyTheme();
  });

  ui.deviceName.addEventListener('click', startRename);
  ui.shareCancel.addEventListener('click', clearStage);

  ui.aboutHow.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelector('.about-detail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  ui.aboutInstall.addEventListener('click', (e) => {
    e.preventDefault();
    promptInstall();
  });
  ui.installBtn.addEventListener('click', promptInstall);

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e;
    ui.installBtn.hidden = false;
  });
  addEventListener('appinstalled', () => {
    deferredInstall = null;
    ui.installBtn.hidden = true;
  });

  // Dragging anywhere highlights the window. Dropping outside a tile stages the files
  // rather than refusing them.
  let dragDepth = 0;
  addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dragging');
  });
  addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.body.classList.remove('dragging');
    }
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;
    const live = [...app.conns.values()].filter((c) => c.state === 'ready');
    if (live.length === 1 && !app.staged) return sendFiles(live[0].id, files);
    stageFiles(files);
    if (!live.length) toast(t('toast.staged'));
  });

  addEventListener('beforeunload', (e) => {
    if ([...app.conns.values()].some((c) => c.progress)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /*
   * Say goodbye on the way out.
   *
   * `pagehide` rather than `beforeunload`, because that is the one mobile browsers fire when
   * a tab goes away. The frame was sealed in advance so this can be a single synchronous
   * send; there is no time here to encrypt anything.
   */
  addEventListener('pagehide', () => {
    for (const channel of Object.values(app.channels)) channel?.sayGoodbyeNow?.();

    /*
     * And drop the links themselves.
     *
     * The goodbye above settles presence, and a device already connected to this one hears
     * none of it. Left alone, the only thing telling it we have gone is ICE noticing that
     * consent stopped being answered: tens of seconds during which it shows a live connection,
     * offers to send over it, and takes anything typed into a channel with nothing at the far
     * end. Closing the peer connection is what a tab closing should look like, and it needs no
     * encryption. A pre-sealed farewell frame is not possible here anyway, because the ratchet
     * would make its sequence stale the moment anything else went out.
     */
    for (const conn of app.conns.values()) {
      try {
        conn.transport.close();
      } catch {
        /* going anyway */
      }
    }
  });

  /*
   * And back again.
   *
   * The handler above runs on the way into the back/forward cache as well as on the way out
   * of the tab, and the browser does not say which it will be, so a page that comes back has
   * already said goodbye and closed its links. Treat a restore as an arrival: drop the
   * connections, all of which are dead, and speak up again so the devices that heard the
   * farewell know this one is still here.
   */
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    for (const id of [...app.conns.keys()]) dropConn(id, { silent: true });
    render();
    for (const channel of Object.values(app.channels)) channel?.hello?.().catch?.(() => {});
    resubscribePaired({ force: true }).catch(() => {});
  });

  addEventListener(
    'resize',
    () => {
      app.radar.resize();
      closeMenu();
    },
    { passive: true },
  );

  /*
   * The rings centre on the beacon, and the beacon moves for reasons other than a window
   * resize: a headline wrapping, a device arriving, the discovery pill changing. Watching the
   * two blocks whose height changes catches all of it.
   *
   * Deferred a frame: a ResizeObserver fires mid-layout, where reading a rect would force a
   * second pass and return positions that are still settling.
   */
  let remeasure = 0;
  const watchLayout = new ResizeObserver(() => {
    cancelAnimationFrame(remeasure);
    remeasure = requestAnimationFrame(() => app.radar.resize());
  });
  for (const el of [$('stage'), ui.footer, ui.beacon]) if (el) watchLayout.observe(el);

  addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    acquireWake();
    // Seen. The title goes back to the app's name.
    if (announced) {
      announced = null;
      updateAmbient();
    }
  });

  addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.el.contains(e.target) && !e.target.closest?.('.peer-menu-btn')) closeMenu();
  });
  /*
   * Escape handled explicitly. The built-in dialog behaviour does not fire here, and this
   * app also runs as a PWA and inside web views where the platform default cannot be relied
   * on. Escape is how people leave a sheet.
   *
   * Written to match the spec rather than shortcut it: raise a cancellable `cancel` on the
   * front dialog and close only if nothing objects. The verification sheet objects, without
   * needing to know about this code. `preventDefault` stops a second close taking the sheet
   * underneath.
   */
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeMenu();

    const top = topModal();
    if (top) {
      if (top.dispatchEvent(new Event('cancel', { cancelable: true }))) top.close();
      e.preventDefault();
      return;
    }

    if (app.staged) clearStage();
  });
  ui.peers.addEventListener('scroll', closeMenu, { passive: true });
}

/**
 * The sheet in front, or nothing.
 *
 * The top layer stacks in the order things were shown, and the DOM records that order
 * nowhere: a sheet opened over another is not moved in the tree and gains no attribute to
 * tell them apart. It is recorded here as it happens, and read back from the end.
 */
function topModal() {
  while (modalStack.length) {
    const d = modalStack[modalStack.length - 1];
    if (d.isConnected && d.open) return d;
    modalStack.pop();
  }
  return null;
}

let modalStack = [];

/**
 * The radar sleeps while a modal is open.
 *
 * Watching the `open` attribute rather than wrapping showModal() means this holds however a
 * dialog comes and goes, whether by a button, the Escape key, a swipe or the form's own
 * submit, and a path added later cannot forget to tell it.
 */
/**
 * Ask the worker which build is actually running this page.
 *
 * Not the version in the markup: that is what the server most recently sent, and the point of
 * the question is whether this browser is showing that or something it cached earlier. The
 * worker's own version is the one that answers it, and a page with no worker says so.
 */
async function showBuild() {
  const el = document.getElementById('about-build');
  if (!el) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration?.();
    const active = reg?.active;
    if (!active) {
      el.textContent = 'live, no offline copy';
    } else {
      const res = await fetch('sw.js', { cache: 'no-store' });
      const served = /const VERSION = '([^']+)'/.exec(await res.text())?.[1] || 'unknown';
      el.textContent = served;
    }
    el.hidden = false;
  } catch {
    /* nothing to say is better than a wrong answer */
  }
}

function watchModals() {
  const dialogs = [...document.querySelectorAll('dialog')];
  modalStack = dialogs.filter((d) => d.open);
  const anyOpen = () => dialogs.some((d) => d.open);
  // A backgrounded tab is the same situation as a modal: nothing worth drawing. Both
  // conditions go through one function so closing a dialog in a hidden tab cannot wake the
  // radar back up.
  const sync = () => {
    if (document.hidden || anyOpen()) {
      app.radar?.pause();
    } else {
      app.radar?.resume();
    }
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const d = r.target;
      const at = modalStack.indexOf(d);
      if (d.open) {
        if (at < 0) modalStack.push(d);
      } else if (at >= 0) {
        modalStack.splice(at, 1);
      }
    }
    sync();
  });
  for (const d of dialogs) observer.observe(d, { attributes: true, attributeFilter: ['open'] });
  addEventListener('visibilitychange', sync);
  sync();
}

function bindCodeBoxes(host, length, onComplete) {
  const boxes = [...host.querySelectorAll('input')];
  const collect = () => boxes.map((b) => b.value).join('');
  const clear = () => boxes.forEach((b) => (b.value = ''));

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = normalizeCode(box.value).slice(-1);
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      const code = collect();
      if (code.length === length) {
        onComplete(code);
        clear();
        boxes[0].focus();
      }
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        boxes[i - 1].value = '';
        boxes[i - 1].focus();
      }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
    });

    box.addEventListener('focus', () => box.select());

    box.addEventListener('paste', (e) => {
      e.preventDefault();
      const code = normalizeCode(e.clipboardData.getData('text')).slice(0, length);
      boxes.forEach((b, j) => (b.value = code[j] || ''));
      if (code.length === length) {
        onComplete(code);
        clear();
      }
      boxes[Math.min(code.length, boxes.length - 1)].focus();
    });
  });
}

/**
 * Renaming happens in place, inside the chip.
 *
 * Only the name span is swapped for the field. The pencil stays where it is, because it is
 * part of the same control and replacing the whole button would take it too.
 */
let renameClosedAt = 0;

function startRename() {
  // Committing on blur means clicking the pencil while editing would finish and then
  // immediately reopen. A rename that just ended stays ended.
  if (ui.deviceName.querySelector('input') || Date.now() - renameClosedAt < 250) return;

  const input = document.createElement('input');
  input.value = app.name;
  input.maxLength = 32;
  input.setAttribute('aria-label', t('footer.rename'));
  input.autocomplete = 'off';
  input.spellcheck = false;

  // Hold the chip at the width of the text it is replacing, then track what is typed.
  // Counting characters and multiplying by `ch` is close but not equal to the rendered
  // width, and the difference is a visible jump the moment the field appears.
  const sizeToContent = () => {
    ui.deviceName.style.setProperty('--name-w', '0px');
    ui.deviceName.style.setProperty('--name-w', `${input.scrollWidth + 1}px`);
  };
  ui.deviceName.style.setProperty(
    '--name-w',
    `${Math.ceil(ui.deviceNameText.getBoundingClientRect().width) + 1}px`,
  );
  ui.deviceName.classList.add('editing');

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    renameClosedAt = Date.now();

    const next = save ? input.value.trim().slice(0, 32) : app.name;
    ui.deviceNameText.textContent = next || app.name;
    ui.deviceName.replaceChildren(ui.deviceNameText, penIcon());
    ui.deviceName.classList.remove('editing');
    ui.deviceName.style.removeProperty('--name-w');

    if (!save || !next || next === app.name) return;
    app.name = next;
    await kv.set('name', next);
    for (const conn of app.conns.values()) {
      conn.transfers._sendCtl({ t: 'rename', name: next }).catch(() => {});
    }
    // Anyone who can see this device on a channel is holding the old name too.
    for (const ch of Object.values(app.channels)) ch?.rename(next);
    toast(t('toast.renamed', { name: next }), 'good');
  };

  input.addEventListener('input', sizeToContent);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation(); // Escape here means "stop renaming", not "close everything"
  });
  input.addEventListener('blur', () => finish(true));

  // The pencil stays in the DOM while editing, faded but occupying its space, so the chip
  // does not change width the moment the field appears.
  ui.deviceName.replaceChildren(input, penIcon());
  input.focus();
  input.select();
}

/** The chip's pencil, rebuilt after an edit swaps the contents out. */
function penIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pen');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-pen');
  svg.append(use);
  return svg;
}

async function promptInstall() {
  if (!deferredInstall) {
    toast(t('toast.installHint'));
    return;
  }
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  ui.installBtn.hidden = true;
}

/* ───────────────────────────────── theme ─────────────────────────────── */

function setTheme(choice) {
  app.prefs.theme = choice;
  try {
    localStorage.setItem('theme', choice);
  } catch {
    /* private mode */
  }
  applyTheme();
}

function applyTheme() {
  const choice = app.prefs.theme || 'auto';
  const light = choice === 'light' || (choice === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.body.classList.toggle('theme-light', light);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', light ? '#ffffff' : '#000000');
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  }
  baseFavicon = null; // the resting icon depends on the theme

  /*
   * The radar is told here, not by whoever changed the theme.
   *
   * It draws on a worker from a palette it was handed, so a theme change that does not reach
   * it leaves it painting the other theme's picture underneath this one's page - and the two
   * themes do not merely differ in colour, they differ in what is drawn at all. This used to
   * hang off the settings buttons, which meant it ran when somebody chose a theme and not
   * when the system chose one for them: a person on `auto` got a white page at sunrise with a
   * dark room's radar still running on it. One caller, on the one function every path goes
   * through.
   */
  app.radar?.refreshColors();
}

/* ───────────────────────────────── toast ─────────────────────────────── */

/**
 * A message someone can act on, from an error written for whoever is reading the stack.
 *
 * Internal messages travel: a handshake failure or a rejected frame arrives here as the
 * string the module threw, and "cpace: invalid group element" on a toast tells the person
 * holding the phone nothing. Known causes get a sentence; everything else gets `fallback`,
 * so a new throw somewhere cannot leak its wording into the interface.
 */
function humanError(message, fallback = 'err.generic') {
  const m = String(message || '').toLowerCase();
  if (!m) return t(fallback);
  /*
   * An offer with no lattice key in it, which has exactly one ordinary cause.
   *
   * The handshake refuses a classical-only offer rather than quietly falling back to one, so
   * the everyday version of this refusal is a device still holding an older copy of the app
   * from its cache. That is fixable by the person looking at the screen, and "couldn't agree
   * a key" does not tell them how.
   */
  if (m.includes('hybrid offer')) return t('err.stale');
  if (m.startsWith('cpace:') || m.includes('not established') || m.includes('no share to key')) return t('err.keying');
  if (m.includes('same code')) return t('err.badCode');
  if (m.includes('still arriving')) return t('err.busy');
  if (m.includes('no streaming sink')) return t('err.tooBig');
  if (m.includes('timeout') || m.includes('timed out')) return t('err.timeout');
  return t(fallback);
}

/**
 * A banner, shaped the way the platform shapes one: an icon, who it is from, and what
 * happened.
 *
 * `opts.title` is what makes it that rather than a status line. A message about a device
 * leads with the device, because the name is what is being scanned for, and putting it on its
 * own line is why a phone's notification is readable at a glance. Without a title it stays
 * one line, which is right for "Copied" and wrong for a file arriving from someone.
 */
/**
 * Put the notices above whatever is open, and keep them there.
 *
 * The top layer is ordered by when each thing was promoted, not by any z-index, so showing the
 * host once at start-up would leave it underneath every sheet opened afterwards. Re-showing it
 * as each notice arrives moves it back to the front. A sheet opened *after* a notice covers it
 * again, which is right: at that point the person has moved on to something else.
 *
 * Both calls can throw - hiding what is not shown, showing what already is - and neither is
 * worth reporting. A browser without `popover` keeps the behaviour it had.
 */
function liftToasts() {
  const host = ui.toastHost;
  if (!host?.showPopover) return;
  try {
    host.hidePopover();
  } catch {
    /* it was not showing */
  }
  try {
    host.showPopover();
  } catch {
    /* nothing to show it over */
  }
}

function toast(text, tone = '', opts = {}) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`.trim();

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mark.setAttribute('viewBox', '0 0 24 24');
  mark.setAttribute('aria-hidden', 'true');
  mark.setAttribute('class', 'toast-mark');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', opts.icon || '#i-drop');
  mark.append(use);
  el.append(mark);

  const copy = document.createElement('div');
  copy.className = 'toast-copy';
  if (opts.title) {
    const head = document.createElement('span');
    head.className = 'toast-title';
    head.textContent = opts.title;
    copy.append(head);
  }
  const span = document.createElement('span');
  span.className = 'toast-body';
  span.textContent = text;
  copy.append(span);
  el.append(copy);

  if (opts.action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.type = 'button';
    b.textContent = opts.label || t('common.ok');
    b.addEventListener('click', () => {
      opts.action();
      el.remove();
    });
    el.append(b);
  }

  ui.toastHost.append(el);
  liftToasts();

  let timer = 0;
  const hide = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    }, ms);
  };
  hide(opts.hold || 3800);

  /*
   * Letting go without dismissing restarts the clock short rather than resuming it.
   *
   * Whoever just held the banner has read it, so the rest of the original wait is time spent
   * covering the toolbar for nobody. Restarting at the full duration is worse still: fail to
   * flick it hard enough and the notice you were trying to get rid of stays longer than if
   * you had left it alone.
   */
  enableSwipeUpToDismiss(el, {
    onDismiss: () => el.remove(),
    onGrab: () => clearTimeout(timer),
    onLetGo: () => hide(1600),
  });
  while (ui.toastHost.children.length > 3) ui.toastHost.firstElementChild.remove();
}

/* ─────────────────────────────── the lock ──────────────────────────────── */

/**
 * Stand in front of the app until the passphrase is given.
 *
 * Not a screen over the top of a loaded app: the app has nothing yet. The device key, the
 * pairings and the conversations are all sealed under a key that does not exist on this
 * machine, and boot stops here until it is derived.
 */
async function askToUnlock() {
  ui.lockError.hidden = true;
  ui.lockPass.value = '';
  ui.lockDialog.showModal();
  setTimeout(() => ui.lockPass.focus(), 60);

  /*
   * And the way out for someone who cannot get in.
   *
   * A forgotten passphrase is not recoverable, which is the point of it, so the only thing
   * this device can offer is to stop being that device: erase what the passphrase was
   * protecting and start again with a new identity. Without this the app is a locked door
   * with nothing behind it, and the only remedy is clearing site data from browser settings.
   *
   * Reached only from here, where the person is already stuck, and it asks before it goes.
   */
  ui.lockForgot.onclick = () => eraseEverything();

  return new Promise((resolve) => {
    ui.lockForm.addEventListener('submit', async function onSubmit(e) {
      e.preventDefault();
      const pass = ui.lockPass.value;
      if (!pass) return;

      // Deriving is a second of work by design, so say something is happening.
      const button = ui.lockForm.querySelector('button');
      button.disabled = true;
      // The reseal is handed over so a vault still locked under the old derivation is moved
      // to the memory-hard one on the way in, while the passphrase is in hand.
      const ok = await vault.unlock(pass, resealVault).catch(() => false);
      button.disabled = false;

      if (!ok) {
        ui.lockError.hidden = false;
        ui.lockPass.select();
        return;
      }
      // The passphrase does not stay in the field for the next person at this machine.
      ui.lockPass.value = '';
      ui.lockForm.removeEventListener('submit', onSubmit);
      ui.lockDialog.close();
      resolve(true);
    });
  });
}

/**
 * The strongest part of this is not the derivation, it is the passphrase.
 *
 * A million PBKDF2 rounds buys about a tenth of a second per guess, which is a great deal
 * against a hundred candidates and nothing at all against a dictionary. What actually decides
 * the outcome is how much the passphrase could have been, so the field arrives already filled
 * with six words drawn from the same list the safety words come from: 256 words, eight bits
 * each, forty-eight bits of choice that nobody had to invent. Typing over it is allowed;
 * accepting it is the better answer and costs nothing.
 */
function suggestPassphrase(words = 6) {
  const pick = crypto.getRandomValues(new Uint32Array(words));
  return Array.from(pick, (n) => SAS_WORDS[n % SAS_WORDS.length]).join(' ');
}

/**
 * Ask for a passphrase, without showing it to the room.
 *
 * `prompt` renders what is typed into it in the clear, which is backwards for the one field
 * whose purpose is that nobody at this machine can read the data. It is also optional: some
 * browsers and most embedded views refuse it, so the setting could fail with nothing on
 * screen to say why.
 *
 * @param {object} opts
 * @param {string} opts.title   heading
 * @param {string} opts.sub     what saying yes will do
 * @param {string} opts.go      the submit button
 * @param {string} opts.label   placeholder for the field
 * @param {boolean} [opts.confirm]  ask for it twice, and offer one worth using
 * @returns {Promise<string|null>} what was typed, or null if it was dismissed
 */
function askPassphrase({ title, sub, go, label, confirm = false }) {
  setText(ui.passTitle, title);
  setText(ui.passSub, sub);
  setText(ui.passGo, go);
  ui.passOne.placeholder = label;
  ui.passOne.setAttribute('aria-label', label);
  ui.passOne.value = '';
  ui.passOne.autocomplete = confirm ? 'new-password' : 'current-password';
  ui.passTwo.hidden = !confirm;
  ui.passTwo.value = '';
  ui.passTwo.placeholder = t('lock.askAgain');
  ui.passTwo.setAttribute('aria-label', t('lock.askAgain'));
  ui.passError.hidden = true;

  // Masked to begin with, every time: a sheet reopened still showing the last answer would
    // undo the change.
  const mask = (on) => {
    ui.passOne.type = ui.passTwo.type = on ? 'password' : 'text';
    setText(ui.passShow, t(on ? 'lock.show' : 'lock.hide'));
  };
  mask(true);

  // A suggestion is only useful if it can be read and written down, so it is shown rather
  // than typed into a masked field the person cannot check.
  const suggestion = confirm ? suggestPassphrase() : '';
  ui.passSuggest.hidden = !confirm;
  if (confirm) ui.passSuggested.textContent = suggestion;

  ui.passDialog.showModal();
  setTimeout(() => ui.passOne.focus(), 60);

  return new Promise((resolve) => {
    const finish = (value) => {
      ui.passShow.onclick = null;
      ui.passUse.onclick = null;
      ui.passForm.onsubmit = null;
      ui.passDialog.oncancel = null;
      ui.passDialog.onclose = null;
      ui.passOne.value = '';
      ui.passTwo.value = '';
      ui.passDialog.close();
      resolve(value);
    };

    ui.passShow.onclick = () => mask(ui.passOne.type === 'text');
    ui.passUse.onclick = () => {
      ui.passOne.value = suggestion;
      ui.passTwo.value = suggestion;
      mask(false);
    };

    const fail = (message) => {
      setText(ui.passError, message);
      ui.passError.hidden = false;
      ui.passOne.select();
    };

    ui.passForm.onsubmit = (e) => {
      e.preventDefault();
      const first = ui.passOne.value;
      if (!first) return;

      if (confirm) {
        // Twelve is not a magic number; it is roughly where a typed passphrase stops being
        // guessable in the time this derivation costs. The suggestion clears it easily.
        if (first.trim().length < 12) return fail(t('lock.tooShort'));
        if (first !== ui.passTwo.value) return fail(t('lock.mismatch'));
      }
      finish(first);
    };

    /*
     * Escape, the close button, and the backdrop all mean the same thing - but only if this
     * close is ours.
     *
     * `close()` returns with the dialog already shut and delivers its event about five
     * milliseconds later. Two prompts in a row, which is what changing a passphrase is, means
     * the first one's event arrives after the second has reopened the same dialog and
     * installed this handler, which reads it as the person dismissing a prompt they were
     * never shown. The second answer came back null, and a passphrase change quietly did
     * nothing while reporting success.
     *
     * A real dismissal leaves the dialog closed. One that arrives while it is open belongs to
     * a prompt that has already finished, and is not ours to act on. Measured rather than
     * reasoned about: a timeout long enough to dodge it on this machine is a bug on a slower
     * one.
     */
    ui.passDialog.onclose = () => {
      if (ui.passDialog.open) return;
      finish(null);
    };
  });
}

/**
 * Turn the lock on or off.
 *
 * Both directions re-encrypt every sealed record on this device, because both change which
 * key they are sealed under. It is the one operation here that is allowed to take a moment.
 */
/* ─────────────────── locking itself again ────────────────── */

/** How often to ask, while anybody is looking. Cheap: it is a subtraction. */
const IDLE_CHECK_MS = 30_000;

/** Job states where bytes are actually moving, as opposed to an offer waiting on an answer. */
const MOVING = new Set(['sending', 'accepting', 'receiving']);

/**
 * Is a transfer running right now?
 *
 * A two-gigabyte file takes longer than the idle timeout and nobody stands over it, so time
 * spent transferring is not time spent away. An offer nobody has answered does not count:
 * that one could sit there forever, and a peer must not be able to hold this device open by
 * asking a question and never withdrawing it.
 */
function transferInFlight() {
  for (const conn of app.conns.values()) {
    const jobs = conn.transfers;
    if (!jobs) continue;
    for (const job of jobs.out.values()) if (MOVING.has(job.state)) return true;
    for (const job of jobs.in.values()) if (MOVING.has(job.state)) return true;
  }
  return false;
}

/**
 * Put a protected device back behind its passphrase once its person has gone.
 *
 * Reload rather than a screen over the top. `lockNow()` drops the key, which stops anything
 * new being read, and it cannot reach what has already been decrypted: the conversation in
 * the DOM, this device's private key, the session key on every live connection. A screen over
 * that is a picture of a lock. A reload drops all of it and lands on `askToUnlock`, which is
 * the gate that already works, and boot reads nothing before it. The cost is the open
 * connections, which is the right answer for a device somebody walked away from.
 *
 * Checked when somebody could be looking, which is the lazy design `lockIfIdle` was written
 * for: on becoming visible, on focus, and on a slow tick while visible. A backgrounded tab
 * ages without being asked and is locked the moment it is looked at again.
 *
 * Does nothing at all on a device with no passphrase - `lockIfIdle` answers false unless the
 * vault is protected - so this costs the common case one subtraction every half minute.
 */
function watchIdleLock() {
  const check = () => {
    if (document.hidden || transferInFlight()) return;
    if (vault.lockIfIdle()) location.reload();
  };

  // Real input is what "still here" means. `unseal` already advances the clock, which covers
  // reading a conversation and misses everything else somebody does in front of the app.
  for (const event of ['pointerdown', 'keydown']) {
    addEventListener(event, () => vault.noteActivity(), { passive: true, capture: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    check();
    // Coming back to the tab is itself the person arriving, so the clock restarts from here
    // rather than from whenever they last left.
    vault.noteActivity();
  });
  addEventListener('focus', check);
  setInterval(check, IDLE_CHECK_MS);
}

async function onLockSetting() {
  const locked = await vault.hasPassphrase();

  if (locked) {
    const current = await askPassphrase({
      title: t('lock.removeTitle'),
      // What removing it means, rather than what it currently does: the browser goes back to
      // holding the key, which is the thing being given up.
      sub: t('lock.settingOff'),
      go: t('lock.turnOff'),
      label: t('lock.askCurrent'),
    });
    if (current === null) return;
    toast(t('lock.working'));
    const ok = await vault.clearPassphrase(current, resealVault).catch(() => false);
    if (!ok) return toast(t('lock.wrong'), 'bad');
    await paintLockRow();
    return toast(t('lock.removed'), 'good');
  }

  const chosen = await askPassphrase({
    title: t('lock.setting'),
    sub: t('lock.ask'),
    go: t('lock.turnOn'),
    label: t('lock.passphrase'),
    confirm: true,
  });
  if (chosen === null) return;
  toast(t('lock.working'));
  try {
    await vault.setPassphrase(chosen, resealVault);
  } catch {
    return toast(t('err.generic'), 'bad');
  }
  await paintLockRow();
  toast(t('lock.done'), 'good', { hold: 8000 });
}

async function paintLockRow() {
  const on = await vault.hasPassphrase();
  setText(ui.lockState, t(on ? 'lock.settingOn' : 'lock.settingOff'));
  setText(ui.lockSet, t(on ? 'lock.turnOff' : 'lock.turnOn'));
  ui.lockSet.classList.toggle('danger', on);
  // Neither of these has anything to act on until there is a passphrase.
  ui.lockNow.hidden = !on;
  ui.lockChange.hidden = !on;
}
/**
 * Change it, which is neither setting nor removing.
 *
 * `changePassphrase` has been in the vault the whole time with nothing calling it, so the
 * only way to change a passphrase was to remove it and set it again - which spends two full
 * re-seals of every record on the device and leaves a window in between where the key is back
 * in the browser. This does it in one pass, and refuses before it starts if the current one is
 * wrong.
 */
async function onLockChange() {
  const current = await askPassphrase({
    title: t('lock.changeTitle'),
    sub: t('lock.settingOn'),
    go: t('common.next'),
    label: t('lock.askCurrent'),
  });
  if (current === null) return;

  const next = await askPassphrase({
    title: t('lock.changeTitle'),
    sub: t('lock.ask'),
    go: t('lock.change'),
    label: t('lock.passphrase'),
    confirm: true,
  });
  if (next === null) return;

  toast(t('lock.working'));
  const ok = await vault.changePassphrase(current, next, resealVault).catch(() => false);
  if (!ok) return toast(t('lock.wrong'), 'bad');
  toast(t('lock.changed'), 'good');
}

/**
 * Back behind the passphrase now, without closing the tab.
 *
 * Same reload as the idle path, for the same reason: dropping the key does not un-draw the
 * conversation that is already on the screen.
 */
function onLockNow() {
  if (!vault.lockNow()) return;
  location.reload();
}


/* ───────────────────────── service worker / share target ─────────────── */

/**
 * Whether this origin could be a machine somebody is working on.
 *
 * Checked first so a real deployment never pays for any of this: a public hostname stops
 * here, makes no extra request, and registers the worker exactly as it always did.
 */
function localOrigin() {
  const h = location.hostname;
  return (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '[::1]' ||
    h === '::1' ||
    h.endsWith('.localhost') ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * Is the thing serving this page a dev server?
 *
 * Asked, rather than assumed from the hostname, because running the real app on a laptop is
 * an ordinary thing to do and it should get a worker and work offline like any other install.
 */
async function servedByDevServer() {
  if (!localOrigin()) return false;
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    return res.headers.get('X-Gear-Drop-Dev') === '1';
  } catch {
    return false; // no answer is not a yes
  }
}

if ('serviceWorker' in navigator) {
  /*
   * A dev server gets no worker, and loses the one a previous session left behind.
   *
   * Without this the worker answers from its cache, so the page under a change is the build
   * before it and says the new version number while doing so. `?sw=1` puts it back for the
   * times the worker itself is what is being worked on, which is the only thing this costs.
   */
  (async () => {
    if (!new URLSearchParams(location.search).has('sw') && (await servedByDevServer())) {
      for (const reg of await navigator.serviceWorker.getRegistrations()) {
        await reg.unregister().catch(() => {});
      }
      for (const key of await caches.keys()) await caches.delete(key).catch(() => {});
      return;
    }

    navigator.serviceWorker.register(scriptURL('sw.js')).catch(() => {});
    // A share that arrived before this page existed is waiting in the worker; ask for it.
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ t: 'want-shared' }))
      .catch(() => {});
  })();

  // Files handed over by the system share sheet arrive here, from the worker.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.t !== 'shared') return;
    if (e.data.files?.length) stageFiles(e.data.files);
    else if (e.data.text) stageText(e.data.text);
  });
}

function stageText(text) {
  const file = new File([text], 'shared.txt', { type: 'text/plain' });
  stageFiles([file], 'Shared text');
}

if (new URLSearchParams(location.search).has('shared')) {
  history.replaceState(null, '', location.pathname);
}

/* ─────────────────────────────── diagnostics ─────────────────────────── */

/*
 * Two functions on a dev server, and nothing at all anywhere else.
 *
 * This was `window.gd = app`, which put the live connections on the global - and a connection
 * holds `session.K`, the raw root key, beside `app.device.priv`, this device's own identity.
 * Both were readable in one line by anything running in this page's world.
 *
 * The policy stops script being *injected*: `script-src 'self'`, Trusted Types, and no sink
 * anywhere in this client. It has nothing to say about script that is already allowed to run,
 * which is exactly what a browser extension's content script is. Handing that code the keys,
 * rather than making it go looking, is the wrong default for an app whose whole claim is that
 * the keys never leave the two devices. It also meant any future careless line would be a key
 * compromise rather than a defacement.
 *
 * Nothing in this repo read it - `bench.js` imports what it needs directly - so the only thing
 * lost is a console handle, and that survives: narrowed to the two calls it was written for,
 * behind the same question the service worker asks, which a real deployment answers no to
 * without making a single extra request.
 */
servedByDevServer().then((dev) => {
  if (!dev) return;
  window.gd = Object.freeze({
    forceRelay: (why = 'why.network') => {
      for (const conn of app.conns.values()) useRelay(conn, why);
    },
    stageFiles,
  });
});
