# Hosting Gear Drop

Gear Drop is two things that do not have to live together:

| | what it is | what it needs |
|---|---|---|
| **the app** | static HTML, CSS and ES modules | any file host |
| **the relay** | a WebSocket that forwards opaque bytes between two sockets | a process that can hold a connection open |

The transfers themselves are peer-to-peer and sealed, so the relay is only a place for two
devices to find each other. It sees a rotating opaque tag and AEAD ciphertext, keeps
nothing, and needs no database, no queue and no disk. That is what makes a free tier
genuinely sufficient rather than merely cheap.

**The relay does not have to be on the same origin as the app.** The client resolves it at
runtime, in this order:

1. the value remembered from a previous visit, once the user agreed to it
2. `<meta name="gd-relay" content="wss://host/rv">`, written into the page at build time
3. this origin

`?relay=wss://host/rv` in a URL only *proposes* a relay; the app shows what it is and asks
before adopting it, so a shared link cannot silently route someone through a chosen server.
Only `ws:`/`wss:` are accepted, and an `https:` page refuses a `ws:` relay rather than
silently downgrading.

---

## The short version

| host | free tier | holds WebSockets | what to deploy |
|---|---|---|---|
| **Cloudflare Workers** | yes, no sleep | yes | `deploy/cloudflare/`, best long-term choice |
| **Deno Deploy** | yes | yes | `deploy/deno/relay.js` |
| **Render** | yes, sleeps when idle | yes | `render.yaml`, whole app, one service |
| **Fly.io** | small allowance | yes | `fly.toml` + `Dockerfile` |
| **Railway / Koyeb** | trial / small free | yes | `Dockerfile` |
| **Vercel** | yes | **no** | the app only; point it at a relay elsewhere |
| **Netlify / Pages / GitHub Pages** | yes | **no** | same as Vercel |

If you want one deployment and nothing to think about: **Render**. If you want it to stay
free and never sleep: **Cloudflare Workers for the relay, Vercel or Pages for the app**.

---

## Everything in one service (Render, Fly, Railway, Koyeb)

The Node server serves the client and runs the relay:

```bash
npm ci --omit=dev
node server/index.js
```

**Render.** Push to GitHub, then New → Blueprint and pick the repo. `render.yaml` is
already here. The free instance sleeps after fifteen minutes of inactivity and takes a few
seconds to wake; the client reconnects on its own and there is no state to lose, because
the relay never had any.

**Fly.io**

```bash
fly launch --no-deploy
fly deploy
```

`auto_stop_machines = "suspend"` keeps an idle relay inside the free allowance.

**Railway / Koyeb / anything that runs a container.** Point it at the `Dockerfile`. It
listens on `$PORT`, defaulting to 3000.

Set `TRUST_PROXY=1` on any of these. They all terminate TLS in front of the process, so
without it every client appears to arrive from the same address, which would put every
user of your relay on the same "network" for discovery purposes.

---

## Relay on Cloudflare Workers (the free-forever option)

Workers hold WebSockets open, and a Durable Object gives the rendezvous one place to live
with no database behind it.

```bash
npm i -g wrangler
cd deploy/cloudflare
wrangler deploy
```

Your relay is then `wss://geardrop-relay.<subdomain>.workers.dev/rv`.

**If the app is hosted anywhere else**, which it is on Vercel, tell the relay which origin
may open a socket on it. Without this the relay refuses the connection and the app sits on
"offline" with nothing on screen to say why:

```bash
echo "https://your-app.vercel.app" | wrangler secret put ALLOWED_ORIGINS
```

A relay that accepted any origin would be a relay any page on the internet could hold sockets
on, so this is a refusal by design rather than a missing default. A client sending no `Origin`
at all is not a browser and is left alone.

Optional secrets:

```bash
wrangler secret put NET_SECRET    # enables the opt-in "devices on this network" channel
wrangler secret put TURN_SECRET   # only if you run your own TURN server
```

