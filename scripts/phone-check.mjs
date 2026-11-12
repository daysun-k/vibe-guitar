// VGT-13 spike: scripted checks for the relay (`npm run phone-check`).
// Starts the relay on this Mac's LAN address, checks the access rules, runs a fake publisher and a
// fake viewer to measure loopback/LAN round trips and extrapolation error, then stops everything.
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { buildViewer, loadRelay, parseArgs } from './phone-lib.mjs';

const R = await loadRelay();
const opts = parseArgs(process.argv.slice(2));
const relay = await R.startRelay({ ...opts, ...(await buildViewer()), log: () => {} });
const [lanIp, lanPort] = relay.lanHost.split(':');
const pubPort = opts.pubPort ?? 47821;
const EXT_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clock = () => performance.timeOrigin + performance.now();

function get(host, port, path, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, headers, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', (e) => resolve(e.code));
    req.end();
  });
}

/** Minimal masked WebSocket client on top of the relay's own frame code. */
function wsConnect(host, port, path, headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host,
      port,
      path,
      agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers },
    });
    req.on('response', (res) => resolve({ status: res.statusCode }));
    req.on('error', (e) => resolve({ status: e.code }));
    req.on('upgrade', (_res, socket, head) => {
      let buf = new Uint8Array(head);
      const listeners = [];
      const c = {
        status: 101,
        messages: [],
        closeCode: null,
        closed: false,
        onText: (fn) => listeners.push(fn),
        send: (text) => socket.write(R.encodeFrame(R.OP_TEXT, new TextEncoder().encode(text), randomBytes(4))),
        sendRaw: (bytes) => socket.write(bytes),
        close: () => socket.destroy(),
      };
      const feed = (chunk) => {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        const r = R.parseFrames(merged, 1 << 20, false);
        buf = r.rest;
        for (const f of r.frames) {
          if (f.opcode === R.OP_CLOSE) c.closeCode = (f.payload[0] << 8) | f.payload[1];
          if (f.opcode !== R.OP_TEXT) continue;
          const text = new TextDecoder().decode(f.payload);
          c.messages.push(text);
          listeners.forEach((fn) => fn(text));
        }
      };
      socket.on('data', feed);
      socket.on('close', () => (c.closed = true));
      if (head.length) feed(new Uint8Array(0));
      resolve(c);
    });
    req.end();
  });
}

const tokenQ = `?t=${relay.token}`;
const viewerHeaders = { Host: relay.lanHost, Origin: `http://${relay.lanHost}` };
const pubHeaders = { Host: `127.0.0.1:${pubPort}`, Origin: EXT_ORIGIN };

console.log(`relay: viewer ${relay.lanHost}, publisher 127.0.0.1:${pubPort}`);

