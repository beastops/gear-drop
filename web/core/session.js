/**
 * SecureSession: the end-to-end encrypted control channel between two devices.
 *
 * Sequence:
 *   1. Both sides subscribe to the same rendezvous tag, derived from a code or from a
 *      rotating pairing token.
 *   2. They run CPace over the code. The relay sees two group elements and learns nothing.
 *   3. Everything after that (hello, SDP offer/answer, ICE candidates, file manifests)
 *      travels sealed under AES-256-GCM with a key the relay cannot derive.
 *   4. A four-word SAS binds the key to both DTLS fingerprints, so a relay that swapped a
 *      fingerprint produces different words on the two screens.
 *
 * Nonce discipline: the peers are ordered by their CPace public messages
 * (lexicographically). The lower one owns lane byte 0, the higher one lane byte 1, so the
 * two directions never collide in nonce space under the same key.
 */
import { concat, te, td, pad, unpad, toHex, equal } from './bytes.js';
import {
  cpaceStart,
  cpaceFinish,
  kemKeypair,
  kemEncapsulate,
  kemDecapsulate,
  sha256,
  KEM_EK_BYTES,
  KEM_CT_BYTES,
  hkdf,
  aeadKey,
  seal,
  open,
  nonceFor,
  sasWords,
} from './gdcrypto.js';

/** A ristretto255 point, which is what a CPace share is on the wire. */
const SHARE_BYTES = 32;

/**
 * How many sealed frames may fail to open on a live session before it is treated as keyed
 * against somebody else.
 */
const DIVERGED_AFTER = 3;

/**
 * How many of a peer's offers to remember, so a replaced one can be recognised.
 *
 * Only the most recent is ever answered, so the list only has to be deep enough that a stale
 * offer still looks stale. Bounded because it is fed by the network.
 */
const HEARD_MAX = 8;

/**
 * How many rounds' confirmations to keep recognising after the round is over.
 *
 * HEARD_MAX holds what the peer published; this holds what we expected back. Bounded for the
 * same reason.
 */
const SPENT_MAX = 8;

/** Minimum gap between two re-keys, so the detector cannot be driven in a loop. */
const REKEY_MIN_MS = 4000;

const F_CPACE = 0x10;
const F_SEALED = 0x11;
/* 0x12 and 0x13 belong to the relay transport, which shares this frame namespace. */
const F_CONFIRM = 0x14;

/**
 * The floor on repeating a share.
 *
 * Without it, invented handshake frames turn into outgoing ones at whatever rate the sender
 * likes. A few hundred milliseconds is enough for that; the cost to us is one small frame
 * either way. Two seconds also set how long a reconnect took, because the reply a returning
 * device waits for is a repeat of a share we have already published.
 */
const ANNOUNCE_MIN_MS = 600;

