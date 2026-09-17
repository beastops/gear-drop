# Hosting Gear Drop

Gear Drop is two pieces, and they don't have to live on the same host.

| | what it is | what it needs |
|---|---|---|
| **the app** | static HTML, CSS and JavaScript | any file host |
| **the relay** | a WebSocket that passes sealed bytes between two people | something that can hold a connection open |

Files go straight between the two devices, sealed. The relay is only the place where two
devices find each other. It sees a rotating meaningless tag and encrypted bytes. It keeps
nothing — no database, no queue, no disk. That's why a free tier is genuinely enough here,
not just cheap.

**The relay can live somewhere else entirely.** The app works out which one to use at
runtime, in this order:

1. one the user already agreed to on an earlier visit
2. `<meta name="gd-relay" content="wss://host/rv">`, written into the page when you build it
3. this origin

Adding `?relay=wss://host/rv` to a URL only *suggests* a relay. The app shows you what it
is and asks before using it, so a link someone sends you can't quietly route you through
their server. Only `ws:` and `wss:` are allowed, and an `https:` page refuses a plain `ws:`
relay instead of silently downgrading.

---

## Pick a host

| host | free tier | holds WebSockets | what to deploy |
|---|---|---|---|
| **Cloudflare Workers** | yes, never sleeps | yes | `deploy/cloudflare/` — best long-term choice |
| **Deno Deploy** | yes | yes | `deploy/deno/relay.js` |
| **Render** | yes, sleeps when idle | yes | `render.yaml` — whole app, one service |
| **Fly.io** | small allowance | yes | `fly.toml` + `Dockerfile` |
| **Railway / Koyeb** | trial / small free | yes | `Dockerfile` |
| **Vercel** | yes | **no** | the app only — point it at a relay elsewhere |
| **Netlify / Pages / GitHub Pages** | yes | **no** | same as Vercel |

**Want one deployment and nothing to think about?** Render.

**Want it free forever and never sleeping?** Cloudflare Workers for the relay, Vercel or
Cloudflare for the app.

---

## Everything in one place

Render, Fly, Railway, Koyeb — anything that runs a process. The Node server serves the app
and runs the relay together:

```bash
npm ci --omit=dev
node server/index.js
```

**Render.** Push to GitHub, then New → Blueprint and pick the repo. `render.yaml` is already
here, so there's nothing to fill in. The free instance goes to sleep after fifteen minutes
and takes a few seconds to wake up. That's fine — the app reconnects by itself, and there's
nothing to lose, because the relay never stored anything.

**Fly.io**

```bash
fly launch --no-deploy
fly deploy
```

`auto_stop_machines = "suspend"` keeps an idle relay inside the free allowance.

**Railway, Koyeb, or anything that runs a container.** Point it at the `Dockerfile`. It
listens on `$PORT`, or 3000 if that isn't set.

**Set `TRUST_PROXY=1` on all of these.** They handle TLS in front of your process, so
without it every visitor looks like they're arriving from the same address — which would put
every user of your relay on one big shared "network" for discovery.

---

## Relay on Cloudflare Workers

The free-forever option. Workers hold WebSockets open, and a Durable Object gives the
rendezvous one place to live with no database behind it.

```bash
npm i -g wrangler
cd deploy/cloudflare
wrangler deploy
```

Your relay is now `wss://geardrop-relay.<subdomain>.workers.dev/rv`.

**If the app is hosted anywhere else** — on Vercel, say — you have to tell the relay which
origin is allowed to open a socket on it. Skip this and the relay refuses the connection, and
the app just sits there saying **offline** with nothing on screen explaining why:

```bash
echo "https://your-app.vercel.app" | wrangler secret put ALLOWED_ORIGINS
```

That refusal is deliberate, not a missing default. A relay that accepted any origin would be
a relay that any page on the internet could open sockets on. A client sending no `Origin` at
all isn't a browser, so it's left alone.

Optional:

```bash
wrangler secret put NET_SECRET    # turns on the opt-in "devices on this network" feature
wrangler secret put TURN_SECRET   # only if you run your own TURN server
```

Leave `NET_SECRET` unset and network discovery simply isn't offered. That's the safer
default — it's the one feature that asks the relay to group people together.

**One honest limit:** every socket lands in a single Durable Object. The protocol forces
this, because one client holds one socket and listens for many tags on it, so you can't split
tags and sockets apart. One object is one thread. Plenty for a personal or team relay; not a
design for a million people at once.

---

## Relay on Deno Deploy

```bash
deployctl deploy --entrypoint=deploy/deno/relay.js
```

Your relay is now `wss://<project>.deno.dev/rv`.

---

## App on Vercel

Vercel serves static files very well and can't hold a WebSocket open. So it hosts the app,
and the app points at a relay from the list above.

**Deploy the relay first** — the app needs its URL at build time.

**From the repository.** Nothing to install, and it redeploys on every push:

1. Go to [vercel.com/new](https://vercel.com/new) and import this repository. Don't touch any
   build setting; `vercel.json` already has them.
2. Add one environment variable, for all environments:
   `GD_RELAY` = `wss://your-relay.workers.dev/rv`
3. Deploy.

If you add `GD_RELAY` after the first deploy, redeploy once so the build picks it up. It's
read while the page is being built, not while it's being served.

**Or from the command line:**

```bash
vercel                                        # link the project
vercel env add GD_RELAY                       # wss://your-relay/rv
vercel --prod
```

`vercel.json` runs `scripts/build-static.mjs`. That copies `web/` into `dist/` and writes
`GD_RELAY` into the page as a `<meta>` tag. No bundler, no minifier — your browser runs
exactly the files in `web/`. The app asks you to trust the code this origin sends you, and a
build pipeline is a place for that to quietly go wrong.

**If you ever delete and re-create the repository, reconnect it.** Vercel stores the link by
the repository's internal id, not its name. Delete a repo and push it back under the same
name and it's a different repository as far as Vercel is concerned. Nothing tells you: the
site stays up on its last build, and `vercel git connect` will even say it's already
connected, because the name it compares never changed. Pushes just stop producing
deployments.

```bash
vercel inspect https://your-app.vercel.app | grep created   # older than your last push?
vercel git disconnect && vercel git connect                 # a plain connect won't do it
```

The same build works on **Netlify** (`build: node scripts/build-static.mjs`, publish `dist`),
**Cloudflare Pages** and **GitHub Pages**.

Without `GD_RELAY` a static deployment has no relay at all, and the app will sit at
"offline". You can still point one browser at a relay with `?relay=wss://…`.

---

## App and relay on different hosts

Two settings, or the browser refuses the connection and you get an empty "offline" app with
no obvious cause:

```bash
# on the relay
ALLOWED_ORIGINS=https://your-app.vercel.app

# on the static build
GD_RELAY=wss://your-relay.example/rv
```

The relay turns away any socket whose `Origin` isn't on that list. It has to: WebSockets
aren't covered by the same-origin policy, so without the check any page on the internet could
open sockets on your relay. A client with no `Origin` at all isn't a browser and is left
alone.

`GD_RELAY` does two jobs. It writes the relay address into the page, *and* it narrows that
page's `connect-src` to exactly that one origin — so even injected script couldn't open a
socket somewhere else.

---

## Settings

| name | default | what it does |
|---|---|---|
| `PORT` | `3000` | |
| `TRUST_PROXY` | off | read the first `X-Forwarded-For` hop. Set this behind any platform proxy |
| `ALLOWED_ORIGINS` | same origin only | **required if the app and relay are on different hosts.** Comma-separated list of origins allowed to open a socket |
| `CSP_CONNECT_EXTRA` | none | extra `connect-src` entries, if this server's page needs to reach a relay elsewhere |
| `STUN_URLS` | *(none)* | comma-separated. Empty means no third party is ever contacted, and cross-network connections fall back to the relay. Point it at a STUN server you run |
| `TURN_URLS` | none | comma-separated |
| `TURN_SECRET` | none | coturn `use-auth-secret`. Credentials expire in 10 minutes |
| `MAX_SOCKETS` | `20000` | total sockets |
| `MAX_PER_ADDRESS` | `32` | how many sockets one address may hold. A whole household shares one, so this is generous |
| `STATS` | off | set to `1` to publish `/stats`, which says how busy the relay is |
| `NET_SECRET` | none | Workers and Deno only. Turns on the opt-in network feature. Unset means it isn't offered |
| `GD_RELAY` | none | build time only. Pins the relay URL into a static build and narrows that build's CSP to it |

---

## Self-hosting notes

**TURN.** STUN gets most connections through. For the rest — symmetric NAT, some corporate
networks — you need TURN, and TURN is bandwidth you pay for. Set it up with `TURN_URLS` and
`TURN_SECRET` (coturn's `use-auth-secret`) so credentials are minted per connection and
expire in ten minutes. Don't ship one static TURN credential to every client; that's an open
invitation to have your relay used by strangers.

Without TURN, a blocked network falls back to carrying the same sealed frames over the
rendezvous socket — but only after asking, every time. Those are bytes passing through your
machine, even though you can't read them.

**Bandwidth.** With nobody using the fallback, a relay costs a few kilobytes per connection:
a handshake, some ICE candidates, and a keep-alive every 25 seconds. A thousand idle devices
cost less than one photo. The fallback path is the expensive one — `Bucket` in
`server/rendezvous.js` caps it per socket, and you'll want to lower that if you pay per
gigabyte.

**Logs.** The server writes none. No addresses, no tags, no timings. But if your platform
logs requests in front of it, that's the platform's log, not the app's — worth knowing before
you tell anyone this relay keeps nothing.

---

## Hiding which site you opened

Everything above is about what the relay and the app can see. This is about what your
*network* can see, which is a different question with a different answer.

TLS encrypts what you send. It does **not** encrypt which host you're sending it to — that
name goes out in the clear during the handshake, so an ISP, an employer or anyone on the path
reads it without breaking anything. For most sites that hardly matters. For a private
file-transfer app it's the whole story: they can't see your files, and they can see that you
opened it.

**Encrypted Client Hello** fixes that. The hostname is encrypted too, and the network sees
only a connection to the provider's shared front name on a shared address.

Check any host:

```bash
curl -s -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=YOUR-HOST&type=HTTPS" | grep -o 'ech=[^ "]*'
```

An `ech=` blob means it's on. Nothing means the hostname is readable.

**Where this project stands.** The Cloudflare relay already has it — Cloudflare turns ECH on
for proxied hostnames without being asked, so the handshake shows `cloudflare-ech.com` on an
address shared with a great many other sites. An app on Vercel publishes no HTTPS record at
all, so its hostname is readable. Said plainly: the traffic carrying your files is already
invisible to your ISP, and the page load that starts it isn't.

Putting the app behind the same provider as the relay closes that gap.

**Two things to know before relying on it.** ECH needs your browser to fetch that DNS record
over an encrypted connection. If DNS is plaintext, the hostname leaks during the lookup
instead and you've gained nothing. Most browsers use DNS-over-HTTPS by default now in most
places — "most" isn't "all", so check rather than assume.

And it hides *which* site, never *that you connected*. Your address still reaches an address.
Only onion routing changes that, and it isn't a setting.

---

## Putting the app on Cloudflare too

```bash
wrangler login
npm run deploy:app
```

Cloudflare folded Pages into Workers, so this deploys as a Worker serving static files, at
`https://<name>.<subdomain>.workers.dev`. That's the same kind of hostname the relay already
uses, which is the point — Cloudflare publishes an ECH config for it without being asked.

The build writes `dist/_headers` from `vercel.json`, so this host applies the same CSP, HSTS
and cross-origin rules Vercel does. That file is the whole reason this move is safe. Every
protection outside the app's own code is a response header — none of it is in the JavaScript
— so a host move that left them behind would give you an app that looks identical and has no
CSP at all. It's generated rather than copied so the two hosts can't drift apart, and a test
fails if they do.

Then point the relay at the new address, or the app comes up **offline** and every socket is
refused with a 403. This is the easy step to forget, and it looks like a broken deployment
rather than a missing setting:

```bash
echo -n "https://YOUR-APP.workers.dev" | wrangler secret put ALLOWED_ORIGINS   --config deploy/cloudflare/wrangler.toml
```

List every origin that should work, comma separated, including any older one still in use.

**There's a real trade here.** Right now Vercel sees page loads and Cloudflare sees sockets,
and neither one alone can say who sent what to whom — they'd have to compare notes. Move both
to one provider and that company sees both halves.

What you get in return is that everyone *between* a person and Cloudflare — their ISP, the
network they're on, anyone keeping traffic logs because the law says so — can no longer tell
this app was opened at all.

Which matters more depends on who you're hiding from. Worried about a company? The split is
better. Worried about your network, your employer or your government? ECH is worth more than
the split, and it isn't close.

---

## Behind a Tor onion service

Every option above hides what you send. None of them hides *that* you sent it, or who to —
the host and the relay both see an address, because a connection has to come from somewhere.

An onion service is the one setup where they don't. Tor gives them a circuit instead of an
address, so there's nothing to log, no location to work out from it, and no way to tell that
two particular people are the two ends of one transfer. That's Tor's guarantee, not this
app's — but it only holds if the app doesn't spoil it, and this one is built so it doesn't.

**Why it works here and not with most web apps**

- **Nothing is fetched from anywhere else.** No CDN, no fonts, no analytics, no third-party
  anything — so there's no request that escapes the circuit.
- **WebRTC isn't needed.** Tor Browser removes it, and rightly: a peer connection punches a
  hole straight through the circuit you just built. Gear Drop treats a browser without it as
  a relay-only browser rather than a broken one. The handshake runs over the rendezvous
  socket, and so does the file, sealed end to end exactly as everywhere else.
- **No address is ever collected.** No STUN server is set up by default, and none is
  contacted unless somebody turns on direct connections — which Tor Browser can't do anyway.
- **It still works offline.** After the first load the service worker serves everything from
  disk, so the circuit carries a transfer and nothing else.

**Running one**

Put Tor in front of whatever you already have. The single-service option above is simplest,
because then the app and the relay share one origin and one hostname.

```
# /etc/tor/torrc
HiddenServiceDir /var/lib/tor/geardrop/
HiddenServicePort 80 127.0.0.1:3000
```

```bash
sudo systemctl restart tor
sudo cat /var/lib/tor/geardrop/hostname    # your .onion address
```

That's the whole deployment. No domain, no certificate, no open inbound port — which also
means it can run from a machine at home without exposing that machine to anything.

**Before you rely on it**

- Open it in **Tor Browser**, at security level *Standard* or *Safer*. At *Safest*,
  JavaScript is off and no web app runs at all.
- `.onion` counts as a secure context, so WebCrypto, the service worker and storage all work.
- Everything goes over the relay path, so it's as fast as the circuit and no faster. That's
  the trade: anonymity costs speed, and there's no arrangement where it doesn't.
- Both people have to be on the same onion address to find each other.
- The relay still sees that one circuit is forwarding to a tag another circuit is listening
  on. It can't read any of it, and a circuit isn't a person — but if you want that link gone
  too, the answer is a mixnet, and this isn't one.
