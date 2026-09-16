/**
 * Conversation storage. Local only, sealed with the vault key.
 *
 * Paired peers get a durable log. `chan:` and `code:` identities are re-rolled per session,
 * so a log stored under one would outlive the identity it belongs to; those stay in memory
 * and go with the tab.
 */

import { chats, attachments } from './store.js';
import { seal, unseal } from './vault.js';

const te = new TextEncoder();
const td = new TextDecoder();

/** Messages kept per conversation. Oldest are dropped past this. */
const MAX_MESSAGES = 300;

/** The longest single message that will be stored, in characters. */
export const MAX_TEXT = 8192;

/** Larger pictures still send, but as an ordinary file rather than inline. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

/** Songs are bigger than pictures. A few minutes of anything ordinary fits well inside this. */
export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

/**
 * Types drawn inline. SVG is excluded on purpose: these bytes are also offered back as a
 * file, and an SVG opened at the top level of this origin runs with our storage.
 */
export const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  /*
   * What an iPhone actually produces.
   *
   * Left out, every photo taken on a phone reached a conversation as a plain file with a
   * download button, which is not what anybody means by sending a picture. They are here on
   * the same terms as AVIF: the list is what a sender might hold, not what every receiver can
   * draw, and a browser that cannot draw one says so and still offers the bytes.
   *
   * Unlike SVG above, none of these can carry script, so accepting them grants nothing.
   */
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

/**
 * Types played inline.
 *
 * What a browser will decode varies, with no Ogg in Safari and no ALAC in Firefox, so the
 * list is what a player is willing to be handed. A codec it cannot decode surfaces as a
 * player that says so rather than a refusal to send. `audio/mp4` and `audio/x-m4a` are the
 * same container under two names that different systems report.
 */
export const AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
]);

const typeOf = (mime) => String(mime || '').toLowerCase().split(';')[0].trim();

/** Whether this is something the conversation should hold on to and draw. */
export function isImage(mime, size) {
  return IMAGE_TYPES.has(typeOf(mime)) && size > 0 && size <= MAX_IMAGE_BYTES;
}

/** The same question for something to play. */
export function isAudio(mime, size) {
  return AUDIO_TYPES.has(typeOf(mime)) && size > 0 && size <= MAX_AUDIO_BYTES;
}

/** Which of the two this is, or '' for anything that travels as an ordinary file. */
export function mediaKind(mime, size) {
  if (isImage(mime, size)) return 'image';
  if (isAudio(mime, size)) return 'audio';
  return '';
}

/** The cap that applies to a type, for saying why something was too big to keep inline. */
export function mediaLimit(mime) {
  return AUDIO_TYPES.has(typeOf(mime)) ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
}

/**
 * The longest a length may claim to be.
 *
 * Not a limit on what can be sent, but a guard against a number that cannot be true. A WebM
 * written live has no duration in its header, and browsers disagree about what to report for
 * one: some say `Infinity`, some a very large finite number, some the right answer. A finite
 * absurdity is the dangerous shape, because every `isFinite` check waves it through and a
 * four-second recording then renders as several million minutes.
 */
export const MAX_DURATION = 6 * 60 * 60;

/** A length that can be believed, or 0. */
export function plausibleDuration(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_DURATION ? n : 0;
}

/** Bars in a waveform. Enough to read as a shape, few enough to stay legible on a phone. */
export const PEAK_BARS = 44;

/**
 * Past this, no waveform is drawn.
 *
 * Decoding uncompresses a whole track into memory to measure it, on the thread drawing the
 * conversation. A voice message is a few hundred kilobytes and a short clip a few megabytes;
 * an album track gets a plain progress bar instead.
 */
export const PEAK_MAX_BYTES = 12 * 1024 * 1024;