export class SecureSession extends EventTarget {
  /**
   * @param {SignalClient} signal
   * @param {object} opts
   * @param {Uint8Array} opts.tag        rendezvous tag
   * @param {string}     [opts.code]     the PAKE password (code pairing)
   * @param {Uint8Array} [opts.pairRoot] stored pairing root (known-device reconnect)
   * @param {object}     [opts.deviceKey]
   * @param {object}     [opts.peer]     stored peer record, for a known-device reconnect
   */
  constructor(signal, opts) {
    super();
    this.signal = signal;
    this.tag = opts.tag;
    this.tagKey = toHex(opts.tag);
    this.code = opts.code || null;
    this.pairRoot = opts.pairRoot || null;
    this.deviceKey = opts.deviceKey || null;
    this.peerRecord = opts.peer || null;

    this.established = false;
    this.lane = 0;
    // Identifies this key agreement. Derived from the shared key, so both peers compute the
    // same value without exchanging anything, and it changes on every re-key. Transports
    // stamp it on their signalling, so leftovers from a dead connection are recognisably
    // stale rather than applied to its replacement.
    this.generation = 0;
    this.sendCounter = 0;
    this._window = new ReplayWindow();
    this.key = null; // AEAD CryptoKey for signalling
    this.K = null; // raw PAKE/DH output, root for transfer keys
    this.sas = null;
    this.peerHello = null;

    /*
     * A key agreement that has not yet been proved.
     *
     * CPace hands back a key whatever the other side did. A wrong code, or an attacker who
     * never had one, still produces a key, just a different one. Treating that as a
     * connection puts an unauthenticated device on screen labelled as an authenticated one.
     * A fresh agreement lands here and moves into `key`/`K` only once the peer has shown it
     * derived the same secret.
     */
    this._candidate = null;
    this._earlyConfirm = null; // a confirmation that arrived before we had a candidate
    /*
     * Our lattice keypair, generated alongside the CPace share and thrown away with it.
     *
     * A promise rather than a value: generating it is a millisecond of work behind a module
     * loaded on demand, and nothing needs it until there is a frame to send.
     */
    this._kem = null;
    /** The one encapsulation made for the current offer, so repeats agree with it. */
    this._kemOut = null;
    this._lastAnnounce = 0;
    this._announcedShare = null;

    /**
     * The peer share this session last replied to, so a live session answers each one once.
     * @type {string|null}
     */
    this._answeredTo = null;

    /*
     * Sealed frames that arrived while established and would not open.
     *
     * A run of them on a session that believes it is up means the two sides hold different
     * keys, which happens when each keyed against a share the other has left behind. Both
     * confirmations were valid for their own round, so nothing reports the state: the
     * transports come up, the tiles say connected, and every frame is discarded.
     */
    this._unopened = 0;
    this._lastRekey = 0;

    /*
     * The offers this peer has published, oldest first.
     *
     * Handshake frames can be delivered late, repeated, or replayed, and nothing in one says
     * which round it belongs to. The order they were first heard in does: an offer seen
     * before that is not the most recent is one the peer has moved past, and keying against
     * it produces an agreement only this side will hold.
     */
    this._heard = [];

    /*
     * The confirmations we were waiting for in rounds that are over.
     *
     * A confirmation that does not match the current round is either somebody without the
     * code or the peer's answer to a round we have left. The first should end the attempt;
     * the second arrived late, and dropping the round in progress over it leaves this device
     * waiting for a message the peer has no reason to send again.
     *
     * A tag we computed ourselves for an earlier round could only have come from a peer with
     * the code, so recognising our own is enough to tell the two apart.
     */
    this._spent = [];

    /*
     * Whether a transport built on this session is currently carrying traffic.
     *
     * Set by the transport, and used for one decision: whether an unsolicited handshake
     * frame is worth acting on. While a connection is up it is not.
     */
    this.transportLive = false;

    this._onFrame = (e) => {
      if (e.detail.key === this.tagKey) this._handle(e.detail.payload);
    };
    this._onPeerUp = (e) => {
      if (e.detail.key !== this.tagKey) return;
      /*
       * Somebody joined the tag, so we owe them a share.
       *
       * `_sendCpace` has nothing to send while this session counts as established, which is
       * where a device is left when its peer went away without the relay noticing: the key is
       * still here and the transport behind it is not. Staying quiet leaves the arriving peer
       * on its retry timer. Resetting produces a fresh share and publishes it.
       *
       * Only when nothing is carrying traffic. A join on a tag whose session is genuinely up
       * is somebody else arriving, and re-keying a working conversation on that cue is what
       * the check in the frame handler prevents.
       */
      if (this.established && !this.transportLive) this.reset();
      else this._sendCpace();
    };
    this._onPeerGone = (e) => {
      if (e.detail.key !== this.tagKey) return;
      // The peer that comes back is a new socket with a new ephemeral share. Without this
      // reset the session stays "established" around a dead key and ignores the returning
      // peer's handshake, which deadlocks the reconnect.
      this.reset();
      this.dispatchEvent(new CustomEvent('peer-gone', { detail: e.detail.reason }));
    };

    signal.addEventListener('frame', this._onFrame);
    signal.addEventListener('peer-up', this._onPeerUp);
    signal.addEventListener('peer-gone', this._onPeerGone);
  }

  destroy() {
    this.signal.removeEventListener('frame', this._onFrame);
    this.signal.removeEventListener('peer-up', this._onPeerUp);
    this.signal.removeEventListener('peer-gone', this._onPeerGone);
    this.signal.unsubscribe(this.tag);
    this.established = false;

    // Drop the key material rather than leave it reachable from a discarded object. The
    // conversation is over and nothing should be able to read it afterwards, including us.
    if (this.K) this.K.fill(0);
    this.K = null;
    this.key = null;
    this.sas = null;
    this._peerShare = null;
    this._dropCandidate();
    this._forgetEphemerals();
    this._cpace = null;
  }

  _dropCandidate() {
    this._spend(this._candidate);
    if (this._candidate?.K) this._candidate.K.fill(0);
    this._candidate = null;
    this._earlyConfirm = null;
  }

  /** Remember what a round was waiting for, now that the round is over. */
  _spend(cand) {
    if (!cand?.theirs) return;
    this._spent.push(cand.theirs);
    if (this._spent.length > SPENT_MAX) this._spent.shift();
  }

  /** Subscribe and send our half of the key exchange. */
  start() {
    this.signal.subscribe(this.tag);
    this._heard = [];
    this._spent = [];
    this._answeredTo = null;
    this._cpace = cpaceStart(this.code ?? '', this.tag);
    this._kem = kemKeypair();
    this._kemOut = null;
    this._sendCpace();
  }

