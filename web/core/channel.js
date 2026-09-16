/**
 * Channel: a presence directory shared by several devices, either a room or the opt-in
 * "this network" group keyed on the label the relay derives from a socket's address.
 *
 * Presence only. Members announce a 16-byte ephemeral id under a key derived from the
 * channel secret; each pair then computes its own tag and runs the ordinary two-party
 * handshake there, so every conversation is still end-to-end between exactly two devices.
 * The relay sees a rotating tag and small ciphertexts, and cannot enumerate rooms, read a
 * roster, or recognise the same channel later.
 *
 * A channel is not authentication: everyone holding the secret is equal, and for the network
 * channel the operator holds it too. Devices met this way stay unverified until the safety
 * words are checked.
 */
import { concat, randomBytes, td, te, toHex, pad, unpad } from './bytes.js';
import { channelKey, channelPairTag, channelSecret, channelTag, roomEpoch, seal, open } from './gdcrypto.js';

const F_PRESENCE = 0x20;

/** How often we re-announce, and how long a silent member is kept. */
const BEACON_MS = 25_000;
const STALE_MS = 95_000;
/** Re-check the epoch on this cadence; the tag rolls hourly. */
const ROLL_MS = 60_000;

export class Channel extends EventTarget {
  /**
   * @param {SignalClient} signal
   * @param {object} opts
   * @param {'room'|'local'} opts.kind   which discovery channel this is
   * @param {string} opts.label          room code, or the relay's network label
   * @param {object} opts.self           { name, kind } announced to the channel
   * @param {() => Promise<string[]>} [opts.hints]  rotating recognition hints (see below)
   */
  constructor(signal, { kind, label, self, hints }) {
    super();
    this.signal = signal;
    this.kind = kind;
    this.label = label;
    this.self = self;
    this._hints = hints || (async () => []);
    this.id = randomBytes(16); // ephemeral, per join; nothing durable is announced
    this.idKey = toHex(this.id);
    this.members = new Map(); // idHex -> { id, idKey, name, kind, seen, pairTag }
    this.joined = false;

    this._tags = new Map(); // tagHex -> Uint8Array
    this._secret = null;
    this._key = null;
    this._timers = [];
    this._replied = new Map(); // idHex -> timestamp of our last directed re-announce
    this._bye = null; // a sealed departure, ready to send without awaiting anything

    this._onFrame = (e) => {
      if (!this._tags.has(e.detail.key)) return;
      this._read(e.detail.payload);
    };
    // A membership change on the tag is the cue to re-introduce ourselves: whoever just
    // arrived has an empty roster and we are the only ones who can fill it.
    this._onPeerUp = (e) => {
      if (this._tags.has(e.detail.key)) this._announce('hi');
    };
  }

  /**
   * The PAKE password for the two-party sessions inside this channel. Everyone in the
   * channel has it, which is what keeps the relay out of the handshake. It does not keep
   * other members out; the safety words do that.
   */
  get password() {
    return this._secret ? toHex(this._secret) : '';
  }

  async join() {
    if (this.joined) return;
    this.joined = true;
    this._secret = await channelSecret(this.label);
    this._key = await channelKey(this._secret);

    this.signal.addEventListener('frame', this._onFrame);
    this.signal.addEventListener('peer-up', this._onPeerUp);

    await this._roll();
    await this._announce('hi');

    this._timers.push(setInterval(() => this._announce('hi'), BEACON_MS));
    this._timers.push(setInterval(() => this._roll(), ROLL_MS));
    this._timers.push(setInterval(() => this._prune(), 15_000));
  }

  async leave() {
    if (!this.joined) return;
    this.joined = false;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
    try {
      await this._announce('bye');
    } catch {
      /* leaving is best-effort */
    }
    this.signal.removeEventListener('frame', this._onFrame);
    this.signal.removeEventListener('peer-up', this._onPeerUp);
    for (const tag of this._tags.values()) this.signal.unsubscribe(tag);
    this._tags.clear();
    for (const m of this.members.values()) {
      this.dispatchEvent(new CustomEvent('member-gone', { detail: m }));
    }
    this.members.clear();
  }

  /**
   * Say hello again.
   *
   * For a page that said goodbye and came back, such as a tab restored from the back/forward
   * cache, where the members who heard the farewell have already forgotten it.
   */
  hello() {
    return this.joined ? this._announce('hi') : Promise.resolve();
  }

  /** Announce a new display name without rejoining. */
  rename(name) {
    this.self = { ...this.self, name };
    if (this.joined) this._announce('hi').catch(() => {});
  }

  /**
   * Subscribe to the current hour's tag and the previous one, always. Two people joining
   * either side of an hour boundary would otherwise never see each other, and the cost of
   * carrying both is one extra idle subscription.
   */
  async _roll() {
    const epoch = roomEpoch();
    const wanted = new Map();
    for (const e of [epoch, epoch - 1]) {
      const tag = await channelTag(this._secret, e);
      wanted.set(toHex(tag), tag);
    }

    for (const [key, tag] of this._tags) {
      if (wanted.has(key)) continue;
      this.signal.unsubscribe(tag);
      this._tags.delete(key);
    }
    for (const [key, tag] of wanted) {
      if (this._tags.has(key)) continue;
      this._tags.set(key, tag);
      this.signal.subscribeRoom(tag);
    }
  }

