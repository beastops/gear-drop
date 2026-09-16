# Gear Drop Protocol, v0.1 (draft, implementable)

All multi-byte integers are **little-endian**. All binary. No JSON on the wire between peers or on the
relay, except inside sealed payloads where JSON is used for structure (and never parsed by the server).

---

## 1. Constants

```
CODE_ALPHABET   "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   // 32 symbols; I, L, O and U are absent
CODE_LEN        6                                    // 30 bits of entropy
TAG_LEN         16                                   // rendezvous tag bytes
TAG_ITERATIONS  600000                               // PBKDF2-SHA256 rounds for a code's tag
EPOCH_SECONDS   600                                  // pairing token rotation
KEM_EK_BYTES    1184                                 // ML-KEM-768 encapsulation key (FIPS 203)
KEM_CT_BYTES    1088                                 // ML-KEM-768 ciphertext
RV_TTL          120                                  // rendezvous lifetime, seconds
CHUNK_MIN       16384                                // 16 KiB  (Firefox-safe floor)
CHUNK_MAX       262144                               // 256 KiB
BUF_HIGH        8388608                              // 8 MiB   send high-watermark
BUF_LOW         1048576                              // 1 MiB   bufferedAmountLowThreshold
LANES_MAX       4
```

### Key schedule

The session key is **hybrid**: a classical PAKE and a lattice KEM, and breaking it needs both.
Neither half is load-bearing alone: the PAKE is what stops a stranger being taken for the peer
today, and the KEM is what stops a recording made today being read once discrete logs fall.

```
Kc       = CPace(code)                       // classical, over ristretto255
Kc       = HKDF(Kc ‖ pairRoot, info="gd/reconnect/v1", 32)      // paired reconnect only
ss0, ss1 = ML-KEM-768 secrets, indexed by lane: ssL is the one lane L's own key opens
T        = SHA-256(offer0 ‖ offer1)          // both offers as published, in lane order
B        = SHA-256(T ‖ ct0 ‖ ct1)            // and both ciphertexts as sent
K        = HKDF(Kc ‖ ss0 ‖ ss1, info="gd/hybrid/v1" ‖ B, 32)    // the session key

Ks       = HKDF(K, info="gd/sig/v1",  32)    // signalling envelope key
Kt       = HKDF(K, info="gd/xfer/v1" ‖ transferId, 32)   // per-transfer payload key
ck(L)    = HKDF(K, info="gd/ratchet/v1/" ‖ L, 32)        // control-channel chain, per lane
pairRoot = HKDF(K, info="gd/pair/v1", 32)    // stored, never transmitted again
token(e) = HKDF(pairRoot, info="gd/rv/v1" ‖ u64(e), 16)
hint(e)  = HKDF(pairRoot, info="gd/hint/v1" ‖ u64(e), 8)
tag(e)   = PBKDF2-SHA256(code, salt="gd/tag/v2" ‖ u64(e), 600000, 16)   // rendezvous tag
SAS      = HKDF(K, info=lv("gd/sas/v1", fpLo, fpHi), 4) → 4 words from a 256-word list
```

`lv(...)` is length-prefixed concatenation: one length byte before each field, so no two
different field lists can produce the same bytes. `fpLo`/`fpHi` are the two DTLS fingerprints
sorted lexicographically, so both screens show the same words whoever dialled.

Ordering everything by **lane** rather than by role is what lets the handshake stay symmetric:
lane 0 is the side whose CPace message sorts lower, and it is the same value on both devices.

### CPace as implemented

Following draft-irtf-cfrg-cpace over ristretto255. The generator is hashed from five
length-prefixed fields:

```
gen = hash_to_ristretto255( lv(DSI, PRS, ZPAD, CI, sid) ),  DSI = "CPace255-gd1"
```

* `PRS` is the code. `CI` is empty, because this protocol has no party names to bind; writing the
  field out anyway keeps the encoding the one the draft describes.
* `sid` is the rendezvous tag, which both sides already agree on out of band.
* `ZPAD` is sized so that `lv(DSI, PRS, ZPAD)` comes to exactly one SHA-512 input block (128
  bytes), so the compression that touches the password touches nothing session-specific.