  /**
   * Return to the pre-handshake state with a fresh ephemeral share, ready to key again
   * with whoever turns up next. Keys are never reused across a reconnect.
   */
  reset() {
    // Always re-announce. A silent reset deadlocks the session: a late "peer gone" can tear
    // down a handshake that just succeeded, and with nothing sent afterwards neither side
    // speaks again. Re-sending converges in one round trip, because the peer sees a share it
    // does not recognise, resets, and keys against this one.
    if (!this.established && this._cpace) {
      this._sendCpace();
      return;
    }
    this.established = false;
    this.key = null;
    if (this.K) this.K.fill(0);
    this.K = null;
    this.sas = null;
    this._peerShare = null;
    this._dropCandidate();
    this.sendCounter = 0;
    this._outChain = null;
    this._window = new ReplayWindow();
    this._answeredTo = null;
    this._cpace = cpaceStart(this.code ?? '', this.tag);
    this._kem = kemKeypair();
    this._kemOut = null;
    this._sendCpace();
  }

  _sendCpace() {
    if (this.established || !this._cpace) return;
    this._announce({ force: true });
  }

  /**
   * Publish our share.
   *
   * Repeats are throttled, because what asks for one is a frame from the network and anyone
   * can send those. Without a floor, invented handshake frames turn into outgoing ones.
   *
   * A share nobody has seen yet is never throttled. A rate limit that can swallow the one
   * message the other side is waiting for hangs the connection instead of protecting it: a
   * device coming back after a restart publishes a new share and needs ours in reply, and a
   * plain time-based floor ate it.
   */
  async _announce({ force = false } = {}) {
    // No keypair means the round it belonged to is over and its private half has been wiped;
    // there is nothing to publish until a reset makes a new one.
    if (!this._cpace || !this._kem) return;
    // Only one case is held back: a repeat of a share we have already published, asked for
    // by a frame off the network. A share nobody has heard, and a repeat the app itself asked
    // for, always go. Withholding either can only deadlock the handshake.
    const unheard = this._announcedShare !== this._cpace.msg;
    if (!force && !unheard && Date.now() - this._lastAnnounce < ANNOUNCE_MIN_MS) return;
    this._lastAnnounce = Date.now();
    this._announcedShare = this._cpace.msg;

    /*
     * Both halves of the offer travel together.
     *
     * The share is the classical element; the key beside it is what the peer wraps a lattice
     * secret to. Sending them in one frame keeps this a two-message handshake: no extra round
     * trip for the post-quantum half, and no window where one half is agreed and the other
     * is not.
     */
    const { ek } = await this._kem;
    // A reset while the keypair was being generated. That round is over, and this frame
    // belongs to a share nobody is listening for.
    if (this._announcedShare !== this._cpace?.msg) return;
    this.signal.forward(this.tag, concat(new Uint8Array([F_CPACE]), this._cpace.msg, ek));
  }

  async _handle(buf) {
    if (!buf || buf.length < 1) return;
    const type = buf[0];
    const body = buf.subarray(1);

    if (type === F_CPACE) {
      /*
       * Answer a share with a share, before deciding whether the share itself is news.
       *
       * A repeat says nothing new about them and something useful about us: they are still
       * asking, so what we sent has not arrived. That happens after a quick disconnect and
       * reconnect. They publish, we key and confirm, and our share goes out while they are
       * not yet listening; they then repeat theirs and we filter every copy as a duplicate,
       * leaving them with a confirmation for an agreement they cannot build. Answering below
       * the guards meant never answering at all.
       *
       * Throttled, so fifty invented shares still draw at most one announcement per floor.
       */
      if (!this.established) this._announce();

      /*
       * A repeat of a share we have already keyed against, live or candidate, is a duplicate.
       *
       * Compared against the share alone, not the whole offer. What arrives is the share
       * followed by an encapsulation key, and what is remembered is the share, so comparing
       * the two never matched and every repeat read as a new peer. On a live session the
       * branch below then publishes a fresh share and keys again, and a second copy of one
       * offer leaves the two ends a round apart.
       */
      const offered = body.subarray(0, SHARE_BYTES);
      if (this.established && this._peerShare && cmp(this._peerShare, offered) === 0) return;
      if (this._candidate && cmp(this._candidate.peerShare, offered) === 0) return;

      /*
       * A new share mid-session means the peer restarted, or that somebody wants us to think
       * so. The frame cannot tell those apart, so ask a different question: is the connection
       * we have still working?
       *
       * If it is, ignore this. Re-keying a healthy session on a stranger's cue lets several
       * such frames settle the two sides on different rounds, each holding a key the other
       * has moved past. A peer that really left is reported gone by the relay, which resets
       * through the usual path.
       */
      if (this.established && this.transportLive) return;

      if (this.established && !this._cpace?.state) {
        // Our scalar was forgotten when the running session was confirmed, so there is
        // nothing left to answer with. Make a fresh one; CPace is a plain Diffie-Hellman, so
        // the peer's existing share still agrees with this one.
        this._cpace = cpaceStart(this.code ?? '', this.tag);
        this._kem = kemKeypair();
        this._kemOut = null;
      }

      /*
       * This is a share we are about to key against, so the peer needs ours, and we can no
       * longer assume it has it.
       *
       * The announcement at the top of the handler is gated on not being established, on the
       * assumption that a session which is up has nothing to re-publish. One state breaks
       * that: established on a key the peer has left, still holding the scalar from a round
       * that never completed. The branch above does not fire, because there is a scalar, so
       * nothing is published and the share we confirm against is one announced long ago that
       * the peer never received. The confirmation then arrives for a round the peer cannot
       * build, and neither side sends again.
       *
       * The floor cannot help here: the share being withheld was published to a peer that is
       * not the one asking now, so "already announced" is true and useless. What bounds it is
       * the share being answered, one reply per distinct share. That also stops the gap
       * between here and the candidate being built from turning one share into a burst. Any
       * frame reaching this point is one we are about to do real work for anyway.
       */
      if (this.established) {
        const answering = toHex(offered);
        const unanswered = this._answeredTo !== answering;
        this._answeredTo = answering;
        this._announce({ force: unanswered });
      }

      try {
        await this._beginKey(body);
      } catch (err) {
        // A malformed or reflected element is an attack or a bug on the other side, and not
        // worth interrupting a session that is already working.
        if (!this.established) this.dispatchEvent(new CustomEvent('error', { detail: err }));
      }
      return;
    }

    if (type === F_CONFIRM) {
      await this._onConfirm(body);
      return;
    }

    if (type === F_SEALED) {
      if (!this.established) return; // never process ciphertext before a key exists
      const msg = await this._unseal(body);
      if (msg) this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    }
  }

