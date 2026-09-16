/**
 * Transfer engine.
 *
 * Sender:   slice → seal (AES-GCM) → hash → lane with the shortest queue
 * Receiver: verify → write through to a streaming sink → durable ack
 *
 * Design choices that separate this from every browser transfer app we measured:
 *   · no application-level ACK gates the pipe (acks exist only for durability/resume)
 *   · a read-ahead queue keeps the SCTP buffer full while chunks are being encrypted
 *   · chunks carry absolute offsets, so lanes are order-independent and resume is exact
 *   · nothing is ever accumulated in memory on either side
 */
import { concat, te, td, u32le, u64le, toHex, equal, pad, unpad } from './bytes.js';
import { hkdf, aeadKey, seal, open, sha256 } from './gdcrypto.js';
import { createSink, offerDownload, sinkCapabilities, pickDestinationDirectory } from './sink.js';
import { transfers as transferStore } from './store.js';
import { ReplayWindow, ratchetPair } from './session.js';
import { addRange, contiguous, covered } from './ranges.js';
import { safeFileName } from './filename.js';
import { plausibleDuration } from './chat.js';
import { checkThumb } from './thumb.js';

const VER = 1;
const HDR = 18; // ver(1) lane(1) fileId(4) offset(8) index(4)
/**
 * The smallest chunk any sender is allowed to negotiate (transport.js CHUNK_MIN). The
 * receiver uses it to bound a chunk index against the size it was offered, because index
 * and offset arrive from the peer and are used to size an array and to position a write.
 */
const MIN_CHUNK = 16 * 1024;
/** Padding granularity for control frames, and the wider one used for messages. */
const CTL_BLOCK = 256;
const TEXT_BLOCK = 1024;

const MAX_TEXT = 32 * 1024;
const READ_AHEAD = 6; // prepared frames kept in flight
const ACK_EVERY = 4 * 1024 * 1024;

/*
 * Bounds on what an offer may claim. An authenticated channel proves the manifest came from
 * the peer, not that the peer means well: `Infinity` for a size defeats the per-file chunk
 * ceiling, a hundred thousand entries freeze the tab before anyone agrees to receive, and a
 * repeated transfer id replaces one in flight.
 *
 * Checked before it becomes state, and refused whole rather than clamped. Clamping keeps a
 * hostile offer alive in a shape we guessed at.
 */
const MAX_FILES = 4096;
const MAX_NAME = 1024;
const MAX_OFFERS = 32; // offers held at once, waiting on a decision
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/*
 * Ids index a Map, which is immune to these, and that is true of the code as it stands
 * today. It is one refactor to a plain object away from not being true, and the cost of
 * saying so here is a set lookup on a path that runs once per offer.
 */
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
/** A file id is the index carried in the 4-byte chunk header, so it is a small integer. */
const isFileId = (n) => Number.isInteger(n) && n >= 0 && n < MAX_FILES;

/** A finite, non-negative, whole number of bytes, and nothing else. */
const isSize = (n) => Number.isSafeInteger(n) && n >= 0;

/*
 * The same, for what a receiver may claim. Acknowledging, rewinding and accepting all drive
 * the sender, and all carry a file id that was used as an array index. `"__proto__"` there
 * returns Array.prototype, and the assignment after it lands on every array on the page. A
 * `NaN` in an acknowledgement stalls the transfer permanently.
 */

/** The entry that id refers to, or null. Never a prototype, never an inherited property. */
function outEntry(job, fileId) {
  if (!Number.isInteger(fileId) || fileId < 0 || fileId >= job.entries.length) return null;
  return job.entries[fileId] || null;
}

/** A byte position inside a file of this size, whatever was actually sent. */
function clampOffset(v, size) {
  if (!Number.isFinite(v)) return null;
  return Math.max(0, Math.min(Math.floor(v), size));
}

/**
 * @returns {{files: Array, total: number} | null} the offer, normalised, or null to refuse.
 */
export function checkManifest(msg, live) {
  if (!msg || typeof msg.transferId !== 'string' || !ID_RE.test(msg.transferId)) return null;
  if (RESERVED.has(msg.transferId)) return null;
  if (live.has(msg.transferId)) return null; // a second offer under a live id
  if (live.size >= MAX_OFFERS) return null; // nobody has thirty-two pending decisions

  const files = msg.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return null;

  const ids = new Set();
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return null;
    if (!isFileId(f.id) || ids.has(f.id)) return null;
    ids.add(f.id);
    if (!isSize(f.size)) return null;
    const name = f.path ?? f.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME) return null;
    total += f.size;
    if (!isSize(total)) return null;
  }

  /*
   * Whether the sender meant this for the conversation rather than for the disk.
   *
   * Narrowed to a real boolean rather than passed through, because it decides which of two
   * paths the receiving side takes and one of those paths can skip the confirmation sheet.
   * A truthy object arriving here must not become a truthy flag there.
   *
   * It is a hint about presentation and nothing more. It grants no permission by itself: the
   * receiver still checks the type, the size and who is asking before anything is accepted
   * without being asked about.
   */
  // The stated total is a claim about the same files, so it is recomputed rather than
  // believed: it is what the person is shown before they agree.
  return {
    files,
    total,
    chat: msg.chat === true,
    voice: msg.voice === true,
    // A claim from the far end, so it is bounded here rather than believed.
    dur: plausibleDuration(msg.dur),
    /*
     * The one part of an offer that is content rather than a description of it.
     *
     * Checked for shape, length and alphabet before it goes anywhere near an image decoder,
     * and copied rather than passed through, so what the sheet later draws is this value and
     * not whatever the object it came from decides to return the second time it is read.
     * Anything that fails is dropped, not refused: an offer with a malformed preview is
     * still a perfectly good offer of a file.
     */
    thumb: checkThumb(msg.thumb),
  };
}

