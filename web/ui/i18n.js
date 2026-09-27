/**
 * Interface language.
 *
 * English is the source of truth: every key exists here, and a locale is a partial
 * override of it. A missing key falls back to English rather than rendering a key name or
 * an empty box, which is why the picker can print each language's coverage
 * instead of listing three dozen languages that are mostly untranslated.
 *
 * Translations may contain <b>…</b> and nothing else. They are turned into real elements
 * by hand below, never through innerHTML, so a bad string can produce ugly text but
 * never markup.
 */

const en = {
  'common.next': 'Next',
  'lock.change': 'Change',
  'lock.changeTitle': 'Change the passphrase',
  'lock.changed': 'Passphrase changed',
  'chat.clearedLater': 'Deleted here. {name} will be erased the next time it connects.',
  'chat.wipeLanded': '{name} has now erased its copy too.',
  'devices.wipeWaiting': 'Waiting to erase this conversation',
  'devices.unpairStrands': 'Unpairing means you can’t reach {name} again, so it will never get the message to delete its copy. Unpair anyway?',
  'devices.erase': 'Erase everything',
  'devices.eraseSub': 'Deletes every conversation, picture and paired device, and starts this device over.',
  'devices.eraseGo': 'Erase',
  'devices.eraseAsk': 'Erase everything on this device? Conversations, pictures, paired devices and any unsaved files. This can’t be undone.',
  'devices.erasePartial': 'Erased, except: {left}. Close any other tab of this app and try again.',
  'erase.part.db': 'the database',
  'erase.part.files': 'received files',
  'erase.part.web': 'theme and language',
  'erase.part.caches': 'the offline cache',
  'erase.part.worker': 'the offline worker',
  'chat.wipedByPeer': '{name} deleted this conversation. It’s gone from this device too.',
  'chat.wipedUnverified': 'Safety words didn’t match. This conversation was deleted here, and the other device was asked to delete its copy.',
  'notify.message': 'Sent you a message',
  'notify.file': 'Sent you a file',
  'chat.photo': 'Photo',
  'chat.save': 'Save this picture',
  'chat.photoGone': 'This picture is no longer stored on this device',
  'chat.photoKind': 'This browser can’t show this one',
  'chat.photoBusy': 'Something else is still transferring. Try again in a moment.',
  'chat.gone': 'This device has gone. Devices you haven’t paired with get a new name each time they join, so this chat can’t carry on. Pair to keep the next one.',
  'chat.sec.direct': 'End-to-end encrypted · direct',
  'chat.sec.local': 'End-to-end encrypted · direct on this network',
  'chat.sec.relay': 'End-to-end encrypted · through the connection',
  'chat.sec.linking': 'End-to-end encrypted · connecting',
  'chat.sec.unverified': 'unverified',
  'chat.sec.tipDirect': 'Nothing sits between the two devices.',
  'chat.sec.tipRelay': 'The encrypted connection passes the messages along and can’t read them.',
  'chat.attach': 'Send a picture or file',
  'chat.clearAsk': 'Delete this conversation? It’s removed from both devices and can’t be undone.',
  'chat.ephemeral': 'Not paired, so this chat lasts only as long as the tab. Pair to keep it.',
  'chat.title': 'Chat',
  'chat.with': 'With',
  'chat.placeholder': 'Message',
  'chat.empty': 'Nothing here yet. Anything either of you sends stays on your two devices.',
  'chat.locked': 'A chat is saved here, but this browser can’t unlock it any more. New messages start a fresh one.',
'chat.offline': 'Not connected. What you write is sent when this device is back.',
  'chat.copy': 'Copy this message',
  'chat.copied': 'Copied',
  'chat.clear': 'Delete this conversation',
  'chat.cleared': 'Deleted from both devices',
  'menu.chat': 'Chat',
  'devices.sound': 'Sound on arrival',
  'devices.soundSub': 'A short tone when a file or message reaches this device.',
  'disc.more': 'What this means',
  /*
   * The discovery control says a whole sentence now.
   *
   * The old `chip.*` words were fragments written to follow a caption - "you can be
   * found: this network" - and the caption is gone, so they had to become statements
   * that stand on their own.
   */
  'disc.pill.local': 'Visible on this network',
  'disc.pill.public': 'Public',
  'disc.pill.off': 'Not discoverable',
  /*
   * The toolbar.
   *
   * Only the four labels that belong to nothing else live here. The buttons that open a
   * sheet borrow that sheet's own title instead, so the two can never drift apart.
   */
  'nav.install': 'Install Gear Drop',
  'nav.about': 'About Gear Drop',
  'nav.relay': 'Encrypted connection',
  'nav.label': 'Main actions',
  'state.offline': 'offline',
  'state.connecting': 'connecting',
  'state.online': 'ready',

  'common.or': 'or',
  'common.ok': 'OK',
  'action.useRelay': 'Use the encrypted connection',
  'common.cancel': 'Cancel',
  'common.send': 'Send',
  'common.copy': 'Copy link',
  'common.save': 'Save',

  'empty.seeking.local': 'Looking for devices on this network',
  'empty.seeking.public': 'Listening for anyone with your code',
  'empty.seeking.off': 'Nobody can find this device right now',
  'empty.title.public': 'Share your code to be found',
  'empty.title.local': 'Open Gear Drop on your other devices to send files',
  'empty.body.local': 'Pair a device or open a room to be found on other networks',
  'empty.body.public': 'Read out the five characters, or send the link. Anyone who types it can see you, on any network.',
  'empty.title.off': 'Nobody can reach this device',
  'empty.body.off': 'Nobody can find you right now. Pair with a code, open a room, or turn this network back on.',
  'action.addDevice': 'Add a device',
  'action.room': 'Open a room',
  'action.network': 'This network',

  'hint.desktop': 'Click a device to send files, or drop them anywhere.',
  'hint.mobile': 'Tap a device to send files.',

  'footer.knownAs': 'You’re known as',
  'footer.rename': 'Rename this device',
  'disc.title': 'Who can find you',
  'disc.sub':
    'Paired devices always reach you. This sets who else can.',
  'disc.off': 'Nobody',
  'disc.offSub': 'Only devices you’ve already paired can reach you.',
  'disc.local': 'This network',
  'disc.localSub':
    'Devices on the same network as you, with no code to type.',
  'disc.public': 'Anyone with your code',
  'disc.publicSub': 'Works on any network. You read out five characters.',
  'disc.noteOff': 'Only your paired devices can still reach you. Nobody else sees this device at all.',
  'disc.notePublic': 'Anyone with your code can see you, on any network. Check the safety words before you send. A new code cancels the old one.',
  'disc.newCode': 'New code',
  'disc.others': '{n} others here',
  'disc.alone': 'nobody else yet',
  'chip.paired': 'paired',

  'share.pick': 'Pick a device below.',

  'connect.title': 'Add a device',
  'connect.sub': 'Pair once. After that it reconnects on its own, with no code.',
  'connect.inviteWhat': 'This link wants to connect you to a device. Whoever sent it will see your device name and that you’re online, and will be able to offer you files.',
  'connect.inviteJoin': 'Connect',
  'connect.show': 'Show this code',
  'connect.enter': 'Enter their code',
  'connect.generate': 'Generate a code',
  'connect.newCode': 'New code',
  'connect.hint': 'Six characters. O reads as 0, I and L as 1. One wrong guess kills the code.',
  'connect.connecting': 'Connecting…',

  'room.title': 'Room',
  'room.sub': 'A five-character code everyone types in. Anyone in the room can see everyone else.',
  'room.create': 'Create one',
  'room.createBtn': 'Open a room',
  'room.createHint': 'You get a code to read out. It works for anyone who types it, on any network.',
  'room.join': 'Join one',
  'room.joinHint': 'Five characters.',
  'room.members': 'In the room',
  'room.leave': 'Leave the room',
  'room.foot': 'Anyone with the code can join, so check the safety words before you send.',

  'net.p1': '<b>How it works.</b> The encrypted connection gives your network a label and hands the same one to every device connecting from there. Devices with this on use it to find each other.',
  'net.p2': '<b>What it costs.</b> For six hours at a time, the encrypted connection can tell that two devices are on the same network. It still can’t see your files, their names or their sizes.',
  'net.p3': '<b>Still check.</b> A device found this way stays unverified until you confirm the safety words.',
  'net.statusOff': 'Hidden from this network',
  'net.statusOn': 'Devices on this network can find you',
  'net.unavailable': 'The encrypted connection didn’t offer a network label',

  'devices.title': 'Paired devices',
  'devices.sub': 'Remembered on this device only. Nothing is kept on a server.',
  'devices.empty': 'Nothing paired yet.',
  'devices.foot': 'Auto-accept takes files without asking you first. Use it only for your own devices.',
  'risk.runs': 'runs code',
  'risk.active': 'can carry script',
  'risk.note': 'This kind of file opens by running. Take it only from someone you know, and only if you expected it.',
  'sink.hintFolder': 'You pick one folder. Everything lands inside it, in the same folders the sender had.',
  'sink.hintDisk': 'Written straight into the file you pick. Only your disk space limits it.',
  'sink.hintSandbox': 'Files land in private storage and download when they finish. The app never touches your folders.',
  'sink.hintMemory': 'This browser can only receive small files.',
  'devices.saveTo': 'Ask where to save',
  'devices.saveToSub': 'Pick a location and the file is written straight into it.',
  'devices.saveToUnavailable': 'This browser has no save dialog, so files download when they finish.',
  'devices.autoAccept': 'Auto-accept',
  'devices.unpair': 'Unpair',
  'devices.notify': 'Notify me about incoming transfers',
  'devices.notifySub': 'Only while this tab is in the background.',
  'devices.awake': 'Keep the screen awake during transfers',
  'devices.awakeSub': 'Stops a phone from pausing a transfer that’s still running.',

  'relay.title': 'This link wants to change your encrypted connection',
  'relay.sub': 'The encrypted connection is what introduces your devices to each other. It never sees your files, only who you meet and when.',
  'relay.current': 'Currently',
  'relay.proposed': 'This link wants',
  'relay.p1': '<b>It can’t</b> read a file, a name or a message. Those stay locked the whole way.',
  'relay.p2': '<b>It can</b> see which devices you meet and when, and it could try to sit in the middle. That’s what the safety words catch.',
  'relay.p3': '<b>Not expecting this?</b> Keep yours. A link that quietly swaps your encrypted connection is how someone would watch who you talk to.',
  'relay.accept': 'Use the new one',
  'relay.keep': 'Keep mine',
  'devices.relay': 'Encrypted connection',
  'devices.relayDefault': 'this site’s own',
  'devices.relayReset': 'Reset',
  'verify.title': 'Confirm the safety words',
  'verify.body': 'Both devices should show the same four words. If they differ, something is sitting between you.',
  'verify.yes': 'They match',
  'verify.no': 'They differ',

  'incoming.from': 'From',
  'incoming.sas': 'Safety words',
  'incoming.size': 'Size',
  'incoming.decline': 'Decline',
  'incoming.accept': 'Accept',
  'incoming.confirm': 'The same words are on the other screen',
  'incoming.queued': 'Queued. It’ll start when the current transfer finishes.',
  'incoming.queuedStart': 'Starting the queued transfer from {name}',
  'devices.direct': 'Direct on other networks',
  'settings.appearance': 'Appearance',
  'settings.title': 'Settings',
  'settings.sub': 'Everything here stays on this device. Nothing syncs anywhere.',
  'settings.appearanceSub': 'Follow the system, or pick one.',
  'settings.language': 'Language',
  'settings.languageSub': 'A language appears here once it’s fully translated.',
  'devices.directSub': 'Devices on this network already connect directly without looking up your address. This does the same further away, where the other device does see it.',
  'devices.directOn': 'On. Devices on other networks connect directly, and see your address.',
  'devices.directOff': 'Off. Devices on other networks go through the encrypted connection, so nobody learns your address.',
  'room.inviteWhat':
    'This link wants to put you in a room. Everyone in it will see your device name and that you’re online.',
  'room.inviteJoin': 'Join the room',
  'incoming.andMore': 'and {n} more',
  'incoming.needWords': 'Check the safety words first. They prove who’s really on the other end.',
  'incoming.one': 'Incoming file',
  'incoming.image': 'Incoming picture',
  'incoming.many': 'Incoming {n} files',
  'recv.open': 'Open link',

  'lang.title': 'Language',
  'lang.sub': 'Each one shows how much of it is translated.',

  'about.tag': 'Nothing in the middle can read your files, pretend to be one of your devices, or recognise you from one visit to the next.',
  'about.p1': '<b>The code is the password.</b> Both devices turn it into the same key without ever sending it. Nothing in the middle can work the key out, and it gets one guess at the code.',
  'about.p2': '<b>Everything is locked before it leaves.</b> File names and sizes too, and each one is padded so nothing in the middle can guess how long it was.',
  'about.p3': '<b>Safety words.</b> Both devices work out the same four words from the connection itself. If someone’s in the middle, the two lists won’t match.',
  'about.p4': '<b>Files go straight to disk.</b> Nothing piles up in memory, so a huge file needs no more room than a small one.',
  'about.p5': '<b>Paired devices stay anonymous.</b> They meet under a name that changes every ten minutes, so nothing in the middle ever sees the same one twice.',
  'about.pq': '<b>Built for later, too.</b> The key is agreed in two separate ways at once, and you’d have to break both. One of them is designed to hold up against quantum computers, so a recording saved today stays shut.',
  'about.addr': '<b>Your address.</b> On the same network, devices use a throwaway name and your real address is never looked up. Further away, everything goes through the encrypted connection, so the other device learns nothing about where you are. The site you connect to still sees your address, like any website does.',
  'about.meets': '<b>What is still visible.</b> The server that introduces two devices can see that they met, and roughly when. It never sees who you are, or what you sent. Hiding that too takes Tor, and this works there.',
  'about.p6': '<b>One thing to know.</b> This is a web page, so every time you open it you’re trusting the code it sends you. That is the one thing no design here can remove.',

  'menu.sendFiles': 'Send files',
  'menu.sendFolder': 'Send a folder',
  'menu.stop': 'Stop transfer',
  'menu.verify': 'Check the safety words',
  'menu.disconnect': 'Disconnect',
  'menu.reconnect': 'Reconnect',
  'menu.forget': 'Forget this device',

  'fact.status': 'Status',
  'fact.found': 'Found on',
  'fact.path': 'Path',
  'fact.rtt': 'Round trip',
  'fact.chunk': 'Chunk',
  'fact.lanes': 'Lanes',
  'fact.sas': 'Safety words',
  'fact.trust': 'Trust',

  'st.offline': 'offline',
  'st.paused': 'disconnected',
  'st.connecting': 'connecting…',
  'st.relayed': 'encrypted',
  'st.local': 'local network',
  'st.verified': 'verified',
  'st.connected': 'connected',
  'st.unverified': 'not verified',
  'st.disconnectedByYou': 'disconnected by you',

  'ch.local': 'this network',
  'ch.paired': 'paired',
  'ch.room': 'room',
  'ch.code': 'a code',
  /* toasts, and the handful of internal errors that reach one */

  'toast.noStore': 'This browser won’t let the app store anything, so pairings and this device’s name last only for this tab.',
  'toast.relaySwitched': 'Now using {host}. Reloading.',
  'toast.relayKept': 'Kept your encrypted connection',
  'toast.relayOwn': 'Back to this site’s own connection. Reloading.',
  'toast.relayOnly': 'This browser keeps everything on the encrypted connection. Transfers work, and nothing about where you are is ever collected.',
  'toast.reopenFailed': 'Couldn’t reopen the connection',
  'toast.openFailed': 'Couldn’t open a connection',
  'toast.dropped': '{name} dropped. Your place is saved.',
  'toast.relayOffer': '{name}: {why}',
  'toast.relaying': '{name} is on the encrypted connection: {why}',
  'toast.direct': '{name}: now connected directly',
  'toast.resume.one': 'Picking up one file where it left off',
  'toast.resume.many': 'Picking up {n} files where they left off',
  'toast.saved': 'Saved {name}',
  'toast.saveFailed': 'Couldn’t save',
  'toast.saveDialogFailed': 'Couldn’t open the save dialog',
  'toast.codeExpired': 'Code expired',
  'toast.findable': 'Findable with {code}',
  'toast.codeOff': 'Your code no longer works',
  'toast.disconnected': 'Disconnected. It stays that way until you reconnect.',
  'toast.reconnecting': 'Reconnecting…',
  'toast.forgotten': 'Forgotten. Pairing again needs a new code.',
  'toast.reconnectHint': 'Disconnected. Use ⋯ to reconnect.',
  'toast.notOnline': 'That device isn’t online',
  'toast.notConnected': 'That device isn’t connected',
  'toast.offer.one': 'Offered one file to {name}',
  'toast.offer.many': 'Offered {n} files to {name}',
  'toast.sendFailed': 'Couldn’t send',
  'toast.queueFailed': 'Couldn’t start the queued transfer',
  'toast.cancelled': 'Cancelled',
  'toast.verified': 'Verified. No code needed next time.',
  'toast.copyFailed': 'Couldn’t copy',
  'toast.pairLinkCopied': 'Link copied',
  'toast.roomLinkCopied': 'Room link copied',
  'toast.noNotifications': 'This browser has no notifications',
  'toast.notifyBlocked': 'Notifications are blocked for this site in your browser settings',
  'toast.notifyOff': 'Not enabled',
  'toast.codeFailed': 'Couldn’t create a code',
  'toast.staged': 'Ready. Add a device and it will be waiting.',
  'toast.renamed': 'Now known as {name}',
  'toast.installHint': 'Use your browser’s “Install app” or “Add to Home Screen” menu',
  'why.peer': 'the other device can’t connect directly',
  'why.network': 'this network is blocking a direct connection',
  'err.generic': 'Something went wrong',
  'err.keying': 'Couldn’t connect securely to that device',
  'err.stale': 'Reload Gear Drop on that device and try again',
  'err.badCode': 'That code didn’t match',
  'err.busy': 'Another transfer is still arriving',
  'err.tooBig': 'This browser can’t receive a file that large',
  'err.transfer': 'The transfer stopped',
  'err.timeout': 'Timed out',
  'xfer.sent': 'Sent',
  'xfer.declined': 'Declined',
  'xfer.failed': 'Failed',
  'tile.options': 'Device options',
  'tile.unnamed': 'Device',
  /* spoken and hover labels: no visible text of their own */

  'a11y.close': 'Close',
  'a11y.preview': 'Preview of the picture being offered',
  'a11y.devices': 'Devices',
  'a11y.discovery': 'Who can find you',
  'a11y.theme': 'Theme',
  'a11y.qrPair': 'Pairing QR code',
  'a11y.qrRoom': 'Room QR code',
  'a11y.qrPublic': 'Discovery QR code',
  'a11y.qrHint': 'Scan it, or click to copy the link',
  'a11y.codeChar': 'Code character {n}',
  'a11y.roomChar': 'Room character {n}',
  'theme.auto': 'Match the system',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'nav.bench': 'Benchmark',
  'nav.how': 'How it works',
  /* audio in a conversation */

  'chat.audio': 'Audio',
  'chat.voiceNote': 'Voice message',
  'chat.record': 'Record a voice message',
  'chat.recording': 'Recording',
  'chat.saveAudio': 'Save this audio',
  'chat.audioGone': 'This audio is no longer stored on this device',
  'chat.noMic': 'No microphone on this device',
  'chat.micBlocked': 'The microphone is blocked for this site in your browser settings',
  'chat.tooBig': 'Too big for the chat. Sending it as a file.',
  'chat.wrongKind': 'This chat can’t play or show it. Sending it as a file.',
  'chat.play': 'Play',
  'chat.pause': 'Pause',
  'chat.speed': 'Playback speed',
  'chat.audioKind': 'This browser can’t play this one',
  /* the passphrase lock */

  'lock.title': 'Locked',
  'lock.sub': 'This device is protected by a passphrase. Nothing here can be read without it.',
  'lock.passphrase': 'Passphrase',
  'lock.unlock': 'Unlock',
  'lock.wrong': 'That passphrase didn’t work',
  'lock.noReset': 'It can’t be reset. Everything stays locked, so the only way in is to erase it all and start again.',
  'lock.forgot': 'Forgotten it? Start fresh',
  'lock.setting': 'Lock with a passphrase',
  'lock.settingOff': 'Your browser holds the key, so anyone who copies this profile can open it elsewhere.',
  'lock.settingOn': 'The key comes from your passphrase and is never saved anywhere.',
  'lock.turnOn': 'Set',
  'lock.turnOff': 'Remove',
  'lock.removeTitle': 'Remove the passphrase',
  'lock.ask': 'Choose a passphrase. It’s the only way back in. Nothing here can be recovered without it.',
  'lock.askAgain': 'Type it again',
  'lock.askCurrent': 'Current passphrase',
  'lock.mismatch': 'Those didn’t match',
  'lock.tooShort': 'Use at least 12 characters, or keep the suggested one',
  'lock.suggested': 'Suggested',
  'lock.useSuggestion': 'Use this one',
  'lock.show': 'Show',
  'lock.hide': 'Hide',
  'lock.working': 'Locking everything on this device…',
  'lock.done': 'Locked. The key is no longer stored on this device.',
  'lock.removed': 'Passphrase removed',
  'lock.lockNow': 'Lock now',
  'toast.connectedBody': 'Connected',
  'toast.readyBody': 'Ready to save',
  'toast.accept.oneBody': 'Sending you a file',
  'toast.accept.manyBody': 'Sending you {n} files',
  'menu.pair': 'Pair this device',
  'verify.pairs': 'Confirming remembers this device, so you won’t need a code next time.',
  'verify.asked': '{name} asked to pair.',
'toast.outbox.one': 'Sent the message that was waiting',
  'toast.outbox.many': 'Sent {n} messages that were waiting',
};