  /**
   * Run the key agreement and hold the result aside, unconfirmed.
   *
   * Nothing observable changes here. The session is not "up", the UI is not told, and no
   * ciphertext is accepted under this key. All of that waits for the peer's confirmation.
   */
  async _beginKey(frame) {
    if (!this._cpace?.state) throw new Error('no share to key with');

    /*
     * No classical-only path, by construction.
     *
     * An offer without a lattice key is either a version that predates this or somebody
     * stripping the post-quantum half. The frame cannot tell those apart, and there is no
     * need to: both ends of a pairing run the code this origin served, so refusing costs
     * nothing and a downgrade is not a shape this protocol accepts.
     */
    if (frame.length !== SHARE_BYTES + KEM_EK_BYTES) throw new Error('cpace: share is not a hybrid offer');
    const peerMsg = frame.subarray(0, SHARE_BYTES);
    const peerEk = frame.subarray(SHARE_BYTES);

    // Our own element coming back at us is a reflection, not a peer. The key it produces is
    // one only we can compute, so it would confirm against itself if allowed to.
    if (cmp(this._cpace.msg, peerMsg) === 0) throw new Error('cpace: reflected share');

    /*
     * An offer this peer has already replaced.
     *
     * Keying against a round the peer has left produces a confirmation that is valid for that
     * round, so this side promotes while the peer completes a later round with a different
     * confirmation. Both ends are established on different keys, with nothing to say so until
     * the first frame fails to open.
     *
     * A newer offer is always answered, and a repeat of the newest is dropped by the guards
     * above. Refused here is the third case: an offer that was current, is not any more, and
     * has come back. Only a delayed or replayed frame produces that, and no honest peer is
     * waiting on an answer to it.
     */
    const seenAt = this._heard.findIndex((h) => cmp(h, peerMsg) === 0);
    if (seenAt >= 0 && seenAt !== this._heard.length - 1) {
      throw new Error('cpace: offer already replaced by a newer one');
    }
    if (seenAt < 0) {
      this._heard.push(Uint8Array.from(peerMsg));
      if (this._heard.length > HEARD_MAX) this._heard.shift();
    }

    let K = await cpaceFinish(this._cpace.state, peerMsg);

    // For a known device, fold in a static-key DH so that even a correct code guess by a
    // third party cannot impersonate the remembered peer.
    if (this.pairRoot) {
      K = await hkdf(concat(K, this.pairRoot), 'gd/reconnect/v1', 32);
    }

    const peerShare = Uint8Array.from(peerMsg);
    /*
     * Wrap a secret to their published key, once per offer.
     *
     * Keying can run several times against the same offer, from a repeated share or a
     * re-announce after a reset. A fresh encapsulation each time is a different ciphertext
     * carrying a different secret; both go out, the peer opens whichever arrives first, and
     * this side holds the other. Two devices established on two different keys, with nothing
     * to say so until the first frame fails to decrypt.
     *
     * So it is computed once and kept against the offer that produced it. The randomness
     * stays the KEM's own. Seeding it from the classical secret would be simpler and would
     * hand the whole post-quantum half to anyone who later breaks the classical one, which is
     * the attacker this exists for.
     */
    const offer = Uint8Array.from(frame);
    if (!this._kemOut || cmp(this._kemOut.forOffer, offer) !== 0) {
      // Stored before the await, so two calls racing on the same offer share one result.
      this._kemOut = { forOffer: offer, pending: kemEncapsulate(Uint8Array.from(peerEk)) };
    }
    const sent = await this._kemOut.pending;

    /*
     * A confirmation that arrived while this was still computing.
     *
     * Keying is asynchronous, so the peer's confirmation can land at any point during it,
     * and `_dropCandidate` below clears the slot it lands in. Timing decided the outcome: a
     * confirmation arriving after the drop was replayed and the handshake completed, one
     * arriving before it was wiped and the handshake did not. The side waiting on it stayed
     * unestablished while the other went ahead, and nothing made either try again.
     *
     * It is held across the drop, and what is used below is whichever of the two exists.
     */
    const heldEarly = this._earlyConfirm;
    this._dropCandidate();
    const lane = cmp(this._cpace.msg, peerMsg) <= 0 ? 0 : 1;

    /*
     * Everything either side published, hashed in one fixed order.
     *
     * The classical agreement proves the two elements agreed and says nothing about the
     * lattice keys that travelled beside them. Somebody without the code cannot forge an
     * element, but relaying one while replacing the key next to it costs nothing, and the two
     * ends would confirm each other and then hold different session keys: up on both screens,
     * unable to read anything from each other.
     *
     * Covering the offers turns that into a confirmation that fails, which the app can
     * report. Lane order rather than arrival order, so both ends hash the same bytes whoever
     * spoke first.
     */
    const mineOffer = concat(this._cpace.msg, (await this._kem).ek);
    const transcript = await sha256(
      lane === 0 ? concat(mineOffer, offer) : concat(offer, mineOffer),
    );

    const cand = {
      K,
      ssOut: sent.ss,
      ctOut: sent.ct,
      transcript,
      peerShare,
      key: await aeadKey(await hkdf(K, 'gd/sig/v1', 32)),
      lane,
      // Each direction proves itself with a different value, bound to the share that
      // produced it, so a confirmation cannot be echoed back at its sender.
      mine: await confirmTag(K, concat(transcript, this._cpace.msg)),
      theirs: await confirmTag(K, concat(transcript, peerShare)),
    };
    cand.peerLane = cand.lane ^ 1;
    this._candidate = cand;

    /*
     * The confirmation carries the wrapped secret with it.
     *
     * The tag proves the classical agreement, which is what stops a stranger being taken for
     * the peer now; no amount of lattice work helps with that. It also proves the two offers
     * as published, so the lattice halves cannot be swapped underneath it. Beside it rides the
     * wrapped secret, which is what stops a recording being readable later. One frame, so the
     * handshake stays two messages deep.
     */
    this.signal.forward(this.tag, concat(new Uint8Array([F_CONFIRM]), sent.ct, cand.mine));

    // A confirmation can outrun the share it belongs to when frames reorder, and one can
    // arrive mid-computation. Either is replayed against the agreement just built.
    const early = this._earlyConfirm || heldEarly;
    if (early) {
      this._earlyConfirm = null;
      await this._onConfirm(early, { replayed: true });
    }
  }