export class TransferManager extends EventTarget {
  constructor({ transport, session }) {
    super();
    this.session = session;
    this.out = new Map(); // transferId -> sending job
    this.in = new Map(); // transferId -> receiving job
    this._keyGen = null;
    this._ctlWindow = new ReplayWindow();
    this._ctl = null;
    this.attachTransport(transport);
  }

  /**
   * Bind to a transport, including a replacement one after the connection dropped.
   *
   * Surviving a reconnect is what resume is built on: the jobs, their sinks and their
   * received-range bookkeeping stay where they were, and only the plumbing under them is
   * swapped. Keys are re-derived because the session re-keys on every reconnect, so no key is
   * reused across two connections.
   */
  async attachTransport(transport) {
    this.transport = transport;
    this._ctlOut = null;

    // Counters may only restart when the key changes. A transport swap that does not re-key,
    // such as moving between the data channel and the relay, keeps the same control key, so
    // resetting the sequence would reuse a nonce under it. Tied to the session generation
    // rather than to the act of attaching.
    const gen = this.session.generation;
    if (gen !== this._keyGen) {
      this._keyGen = gen;
      // A new session key is a new pair of chains. The old ones are zeroed rather than
      // dropped, so what they could still have derived goes with them.
      this._ctl?.out.destroy();
      this._ctl?.in.destroy();
      this._ctlWindow = new ReplayWindow();
      this._ctl = null;
      for (const job of [...this.in.values(), ...this.out.values()]) {
        job.key = await this.session.transferKey(job.transferId);
      }
    }

    transport.addEventListener('ctl', (e) => this._onCtlFrame(e.detail));
    transport.addEventListener('chunk', (e) => this._onChunk(e.detail));
  }

  /**
   * Ask for everything still missing. The receiver drives this, because it is the only
   * side that knows what actually reached the disk.
   */
  async resumeAll() {
    let resumed = 0;
    for (const job of this.in.values()) {
      if (job.state !== 'receiving') continue;
      for (const [fileId, entry] of job.entries) {
        if (entry.received >= entry.size) continue;
        await this._sendCtl({
          t: 'resume',
          transferId: job.transferId,
          fileId,
          from: entry.contiguous,
        });
        resumed++;
      }
    }
    if (resumed) {
      this.dispatchEvent(new CustomEvent('resumed', { detail: { files: resumed } }));
    }
    return resumed;
  }

  async _ctlChains() {
    if (!this._ctl) this._ctl = await ratchetPair(this.session.K, this.session.lane);
    return this._ctl;
  }

  /* ----------------------------------------------------------- control io */

  /**
   * Serialised, so sequence order on the wire matches the counter order.
   *
   * `block` is the padding granularity. Control traffic is short and structural, so 256
   * bytes hides a file name; a message is written by a person and its length says
   * something about it, so text pads to a kilobyte.
   */
  _sendCtl(obj, block = CTL_BLOCK) {
    const done = (this._ctlOut || Promise.resolve()).then(async () => {
      const ctl = await this._ctlChains();

      /*
       * Nothing is minted for a link that cannot carry it.
       *
       * The chain steps on `send`, not on delivery, so every frame sealed into a dead channel
       * moves this side one place further from the peer's. The receiver tolerates a gap of
       * MAX_SKIP and refuses anything beyond it, so a few hundred frames written into a
       * transport that is not there desynchronises the chains permanently. The connection
       * afterwards looks healthy while every control frame is refused.
       *
       * Failing here is recoverable: the caller learns the frame did not go, the resume paths
       * handle that, and the chains stay in step. A channel that closes between this check and
       * the send costs one key, which is what the window absorbs.
       *
       * Asked explicitly rather than with `canSendCtl?.()`, which reads as a null check and is
       * not one. On a transport without the method it yields undefined, fails the test, and
       * throws on every control frame. That shape is reachable whenever a page runs two builds
       * at once, one module from the cache beside one from the network. A transport that says
       * no is believed; one with no opinion is given the benefit of the doubt, and its
       * `sendCtl` still reports below.
       */
      const ask = this.transport.canSendCtl;
      if (typeof ask === 'function' && !ask.call(this.transport)) {
        throw new Error('control path is not open');
      }

      // One key, one frame. The chain steps here and the value that produced it is gone.
      const { seq, key } = await ctl.out.send();
      const nonce = new Uint8Array(12);
      nonce[0] = this.session.lane;
      nonce.set(u64le(seq), 4);
      // Padded to a block boundary so a file name's length is not readable from the
      // ciphertext size, which is the metadata leak that survives naive encryption.
      const ct = await seal(key, nonce, pad(te.encode(JSON.stringify(obj)), block), te.encode('gd/ctl'));
      const out = new Uint8Array(8 + ct.length);
      out.set(u64le(seq), 0);
      out.set(ct, 8);
      // A channel that closed in the meantime: the key is spent and the gap widens by one,
      // which the window absorbs. The caller is still told, because it did not go.
      if (!this.transport.sendCtl(out)) throw new Error('control frame was not sent');
    });

    /*
     * The tail is what the next send waits on, and it has to survive a failure.
     *
     * Chaining the raw promise looked right and was not. One rejected send left `_ctlOut`
     * rejected, and every later `.then` on it short-circuited without running: no manifests,
     * no accepts, no acks, no messages. A single oversized or failed frame ended the
     * conversation for the rest of the session, which any peer could trigger on purpose.
     *
     * The ordering chain always resolves, and the caller still gets the real error.
     */
    this._ctlOut = done.catch(() => {});
    return done;
  }

