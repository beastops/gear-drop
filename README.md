# Gear Drop

Device-to-device file transfer in the browser. The relay that introduces two devices cannot
read what they send, impersonate either of them, or link them across sessions.

```bash
npm install
npm start          # http://localhost:3000
npm test           # 513 tests
```

Open the app on two devices. Click **Add a device** on one and type the six characters on the
other, check that the four safety words match, and send. Devices on the same network find each
other without a code.

Hosting is in [`DEPLOY.md`](DEPLOY.md). It runs on free tiers, and the app and relay can live
on different services.

## How it works

A six-character code is the password input to a **CPace** PAKE over ristretto255, so the
session key is derived on the two devices and never reaches the relay. Session descriptions,
ICE candidates, file names and sizes are sealed with AES-256-GCM before the relay sees them,
and four **safety words** bind the key to both DTLS certificate fingerprints, so anything
relaying in the middle produces different words on the two screens.

A PAKE answers who is on the other end today and says nothing about tomorrow: discrete logs
fall to a quantum computer, so anything agreed this way is readable by whoever kept a copy and
waited. So **ML-KEM-768** runs beside it. Each side publishes a lattice key alongside its CPace
share in the same frame, with no extra round trip, and the session key is derived from the
classical secret and both lattice secrets together, so breaking it needs both. Neither half
alone reaches the key, and the whole exchange is hashed into it, so a key substituted in flight
produces a confirmation that fails rather than two devices that quietly cannot talk.

Thirty bits of code would fall to a GPU in a fraction of a second, so the rendezvous tag costs
600 000 rounds of PBKDF2 salted with a ten-minute epoch. Recovering the code would still only
enable an active attack, which is what the safety words are there to catch.

Transfers are peer-to-peer. Where WebRTC is blocked outright there is a fallback carrying the
same sealed frames over the rendezvous socket, so the relay handles ciphertext either way. It
is never taken silently: the app asks each time rather than remembering a yes, and upgrades
back to the direct path if one becomes available.

### Finding devices

| | how | authenticated |
|---|---|---|
| **paired** | a rotating token from a shared secret and a ten-minute epoch; no code, no server record | yes, the pairing root is folded into the key |
| **this network** | opt-in; the relay labels each socket by the address it arrived on, re-rolled every six hours | no, check the safety words |
| **a room** | a five-character code read out loud, across networks | no, everyone with the code is equal |

A room is a directory rather than a channel: members announce a per-session id, and each pair
then runs the ordinary two-party handshake at its own tag. The relay never carries a group
conversation and cannot list rooms or read a roster.

### What is encrypted, with which key

Three keys are derived from the session key, so compromising one reads none of the others. All
of this sits inside DTLS as well; this layer is what the relay also cannot read.

| | key | nonce | padded to |
|---|---|---|---|
| Signalling: SDP, ICE candidates | `gd/sig/v1` | lane ‖ counter | 256 B |
| Messages, file names, sizes, acks | `gd/ratchet/v1/`lane, a key per frame | lane ‖ sequence | 256 B, 1 KiB for text |
| File bytes | `gd/xfer/v1` ‖ transferId | file ‖ chunk index | chunk-sized |

Control frames step a ratchet: every frame has its own key, derived forwards from the one
before, so a key recovered from a running device reads that frame and nothing earlier. Each
chunk's GCM tag is bound to its `(file, offset)`, and a hash over those tags verifies the whole
file before it is handed over. Names and messages are padded, so the relay cannot tell a word
from a paragraph.

Both private halves of the exchange, the CPace scalar and the ML-KEM decapsulation key, are
zeroed the moment the session key exists. That is what makes a finished session unrecoverable
rather than merely encrypted: a recording of it cannot be reopened from this device afterwards,
and breaking the classical half later is not enough on its own.

### Storage

Received files stream to disk rather than buffering: File System Access, then origin-private
storage, then memory, by capability. Peak receiver heap for a 512 MB transfer is 12 MB.