  async _onConfirm(body, { replayed = false } = {}) {
    if (!body || body.length !== KEM_CT_BYTES + 32) return;
    const peerCt = body.subarray(0, KEM_CT_BYTES);
    const tag = body.subarray(KEM_CT_BYTES);

    /*
     * Re-applied rather than discarded if the round moves underneath it.
     *
     * Finishing the key yields the thread three times (opening the wrapped secret, stretching
     * it, importing it), and a share arriving in any of those gaps builds a fresh candidate.
     * The confirmation is still good: it proves the same two shares agreed, and re-keying
     * against the same peer share reaches the same place. Discarding it left one side up and
     * the other waiting, because nothing would send it again. The bound is a formality, since
     * each turn needs a candidate to have been replaced.
     */
    for (let attempt = 0; attempt < 4; attempt++) {
      const c = this._candidate;
      if (!c) {
        this._earlyConfirm = Uint8Array.from(body);
        return;
      }

      if (!equal(tag, c.theirs)) {
        /*
         * Our own expectation from a round that is over: the peer's answer, arriving after we
         * stopped waiting for it. It proves the code was right, so it is not a stranger, and
         * there is nothing left to do with it. The round in progress is left alone.
         */
        if (this._spent.some((t) => equal(tag, t))) return;

        // Either the other end does not have the code, or it is not the other end. Either way
        // this agreement is worthless, and a session that was already running is unaffected.
        //
        // A held confirmation is the exception. It may belong to a round that has since been
        // replaced, so it is still reported, because a wrong code looks the same and saying
        // nothing would hang. It does not take the new agreement with it, since that round's
        // confirmation may still be in flight.
        if (!replayed) this._dropCandidate();
        if (!this.established) {
          this.dispatchEvent(
            new CustomEvent('error', {
              detail: new Error('the other device could not prove it has the same code'),
            }),
          );
        }
        return;
      }

      /*
       * Both halves agreed, so the session key is made of both.
       *
       * `ssOut` is the secret we wrapped to them; `ssIn` is the one they wrapped to us. Both
       * sides hold the same pair and must feed them in the same order, so they go in by lane
       * rather than by who generated which. The lane is the tiebreak this handshake uses
       * elsewhere and is the same value on both screens.
       */
      if (!this._kem) return; // the round this belongs to is over and its key is wiped
      const ssIn = await kemDecapsulate((await this._kem).dk, Uint8Array.from(peerCt));
      const mineCt = Uint8Array.from(peerCt);
      const toLane0 = c.lane === 0 ? ssIn : c.ssOut;
      const toLane1 = c.lane === 0 ? c.ssOut : ssIn;

      /*
       * The ciphertexts are part of the key, not only the thing that carried it.
       *
       * ML-KEM never reports a bad ciphertext. Decapsulating a tampered one returns an
       * ordinary-looking secret that is not the sender's, and nothing in the frame
       * distinguishes the two. Putting the ciphertexts into the derivation means one altered
       * byte anywhere in the exchange lands the two sides on different keys immediately,
       * rather than appearing to agree and failing later.
       *
       * By lane, like the secrets they carry: lane 0's is the one only lane 0 can open.
       */
      const ctLane0 = c.lane === 0 ? mineCt : c.ctOut;
      const ctLane1 = c.lane === 0 ? c.ctOut : mineCt;

      // Hashed first because HKDF's context argument stops at a kilobyte and one ciphertext
      // is already past it. A digest of the whole exchange binds the same material.
      const bound = await sha256(concat(c.transcript, ctLane0, ctLane1));
      const hybrid = await hkdf(
        concat(c.K, toLane0, toLane1),
        concat(te.encode('gd/hybrid/v1'), bound),
        32,
      );
      const key = await aeadKey(await hkdf(hybrid, 'gd/sig/v1', 32));
      ssIn.fill(0);

      if (this._candidate !== c) {
        hybrid.fill(0);
        continue; // a newer round is in the slot; prove this confirmation against that one
      }

      c.ssOut.fill(0);
      c.K.fill(0);
      c.K = hybrid;
      c.key = key;
      this._promote();
      return;
    }
  }