  /**
   * Authenticate a control frame before it may move the replay window.
   *
   * On the relay path the sequence number is the relay's claim until it decrypts. Advancing
   * on that claim let one invented frame near 2^63 push the window past every real one, which
   * silently ended the session, or claim the sequences the peer was about to use.
   */
  async _onCtlFrame(data) {
    try {
      const buf = asBytes(data);
      if (buf.length < 9) return;
      const seq = Number(new DataView(buf.buffer, buf.byteOffset, 8).getBigUint64(0, true));
      if (!Number.isSafeInteger(seq) || seq < 0) return;

      const ctl = await this._ctlChains();
      /*
       * The key for this frame, derived without committing to it.
       *
       * Reaching a sequence the chain has not got to yet means walking it forward, and the
       * sequence is the sender's claim until the frame decrypts. Walking the real chain on a
       * claim would let one invented frame far ahead strand every honest one behind it, so
       * the walk happens on a copy and is kept only if the frame proves itself.
       */
      const step = await ctl.in.receive(seq);
      if (!step) return; // too far ahead, or a key that has already been used and destroyed

      const nonce = new Uint8Array(12);
      nonce[0] = this.session.lane ^ 1;
      nonce.set(u64le(seq), 4);

      let pt;
      try {
        pt = await open(step.key, nonce, buf.subarray(8), te.encode('gd/ctl'));
      } catch {
        return; // not from the peer: nothing to report and nothing to change
      }
      if (!this._ctlWindow.accept(seq)) return; // genuine, but already seen

      // Authenticated. Now the chain may move, and the key it used stops existing.
      step.commit();

      await this._onCtl(JSON.parse(td.decode(unpad(pt))));
    } catch {
      this.dispatchEvent(new CustomEvent('error', { detail: new Error('control frame rejected') }));
    }
  }

  async _onCtl(msg) {
    /*
     * A control frame's plaintext is whatever JSON it turned out to be.
     *
     * It has authenticated by the time it reaches here, so this is not about a stranger -
     * it is that `JSON.parse('null')` is `null` and `JSON.parse('7')` is a number, and
     * reading `.t` off either throws. The caller catches it and reports a rejected frame,
     * so nothing crashes today; it is still a throw standing in for a check, and the next
     * caller may not have the try.
     */
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    switch (msg.t) {
      case 'manifest':
        return this._onManifest(msg);
      case 'accept':
        return this._onAccept(msg);
      case 'decline':
        return this._onDecline(msg);
      case 'ack':
        return this._onAck(msg);
      case 'resume':
        return this._onResume(msg);
      case 'done':
        return this._onDone(msg);
      case 'abort':
        return this._onAbort(msg);
      case 'rename':
        return this.dispatchEvent(new CustomEvent('peer-name', { detail: msg.name }));
      case 'text':
        // Bounded on the way in as well as on the way out: the sender's limit is the
        // sender's, and this one arrives from someone else.
        return this.dispatchEvent(
          new CustomEvent('text', { detail: String(msg.body ?? '').slice(0, MAX_TEXT) }),
        );
      case 'bye':
        /*
         * The other device is going, and is saying so rather than being noticed.
         *
         * Without this the far end learns of a deliberate disconnect the same way it learns
         * of a cable being pulled: by waiting for ICE to give up, which takes seconds of
         * consent failures. In that window it shows a healthy connection, offers to send over
         * it, and refuses a fresh handshake because it believes it already has one. Saying so
         * costs one frame and turns a reconnect from a timeout into a round trip.
         *
         * It carries nothing, so there is nothing to lie about: the only claim is "I am
         * going", made by a device already authenticated on this channel, about itself.
         */
        return this.dispatchEvent(new CustomEvent('bye'));
      case 'wipe':
        /*
         * The other device is destroying this conversation and is telling us to do the same.
         *
         * It carries nothing - no id, no reason, no list of what to remove. There is one
         * conversation between these two devices and the frame arrives sealed under a key only
         * they hold, so which conversation is meant is already settled by the fact that it
         * decrypted at all. Nothing in it needs checking because there is nothing in it.
         */
        return this.dispatchEvent(new CustomEvent('wipe'));
      case 'wiped':
        /*
         * The other device has destroyed its copy and is saying so.
         *
         * This is what makes an erase that crosses a disconnection finishable. Without it the
         * sender can only know it handed a frame to a socket, which is not the same as the
         * frame arriving - a connection that dies in that instant would leave the sender
         * believing the other copy was gone. The sender keeps asking until this comes back.
         */
        return this.dispatchEvent(new CustomEvent('wipe-ack'));
    }
  }