// ---------- access rules ----------
check('page with right token', (await get(lanIp, lanPort, `/${tokenQ}`)) === 200);
check('page with wrong token rejected', (await get(lanIp, lanPort, `/?t=${'x'.repeat(22)}`)) === 403);
check('page without token rejected', (await get(lanIp, lanPort, '/')) === 403);
check('page with foreign Host rejected (DNS rebinding)', (await get(lanIp, lanPort, `/${tokenQ}`, { Host: `evil.example:${lanPort}` })) === 421);
check('viewer socket with right token', (await wsConnect(lanIp, lanPort, `/viewer${tokenQ}`, viewerHeaders)).status === 101);
check('viewer socket with wrong token rejected', (await wsConnect(lanIp, lanPort, `/viewer?t=${'y'.repeat(22)}`, viewerHeaders)).status === 403);
check('viewer socket from foreign Origin rejected', (await wsConnect(lanIp, lanPort, `/viewer${tokenQ}`, { ...viewerHeaders, Origin: 'http://evil.example' })).status === 403);
const lanPub = await new Promise((resolve) => {
  const s = net.connect({ host: lanIp, port: pubPort }, () => {
    s.destroy();
    resolve('connected');
  });
  s.on('error', (e) => resolve(e.code));
});
check('publisher port NOT reachable on the LAN address', lanPub === 'ECONNREFUSED', `${lanIp}:${pubPort} -> ${lanPub}`);
const loopViewer = await get('127.0.0.1', lanPort, `/${tokenQ}`);
check('viewer port not bound on loopback (LAN address only)', loopViewer === 'ECONNREFUSED', `127.0.0.1:${lanPort} -> ${loopViewer}`);
check('publisher from a web page Origin rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { ...pubHeaders, Origin: 'http://localhost:3000' })).status === 403);
check('publisher without Origin rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { Host: `127.0.0.1:${pubPort}` })).status === 403);
check('publisher with foreign Host rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { ...pubHeaders, Host: `evil.example:${pubPort}` })).status === 403);

// ---------- broadcast ----------
const song = R.syntheticSong();
const epoch = 'probecheck01';
let seq = 0;
let anchor = { id: 1, at: Date.now(), position: 0, rate: 1, paused: true };
let loop = { a: 0, b: song.duration };
const pub = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
check('fake publisher connected', pub.status === 101);
const viewer = await wsConnect(lanIp, lanPort, `/viewer${tokenQ}`, viewerHeaders);
await sleep(50);
const sendState = () => pub.send(JSON.stringify({ t: 'state', epoch, seq: ++seq, song, anchor, loop }));
sendState();
await sleep(100);
const got = viewer.messages.map((m) => JSON.parse(m)).find((m) => m.t === 'state' && m.seq === seq);
check('viewer received the state broadcast', !!got && got.song.chords.length === song.chords.length);

// ---------- clock offset and RTT over the LAN address ----------
const samples = [];
viewer.onText((text) => {
  const m = JSON.parse(text);
  if (m.t === 'pong') samples.push(R.clockSample(m.c, m.s, clock()));
});
for (let i = 0; i < 60; i++) {
  viewer.send(JSON.stringify({ t: 'ping', id: i + 1, c: clock() }));
  await sleep(25);
}
await sleep(100);
const rtts = samples.map((s) => s.rtt).sort((a, b) => a - b);
const est = R.estimateOffset(samples);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(`RTT via ${relay.lanHost} (n=${rtts.length}): min ${rtts[0].toFixed(3)} median ${R.median(rtts).toFixed(3)} p95 ${pct(rtts, 0.95).toFixed(3)} max ${rtts.at(-1).toFixed(3)} ms`);
console.log(`clock offset estimate: ${est.offset.toFixed(3)} ms (viewer clock = performance.timeOrigin+now, relay = Date.now; ±${(est.rtt / 2).toFixed(3)} ms)`);

// ---------- extrapolation error during playback ----------
// Publisher: polls its own clock and sends a mark when its chord index changes (like the probe page).
// Viewer: extrapolates from anchors with the estimated offset and records its own changes.
const changes = [];
const errors = [];
const ideal = [];
let marks = [];
let vState = null;
viewer.onText((text) => {
  const m = JSON.parse(text);
  if (m.t === 'state' && R.isNewer(vState, m)) vState = m;
  if (m.t === 'mark') marks.push(m);
});
let pubPrev = null;
let viewPrev = null;
const tick = setInterval(() => {
  const t = Date.now();
  const p = R.positionAt(anchor, loop, song.duration, t);
  const i = R.chordIndexAt(song.chords, p);
  if (pubPrev && pubPrev.id === anchor.id && pubPrev.i !== i) pub.send(JSON.stringify({ t: 'mark', epoch, index: i, at: t }));
  pubPrev = { id: anchor.id, i };
  if (vState) {
    const macNow = clock() + est.offset;
    const a = vState.anchor;
    const vp = R.positionAt(a, vState.loop, vState.song.duration, macNow);
    const vi = R.chordIndexAt(vState.song.chords, vp);
    if (viewPrev && viewPrev.id === a.id && viewPrev.i !== vi) {
      changes.push({ index: vi, at: macNow });
      const chordAt = vState.song.chords[vi].at;
      // Ideal crossing time from the anchor (skipped after a loop wrap, where the formula differs).
      const unwrapped = a.position + (a.rate * (macNow - a.at)) / 1000;
      if (chordAt > a.position && unwrapped < (vState.loop?.b ?? Infinity)) ideal.push(macNow - (a.at + ((chordAt - a.position) / a.rate) * 1000));
    }
    viewPrev = { id: a.id, i: vi };
  }
  marks = marks.filter((mk) => {
    const e = R.matchChange(changes, mk);
    if (e === null) return true;
    errors.push(e);
    return false;
  });
}, 1);
const hb = setInterval(sendState, 1000);
let pingN = 1000;
const vPing = setInterval(() => viewer.send(JSON.stringify({ t: 'ping', id: ++pingN, c: clock() })), 2000);
const setAnchor = (ch) => {
  const t = Date.now();
  anchor = { ...anchor, id: anchor.id + 1, at: t, position: R.positionAt(anchor, loop, song.duration, t), ...ch };
  sendState();
};
// Loop the 2-beat run (C G Am Em, beats 16-24) so changes come every 1.33 s, wrap included.
loop = { a: song.chords[4].at, b: song.chords[8].at };
setAnchor({ paused: false, position: loop.a });
await sleep(16000);
setAnchor({ rate: 0.75 });
await sleep(8000);
setAnchor({ position: loop.a }); // loop jump
await sleep(4000);
clearInterval(tick);
clearInterval(hb);
clearInterval(vPing);
const s = R.summarizeErrors(errors);
const si = R.summarizeErrors(ideal);
console.log(`viewer change vs publisher mark (n=${s.n}): median|e| ${s.medianAbs.toFixed(3)} worst ${s.worstAbs.toFixed(3)} mean ${s.mean.toFixed(3)} ms`);
console.log(`  raw errors ms: ${errors.map((e) => e.toFixed(2)).join(' ')}`);
console.log(`viewer change vs ideal crossing (n=${si.n}): median|e| ${si.medianAbs.toFixed(3)} worst ${si.worstAbs.toFixed(3)} ms`);
check('viewer stayed connected through playback', !viewer.closed && viewer.closeCode === null);
check('extrapolated changes within 100 ms of the publisher (scripted, same Mac)', s.n >= 15 && s.worstAbs <= 100, `n=${s.n}`);

// ---------- message validation ----------
pub.send(JSON.stringify({ t: 'state', epoch, seq: ++seq, song, anchor: { ...anchor, rate: 9 }, loop }));
await sleep(150);
check('publisher sending an invalid state is closed (1008)', pub.closeCode === 1008, `close ${pub.closeCode}`);
const pub2 = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
pub2.send('x'.repeat(9000));
await sleep(150);
check('oversized message is closed (1009)', pub2.closeCode === 1009, `close ${pub2.closeCode}`);
viewer.send(JSON.stringify({ t: 'state', epoch, seq: 999, song, anchor, loop }));
await sleep(150);
check('viewer sending anything but ping is closed (1008)', viewer.closeCode === 1008, `close ${viewer.closeCode}`);

// ---------- stop ----------
await relay.close();
const after = await get(lanIp, lanPort, `/${tokenQ}`);
const afterPub = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
check('both ports closed after stop', after === 'ECONNREFUSED' && afterPub.status === 'ECONNREFUSED', `${after}, ${afterPub.status}`);
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