Leave `NET_SECRET` unset and network discovery is simply not offered to clients. That is
the safer default: it is the one feature that asks the relay to group people.

**The honest limit:** every socket lands in a single Durable Object. That is forced by the
protocol: a client holds one socket and subscribes to many tags on it, so tags and sockets
cannot be sharded apart. One object is one thread. Ample for a personal or team relay; not
a design for a million concurrent users.

## Relay on Deno Deploy

```bash
deployctl deploy --entrypoint=deploy/deno/relay.js
```

Your relay is then `wss://<project>.deno.dev/rv`.

---

## App on Vercel

Vercel serves static files very well and cannot hold a WebSocket open, so it hosts the app
and points at a relay running somewhere from the list above. Deploy the relay first: the
app needs its URL at build time.

**From the repository**, which needs nothing installed and redeploys on every push:

1. [vercel.com/new](https://vercel.com/new) and import this repository. Leave every build
   setting alone; `vercel.json` already carries them.
2. Add one environment variable, for all environments:
   `GD_RELAY` = `wss://your-relay.workers.dev/rv`
3. Deploy.

If you add `GD_RELAY` after the first deploy, redeploy once so the build picks it up. It is
read while the page is written, not while it is served.

**Or from the command line:**

```bash
vercel                                        # link the project
vercel env add GD_RELAY                       # wss://your-relay/rv
vercel --prod
```

`vercel.json` runs `scripts/build-static.mjs`, which copies `web/` to `dist/` and writes
`GD_RELAY` into the page as a `<meta>` tag. There is no bundler and no minifier: the
browser runs exactly the files in `web/`. The app's one stated assumption is that you trust
the code this origin serves you, and a build pipeline is a place for that to go wrong
quietly.

**If you ever delete and re-create the repository**, reconnect it. Vercel stores the link by
the repository's internal id, not its name, so a repository that was deleted and pushed back
under the same name is a different one as far as Vercel is concerned. Nothing reports this: the
site stays up on its last build, and `vercel git connect` will tell you it is already connected,
because the name it compares never changed. Pushes simply stop producing deployments.

```bash
vercel inspect https://your-app.vercel.app | grep created   # older than your last push?
vercel git disconnect && vercel git connect                 # a plain connect is not enough
```

The same build works on **Netlify** (`build: node scripts/build-static.mjs`, publish
`dist`), **Cloudflare Pages** and **GitHub Pages**.

Without `GD_RELAY`, a static deployment has no relay at all and the app will sit at
"offline". You can still point an individual browser at one with `?relay=wss://…`.

---

## Self-hosting notes

**TURN.** STUN gets most connections through. For the rest, meaning symmetric NAT and some
corporate networks, you need TURN, which is bandwidth you pay for. Configure it with
`TURN_URLS` + `TURN_SECRET` (coturn's `use-auth-secret`) so credentials are minted per
connection and expire in ten minutes. Static TURN credentials shipped to every client, the
way PairDrop's `rtc_config.json` does it, are a standing invitation to relay theft.

Without TURN, a blocked network falls back to carrying the same sealed frames over the
rendezvous socket, but only after asking, every time, because that is bytes passing
through your machine even though you cannot read them.

**Bandwidth.** With no relay fallback in use, a relay's traffic is a few kilobytes per
connection: a handshake, some ICE candidates, and a keep-alive every 25 seconds. A
thousand idle devices cost less than a single photo. The fallback path is the expensive
one; `Bucket` in `server/rendezvous.js` caps it per socket, and you will want to lower it
if you pay per gigabyte.

**Logs.** The server writes none: no addresses, no tags, no timings. If
your platform logs requests in front of it, that is the platform's log, not the app's, and
it is worth knowing that before you tell anyone this relay keeps nothing.

**Environment variables**

| name | default | meaning |
|---|---|---|
| `PORT` | `3000` | |
| `TRUST_PROXY` | off | read the first `X-Forwarded-For` hop; set this behind any platform proxy |
| `ALLOWED_ORIGINS` | same-origin only | **required for a split deployment.** Comma-separated browser origins allowed to open a relay socket |
| `CSP_CONNECT_EXTRA` | none | extra `connect-src` entries, if this server's page must reach a relay elsewhere |
| `STUN_URLS` | *(none)* | comma-separated. Empty means no third party is ever contacted; cross-network direct connections then fall back to the relay. Set it to a STUN server you run. |
| `TURN_URLS` | none | comma-separated |
| `TURN_SECRET` | none | coturn `use-auth-secret`; credentials expire in 10 minutes |
| `MAX_SOCKETS` | `20000` | total sockets |
| `MAX_PER_ADDRESS` | `32` | sockets one address may hold; a NAT shares one, so it is generous |
| `STATS` | off | set to `1` to publish `/stats`; the counters describe how busy the relay is |
| `NET_SECRET` | none | Workers/Deno only: enables the opt-in network channel. Unset means the feature is not offered |
| `GD_RELAY` | none | build-time only: pins the relay URL into a static build, and narrows that build's CSP to it |

### If the app and the relay are on different hosts

Two things must be set, or the browser will refuse the connection and you will see an empty
"offline" app with no obvious cause:

```bash
# on the relay
ALLOWED_ORIGINS=https://your-app.vercel.app

# on the static build
GD_RELAY=wss://your-relay.example/rv
```

The relay rejects a socket whose `Origin` is not listed, because WebSockets are not subject
to the same-origin policy and without that check any page on the internet could hold sockets
on your relay. A client that sends no `Origin` at all is not a browser and is left alone.

`GD_RELAY` does double duty: it writes the relay address into the page *and* narrows that
page's `connect-src` to exactly that origin, so injected script could not open a socket
somewhere else.

## Hiding which site you are

Everything else here is about what the relay and the app can see. This one is about what your
*network* can see, which is a different question with a different answer.

TLS encrypts what you send. It does not encrypt **which host you are sending it to** — the name
travels in the clear in the TLS handshake, so an ISP, an employer or anyone on the path reads it
without breaking anything. For most sites that hardly matters. For a private file-transfer app it
is the whole story: they cannot see the files, and they can see that you opened it.

**Encrypted Client Hello** closes that. The hostname is encrypted too, and the network sees only
a connection to the provider's shared front name on a shared address.

Check any host with:

```bash
curl -s -H 'accept: application/dns-json' \
  "https://cloudflare-dns.com/dns-query?name=YOUR-HOST&type=HTTPS" | grep -o 'ech=[^ "]*'
```

An `ech=` blob means it is on. Nothing means the hostname is readable.

**Where this project stands.** The Cloudflare relay already has it — Cloudflare enables ECH on
proxied hostnames without being asked, so the handshake presents `cloudflare-ech.com` on an
anycast address shared with a great many other sites. The app on Vercel publishes no HTTPS record
at all, so its hostname is readable. The consequence is worth stating plainly: the traffic that
carries your transfers is already anonymous to your ISP, and the page load that starts it is not.

Putting the app behind the same provider as the relay closes it. Cloudflare Pages, or Cloudflare
in front of whatever is serving it now.

**Two things to know before relying on it.** ECH needs the browser to fetch that DNS record over
an encrypted resolver — if DNS is plaintext, the hostname leaks in the lookup instead, and
nothing has been gained. Most browsers now use DNS-over-HTTPS by default in most regions, but
"most" is not "all", and it is worth checking rather than assuming.

And it hides *which* site, never *that you connected*. Your address still reaches an address.
Only onion routing changes that, and it is not a setting.

### Putting the app on Cloudflare too

```bash
wrangler login
npm run deploy:app
```

Cloudflare has folded Pages into Workers, so this deploys as a Worker serving static assets and
the URL is `https://<name>.<subdomain>.workers.dev`. That is the same kind of hostname the relay
already uses, which is the point: Cloudflare publishes an ECH config for it without being asked.

`dist/_headers` is written by the build from `vercel.json`, so Pages applies the same CSP, HSTS
and cross-origin rules Vercel does. That file is the whole reason this is safe to do: every
protection outside the app's own code is a response header, none of it is in the JavaScript, and
a host move that left them behind would produce an app that looks identical and has no CSP. It
is generated rather than copied so the two hosts cannot drift, and a test fails if they do.

Then point the relay at it, or the app comes up saying **offline** and every socket is refused
with a 403. This is the step that is easy to forget and looks like a broken deployment rather
than a missing setting:

```bash
echo -n "https://YOUR-APP.workers.dev" | wrangler secret put ALLOWED_ORIGINS   --config deploy/cloudflare/wrangler.toml
```

List every origin that should be allowed, comma separated, including any older one still in use.

**The trade, which is real.** Today Vercel sees page loads and Cloudflare sees sockets, and
neither alone can say who sent what to whom — they would have to compare notes. Move both and one
company can see both halves. What you get for that is everyone *between* a person and Cloudflare —
their ISP, the network they are on, anyone retaining traffic logs by law — losing the ability to
tell this app was opened at all.

Which matters more depends on who is being hidden from. For someone worried about a company, the
split is better. For someone worried about their network, their employer or their government,
ECH is worth more than the split, and it is not close.

## Behind an onion service (the anonymous one)

Every option above hides what you send. None of them hides *that you sent it*, or to whom: the
host and the relay both see an address, because a connection has to come from somewhere.

An onion service is the one arrangement where they do not. Tor hands them a circuit instead of an
address, so there is nothing to log, no location to infer from it, and no way to tell that two
particular people are the two ends of one transfer. That is Tor's guarantee, not this app's — but
it only holds if the app does nothing to spoil it, and the app is built so it does not.

**Why this works here and not with most web apps**

- **Nothing is fetched from anywhere else.** No CDN, no fonts, no analytics, no third-party
  origin of any kind, so there is no request that escapes the circuit.
- **No WebRTC is needed.** Tor Browser removes `RTCPeerConnection`, and rightly — a peer
  connection is a hole punched straight through the circuit you just built. Gear Drop treats a
  browser without it as a relay-only browser rather than a broken one: the handshake runs over
  the rendezvous socket and so does the file, sealed end to end exactly as everywhere else.
- **No address is ever gathered.** No STUN server is configured by default, and none is contacted
  unless somebody turns on direct connections, which Tor Browser cannot do anyway.
- **It still works offline.** After the first load the service worker serves everything from
  disk, so the circuit carries a transfer and nothing else.

**Running one**

Put Tor in front of whatever you already have — the single-service option above is the simplest,
since the app and the relay then share one origin and one hostname.

```
# /etc/tor/torrc
HiddenServiceDir /var/lib/tor/geardrop/
HiddenServicePort 80 127.0.0.1:3000
```

```bash
sudo systemctl restart tor
sudo cat /var/lib/tor/geardrop/hostname    # your .onion address
```

That is the whole deployment. It needs no domain, no certificate and no open inbound port —
which also means it runs from a machine at home without exposing that machine to anything.

**What to know before you rely on it**

- Open it in **Tor Browser**, at its security level *Standard* or *Safer*. At *Safest* JavaScript
  is off and no web app runs at all.
- `.onion` is a secure context, so WebCrypto, the service worker and storage all work.
- Everything goes over the relay path, so it is as fast as the circuit and no faster. This is the
  trade: anonymity costs throughput, and there is no arrangement where it does not.
- Both ends have to be on the same onion for the two of them to find each other.
- The relay still sees that one circuit forwards to a tag another circuit is subscribed to. It
  cannot read any of it, and a circuit is not a person — but if you want that link gone too, the
  answer is a mixnet, and this is not one.