  /* -------------------------------------------------------------- sending */

  /**
   * Send a short message. It rides the same sealed control channel as everything else, so
   * the relay sees ciphertext padded to a block boundary, not even its length.
   */
  sendText(text) {
    return this._sendCtl(
      { t: 'text', body: String(text).slice(0, MAX_TEXT) },
      TEXT_BLOCK,
    );
  }

  /**
   * Tell the other device to destroy the conversation it holds with this one.
   *
   * Best effort by design. A device that is off, or already gone from the network, will never
   * receive it, and the answer is not to retry or queue it: a queue of "delete this later" is
   * itself a record of what was said and to whom. This side guarantees its own copy, which it
   * destroys whether or not the frame is delivered.
   *
   * It rides the same sealed control channel as everything else, so the relay learns that two
   * devices exchanged a frame and not one thing about what it asked for.
   */
  sendWipe() {
    return this._sendCtl({ t: 'wipe' });
  }

  /** Tell the peer this side is closing, so it does not wait for ICE to work it out. */
  sendBye() {
    return this._sendCtl({ t: 'bye' });
  }

  /**
   * Confirm that this device has destroyed the conversation it was asked to.
   *
   * Sent whether or not there was anything to destroy. "I have nothing" and "I had something
   * and it is gone" are the same fact to the other side, and a device that stayed silent
   * because its copy was already empty would leave the sender retrying forever.
   */
  sendWipeAck() {
    return this._sendCtl({ t: 'wiped' });
  }

  /**
   * Offer files to the peer. Returns the transferId.
   *
   * `chat` marks the offer as belonging to an open conversation, which is what lets a picture
   * arrive in the chat instead of as a save prompt. It changes nothing about how the bytes
   * travel: same sealed frames, same per-transfer key, same integrity check at the end.
   */
  async offer(files, { chat = false, voice = false, dur = 0, thumb = null } = {}) {
    const transferId = toHex(crypto.getRandomValues(new Uint8Array(8)));
    const entries = [];
    let total = 0;
    files.forEach((file, i) => {
      entries.push({
        id: i,
        file,
        name: file.name,
        path: file.path || file.webkitRelativePath || file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        offset: 0,
        acked: 0,
        hashes: [],
      });
      total += file.size;
    });

    const job = {
      transferId,
      entries,
      total,
      sent: 0,
      startedAt: 0,
      state: 'offered',
      key: await this.session.transferKey(transferId),
      chunkSize: this.transport.chunkSize,
    };
    this.out.set(transferId, job);

    await this._sendCtl({
      t: 'manifest',
      transferId,
      total,
      chat: chat === true,
      // Presentation only, like `chat`: these decide how the other side draws the message,
      // and grant nothing.
      voice: voice === true,
      /*
       * How long it runs, measured here rather than left for the other end to work out.
       *
       * A recording's container is written while it is still being recorded, so its header
       * carries no length and browsers disagree about what to report: some say `Infinity`,
       * some a number so large it renders as millions of minutes. The sender held a clock, so
       * that is the number, and it travels with the file.
       */
      dur: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0,
      /*
       * A rendering of the picture, when there is one picture and the browser could make one.
       *
       * It is the only thing in an offer that travels before the answer does. The caller
       * decides whether to make one at all; this end only puts it in the frame, and checks
       * it on the way out for the same reason the receiver checks it on the way in - so a
       * bug on this side cannot send a frame the other side will refuse.
       */
      thumb: checkThumb(thumb),
      files: entries.map((e) => ({ id: e.id, name: e.name, path: e.path, size: e.size, mime: e.mime })),
    });

    this.dispatchEvent(new CustomEvent('offered', { detail: { transferId, total, count: files.length } }));
    return transferId;
  }

  async _onAccept(msg) {
    const job = this.out.get(msg.transferId);
    if (!job) return;
    // Idempotent: a second acceptance must not start a second send loop, or the two
    // loops race on the same offsets and the receiver never becomes whole.
    if (job.state === 'sending' || job.state === 'sent') return;
    job.state = 'sending';
    job.startedAt = performance.now();
    job.accepted = new Set(Array.isArray(msg.files) ? msg.files.filter(Number.isInteger) : []);
    // A reconnecting receiver tells us what it already has, as a position in a file we are
    // holding rather than an arbitrary number we start reading from.
    if (msg.have && typeof msg.have === 'object') {
      for (const e of job.entries) {
        const got = clampOffset(msg.have[e.id], e.size);
        if (got !== null) e.offset = e.acked = got;
      }
    }
    this.dispatchEvent(new CustomEvent('accepted', { detail: { transferId: msg.transferId } }));
    this._pump(job).catch((err) =>
      this.dispatchEvent(new CustomEvent('error', { detail: err })),
    );
  }