  async _announce(t) {
    if (!this._key || !this._tags.size) return;
    // Hints let an already-paired device be recognised as itself rather than turning up a
    // second time as a stranger. They rotate every epoch and mean nothing to anyone who
    // does not already hold the matching pairing root.
    const hints = t === 'hi' ? (await this._hints()).slice(0, 8) : [];
    const body = pad(
      te.encode(
        JSON.stringify({
          t,
          id: this.idKey,
          name: this.self?.name || '',
          kind: this.self?.kind || 'laptop',
          h: hints,
        }),
      ),
      256,
    );
    // A random nonce, not a counter: there is no single ordered sender on a channel tag,
    // and these are a handful of small messages under a key that lives for one session.
    const nonce = randomBytes(12);
    const ct = await seal(this._key, nonce, body, te.encode('gd/chan'));
    const frame = concat(new Uint8Array([F_PRESENCE]), nonce, ct);
    for (const tag of this._tags.values()) this.signal.forward(tag, frame);

    // Keep a goodbye ready to go, and finish preparing it before this call resolves. A
    // farewell still being sealed when the tab closes is one nobody receives.
    if (t === 'hi') await this._prepareBye().catch(() => {});
  }

  /**
   * Seal a departure announcement in advance, so it can be sent without awaiting anything.
   *
   * A tab that closes has no time to encrypt: the page is going away, and any promise
   * started in `pagehide` is unlikely to finish. Without a goodbye the only thing that
   * removes a device from everyone else's screen is the ninety-five second staleness
   * timeout, so closing a tab left a ghost on the radar of every device on the network:
   * tappable, and connecting to nothing.
   *
   * Sealing it ahead of time turns the farewell into a single synchronous send. The nonce is
   * fresh for each one and only the latest is ever sent, so nothing is reused.
   */
  async _prepareBye() {
    if (!this._key) return;
    const body = pad(te.encode(JSON.stringify({ t: 'bye', id: this.idKey })), 256);
    const nonce = randomBytes(12);
    const ct = await seal(this._key, nonce, body, te.encode('gd/chan'));
    this._bye = concat(new Uint8Array([F_PRESENCE]), nonce, ct);
  }

  /** Send the prepared goodbye synchronously. Safe to call from `pagehide`. */
  sayGoodbyeNow() {
    if (!this._bye || !this.joined) return;
    for (const tag of this._tags.values()) {
      try {
        this.signal.forward(tag, this._bye);
      } catch {
        /* the socket is already going; nothing useful left to do */
      }
    }
    this._bye = null; // one nonce, one use
  }

  async _read(buf) {
    if (!this._key || !buf || buf.length < 14 || buf[0] !== F_PRESENCE) return;
    let msg;
    try {
      const nonce = buf.subarray(1, 13);
      const pt = await open(this._key, nonce, buf.subarray(13), te.encode('gd/chan'));
      msg = JSON.parse(td.decode(unpad(pt)));
    } catch {
      return; // not for this channel, or tampered with; either way, ignore it
    }

    const idKey = typeof msg?.id === 'string' ? msg.id : '';
    if (!/^[0-9a-f]{32}$/.test(idKey) || idKey === this.idKey) return;

    if (msg.t === 'bye') {
      const gone = this.members.get(idKey);
      if (!gone) return;
      this.members.delete(idKey);
      this.dispatchEvent(new CustomEvent('member-gone', { detail: gone }));
      return;
    }
    if (msg.t !== 'hi') return;

    const known = this.members.get(idKey);
    const name = String(msg.name || '').slice(0, 64);
    const kind = msg.kind === 'phone' || msg.kind === 'tablet' ? msg.kind : 'laptop';
    const hints = Array.isArray(msg.h) ? msg.h.filter((h) => /^[0-9a-f]{16}$/.test(h)).slice(0, 8) : [];

    if (known) {
      known.seen = Date.now();
      // Hints change when the other side pairs or unpairs with someone, and that changes
      // whether we should be holding a separate conversation with them. Re-announce the
      // member so the decision is made again rather than frozen at first sight.
      const changed = known.name !== name || known.hints.join() !== hints.join();
      known.name = name || known.name;
      known.kind = kind;
      known.hints = hints;
      if (changed) this.dispatchEvent(new CustomEvent('member', { detail: known }));
      return;
    }

    const id = Uint8Array.from(idKey.match(/../g).map((h) => parseInt(h, 16)));
    const member = {
      idKey,
      id,
      name: name || 'Device',
      kind,
      hints,
      seen: Date.now(),
      channel: this.kind,
      pairTag: await channelPairTag(this._secret, this.id, id),
    };
    this.members.set(idKey, member);
    this.dispatchEvent(new CustomEvent('member', { detail: member }));

    // Answer a newcomer so their roster fills even if the relay's membership notice raced
    // their announcement. At most once every few seconds per member, so a room full of
    // devices does not turn one arrival into a storm of announcements.
    const last = this._replied.get(idKey) || 0;
    if (Date.now() - last > 5000) {
      this._replied.set(idKey, Date.now());
      setTimeout(() => this._announce('hi').catch(() => {}), 120 + Math.random() * 400);
    }
  }

  _prune() {
    const cutoff = Date.now() - STALE_MS;
    for (const [key, m] of this.members) {
      if (m.seen >= cutoff) continue;
      this.members.delete(key);
      this.dispatchEvent(new CustomEvent('member-gone', { detail: m }));
    }
  }
}