* The peer's message is rejected if it is not a canonical encoding or if it is the identity.
* `ISK = HKDF(g^xy, info=lv(DSI ‖ "_ISK", sid, Ylo, Yhi), 32)`, the two messages sorted, so both
  sides hash the same bytes. The draft hashes the secret with the transcript; HKDF-Extract of the
  secret followed by Expand over the transcript is the same construction with a better shape.

---

## 2. Client ⇄ Server (rendezvous relay)

Binary WebSocket frames. The server understands **five** frame types and never looks inside `payload`.

```
+--------+----------------+-------------------------+
| type:1 |   tag: 16      |  payload: 0..N          |
+--------+----------------+-------------------------+
```

| type | name | direction | payload | server action |
|---|---|---|---|---|
| `0x01` | `SUBSCRIBE` | C→S | — | attach socket to `tag`; ≤2 sockets; start TTL |
| `0x02` | `FORWARD` | C→S | opaque | copy verbatim to the other socket on `tag` |
| `0x03` | `PEER_UP` | S→C | — | a counterpart attached |
| `0x04` | `PEER_GONE` | S→C | reason:1 | counterpart left / TTL expired / tag full |
| `0x05` | `ICE_CREDS` | S→C | CBOR `{urls[], username, credential, ttl}` | short-lived TURN credentials |

Rules:
* A `tag` holds **at most two** sockets. A third `SUBSCRIBE` is answered with `PEER_GONE(FULL)`.
* Rendezvous tags used for code pairing are **burned** once both sides have exchanged a `FORWARD`.
* Pairing tokens (§1) are re-subscribable every epoch; the server keeps no history across them.
* Keep-alive uses WebSocket protocol ping/pong (25 s interval, 2 misses ⇒ close). No application ping.
* The server MUST NOT log payloads, tags, or IP addresses.

### 2.1 Sealed signalling envelope (inside `FORWARD`)
```
+---------+-----------+-------------------------------+
| ver: 1  | nonce: 12 |  AES-256-GCM(Ks, nonce, msg)  |
+---------+-----------+-------------------------------+
```
`msg` is CBOR:

| `t` | fields | meaning |
|---|---|---|
| `hello` | `pk` (X25519 static pub), `name`, `caps[]`, `proto` | identity + capability advertisement |
| `offer` / `answer` | `sdp` | WebRTC description (fingerprints included ⇒ MITM-bound by SAS) |
| `ice` | `cand`, `mid` | trickle candidate |
| `lane` | `id`, `role` | extra peer connection for lane `id` |
| `wt` | `url`, `token` | WebTransport relay path offer |
| `bye` | `reason` | teardown |

The two handshake offers are sent unsealed, since they are the key exchange itself, framed as
`0x10 ‖ cpaceMsg(32) ‖ ek(1184)`: the classical share and the lattice encapsulation key
travel together, so the post-quantum half costs no extra round trip. An offer of any other
length is refused rather than treated as an older, classical-only peer: both ends load their
code from the same origin, so there is nothing to be compatible with, and a downgrade is then
not a shape this protocol can be talked into. Everything after the offers is sealed.

### 2.2 Key confirmation (`0x14`)

CPace returns a key whatever the other side did. A wrong code, or a party with no code at
all, still produces a key, just a different one. So agreement is not the end of the
handshake; proving agreement is.

    confirm(share) = HKDF(Kc, "gd/kc/v1" ‖ T ‖ share, 32)

Each side sends `0x14 ‖ ct(1088) ‖ confirm(ownShare)` as soon as it has a key, and compares
what arrives against `confirm(peerShare)` in constant time. The wrapped lattice secret rides
in the same frame, which is what keeps the handshake two messages deep.

Two things are bound into that value, for two different reasons:

* **The share that produced it**, so the two directions never send the same bytes and a
  confirmation cannot simply be reflected back at the peer that sent it.