  _onDecline(msg) {
    const job = this.out.get(msg.transferId);
    if (!job) return;
    this.out.delete(msg.transferId);
    this.dispatchEvent(new CustomEvent('declined', { detail: { transferId: msg.transferId } }));
  }

  _onAck(msg) {
    const job = this.out.get(msg.transferId);
    if (!job) return;
    const entry = outEntry(job, msg.fileId);
    if (!entry) return;
    const upto = clampOffset(msg.upto, entry.size);
    if (upto === null) return;
    entry.acked = Math.max(entry.acked, upto);
  }

  /**
   * The receiver told us where it actually got to. Rewind to that offset and start sending
   * again, whether we stopped because the link died or because we thought we were finished.
   */
  async _onResume(msg) {
    const job = this.out.get(msg.transferId);
    if (!job) return;
    const entry = outEntry(job, msg.fileId);
    if (!entry) return;

    const from = clampOffset(msg.from, entry.size);
    if (from === null) return;
    entry.offset = from;
    entry.acked = entry.offset;
    job.sent = job.entries.reduce((n, e) => n + e.offset, 0);
    job.state = 'sending';

    this.dispatchEvent(
      new CustomEvent('resuming', {
        detail: { transferId: job.transferId, fileId: msg.fileId, from: entry.offset },
      }),
    );

    this._kick(job);
  }

  /**
   * Start the send loop, waiting for any previous one to finish unwinding first.
   *
   * When a link dies, the old loop can still be parked in a drain() when the resume
   * arrives on the new one. Starting a second loop then would race two writers over the
   * same offsets; refusing to start would strand the transfer. So: retry shortly.
   */
  _kick(job, tries = 0) {
    if (job.pumping) {
      if (tries < 40) setTimeout(() => this._kick(job, tries + 1), 120);
      return;
    }
    if (job.state !== 'sending' || this.transport.closed) return;
    job.startedAt = performance.now();
    this._pump(job).catch((err) => this.dispatchEvent(new CustomEvent('error', { detail: err })));
  }

  /**
   * The send loop. Keeps READ_AHEAD frames prepared so encryption and disk reads never
   * leave the SCTP send buffer empty, and yields only when the buffer is genuinely full.
   */
  async _pump(job) {
    job.pumping = true;
    const myTransport = this.transport;
    const pending = [];
    let nextEntry = 0;

    const prepare = async () => {
      while (nextEntry < job.entries.length) {
        const entry = job.entries[nextEntry];
        if (job.accepted && !job.accepted.has(entry.id)) {
          nextEntry++;
          continue;
        }
        if (entry.offset >= entry.size) {
          nextEntry++;
          continue;
        }
        /*
         * A floor, because the arithmetic below has no other one.
         *
         * `job.chunkSize` is set when the offer is made and has always been a number. If it
         * ever were not, `offset + undefined` is NaN, the entry's offset becomes NaN, and
         * the loop then asks for slices of a file at no position at all - forever, with no
         * error and no progress. One `||` turns a silent permanent stall into a transfer.
         */
        const chunkSize = job.chunkSize || this.transport.chunkSize || MIN_CHUNK;
        const offset = entry.offset;
        const end = Math.min(offset + chunkSize, entry.size);
        entry.offset = end;
        const index = Math.floor(offset / chunkSize);
        return { entry, offset, end, index };
      }
      return null;
    };

    const build = async (slot) => {
      const { entry, offset, end, index } = slot;
      const buf = new Uint8Array(await entry.file.slice(offset, end).arrayBuffer());
      const ct = await seal(job.key, chunkNonce(entry.id, index), buf, aadFor(entry.id, offset));
      // The GCM tag is already a keyed MAC over this chunk's plaintext and its
      // (fileId, offset) binding, so the file-level root is built from the tags.
      // No second hash pass over the data, which saves two SHA-256 passes.
      entry.hashes[index] = ct.subarray(ct.length - 16);
      const frame = new Uint8Array(HDR + ct.length);
      frame[0] = VER;
      frame[1] = 0; // lane is filled in at send time
      frame.set(u32le(entry.id), 2);
      frame.set(u64le(offset), 6);
      frame.set(u32le(index), 14);
      frame.set(ct, HDR);
      return { frame, bytes: end - offset, entry };
    };

    while (true) {
      while (pending.length < READ_AHEAD) {
        const slot = await prepare();
        if (!slot) break;
        pending.push(build(slot));
      }
      if (!pending.length) break;

      const item = await pending.shift();
      let lane = myTransport.pickLane();
      let spins = 0;
      while (lane < 0 || !myTransport.canSend(lane)) {
        if (myTransport.closed || myTransport !== this.transport) {
          job.pumping = false; // the link went away; a resume will restart us
          return;
        }
        await myTransport.drain(Math.max(lane, 0));
        // drain() may resolve immediately when the transport is blocked for a reason it
        // cannot see; yield for real rather than burning the event loop.
        if (++spins % 8 === 0) await new Promise((r) => setTimeout(r, 20));
        lane = myTransport.pickLane();
      }
      if (myTransport !== this.transport) {
        job.pumping = false;
        return;
      }
      item.frame[1] = lane;
      myTransport.send(lane, item.frame);
      job.sent += item.bytes;

      const now = performance.now();
      if (!job._lastReport || now - job._lastReport > 200) {
        job._lastReport = now;
        this._report(job, 'send');
      }
    }

    // Everything is queued; wait for the wire to actually drain before declaring done.
    for (let i = 0; i < myTransport.lanes.length; i++) await myTransport.drain(i);
    job.pumping = false;
    if (myTransport !== this.transport || myTransport.closed) return;

    for (const entry of job.entries) {
      if (job.accepted && !job.accepted.has(entry.id)) continue;
      const root = await rootHash(entry.hashes);
      await this._sendCtl({ t: 'done', transferId: job.transferId, fileId: entry.id, root: toHex(root) });
    }
    job.state = 'sent';
    this._report(job, 'send');
    this.dispatchEvent(new CustomEvent('sent', { detail: { transferId: job.transferId } }));
  }

