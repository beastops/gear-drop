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