* **`T`, the two offers as published.** The classical agreement proves the two group elements
  agreed and says nothing about the lattice keys beside them. Somebody without the code cannot
  forge an element, but relaying a genuine one while replacing the key next to it costs
  nothing, and without `T` both ends confirm each other, go live, and then hold different
  session keys. Covering the offers turns that into a confirmation that fails, which is
  something the app can say out loud, rather than a silence it has to infer.

Both ciphertexts are bound into the session key rather than into the tag, because a side does
not learn the peer's ciphertext until the confirmation arrives. ML-KEM never reports a bad
ciphertext, because decapsulating a tampered one returns an ordinary-looking secret that is
not the sender's, so this is the only place tampering there can be made to show.

Until that comparison succeeds the key is held aside and is not the session key: no sealed
frame is accepted under it, nothing is reported as connected, and the UI is not told. A
mismatch means the far end does not have the code, and is reported as that rather than
surfacing later as a decryption failure.

A peer's own share echoed back is refused before any of this: the key it yields is one only
we can compute, and it would otherwise confirm against itself.

**Re-keying.** While a transport is carrying traffic an unsolicited `0x10` is ignored. There
is no way to tell a restarted peer from an invented frame by looking at it, so the question
asked instead is whether the existing connection still works. A peer that genuinely left is
reported gone by the relay, which resets the session. Answering unsolicited shares while
connected allowed anyone on the rendezvous to re-key a healthy session, and with several in
flight the two sides could settle on different rounds, both believing they were connected,
neither able to read the other.

---

## 3. Peer ⇄ Peer (data channel / relay stream)

Two channels per peer connection:
* `ctl`: ordered, reliable, small JSON-in-CBOR control frames.
* `bulk`: ordered, reliable, binary chunk frames. One `bulk` per lane.

### 3.1 Control frames (`ctl`, sealed with `Kt` once a transfer starts)

| `t` | fields |
|---|---|
| `manifest` | `transferId`, `files:[{fileId, name, size, mime, sha256, chunk}]`, `totalSize`, `thumb?` |
| `accept` | `transferId`, `files:[fileId]` (subset allowed) |
| `decline` | `transferId`, `reason` |
| `resume` | `transferId`, `fileId`, `have:[[start,end],…]` |
| `ack` | `transferId`, `fileId`, `upto` (bytes contiguously persisted) |
| `progress` | `transferId`, `received`, `rateBps` |
| `done` | `transferId`, `fileId`, `sha256` |
| `abort` | `transferId`, `reason` |
| `rename` | `name` (peer display name change, **rendered with textContent only**) |

`ack` carries the durable offset (after the sink reports a successful write), so resume is exact.

### 3.2 Bulk chunk frame (`bulk`)
```
+---------+---------+-----------+-----------+------------------------+---------+
| ver:1   | lane:1  | fileId:4  | offset:8  | ciphertext: len        | tag:16  |
+---------+---------+-----------+-----------+------------------------+---------+
   nonce = lane(1) ‖ counter(11)        aad = fileId ‖ offset ‖ len
```
* `len` is implied by the frame size (SCTP preserves message boundaries).
* Chunk size is `negotiated = clamp(min(sctp.maxMessageSize_A, sctp.maxMessageSize_B) - 48, CHUNK_MIN, CHUNK_MAX)`.
* The receiver verifies the GCM tag **before** writing; a failure aborts the transfer (it means tampering,
  not corruption; SCTP already guarantees integrity of delivered data).

### 3.3 Flow control
Sender per lane:
```
while (channel.bufferedAmount < BUF_HIGH && haveWork) send(nextChunk)
channel.bufferedAmountLowThreshold = BUF_LOW
channel.onbufferedamountlow = pump
```
No application-level ACK gates the pipe. `ack` exists only for **durability/resume**, never for pacing.

### 3.4 Transfer lifecycle
```
sender                                receiver
 manifest ───────────────────────────► [single dialog: SAS + manifest]
        ◄─────────────────────── accept | decline
 (open lanes)                          (open sink, load resume bitmap)
        ◄─────────────────────── resume {have:[…]}      (only if reconnecting)
 chunk × N ──────────────────────────► verify → sink.write → bitmap
        ◄─────────────────────── ack {upto} (≥ every 4 MiB or 1 s)
 done ───────────────────────────────► verify sha256 → close sink → surface file
        ◄─────────────────────── done
```
Reconnect: either side re-subscribes to the pairing token, re-runs §2, re-opens lanes, and sends
`resume`. The transfer never restarts from zero.