  /* ------------------------------------------------------------ receiving */

  async _onManifest(msg) {
    const checked = checkManifest(msg, this.in);
    if (!checked) return; // silently: a refusal that explains itself is a probe that pays

    const job = {
      transferId: msg.transferId,
      total: checked.total,
      files: checked.files,
      received: 0,
      state: 'offered',
      key: await this.session.transferKey(msg.transferId),
      sinks: new Map(),
      entries: new Map(),
      startedAt: 0,
      // Chunk handling is serialised: sink writes must not interleave, and the
      // contiguous-offset bookkeeping that drives resume must stay consistent.
      chain: Promise.resolve(),
    };
    this.in.set(msg.transferId, job);
    // The UI is handed the checked version, not the wire one, so what is displayed and what
    // is written are the same set of files and the same size.
    this.dispatchEvent(
      new CustomEvent('incoming', {
        detail: {
          transferId: msg.transferId,
          files: checked.files,
          total: checked.total,
          chat: checked.chat,
          voice: checked.voice,
          dur: checked.dur,
        },
      }),
    );
  }

  /**
   * Accept an offered transfer. Must be called from a user gesture if a file picker
   * sink is wanted (the picker requires one).
   */
  async accept(transferId, opts = {}) {
    const job = this.in.get(transferId);
    if (!job) return;
    // A double tap on Accept must not open a second set of sinks over the first.
    if (job.state !== 'offered') return;

    /*
     * One receiving transfer at a time, enforced rather than assumed. A chunk header carries
     * a file id but no transfer id, so with two in flight the reader cannot tell which job a
     * chunk belongs to. Carrying the transfer id in the header would lift this properly, but
     * that is a wire change.
     */
    const busy = [...this.in.values()].some((j) => j !== job && j.state === 'receiving');
    if (busy) {
      const err = new Error('another transfer is still arriving');
      err.name = 'BusyError'; // the caller can wait rather than give up
      throw err;
    }

    job.state = 'accepting';

    /*
     * A folder gets one prompt and keeps its shape.
     *
     * Only when the offer actually contains a path. A handful of loose files has no structure
     * to rebuild, and asking for a whole directory to write them into is a much larger
     * permission than the one save dialog they need.
     *
     * It also fixes the arithmetic that made folders unusable before: a save dialog per file
     * meant fifty dialogs for fifty files, and a browser stops granting them after the first,
     * so everything after that quietly fell back to a flattened name anyway.
     */
    let directory = null;
    const foldered = job.files.some((f) => /[\\/]/.test(f.path || ''));
    const mayAsk = opts.userGesture !== false && opts.prefer !== 'memory' && opts.prefer !== 'opfs';

    if (foldered && mayAsk && sinkCapabilities().directory) {
      try {
        directory = await pickDestinationDirectory();
      } catch (err) {
        // Cancelling the picker is an answer, and it is no. Falling back to flattened names
        // in the downloads folder would be writing somewhere they just declined to choose.
        if (err?.name === 'AbortError') {
          job.state = 'offered'; // they can accept again
          throw err;
        }
        directory = null; // refused for another reason: the flat path still works
      }
    }

    try {
      for (const f of job.files) {
        // Without a directory to write into, a browser cannot create folders in the downloads
        // directory, so the path is flattened into the file name rather than silently dropped.
        const saveAs = safeFileName(f.path || f.name);
        const sink = await createSink({ ...f, name: saveAs, path: directory ? f.path : '' }, { ...opts, directory });
        job.sinks.set(f.id, sink);
        const entry = {
          ...f,
          received: 0,
          contiguous: 0,
          hashes: [],
          lastAck: 0,
          ranges: [],
          // One spare for a final short chunk; anything past this is not a chunk of this file.
          maxChunks: Math.ceil(Math.max(0, f.size) / MIN_CHUNK) + 1,
        };
        // Resolved by the chunk processor when every byte has landed, so the finaliser
        // can wait for the payload stream even though `done` arrives on another stream.
        entry.complete = new Promise((resolve) => {
          entry.resolveComplete = resolve;
        });
        job.entries.set(f.id, entry);
      }
    } catch (err) {
      // The user cancelled the save dialog, or storage refused. Put the offer back so
      // they can try again instead of leaving it permanently unacceptable.
      for (const sink of job.sinks.values()) await sink.abort().catch(() => {});
      job.sinks.clear();
      job.entries.clear();
      job.state = 'offered';
      throw err;
    }

    job.state = 'receiving';
    job.startedAt = performance.now();
    await this._sendCtl({ t: 'accept', transferId, files: job.files.map((f) => f.id) });
    this.dispatchEvent(new CustomEvent('receiving', { detail: { transferId } }));
  }