  /** Adopt a confirmed agreement as the live session. */
  _promote() {
    const c = this._candidate;
    this._spend(c);
    this._candidate = null;
    this._earlyConfirm = null;

    if (this.K) this.K.fill(0);
    this.K = c.K;
    this.key = c.key;
    this.lane = c.lane;
    this.peerLane = c.peerLane;
    this._peerShare = c.peerShare;
    this.generation = ((c.K[0] << 24) | (c.K[1] << 16) | (c.K[2] << 8) | c.K[3]) >>> 0;

    // A new key means a new nonce space, so the counters restart safely.
    this.sendCounter = 0;
    this._outChain = null;
    this._window = new ReplayWindow();
    this._unopened = 0;
    this.sas = null;
    this.established = true;

    this._forgetEphemerals();

    this.dispatchEvent(new CustomEvent('secure', { detail: { lane: this.lane } }));
  }

  /**
   * Drop the private halves of the exchange, now that the key they produced exists.
   *
   * Neither is needed again. Holding either means anything able to read this process later,
   * such as a memory dump or a compromised extension, can use it against recorded traffic.
   *
   * The lattice private key matters as much as the scalar. It is what makes a recording
   * unreadable to somebody who later breaks discrete logs, and a copy of it left in memory
   * for the rest of the session would hand that attacker the whole key if they also got the
   * device.
   */
  _forgetEphemerals() {
    if (this._cpace?.state) {
      this._cpace.state.y = 0n;
      this._cpace.state = null;
    }
    const kem = this._kem;
    this._kem = null;
    this._kemOut = null;
    // A promise, because the keypair is generated off the critical path. The bytes are zeroed
    // whenever it lands, and a failed generation has nothing to zero.
    if (kem) Promise.resolve(kem).then((k) => k?.dk?.fill(0), () => {});
  }

  /** Bind the SAS to the actual DTLS fingerprints of the negotiated media path. */
  async computeSas(localFp, remoteFp) {
    this.sas = await sasWords(this.K, localFp, remoteFp);
    this.dispatchEvent(new CustomEvent('sas', { detail: this.sas }));
    return this.sas;
  }