---

## 3.5 Discovery channels (rooms, and "this network")

A **channel** is one secret held by several devices at once. Two things in the product are
channels, and they differ only in where the secret comes from:

| channel | secret | who has it |
|---|---|---|
| room | `room:<5-char code>` typed by people | everyone who was told the code |
| this network | `net:<label>` the relay derives from the address a socket arrived on | everyone on that network, **and the operator** |

Everything else is identical:

```
secret   = HKDF(label,        "gd/chan/v1")            32 B, never transmitted
tag      = HKDF(secret,       "gd/chan/tag/v1" ‖ epoch) 16 B, what the relay sees, rolls hourly
key      = HKDF(secret,       "gd/chan/presence/v1")    AES-256-GCM, seals presence
pairTag  = HKDF(secret, "gd/chan/pair/v1" ‖ lo(idA,idB) ‖ hi(idA,idB))   16 B
```

`epoch = floor(unix / 3600)`. A member subscribes to the current hour's tag **and the
previous one, always**, because two people joining either side of an hour boundary would
otherwise never meet, and an idle extra subscription is cheap.

### The room tag is a directory, not a channel

The relay gives a tag a **mode**, fixed by whoever creates it:

| frame | cap | payload cap |
|---|---|---|
| `SUBSCRIBE` (0x01) | 2 | 256 KiB |
| `SUBSCRIBE_ROOM` (0x06) | 24 | 2 KiB |

Joining an existing tag in the other mode is refused with `PEER_GONE{MODE}` rather than
silently widened. Otherwise anyone could turn a two-party rendezvous into a room and sit
inside it. The small payload cap stops a many-member tag being used as a broadcast
amplifier: presence frames are 300-odd bytes, bulk data belongs on a two-party tag.

### Presence

One frame type, sealed under `key`, padded to 256 bytes:

```
+--------+-----------+--------------------+
| 0x20   | nonce:12  | ciphertext ‖ tag:16|
+--------+-----------+--------------------+

plaintext = { t: "hi" | "bye", id: <16 B hex>, name, kind, h: [hint, …] }
```

`id` is 16 random bytes generated **per join**, so nothing durable is announced. The nonce
is random rather than a counter: a channel tag has no single ordered sender, and these are
a handful of small messages under a key that lives for one session.

Members announce on join, on every `PEER_UP` (which is what tells the room someone new
arrived), every 25 s, and once, jittered 120–520 ms, in direct reply to a stranger's
announcement so a newcomer's roster fills even if the relay's membership notice raced it.
A member unheard from for 95 s is dropped.

### Recognition hints

`h` carries one hint per already-paired device:

```
hint = HKDF(pairRoot, "gd/hint/v1" ‖ epoch)[0:8]      epoch = 10-minute pairing epoch
```

A device holding the same pairing root computes the same value and recognises its
counterpart; to anyone else it is 8 bytes that change every ten minutes. This is what stops
a device you have already paired with appearing a second time as a stranger, without
announcing any durable identity to the room. A member is re-evaluated whenever its hints
change, so pairing mid-session retires the redundant conversation rather than leaving two
tiles on screen.

### Pairing off

Having learned each other's ids, two members compute `pairTag` and run **the ordinary
§2 two-party handshake there**, with `toHex(secret)` as the CPace password. So:

* the relay is outside the handshake, exactly as with a typed code;
* inside a room, everyone holds the password, so a member can attempt to interpose,
  and for "this network" the operator holds it too;
* the SAS is what exposes that, which is why a device met through a channel is shown as
  **unverified** until someone checks the words, and why the network channel is off by
  default and says so in its own dialog.

The server groups sockets by the address they arrived from and never sees the SDP, so it
learns that two devices share a network and nothing about what they then say. That is still
weaker than a paired device, and the interface does not pretend otherwise.

