/**
 * Run an expression in the page that real Android Chrome is showing, and print the result.
 *
 *   node cdp.mjs "<javascript>"
 *
 * The browser pane cannot answer what a phone reports for `hover` or what happens to a
 * vertical drag when `touch-action` hands it to the browser. This can: it is the same Chrome,
 * on the same Android, with the same touch stack.
 */
import WebSocket from 'ws';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('gear-drop'));
if (!page) {
  console.error('Gear Drop is not open in Chrome on the device');
  process.exit(1);
}

const expression = process.argv[2];
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });

const done = new Promise((resolve, reject) => {
  ws.on('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id !== 1) return;
    if (msg.result?.exceptionDetails) reject(new Error(msg.result.exceptionDetails.text + ' ' + (msg.result.exceptionDetails.exception?.description || '')));
    else resolve(msg.result?.result?.value);
    ws.close();
  });
  ws.on('error', reject);
  setTimeout(() => reject(new Error('timed out talking to the device')), 30000);
});

try {
  console.log(JSON.stringify(await done, null, 2));
} catch (e) {
  console.error('FAILED:', e.message.slice(0, 300));
  process.exit(1);
}