  /**
   * Decline an offer, and only an offer. Once bytes are landing the way to stop is abort(),
   * so a stray decline cannot orphan a transfer that is already in flight.
   */
  async decline(transferId) {
    const job = this.in.get(transferId);
    if (job && job.state !== 'offered') return;
    this.in.delete(transferId);
    await this._sendCtl({ t: 'decline', transferId, reason: 'user' });
  }

  _onChunk({ data }) {
    const buf = asBytes(data);
    if (buf.length < HDR || buf[0] !== VER) return;

    // There is exactly one receiving job at a time per session in v0.1.
    const job = [...this.in.values()].find((j) => j.state === 'receiving');
    if (!job) return;

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const fileId = view.getUint32(2, true);
    const offset = Number(view.getBigUint64(6, true));
    const index = view.getUint32(14, true);
    const ct = buf.subarray(HDR);

    const entry = job.entries.get(fileId);
    if (!entry) return;

    // `index` and `offset` come off the wire and are used to size an array and to position
    // a write. The chunk itself is authenticated, but these are read *before* that, so they
    // are checked against the manifest the user actually accepted. Without this, one frame
    // claiming index 0xFFFFFFFF grows `hashes` to four billion entries, and one claiming a
    // huge offset asks the sink to allocate a file far larger than the one offered.
    if (!Number.isInteger(index) || index < 0 || index > entry.maxChunks) return;
    if (!Number.isFinite(offset) || offset < 0 || offset > entry.size) return;

    // Decrypt immediately and in parallel, since order does not matter for positioned
    // writes, then queue only the write, because a writable stream must be written serially.
    const plain = open(job.key, chunkNonce(fileId, index), ct, aadFor(fileId, offset));
    plain.catch(() => {}); // the awaiting writer handles it; this just silences the warning
    job.chain = job.chain
      .then(() => this._writeChunk(job, fileId, offset, plain, index, ct))
      .catch(() => {});
  }

  async _writeChunk(job, fileId, offset, plainPromise, index, ct) {
    const entry = job.entries.get(fileId);
    const sink = job.sinks.get(fileId);
    if (!entry || !sink) return;

    let pt;
    try {
      pt = await plainPromise;
    } catch {
      // A GCM failure is tampering or a key mismatch, never ordinary corruption:
      // SCTP already guarantees the integrity of anything it delivers.
      return this._fail(job, 'chunk failed authentication');
    }

    // The tag goes into the integrity tree only now. Writing it as the frame arrived meant
    // a frame that never authenticated could still overwrite the record of one that had.
    entry.hashes[index] = ct.slice(ct.length - 16); // the GCM tag is the chunk's MAC

    if (offset + pt.length > entry.size) {
      return this._fail(job, `chunk outside the offered size for ${entry.name}`);
    }

    await sink.write(offset, pt);
    job.received += pt.length;

    // Track received ranges so lanes may deliver out of order and resume stays exact.
    addRange(entry.ranges, offset, offset + pt.length);
    entry.contiguous = contiguous(entry.ranges);
    // Coverage, not arrivals. A resend is byte-identical by design and the resume path
    // produces them deliberately, so counting arrivals would count twice and let a file with
    // a hole in it look complete.
    entry.received = covered(entry.ranges);

    if (entry.contiguous >= entry.size) entry.resolveComplete?.();

    if (entry.contiguous - entry.lastAck >= ACK_EVERY || entry.contiguous >= entry.size) {
      entry.lastAck = entry.contiguous;
      this._sendCtl({ t: 'ack', transferId: job.transferId, fileId, upto: entry.contiguous });
      // Deliberately without the file name.
      //
      // This record exists so a transfer can pick up where it left off, which takes an offset
      // and a timestamp. The name was written alongside it and never read back, turning this
      // store into a permanent list of everything the person had received: in the clear,
      // growing, with nothing in the app to show it to them or clear it.
      transferStore
        .put({ id: `${job.transferId}:${fileId}`, upto: entry.contiguous, at: Date.now() })
        .catch(() => {});
    }

    const now = performance.now();
    if (!job._lastReport || now - job._lastReport > 200) {
      job._lastReport = now;
      this._report(job, 'recv');
    }
  }