---

## 3.6 Messages, and everything else on the control channel

A message is not a special case: it is one control frame among the manifests, accepts,
acks, resumes and renames, and they are all sealed the same way.

```
ck(L)  = HKDF(K, "gd/ratchet/v1/" ‖ L, 32)      one chain per direction, by lane
mk(i)  = HKDF(ck(i), "gd/ratchet/mk/v1", 32)    the key for frame i
ck(i+1)= HKDF(ck(i), "gd/ratchet/ck/v1", 32)    and the chain that replaces it
nonce  = lane(1) ‖ 000 ‖ seq(8 LE)              lane 0 / lane 1 by CPace share order
aad    = "gd/ctl"
frame  = seq(8 LE) ‖ AES-256-GCM(mk, nonce, pad(JSON, block), aad)
```

| | |
|---|---|
| **Own key** | `gd/ratchet/v1/*`, distinct from `gd/sig/v1` (signalling) and `gd/xfer/v1` (payload), so compromising one reads none of the others |
| **Forward secret per frame** | every frame has its own key and the chain only moves forwards, so a key recovered from memory reads that frame and nothing before it. A chain is walked forward at most `MAX_SKIP` (512) steps for a frame that claims to have skipped ahead, which is both the tolerance for a lossy link and the ceiling on what one frame can ask for |
| **Derive, then authenticate, then commit** | the sequence number arrives unauthenticated, so the key for it is derived speculatively and the chain is only advanced once the frame has actually opened |
| **Authenticate before state** | a replay window is only moved by a frame that has already decrypted. Advancing it on a sequence number read off the wire let one unauthenticated frame carrying a counter near 2^63 push the window past every real counter and silence the channel for good |
| **No nonce reuse** | the lower CPace share owns lane 0 and the other lane 1, so both sides count from zero without colliding; the counter restarts **only when the session generation changes**, never on a transport swap |
| **Length hidden** | padded to 256 B for structural frames and **1 KiB for text**, because a message's length says more about it than a file name's does |
| **Replay refused** | a sliding window, so out-of-order frames still land and repeats do not |
| **Bound to being control** | the AAD means a control frame cannot be replayed as a signalling frame |
| **Bounded both ways** | 32 KiB on send *and* on receive; the sender's limit is the sender's |

This holds on the relay path too: `RelayTransport` carries these exact bytes, so a relay
handling the fallback sees AEAD ciphertext of a fixed size and learns neither the text of a
message nor the length of one.

### 3.7 Forgetting

Both private halves of the exchange, the CPace scalar and the ML-KEM decapsulation key, are
zeroed the moment the session key exists. Neither is needed again, and holding either would
let anything able to read the process later recompute the key against recorded traffic.
`destroy()` zeroes `K` and drops the derived keys, the SAS and the peer's share.

What this buys: a finished session cannot be reopened, by anyone, including from this
device. What it does not buy: protection against a compromise that is *already present*
while the session is live.

---

## 4. Wire-level privacy notes

* The server observes: connection time, IP, an opaque 16-byte tag, and ciphertext lengths. Nothing else.
* The one exception is the **network label**, and only for clients that opt in: `HMAC(secret, address)`
  under a secret re-rolled every six hours, handed to the client alongside the ICE credentials. It tells
  the client nothing it did not already know, and it is the only place the relay is asked to group anyone.
  It is never stored, and with the secret unset the feature is simply unavailable.
* Tags rotate every 10 minutes for paired devices and are single-use for code pairing ⇒ **no stable
  identifier ever reaches the server**.
* File names, sizes, MIME types and thumbnails live inside `Kt`-sealed control frames, even on the relay
  path — the fallback carries the same sealed frames as the direct path, so nothing becomes
  readable by dropping to it.
* Padding: control frames are padded to a 256-byte multiple so that a file-name length is not inferable
  from the ciphertext size.

---

## 5. Versioning
`ver` byte on every frame; a mismatch produces a clean "update one of your devices" message rather than a
silent failure. Protocol changes bump `proto` in `hello`, and both sides negotiate down to the lower
common version.