/** A message id that sorts by time and does not collide within a millisecond. */
function messageId(at) {
  const r = crypto.getRandomValues(new Uint8Array(4));
  return `${at.toString(36)}-${[...r].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Conversations with peers whose identity does not outlive the tab. */
const session = new Map();

/** Their attachments, held the same way. */
const sessionAtt = new Map();

/** `<peer>|<random>`, so the prefix finds a conversation's attachments without reading them. */
function attachmentId(peerId) {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return `${peerId}|${[...r].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const attachmentPeer = (id) => {
  const i = String(id).indexOf('|');
  return i < 0 ? '' : String(id).slice(0, i);
};

/** Store one attachment, sealed, and return the reference the log will hold. */
export async function putAttachment(peerId, bytes) {
  if (!peerId || !bytes?.length) return null;
  const id = attachmentId(peerId);

  if (!isDurable(peerId)) {
    sessionAtt.set(id, bytes);
    return id;
  }
  await attachments.put({ id, at: Date.now(), sealed: await seal(bytes) });
  return id;
}

/** The bytes back, or null if this browser can no longer read them. */
export async function getAttachment(id) {
  if (!id) return null;
  if (sessionAtt.has(id)) return sessionAtt.get(id);
  const rec = await attachments.get(id).catch(() => null);
  return rec ? await unseal(rec.sealed) : null;
}

/** Destroy specific attachments. Used when a message ages out of the log. */
async function dropAttachments(ids) {
  for (const id of ids) {
    if (!id) continue;
    sessionAtt.delete(id);
    await attachments.del(id).catch(() => {});
  }
}

/**
 * Drop every attachment for one conversation, by key prefix, so a log that can no longer be
 * unsealed still has its bytes removed.
 */
async function dropPeerAttachments(peerId) {
  for (const id of [...sessionAtt.keys()]) {
    if (attachmentPeer(id) === peerId) sessionAtt.delete(id);
  }
  const keys = await attachments.keys().catch(() => []);
  for (const id of keys) {
    if (attachmentPeer(id) === peerId) await attachments.del(id).catch(() => {});
  }
}

/**
 * Whether this peer's id survives the session. The UI needs it too: a non-durable id stops
 * resolving the moment that device leaves, so the chat says "gone" rather than "offline".
 */
export const isDurable = (peerId) => !!peerId && !peerId.startsWith('chan:') && !peerId.startsWith('code:');

/**
 * Read one conversation. Empty for a peer never spoken to; `locked` when a record exists but
 * was sealed under a key this browser no longer has.
 */
export async function load(peerId) {
  if (!peerId) return { messages: [], locked: false };
  if (!isDurable(peerId)) return { messages: session.get(peerId) || [], locked: false, ephemeral: true };

  const rec = await chats.get(peerId).catch(() => null);
  if (!rec) return { messages: [], locked: false };

  const bytes = await unseal(rec.sealed);
  if (!bytes) return { messages: [], locked: true };

  try {
    const parsed = JSON.parse(td.decode(bytes));
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return { messages, locked: false };
  } catch {
    return { messages: [], locked: true };
  }
}

/** Write a whole conversation back, sealed. */
async function save(peerId, messages) {
  const trimmed = messages.slice(-MAX_MESSAGES);

  /*
   * A message that ages out takes its attachment with it.
   *
   * Without this the log stays capped at three hundred entries while the bytes behind the
   * ones it dropped stay on the disk forever, referenced by nothing and deleted by nothing -
   * the conversation would look bounded and the storage it uses would not be.
   */
  if (trimmed.length < messages.length) {
    const kept = new Set(trimmed.map((m) => m.att).filter(Boolean));
    const dropped = messages
      .slice(0, messages.length - trimmed.length)
      .map((m) => m.att)
      .filter((a) => a && !kept.has(a));
    if (dropped.length) await dropAttachments(dropped);
  }

  const sealed = await seal(te.encode(JSON.stringify({ v: 1, messages: trimmed })));
  await chats.put({ id: peerId, updated: Date.now(), sealed });
  return trimmed;
}

/**
 * One writer at a time, per conversation.
 *
 * Appending is read, modify, write with awaits in between: a decrypt, a JSON parse, an
 * encrypt, a database round trip. Three messages arriving in quick succession each read the
 * same log before any has written, and the last write wins, so the other two are lost and the
 * same message can appear twice where two copies of one read were saved.
 *
 * It showed up once an outbox existed, because a flush delivers several messages as fast as
 * the link will take them, but nothing about it needed an outbox: a burst of ordinary messages
 * did the same thing.
 *
 * Each conversation gets a chain, so its writes run in the order they were asked for. Keyed
 * per peer rather than globally, since two conversations need not wait on each other.
 */
const writers = new Map();

function serialise(peerId, work) {
  const queued = (writers.get(peerId) || Promise.resolve()).then(work, work);
  // The chain must not keep a rejection, or every later write to this conversation inherits it.
  writers.set(peerId, queued.then(() => {}, () => {}));
  return queued;
}

/**
 * Add one message and return the conversation it belongs to.
 *
 * Read, append, write, rather than keeping a copy in memory and flushing it. Two tabs of this
 * app on the same machine share one database, and a log held in a variable in one of them
 * would overwrite whatever the other had written. The cost is a read per message.
 */
export function append(peerId, message) {
  return serialise(peerId, () => appendNow(peerId, message));
}

async function appendNow(peerId, { dir, text, media, pending = false }) {
  // A picture or a recording is a message with no words in it, so "nothing to add" has two
  // shapes.
  if (!peerId || (!text && !media)) return { messages: [], locked: false };

  const at = Date.now();
  const msg = {
    id: messageId(at),
    dir: dir === 'out' ? 'out' : 'in',
    text: String(text || '').slice(0, MAX_TEXT),
    at,
  };

  /*
   * Written, but not yet said.
   *
   * A message to a device that is not here is kept rather than refused: the conversation is
   * durable and so is the device's identity, so there will be a next time. It carries the
   * flag until it has actually gone out, which is what stops a reconnect re-sending the whole
   * history and what lets the log show the difference between sent and waiting.
   */
  if (pending) msg.pending = true;

  /*
   * What is stored about an attachment, and what is not.
   *
   * The name and the type sit in the conversation record, which is sealed; only the reference
   * and the size are outside it, in the attachment row. Keeping the size here as well means a
   * log that has lost its attachments - a half-finished delete, a database copied without its
 * key - can still be drawn as it stands, showing that something was sent and how big it was,
   * rather than silently omitting it.
   *
   * `dur` is the one thing a player needs before the bytes are decrypted: how long this is.
   * Without it a recording draws a zero-length scrubber until the blob resolves.
   */
  if (media) {
    msg.kind = media.kind === 'audio' ? 'audio' : 'image';
    msg.att = media.att;
    msg.name = String(media.name || msg.kind).slice(0, 260);
    msg.mime = String(media.mime || '').slice(0, 100);
    msg.size = Number(media.size) || 0;
    const dur = plausibleDuration(media.dur);
    if (dur) msg.dur = Math.round(dur);
    if (media.voice) msg.voice = true;
    // The waveform, drawn once when the bytes arrive rather than every time the log is.
    // Small enough to live in the record: one byte a bar, and the record is sealed anyway.
    if (Array.isArray(media.peaks) && media.peaks.length) {
      msg.peaks = media.peaks.slice(0, PEAK_BARS).map((p) => Math.max(0, Math.min(15, p | 0)));
    }
  }

  if (!isDurable(peerId)) {
    const next = [...(session.get(peerId) || []), msg].slice(-MAX_MESSAGES);
    session.set(peerId, next);
    return { messages: next, locked: false, ephemeral: true };
  }

  const { messages, locked } = await load(peerId);
  // A locked log cannot be appended to without destroying what is already in it. Better to
  // keep the unreadable record and let this message live only on screen.
  if (locked) return { messages: [msg], locked: true };

  const next = await save(peerId, [...messages, msg]);
  return { messages: next, locked: false };
}

/** Everything still waiting to go to this device, oldest first. */
export async function pendingFor(peerId) {
  const { messages } = await load(peerId);
  return messages.filter((m) => m.pending);
}

/**
 * Mark messages as delivered.
 *
 * By id rather than by position. The log can have grown underneath this, with a reply
 * arriving mid-flush being the ordinary case, and clearing a flag by index would clear the
 * wrong one.
 */
export function markSent(peerId, ids) {
  return serialise(peerId, () => markSentNow(peerId, ids));
}

async function markSentNow(peerId, ids) {
  if (!peerId || !ids?.length) return;
  const done = new Set(ids);
  if (!isDurable(peerId)) {
    const held = session.get(peerId);
    if (held) for (const m of held) if (done.has(m.id)) delete m.pending;
    return;
  }
  const { messages, locked } = await load(peerId);
  if (locked) return;
  let touched = false;
  for (const m of messages) {
    if (done.has(m.id) && m.pending) {
      delete m.pending;
      touched = true;
    }
  }
  if (touched) await save(peerId, messages);
}

/** Forget one conversation. Called when a device is unpaired, and from the chat itself. */
export async function clear(peerId) {
  if (!peerId) return;
  session.delete(peerId);
  await chats.del(peerId).catch(() => {});
  // The attachments are the conversation as much as the words are; deleting one has to be
  // deleting both, or "delete this conversation" is not true.
  await dropPeerAttachments(peerId);
}

/**
 * Drop conversations that can never be opened again.
 *
 * Two kinds. A `chan:` or `code:` row should not exist at all now - those identities do not
 * outlive a session, so a durable log against one is addressed to nobody - but an earlier
 * version of this file wrote them before that rule existed, and an upgrade should not leave
 * its own litter behind. And a row for a peer that has since been unpaired is the same thing
 * arrived at differently: unpairing is meant to leave nothing, so anything that survived it,
 * by a crash or a half-finished delete, goes here.
 *
 * Runs once at startup, deletes nothing that is still reachable, and is silent.
 */
export async function sweep(pairedIds) {
  const keep = new Set(pairedIds || []);
  const all = await chats.all().catch(() => []);
  const alive = new Set();
  for (const rec of all) {
    if (isDurable(rec.id) && keep.has(rec.id)) {
      alive.add(rec.id);
      continue;
    }
    await chats.del(rec.id).catch(() => {});
  }

  /*
   * And any picture whose conversation is not one of the survivors.
   *
   * This catches more than the rows deleted just above. An attachment is written before the
   * message that refers to it, so a tab closed in between leaves one behind that nothing will
   * ever ask for; so does a delete interrupted half way. Sweeping by conversation rather than
   * by message means neither case needs to be anticipated - anything not belonging to a
   * conversation that still exists is not worth keeping.
   */
  const keys = await attachments.keys().catch(() => []);
  for (const id of keys) {
    if (!alive.has(attachmentPeer(id))) await attachments.del(id).catch(() => {});
  }
}
