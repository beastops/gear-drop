/**
 * Loopback benchmark. Two RTCPeerConnections in one page, no signalling, no network:
 * so the number that comes out is the cost of the engine, not the link.
 *
 * Stages:
 *   1. raw            send pre-made frames, backpressure only. The ceiling.
 *   2. sealed         add AES-256-GCM per chunk on both sides.
 *   3. sealed + sink  add the streaming sink and the per-chunk MAC bookkeeping.
 */
import { fmtBytes, fmtRate, randomBytes } from './core/bytes.js';
import { aeadKey, seal, open } from './core/gdcrypto.js';

const $ = (id) => document.getElementById(id);
const results = $('results');

$('env').textContent = `${navigator.hardwareConcurrency || '?'} logical cores · ${navigator.userAgent}`;

$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  results.replaceChildren();
  try {
    const total = Number($('size').value);
    const chunk = Number($('chunk').value);
    const sinkKind = $('sink').value;

    const link = await loopback();
    try {
      // Warm up first: the first pass through this code pays JIT and allocation costs
      // that would otherwise be charged to whichever stage happens to run first.
      const warm = row('warming up…', '', '');
      await stage(null, link, { total: Math.min(total, 32 << 20), chunk, sealed: true, sink: 'none' });
      await stage(null, link, { total: Math.min(total, 32 << 20), chunk, sealed: false, sink: 'none' });
      warm.remove();

      const raw = await best('1 · raw channel (ceiling)', link, { total, chunk, sealed: false, sink: 'none' });
      const sealed = await best('2 · + AES-256-GCM both ways', link, { total, chunk, sealed: true, sink: 'none' });
      const full = await best(`3 · + streaming sink (${sinkKind})`, link, { total, chunk, sealed: true, sink: sinkKind });

      row('cost of encryption', verdict(sealed.MBps / raw.MBps), 'stage 2 against stage 1');
      row('cost of the full pipeline', verdict(full.MBps / raw.MBps), 'stage 3 against stage 1');
      row(
        'peak JS heap while receiving',
        fmtBytes(Math.max(raw.peak, sealed.peak, full.peak)),
        `for a ${fmtBytes(total)} transfer — a buffering design would need at least the file size here`,
      );
    } finally {
      link.close();
    }
  } catch (err) {
    row('error', err.message || String(err), '');
  }
  $('run').disabled = false;
});

const pct = (x) => `${Math.round(x * 100)}%`;

/**
 * Both peers share one thread in a loopback, so ±10% between stages is scheduling noise,
 * not a real difference. Say so rather than reporting a speedup that isn't one.
 */
function verdict(ratio) {
  if (ratio >= 0.9) return `no measurable cost (${pct(ratio)} of the raw channel)`;
  return `${pct(1 - ratio)} slower than the raw channel`;
}

function row(name, value, sub) {
  const li = document.createElement('li');
  li.className = 'transfer';
  const top = document.createElement('div');
  top.className = 'top';
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name;
  const v = document.createElement('span');
  v.className = 'mono';
  v.textContent = value;
  top.append(n, v);
  li.append(top);
  if (sub) {
    const s = document.createElement('div');
    s.className = 'stats';
    s.textContent = sub;
    li.append(s);
  }
  results.append(li);
  return li;
}

/** A pair of connected peer connections inside this page. */
async function loopback() {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});

  const send = a.createDataChannel('bulk', { ordered: true });
  send.binaryType = 'arraybuffer';
  send.bufferedAmountLowThreshold = 1 << 20;

  const recvPromise = new Promise((resolve) => {
    b.ondatachannel = (e) => {
      e.channel.binaryType = 'arraybuffer';
      resolve(e.channel);
    };
  });

  const offer = await a.createOffer();
  await a.setLocalDescription(offer);
  await b.setRemoteDescription(offer);
  const answer = await b.createAnswer();
  await b.setLocalDescription(answer);
  await a.setRemoteDescription(answer);

  const recv = await recvPromise;
  await Promise.all([until(() => send.readyState === 'open'), until(() => recv.readyState === 'open')]);

  return {
    send,
    recv,
    maxMessage: a.sctp?.maxMessageSize ?? 65536,
    close() {
      a.close();
      b.close();
    },
  };
}