  /** Derive the per-transfer payload key. */
  async transferKey(transferId) {
    return aeadKey(await hkdf(this.K, concat(te.encode('gd/xfer/v1'), te.encode(transferId)), 32));
  }

  /** Derive the durable pairing root so this peer is recognised later, serverlessly. */
  async derivePairRoot() {
    return hkdf(this.K, 'gd/pair/v1', 32);
  }

  /**
   * Sends are serialised so the counter order matches the wire order. Without this,
   * two concurrent seals can finish out of order and the peer's replay window has to
   * deal with gaps it should never have seen.
   */
  send(obj) {
    if (!this.established) throw new Error('session not established');
    this._outChain = (this._outChain || Promise.resolve()).then(async () => {
      const body = pad(te.encode(JSON.stringify(obj)), 256);
      const counter = this.sendCounter++;
      const ct = await seal(this.key, nonceFor(this.lane, counter), body, te.encode('gd/sig'));
      const head = new Uint8Array(9);
      head[0] = F_SEALED;
      new DataView(head.buffer).setBigUint64(1, BigInt(counter), true);
      this.signal.forward(this.tag, concat(head, ct));
    });
    return this._outChain;
  }

  /**
   * Open a sealed frame, and only then let it touch the replay window.
   *
   * The window used to be advanced with the counter read straight off the wire, before
   * anything had shown the frame was genuine. One invented frame carrying a counter near
   * 2^63 pushed the window past every real counter and silenced the channel for good, with
   * no key, no error and nothing to notice. Claiming the next few counters instead dropped
   * the frames an attacker chose while the connection kept looking healthy.
   *
   * A replay window is authenticated state. Only an authenticated frame may move it.
   */
  async _unseal(body) {
    if (body.length < 8) return null;
    const counter = Number(new DataView(body.buffer, body.byteOffset, 8).getBigUint64(0, true));
    // Past 2^53 a counter is no longer exactly representable, so it cannot be one a sender
    // used, and no sender will reach it.
    if (!Number.isSafeInteger(counter) || counter < 0) return null;

    let pt;
    try {
      pt = await open(this.key, nonceFor(this.peerLane, counter), body.subarray(8), te.encode('gd/sig'));
    } catch {
      // Noise, or somebody trying. Neither earns a state change or a banner. A wrong code is
      // caught at confirmation.
      this._maybeDiverged();
      return null;
    }
    // It opened, so the two sides agree and whatever came before was noise.
    this._unopened = 0;
    if (!this._window.accept(counter)) return null; // genuine, but already seen
    try {
      return JSON.parse(td.decode(unpad(pt)));
    } catch {
      return null;
    }
  }

  /**
   * A run of unopenable frames on a live session means the peer is on another key.
   *
   * The remedy is the one used when the relay reports a peer gone: throw the agreement away
   * and key again. The alternative is a connection that stays up and carries nothing for as
   * long as both sides believe in it.
   *
   * Two guards keep this from becoming a lever. The count only rises while established and is
   * cleared by any frame that opens, so ordinary noise never reaches the threshold, and a
   * re-key is allowed at most once every few seconds, so somebody feeding the socket rubbish
   * buys one handshake rather than a loop.
   */
  _maybeDiverged() {
    if (!this.established) return;
    if (++this._unopened < DIVERGED_AFTER) return;

    const now = Date.now();
    if (now - this._lastRekey < REKEY_MIN_MS) return;
    this._lastRekey = now;
    this._unopened = 0;

    this.dispatchEvent(new CustomEvent('diverged'));
    this.reset();
  }
}

/**
 * What one side sends to show it derived the same key.
 *
 * Bound to the share that produced it, so the two directions never send the same value and a
 * confirmation cannot be reflected back at the peer that sent it.
 */
async function confirmTag(K, share) {
  return hkdf(K, concat(te.encode('gd/kc/v1'), share), 32);
}