/*
 * Everything but English is a file.
 *
 * `web/lang/<code>.json` is fetched when that language is chosen, and `web/lang/index.json`
 * lists what exists and how complete each one is. Both are generated from the English table by
 * `scripts/build-lang.mjs`, so a language cannot be offered at a coverage nobody measured, and
 * the template translators work from cannot drift from the keys the app actually asks for.
 */

/** English is not fetched: it is the fallback, and `t()` is called before any fetch returns. */
export const TABLES = { en };

/*
 * Enough to draw the picker before the manifest arrives, and enough to keep working if it never
 * does. Coverage is filled in from the manifest; until then a language claims nothing.
 */
export const LOCALES = [{ code: 'en', native: 'English', english: 'English', dir: 'ltr', coverage: 100 }];

let manifestLoaded = null;

/**
 * Read the list of languages once.
 *
 * Failure is not an error worth showing anyone: the app is already in English, which is the
 * language it would fall back to anyway. It just means the picker offers one entry.
 */
export function loadLocales() {
  manifestLoaded ??= fetch(new URL('../lang/index.json', import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .then((list) => {
      if (!Array.isArray(list) || !list.length) return LOCALES;
      LOCALES.length = 0;
      LOCALES.push(...list);
      return LOCALES;
    })
    .catch(() => LOCALES);
  return manifestLoaded;
}

/**
 * Fetch one language's table, once.
 *
 * A language that fails to load is left out of `TABLES`, so every one of its keys falls through
 * to English. A half-loaded interface is worse than an English one.
 */
async function loadTable(code) {
  if (TABLES[code]) return TABLES[code];
  try {
    const res = await fetch(new URL(`../lang/${code}.json`, import.meta.url));
    if (!res.ok) return null;
    const table = await res.json();
    if (table && typeof table === 'object') TABLES[code] = table;
    return TABLES[code] ?? null;
  } catch {
    return null;
  }
}

let locale = 'en';
let table = en;

export function currentLocale() {
  return locale;
}

/** The browser's preferred language, if it is one we have. */
export function preferredLocale() {
  const have = new Set(LOCALES.map((l) => l.code));
  for (const tag of navigator.languages || [navigator.language || 'en']) {
    const raw = String(tag);
    // Regional first: pt-BR and zh-TW are not interchangeable with pt and zh.
    if (have.has(raw)) return raw;
    const base = raw.toLowerCase().split('-')[0];
    if (have.has(base)) return base;
    const region = LOCALES.find((l) => l.code.toLowerCase().split('-')[0] === base);
    if (region) return region.code;
  }
  return 'en';
}

/**
 * Switch language, fetching it if this is the first time.
 *
 * Async now that a language is a file. Callers that do not wait get English for one frame and
 * the right language immediately after, which is the same thing that happens on a slow network
 * and is why every string has an English fallback rather than a blank.
 */
export async function setLocale(code) {
  const wanted = String(code || 'en');
  /*
   * A table already in hand is reason enough. The manifest says what *can* be fetched; it is not
   * a permission slip for a language that is already loaded, and requiring it would mean a
   * failed manifest could veto a language sitting right there.
   */
  const known = LOCALES.some((l) => l.code === wanted) || TABLES[wanted];
  const loaded = wanted === 'en' ? en : known ? await loadTable(wanted) : null;

  locale = loaded ? wanted : 'en';
  table = loaded || en;
  document.documentElement.lang = locale;
  document.documentElement.dir = LOCALES.find((l) => l.code === locale)?.dir || 'ltr';
  applyTo(document);
  return locale;
}


/** Look up a string, falling back to English, then to the key itself. */
export function t(key, vars) {
  let s = table[key] ?? en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/**
 * Render a translated string into an element. Only <b> is honoured, and it is built as a
 * real element, so nothing here can inject markup even if a string is malformed.
 */
export function setText(el, str) {
  el.replaceChildren();
  for (const part of String(str).split(/(<b>|<\/b>)/)) {
    if (part === '<b>') {
      el.append((el._open = document.createElement('b')));
      continue;
    }
    if (part === '</b>') {
      el._open = null;
      continue;
    }
    if (!part) continue;
    (el._open || el).append(document.createTextNode(part));
  }
  el._open = null;
}

export function applyTo(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    // Translating an element replaces its children, so an element that contains other
    // translated elements is a layout wrapper and must be left alone. Catching it here
    // means a heading with a subtitle inside it cannot silently lose the subtitle.
    if (el.querySelector('[data-i18n]')) continue;
    setText(el, t(el.dataset.i18n));
  }
  /*
   * A tooltip is not a name.
   *
   * `title` shows on hover, which a keyboard does not do and a screen reader does not read;
   * a button whose only content is an icon has nothing else to be announced as, so it is
   * announced as "button" and the person operating it has to guess. Where the element has no
   * text of its own the title doubles as the accessible name, which is the case it was
   * written for. Where it does have text, that text is the name and this leaves it alone.
   */
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const label = t(el.dataset.i18nTitle);
    el.title = label;
    if (!el.textContent.trim()) el.setAttribute('aria-label', label);
  }
  // `data-i18n-n` carries the one number a label may need: the boxes a code is typed into
  // are "Code character 1" through 6, and six near-identical keys would be six chances to
  // mistranslate the same sentence.
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    const n = el.dataset.i18nN;
    el.setAttribute('aria-label', t(el.dataset.i18nLabel, n ? { n } : undefined));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}