  async _onDone(msg) {
    const job = this.in.get(msg.transferId);
    if (!job) return;
    const entry = job.entries.get(msg.fileId);
    const sink = job.sinks.get(msg.fileId);
    if (!entry || !sink) return;

    // `done` travels on the control stream and can overtake the tail of the payload stream,
    // because SCTP orders within a stream and not across them. Wait for the bytes.
    if (entry.contiguous < entry.size) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000));
      try {
        await Promise.race([entry.complete, timeout]);
      } catch {
        await sink.abort();
        return this._fail(job, `transfer ended early for ${entry.name}`);
      }
    }
    await job.chain; // let every queued chunk finish writing and hashing

    // The root is required, not merely checked when offered. Treating it as optional let a
    // sender skip verification altogether by omitting one field, which is the one thing the
    // check exists to prevent.
    const root = toHex(await rootHash(entry.hashes));
    if (typeof msg.root !== 'string' || !equal(hexBytes(msg.root), hexBytes(root))) {
      await sink.abort();
      return this._fail(job, `integrity check failed for ${entry.name}`);
    }

    const result = await sink.close();
    job.sinks.delete(msg.fileId);
    // Finished: there is nothing left to resume, so the progress record goes rather than
    // lingering until some later sweep gets to it.
    transferStore.del(`${job.transferId}:${msg.fileId}`).catch(() => {});
    this.dispatchEvent(new CustomEvent('file-complete', { detail: { transferId: job.transferId, file: result, entry } }));

    if (job.sinks.size === 0) {
      job.state = 'done';
      this._report(job, 'recv');
      this.dispatchEvent(new CustomEvent('complete', { detail: { transferId: job.transferId } }));
      this.in.delete(job.transferId);
    }
  }

  async _onAbort(msg) {
    const job = this.in.get(msg.transferId) || this.out.get(msg.transferId);
    if (!job) return;
    for (const sink of job.sinks?.values() || []) await sink.abort();
    this.in.delete(msg.transferId);
    this.out.delete(msg.transferId);
    this.dispatchEvent(new CustomEvent('aborted', { detail: { transferId: msg.transferId, reason: msg.reason } }));
  }

  async abort(transferId, reason = 'user') {
    const job = this.in.get(transferId) || this.out.get(transferId);
    if (job?.sinks) for (const sink of job.sinks.values()) await sink.abort();
    this.in.delete(transferId);
    this.out.delete(transferId);
    await this._sendCtl({ t: 'abort', transferId, reason });
    this.dispatchEvent(new CustomEvent('aborted', { detail: { transferId, reason } }));
  }

  /** Ask the sender to continue a partially received transfer after a reconnect. */
  async resumeIncoming() {
    for (const job of this.in.values()) {
      if (job.state !== 'receiving') continue;
      for (const [fileId, entry] of job.entries) {
        await this._sendCtl({ t: 'resume', transferId: job.transferId, fileId, from: entry.contiguous });
      }
    }
  }

  _fail(job, why) {
    job.state = 'failed';
    this.dispatchEvent(new CustomEvent('error', { detail: new Error(why) }));
  }

  _report(job, dir) {
    const done = dir === 'send' ? job.sent : job.received;
    const elapsed = (performance.now() - (job.startedAt || performance.now())) / 1000;
    const rate = elapsed > 0.2 ? done / elapsed : 0;
    this.dispatchEvent(
      new CustomEvent('progress', {
        detail: {
          transferId: job.transferId,
          direction: dir,
          done,
          total: job.total,
          rate,
          eta: rate > 0 ? (job.total - done) / rate : Infinity,
          lanes: this.transport.readyLanes,
          path: this.transport.pathType,
          rtt: this.transport.rtt,
          state: job.state,
        },
      }),
    );
  }
}

/* --------------------------------------------------------------- helpers */

/**
 * View bytes without copying and without losing a subarray's offset.
 *
 * A relayed frame arrives as a subarray of the socket buffer; `new Uint8Array(x.buffer)`
 * silently ignores byteOffset and hands back the wrong bytes, which decrypts to garbage.
 */
function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** nonce = [0][fileId:3][chunkIndex:8]. Deterministic, so a resend is byte-identical. */
function chunkNonce(fileId, index) {
  const n = new Uint8Array(12);
  n[1] = fileId & 0xff;
  n[2] = (fileId >> 8) & 0xff;
  n[3] = (fileId >> 16) & 0xff;
  n.set(u64le(index), 4);
  return n;
}

/** AAD binds a chunk to its file and absolute offset; splicing or reordering fails. */
function aadFor(fileId, offset) {
  return concat(new Uint8Array([VER]), u32le(fileId), u64le(offset));
}

/** Hex → bytes, so the root comparison is a constant-time byte compare rather than ===. */
function hexBytes(hex) {
  const clean = typeof hex === 'string' && /^[0-9a-f]*$/i.test(hex) && hex.length % 2 === 0 ? hex : '';
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** Hash of the ordered chunk hashes. A hole means a missing chunk, so it must fail. */
async function rootHash(hashes) {
  const parts = [];
  for (let i = 0; i < hashes.length; i++) {
    if (!hashes[i]) return new Uint8Array(32); // deliberately not a valid root
    parts.push(hashes[i]);
  }
  return sha256(concat(...parts));
}



/**
 * Drop progress records for transfers nobody is going to resume.
 *
 * A record is only useful while the other device still has the file open and is willing to
 * carry on. After a day it is residue: it cannot resume anything, and it still says that
 * something was being received at a particular moment. Boot is the right time to clear it,
 * because that is the only moment we know no transfer is in flight.
 */
export async function sweepResume(maxAgeMs = 24 * 60 * 60_000) {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const all = await transferStore.all();
    let removed = 0;
    for (const rec of all) {
      if (!rec?.at || rec.at < cutoff) {
        await transferStore.del(rec.id);
        removed++;
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

export { offerDownload };
