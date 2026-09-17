<div align="center">

<img src="web/icon.svg" width="84" height="84" alt="">

# Gear Drop

### Send a file straight from one device to another.<br>Nothing in the middle can read it.

[**Open the app →**](https://gear-drop.beastops.workers.dev)

[Host your own](DEPLOY.md) · [How it works](#how-it-works) · [What the server sees](#what-the-server-sees) · [What your Wi-Fi sees](#what-your-wi-fi-and-isp-see) · [Report a bug](https://github.com/beastops/gear-drop/issues)

![Gear Drop on a laptop: a file ready to send, and two devices found on the same network](docs/img/desktop.png)

</div>

## What it's for

- The photo on your phone that you want on your laptop, right now.
- A 4 GB video that email won't take.
- A file for the person sitting across from you, on café Wi-Fi you don't trust.
- Your own two machines, on different networks, without signing in to anything.

Open a tab and you're ready. No account, nothing to install. The file goes straight from one
device to the other — it never sits on somebody's server in between.

## Try it

**Same Wi-Fi?** Open the app on both devices. They find each other on their own. Tap the
device, pick the file, send.

**Not on the same Wi-Fi?** Tap **Add a device** on one. It shows six characters. Type them
into the other.

Either way, both screens then show the same **four words**.

Same words on both? You're talking to the device you think you are. Different words? Someone
is sitting in the middle — and catching that is exactly what the words are for. It takes three
seconds and you only do it once. After that the two devices remember each other.

## What the server sees

Two browsers can't find each other by themselves, so a small server introduces them. That's
all it does. Here's the honest list of what it gets.

**What it sees**

- A device connected, and from which address — same as any website you open.
- Roughly when two devices talked.
- On the backup path, roughly how much moved. Rounded, not exact.
- Nothing else, and it keeps none of it.

**What it doesn't see**

- Your files. On the normal path they never go near it.
- How many files, what they're called, how big they are, or anything inside them.
- Who you are, or which device is which.
- Enough to pretend to be one of your devices, or to recognise you next time you show up.

If your network blocks the direct connection, the app offers to pass the data through that same
server instead. It asks first, every time, and switches back to direct as soon as it can. Even
on that path everything is locked twice over, so the server is just shifting sealed bytes it
can't open. And when things go quiet it keeps topping the connection up, so "how much did they
send" doesn't have a clean answer either.

You don't have to take our word for any of this. It's a few hundred lines, there's no build
step, the relay is a single file, and `docs/` describes the wire format well enough for you to
write your own client and check us against it.

## What your Wi-Fi and ISP see

The server above is one problem. Your network is the bigger one — your Wi-Fi, your ISP, your
work network, whoever carries your traffic.

They can't read what's inside an encrypted connection. But normally they can still see the
**name** of the site you opened, because that name goes out in the clear before the encryption
starts.

This app is served from a host that hides the name too. So they see you connect to one huge
network that a huge number of other sites sit behind — not which of them you wanted.

One catch, and it's a real one: your browser has to look up addresses over an encrypted
connection, or the name leaks during the lookup instead. Most browsers do that by default now.
Most, not all — worth checking rather than assuming.

And here's what they can always see, no matter what: that you're online, roughly how much moved,
and when. No website can hide that from its own end. Only Tor can, and this works over Tor.

> There's also [gear-drop.vercel.app](https://gear-drop.vercel.app) — same app, but that address
> isn't hidden on the way out, so your network can see you opened it. Use it if the first one is
> blocked where you are.

## On a phone

Same app. It's built to feel like a phone app instead of a website squeezed onto a small screen:
sheets you swipe away, a list that keeps gliding when you flick it, and no animation that makes
your phone warm.

<div align="center">
  <img src="docs/img/phone.png" width="280" alt="Gear Drop on a phone: a file ready to send, and a laptop found on the same network">
</div>

| | |
|---|---|
| **Android** | Everything. Folders, install to the home screen, share target, notifications, stays awake during a transfer |
| **iOS** | Everything except sending a folder — Safari accepts it and then never delivers it. Files arrive as a **Save** |
| **Desktop** | Everything, plus writing straight to disk on Chrome and Edge |
| **Older browsers** | Plainer animation, solid panels. Nothing actually missing |
| **Private mode** | Works and transfers. It tells you once that it can't remember pairings |

## How it works

The two devices agree on a key **between themselves**. Those six characters you type are the
password for that agreement — but they never get sent anywhere, and the server can't work out
the key by watching. Everything after that is locked with it.

The four words come from that key **and** from both devices' connection certificates. Anyone
sitting in the middle has a different key to at least one side, so their words come out
different. That's the whole trick, and it's why the three seconds are worth it.

Files go straight between the two browsers. They're read off disk and written to disk in pieces,
so a 4 GB file needs no more memory than a small one.

<details>
<summary><b>The cryptography, in detail</b> — the parts a reviewer would want to check</summary>

<br>

*The relay is the small server from above — the one that introduces two devices to each other.*

The six-character code is the password input to a **CPace** PAKE over ristretto255, so the
session key is derived on the two devices and never reaches the relay. Session descriptions,
ICE candidates, file names and sizes are sealed with AES-256-GCM before the relay sees them,
and the four safety words bind the key to both DTLS certificate fingerprints, so anything
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

Both private halves of the exchange, the CPace scalar and the ML-KEM decapsulation key, are
zeroed the moment the session key exists. That is what makes a finished session unrecoverable
rather than merely encrypted.

**Finding each other**

| | how | authenticated |
|---|---|---|
| **paired** | a rotating token from a shared secret and a ten-minute epoch; no code, no server record | yes, the pairing root is folded into the key |
| **this network** | opt-in; the relay labels each socket by the address it arrived on, re-rolled every six hours | no, check the safety words |
| **a room** | a five-character code read out loud, across networks | no, everyone with the code is equal |

A room is a directory rather than a channel: members announce a per-session id, and each pair
then runs the ordinary two-party handshake at its own tag. The relay never carries a group
conversation and cannot list rooms or read a roster.

**What is encrypted, with which key**

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

**Storage and reach**

Received files stream to disk rather than buffering: File System Access, then origin-private
storage, then memory, by capability. The device key and pairing roots are sealed under a
non-extractable key held by the browser, so a copied database yields ciphertext. Where a browser
refuses to store one, pairings are dropped on reload rather than written in the clear.

The only sources for sending are the file input and dropped files: no `showOpenFilePicker`, no
directory picker, no path read anywhere. File names from a peer are composed to NFC and stripped
of direction overrides, zero-width marks, control characters and path separators, so
`holiday‮gnp.exe` cannot arrive looking like a photo. Files that open by running are labelled.
Nothing is blocked.

</details>

## Built with

Plain HTML, CSS and JavaScript. No framework, no bundler, no build step — your browser runs
exactly the files in `web/`, so you can read what you're running.

- [WebRTC](https://webrtc.org/) for the transfer itself, with an encrypted fallback for networks that block it
- [CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/) and [ML-KEM-768](https://csrc.nist.gov/pubs/fips/203/final) for the key agreement, via [@noble](https://paulmillr.com/noble/)
- AES-256-GCM for everything that leaves a device
- File System Access and origin-private storage, so files stream to disk instead of filling memory
- [libheif](https://github.com/strukturag/libheif) to show iPhone photos, downloaded only by someone who has one
- A progressive web app: installable, and it opens without a connection

## Host your own

```bash
npm install
npm start          # http://localhost:3000
npm test
```

[`DEPLOY.md`](DEPLOY.md) has the rest. It runs on free tiers, and the app and the relay can sit
on different services — Cloudflare Workers or Deno Deploy for the relay, Cloudflare, Vercel or
any static host for the app. The security headers are generated at build time from one file, so
they follow the app to whichever host you pick instead of being left behind on the old one.

The wire protocol is written up in full in
[`docs/`](docs/06-gear-drop-protocol-spec.md), in enough detail to build another client from,
and `web/bench.html` measures a transfer on your own machine.

## One thing worth knowing

This is a web page. Every time you open it, you're trusting the code this address sends you.
Everything above is built so that's the *only* thing you have to trust — and the app says so
right on its own About screen, instead of leaving you to find out later.

## Licence

Gear Drop is [AGPL-3.0-or-later](LICENSE).

The libraries under [`web/vendor/`](web/vendor/README.md) keep their own licences —
`@noble/curves`, `@noble/hashes` and `@noble/post-quantum` (MIT), and `libheif` (LGPL-3.0). They
ship with the app so it fetches nothing from anywhere else, and each licence sits beside the
code it covers.

## Contributing

Issues and pull requests are welcome —
[open one here](https://github.com/beastops/gear-drop/issues).