The device key and pairing roots are sealed under a non-extractable key held by the browser, so
a copied database yields ciphertext. Where a browser refuses to store one, pairings are dropped
on reload rather than written in the clear.

### What it can reach

**Sending: nothing.** The only sources are the file input and dropped files: no
`showOpenFilePicker`, no directory picker, no path read anywhere.

**Receiving: origin-private storage by default**, downloaded when finished. *Ask where to save*
is opt-in and hands back a handle to exactly the file you picked.

File names from a peer are composed to NFC and stripped of direction overrides, zero-width
marks, control characters and path separators, so `holiday‮gnp.exe` cannot arrive looking like a
photo. Files that open by running are labelled. Nothing is blocked.

## Performance

Measured on one laptop, two browser contexts, loopback:

| | |
|---|---|
| 512 MB transfer | 15.8 s, 272 Mb/s |
| Peak receiver heap | 12 MB |
| Chunk size | 262 080 B, negotiated from `sctp.maxMessageSize` |
| Cost of AES-256-GCM | within noise of the raw channel |

`web/bench.html` reproduces this on any machine: two peer connections in one page, reporting
the raw channel ceiling and the cost of encryption and of the streaming sink.

## Layout

```
server/   the relay: moves opaque bytes, keeps nothing
web/      the client: crypto, transport, transfer engine, UI, benchmark
deploy/   the same relay for Cloudflare Workers and Deno Deploy
test/     513 tests: crypto core, protocol invariants, discovery, relay, receive path, UI
docs/     protocol spec, architecture, and the research behind both
```

There is no bundler and no minifier: the browser runs exactly the files in `web/`.

| | |
|---|---|
| [`06-gear-drop-protocol-spec.md`](docs/06-gear-drop-protocol-spec.md) | the wire protocol, implementable from the document alone |
| [`05-gear-drop-blueprint.md`](docs/05-gear-drop-blueprint.md) | threat model, crypto core, discovery, transport |
| [`07-roadmap-and-benchmarks.md`](docs/07-roadmap-and-benchmarks.md) | milestones, targets, measured results |
| [`01`](docs/01-pairdrop-architecture.md)–[`04`](docs/04-competitive-landscape.md) | research: how comparable tools work and where they break |

## Platforms

| | |
|---|---|
| Android | everything: folders, install, share target, notifications, wake lock |
| iOS | everything except folder sending, which Safari accepts and never delivers. Received files arrive as a **Save** that opens the share sheet |
| Desktop | everything, plus stream-straight-to-disk on Chromium |
| Older Safari / Firefox | plainer motion and solid panels; nothing missing |
| Private mode | runs and transfers, and says once that pairings cannot be remembered |

`web/core/platform.js` makes those calls in one place, and the app hides what a browser cannot
do rather than failing quietly.

## Not built yet

Parallel lanes exist in the transport but are not yet benchmarked as a win. The WebTransport
relay path, resume across a full page reload, and streaming zip are open. See
[`07-roadmap-and-benchmarks.md`](docs/07-roadmap-and-benchmarks.md).

## Limitation

This is a web application: you trust the code this origin serves on each load. Everything above
is designed so that is the only thing you have to trust, and the app says so on its own About
screen.

## Licensing

Gear Drop is [AGPL-3.0-or-later](LICENSE).

It is an independent implementation, written from the protocol behaviour documented in
`docs/01`–`docs/03`. No PairDrop or Snapdrop source is copied, adapted or linked. Those notes
were taken while reading their published source, which is not redistributed here.

Four libraries are vendored under [`web/vendor/`](web/vendor/README.md) so the app fetches
nothing from anywhere else: `@noble/curves`, `@noble/hashes` and `@noble/post-quantum` (MIT),
and `libheif` (LGPL-3.0), which decodes iPhone photos and is downloaded only by someone who
actually has one. Each licence sits beside the code it covers, and a test checks every
vendored file against what npm published.