function cmp(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * A symmetric ratchet, so a key recovered later does not open what was already said.
 *
 * The session key used to be derived once and used for every control frame the session
 * carried. That is sound against someone watching the wire and useless against someone who
 * gets the key afterwards, because one value opens every message from the start, including
 * the ones already delivered and closed.
 *
 * Each direction gets a chain instead. Every frame is sealed under a key used once, and the
 * chain steps forward:
 *
 *     MK(n)   = HKDF(CK(n), "…/mk/v1")     the key frame n is sealed under
 *     CK(n+1) = HKDF(CK(n), "…/ck/v1")     what the chain becomes
 *
 * `CK(n)` is overwritten once it has produced both, and HKDF does not run backwards, so after
 * the chain passes n nothing on this device can reconstruct the key frame n used. Compromise
 * is not retroactive.
 *
 * This does not give healing. An attacker who takes the chain state keeps pace with it, since
 * every future key derives from what they hold. Recovering needs fresh key material from a
 * new exchange, which is a Diffie-Hellman ratchet and separate work; re-keying the session
 * reaches the same place more bluntly.
 */

const MK_INFO = 'gd/ratchet/mk/v1';
const CK_INFO = 'gd/ratchet/ck/v1';

/**
 * How far ahead of the chain a frame may claim to be.
 *
 * Frames can arrive out of order or not at all, and the chain has to be walked forward to
 * reach one that skipped ahead. This is both the tolerance for a lossy link and the ceiling
 * on how much work a single frame can ask for. Without it, one frame claiming sequence 2^40
 * hangs the receiver.
 */
export const MAX_SKIP = 512;

export class Ratchet {
  /** @param {Uint8Array} seed the chain's starting value, already domain-separated. */
  constructor(seed) {
    this.next = Uint8Array.from(seed);
    this.index = 0;
    /** Keys for frames that were passed over, held until they arrive or age out. */
    this.skipped = new Map();
  }

  /** One step: the key for the current index, and the chain that replaces it. */
  static async step(ck) {
    const mk = await hkdf(ck, MK_INFO, 32);
    const next = await hkdf(ck, CK_INFO, 32);
    return { mk, next };
  }

  /** The next outgoing frame: its sequence number and the key it is sealed under. */
  async send() {
    const seq = this.index;
    const { mk, next } = await Ratchet.step(this.next);
    this.next.fill(0);
    this.next = next;
    this.index = seq + 1;
    const key = await aeadKey(mk);
    // The bytes are gone once the key object exists; only the browser holds it now.
    mk.fill(0);
    return { seq, key };
  }

  /**
   * The key for an incoming frame, and a way to make that permanent.
   *
   * Nothing is committed here. The sequence number arrives unauthenticated, and on the relay
   * path it is the relay's claim until the frame decrypts. A chain advanced on a claim is one
   * an attacker can drive: a single invented frame far ahead makes every real frame behind it
   * unopenable. The walk is done on a copy, and the caller commits once the frame has proved
   * itself.
   */
  async receive(seq) {
    if (!Number.isSafeInteger(seq) || seq < 0) return null;

    // Already passed, so it is late or a replay. The key was kept only if it was skipped.
    if (seq < this.index) {
      const mk = this.skipped.get(seq);
      if (!mk) return null;
      return {
        key: await aeadKey(mk),
        commit: () => {
          mk.fill(0);
          this.skipped.delete(seq);
        },
      };
    }

    if (seq - this.index > MAX_SKIP) return null;

    // Walk a copy forward, keeping what is stepped over in case those frames turn up.
    let ck = Uint8Array.from(this.next);
    const passed = [];
    let mk = null;
    for (let i = this.index; i <= seq; i++) {
      const out = await Ratchet.step(ck);
      ck.fill(0);
      ck = out.next;
      if (i === seq) mk = out.mk;
      else passed.push([i, out.mk]);
    }

    return {
      key: await aeadKey(mk),
      commit: () => {
        this.next.fill(0);
        this.next = ck;
        this.index = seq + 1;
        mk.fill(0);
        for (const [i, key] of passed) this.skipped.set(i, key);
        this._trim();
      },
    };
  }

  /** The skipped store is memory an attacker could otherwise grow by never sending. */
  _trim() {
    while (this.skipped.size > MAX_SKIP) {
      const oldest = this.skipped.keys().next().value;
      this.skipped.get(oldest)?.fill(0);
      this.skipped.delete(oldest);
    }
  }

  /** Forget everything. What is zeroed here cannot be derived again. */
  destroy() {
    this.next?.fill(0);
    for (const mk of this.skipped.values()) mk.fill(0);
    this.skipped.clear();
    this.index = 0;
  }
}

/**
 * The two chains a session talks over.
 *
 * Each side derives both from the same session key, separated by the lane the frame travels
 * on, so what one calls outgoing the other calls incoming without either being told.
 */
export async function ratchetPair(K, lane) {
  const seed = async (l) => hkdf(K, `gd/ratchet/v1/${l}`, 32);
  return {
    out: new Ratchet(await seed(lane)),
    in: new Ratchet(await seed(lane ^ 1)),
  };
}

/**
 * Sliding replay window. Accepts any counter ahead of the window, and any unseen counter
 * inside it. Refuses replays and anything older than the window.
 */
export class ReplayWindow {
  constructor(size = 256) {
    this.size = size;
    this.highest = -1;
    this.seen = new Set();
  }
  accept(counter) {
    if (!Number.isInteger(counter) || counter < 0) return false;
    if (counter <= this.highest - this.size) return false; // too old to judge
    if (this.seen.has(counter)) return false; // replay
    this.seen.add(counter);
    if (counter > this.highest) this.highest = counter;
    if (this.seen.size > this.size * 2) {
      for (const c of this.seen) if (c <= this.highest - this.size) this.seen.delete(c);
    }
    return true;
  }
}

export { equal };