function until(fn, ms = 10000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      if (fn()) return resolve();
      if (performance.now() - t0 > ms) return reject(new Error('timed out waiting for the channel'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Two measured passes, reporting the better one; one-off scheduling noise is not a result. */
async function best(label, link, opts) {
  const a = await stage(null, link, opts);
  const b = await stage(null, link, opts);
  const win = a.MBps >= b.MBps ? a : b;
  row(
    label,
    `${win.MBps.toFixed(1)} MB/s · ${Math.round(win.MBps * 8.389)} Mb/s`,
    `${fmtBytes(opts.total)} in ${(win.ms / 1000).toFixed(2)}s · ${fmtBytes(opts.chunk)} chunks` +
      (win.peak ? ` · peak JS heap ${fmtBytes(win.peak)}` : '') +
      ` · other pass ${(a === win ? b.MBps : a.MBps).toFixed(1)} MB/s`,
  );
  return win;
}

async function stage(label, link, { total, chunk, sealed, sink }) {
  const key = sealed ? await aeadKey(randomBytes(32)) : null;
  const payload = randomBytes(chunk - (sealed ? 16 : 0));
  const frames = Math.ceil(total / payload.length);

  let writer = null;
  let dirHandle = null;
  let fileName = null;
  if (sink === 'opfs') {
    const root = await navigator.storage.getDirectory();
    dirHandle = await root.getDirectoryHandle('bench', { create: true });
    fileName = `bench-${Date.now().toString(36)}.bin`;
    const fh = await dirHandle.getFileHandle(fileName, { create: true });
    writer = await fh.createWritable({ keepExistingData: false });
  }

  let received = 0;
  let writeChain = Promise.resolve();
  let done;
  const finished = new Promise((r) => {
    done = r;
  });
  const peakHeap = { v: 0 };
  const heapTimer = setInterval(() => {
    if (performance.memory) peakHeap.v = Math.max(peakHeap.v, performance.memory.usedJSHeapSize);
  }, 200);

  link.recv.onmessage = (e) => {
    const buf = new Uint8Array(e.data);
    if (!sealed) {
      received += buf.length;
      if (writer) writeChain = writeChain.then(() => writer.write(buf));
      if (received >= total) done();
      return;
    }
    const offset = received;
    const plain = open(key, nonce(offset / payload.length), buf, null);
    plain.catch(() => {});
    received += buf.length - 16;
    writeChain = writeChain.then(async () => {
      const pt = await plain;
      if (writer) await writer.write({ type: 'write', position: offset, data: pt });
    });
    if (received >= total) writeChain.then(done);
  };

  const t0 = performance.now();
  let sent = 0;
  for (let i = 0; i < frames; i++) {
    const frame = sealed ? await seal(key, nonce(i), payload, null) : payload;
    while (link.send.bufferedAmount > 8 << 20) await drain(link.send);
    link.send.send(frame);
    sent += payload.length;
  }
  while (link.send.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 5));
  await finished;
  await writeChain;
  const ms = performance.now() - t0;
  clearInterval(heapTimer);

  if (writer) {
    await writer.close();
    await dirHandle.removeEntry(fileName).catch(() => {});
  }
  link.recv.onmessage = null;

  const MBps = sent / 1048576 / (ms / 1000);
  if (label) {
    row(
      label,
      `${MBps.toFixed(1)} MB/s · ${Math.round((sent * 8) / 1e6 / (ms / 1000))} Mb/s`,
      `${fmtBytes(sent)} in ${(ms / 1000).toFixed(2)}s · ${frames} frames of ${fmtBytes(payload.length)}` +
        (performance.memory ? ` · peak JS heap ${fmtBytes(peakHeap.v)}` : ''),
    );
  }
  return { MBps, ms, peak: peakHeap.v };
}

function nonce(i) {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setBigUint64(4, BigInt(Math.floor(i)), true);
  return n;
}

function drain(dc) {
  return new Promise((resolve) => {
    const h = () => {
      dc.removeEventListener('bufferedamountlow', h);
      resolve();
    };
    dc.addEventListener('bufferedamountlow', h);
    setTimeout(h, 500);
  });
}

export { fmtRate };
