/**
 * Build the static client for a host that serves files but cannot hold a WebSocket open:
 * Vercel, Netlify, Cloudflare Pages, GitHub Pages, any CDN.
 *
 * It copies `web/` to `dist/` and, if GD_RELAY is set, writes it into the page as
 *
 *     <meta name="gd-relay" content="wss://…/rv">
 *
 * which is where the client looks when the relay is not on the same origin. Nothing else
 * is transformed: there is no bundler, no minifier and no step that could change what the
 * browser executes, because "you are trusting the code this origin serves" is the app's
 * one stated assumption and a build pipeline is a place for that to go wrong quietly.
 *
 *   GD_RELAY=wss://geardrop-relay.example.workers.dev/rv node scripts/build-static.mjs
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'web');
const out = path.join(root, 'dist');

const relay = (process.env.GD_RELAY || '').trim();

if (relay && !/^wss?:\/\//i.test(relay)) {
  console.error(`GD_RELAY must be a ws:// or wss:// URL, got: ${relay}`);
  process.exit(1);
}

await fs.rm(out, { recursive: true, force: true });
await fs.cp(src, out, { recursive: true });

if (relay) {
  // Only ever injected into a page's own <head>, and only as an attribute value with the
  // quote characters rejected outright rather than escaped.
  if (/["'<>]/.test(relay)) {
    console.error('GD_RELAY contains characters that cannot appear in a URL');
    process.exit(1);
  }
  for (const page of ['index.html', 'bench.html']) {
    await inject(path.join(out, page), `<meta name="gd-relay" content="${relay}">`);
  }
  console.log(`dist/ built, relay pinned to ${relay}`);
} else {
  console.log('dist/ built. No GD_RELAY set — the client will look for a relay on its own origin.');
  console.log('On a static host that means no relay at all, so set GD_RELAY or pass ?relay=wss://…');
}

/*
 * A static host serves one CSP to every page, so `connect-src` there has to be broad enough
 * for whatever relay any deployment might use, which means broad enough to be a route out
 * for injected script. The build knows the exact relay, so it writes a second CSP into the
 * page naming only that origin. Both are enforced, and the browser takes the intersection,
 * so the narrow one wins.
 */
for (const page of ['index.html', 'bench.html']) {
  const connect = relay ? `'self' ${new URL(relay).origin.replace(/^http/, 'ws')}` : "'self'";
  await inject(
    path.join(out, page),
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; ` +
      `style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; ` +
      `connect-src ${connect}; worker-src 'self'; base-uri 'none'; form-action 'none'; ` +
      `object-src 'none'; require-trusted-types-for 'script'; trusted-types gd">`,
  );
}

/** Put a tag at the end of a page's head, if the page exists. */
async function inject(file, tag) {
  let html;
  try {
    html = await fs.readFile(file, 'utf8');
  } catch {
    return;
  }
  await fs.writeFile(file, html.replace('</head>', `${tag}\n</head>`), 'utf8');
}
