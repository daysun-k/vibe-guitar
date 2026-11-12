// VGT-13: scripted checks for the phone music stand relay (`npm run phone-check`).
// Starts the relay on this Mac's LAN address, checks the access rules and malformed input, then runs
// a fake side panel (publisher) with the real demo song view and a fake phone (viewer) to measure
// round trips and how far the phone's extrapolated chord changes land from the panel's, then stops.
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { buildViewer, loadRelay, loadSongTools, parseArgs } from './phone-lib.mjs';

const R = await loadRelay();
const S = await loadSongTools();
const opts = parseArgs(process.argv.slice(2));
const EXT_ID = 'a'.repeat(32);
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const relay = await R.startRelay({ host: opts.host, port: opts.port ?? 0, pubPort: opts.pubPort ?? 0, extensionId: EXT_ID, ...(await buildViewer()), log: () => {} });
const [lanIp, lanPort] = relay.lanHost.split(':');
const pubPort = Number(new URL(relay.publisherUrl).port);
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: e.code, headers: {}, body: '' }));
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
      let buf = new Uint8Array(0);
      const listeners = [];
      const c = {
        status: 101,
        messages: [],
        closeCode: null,
        closed: false,
        onText: (fn) => listeners.push(fn),
        send: (text) => socket.write(R.encodeFrame(R.OP_TEXT, new TextEncoder().encode(text), randomBytes(4))),
        close: () => socket.destroy(),
        /** Closes like a browser does (close frame 1000), as when the panel switches 휴대폰 악보대 off. */
        bye: () => socket.end(R.encodeFrame(R.OP_CLOSE, new Uint8Array([0x03, 0xe8]), randomBytes(4))),
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
      if (head.length) feed(new Uint8Array(head));
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
const page = await get(lanIp, lanPort, `/${tokenQ}`);
check('page with right token', page.status === 200);
check('page has CSP and no-store', /default-src 'none'/.test(page.headers['content-security-policy'] ?? '') && page.headers['cache-control'] === 'no-store');
check('page with wrong token rejected', (await get(lanIp, lanPort, `/?t=${'x'.repeat(22)}`)).status === 403);
check('page without token rejected', (await get(lanIp, lanPort, '/')).status === 403);
check('page with foreign Host rejected (DNS rebinding)', (await get(lanIp, lanPort, `/${tokenQ}`, { Host: `evil.example:${lanPort}` })).status === 421);
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
check('viewer port not bound on loopback (LAN address only)', loopViewer.status === 'ECONNREFUSED', `127.0.0.1:${lanPort} -> ${loopViewer.status}`);
check('publisher from a web page Origin rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { ...pubHeaders, Origin: 'http://localhost:3000' })).status === 403);
check('publisher from another extension rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { ...pubHeaders, Origin: `chrome-extension://${'b'.repeat(32)}` })).status === 403);
check('publisher without Origin rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { Host: `127.0.0.1:${pubPort}` })).status === 403);
check('publisher with foreign Host rejected', (await wsConnect('127.0.0.1', pubPort, '/publish', { ...pubHeaders, Host: `evil.example:${pubPort}` })).status === 403);

// ---------- malformed input must not stop the relay ----------
function raw(host, port, bytes) {
  return new Promise((resolve) => {
    const chunks = [];
    const sock = net.connect({ host, port }, () => sock.write(bytes));
    const done = () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(done, 800);
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', done);
    sock.on('error', done);
  });
}
const statusOf = (b) => Number(/^HTTP\/1\.1 (\d{3})/.exec(b.toString('latin1'))?.[1]);
const closeCodeOf = (b) => {
  const at = b.indexOf('\r\n\r\n');
  if (at < 0) return null;
  const frames = R.parseFrames(new Uint8Array(b.subarray(at + 4)), 1 << 20, false).frames;
  const c = frames.find((f) => f.opcode === R.OP_CLOSE);
  return c ? (c.payload[0] << 8) | c.payload[1] : null;
};
const upgradeReq = (p, host, origin) =>
  `GET ${p} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`;
const badFrame = Buffer.from(R.encodeFrame(R.OP_TEXT, new TextEncoder().encode('{}'), randomBytes(4)));
check('GET // on the viewer page rejected (400)', statusOf(await raw(lanIp, lanPort, `GET // HTTP/1.1\r\nHost: ${relay.lanHost}\r\n\r\n`)) === 400);
check('viewer upgrade with target // rejected (400)', statusOf(await raw(lanIp, lanPort, upgradeReq('//', relay.lanHost, `http://${relay.lanHost}`))) === 400);
check('publisher upgrade with target // rejected (400)', statusOf(await raw('127.0.0.1', pubPort, upgradeReq('//', `127.0.0.1:${pubPort}`, EXT_ORIGIN))) === 400);
{
  const v = await raw(lanIp, lanPort, Buffer.concat([Buffer.from(upgradeReq(`/viewer${tokenQ}`, relay.lanHost, `http://${relay.lanHost}`)), badFrame]));
  check('viewer handshake + invalid frame in one write: closed 1008', statusOf(v) === 101 && closeCodeOf(v) === 1008, `status ${statusOf(v)}, close ${closeCodeOf(v)}`);
  const p = await raw('127.0.0.1', pubPort, Buffer.concat([Buffer.from(upgradeReq('/publish', `127.0.0.1:${pubPort}`, EXT_ORIGIN)), badFrame]));
  check('publisher handshake + invalid frame in one write: closed 1008', statusOf(p) === 101 && closeCodeOf(p) === 1008, `status ${statusOf(p)}, close ${closeCodeOf(p)}`);
}
// A client that sends a rejected upgrade and then resets the connection (RST) must not stop the relay.
const resetAfter = (host, port, req, ms) =>
  new Promise((resolve) => {
    const s = net.connect({ host, port }, () => {
      s.write(req);
      setTimeout(() => (s.resetAndDestroy(), resolve()), ms);
    });
    s.on('error', resolve);
  });
for (const ms of [0, 5, 30]) {
  await resetAfter(lanIp, lanPort, upgradeReq(`/viewer?t=${'z'.repeat(22)}`, relay.lanHost, `http://${relay.lanHost}`), ms);
  await resetAfter('127.0.0.1', pubPort, upgradeReq('/publish', `127.0.0.1:${pubPort}`, 'http://evil.example'), ms);
}
await sleep(300);
check('relay still serving after malformed input and RST after rejected upgrades', (await get(lanIp, lanPort, `/${tokenQ}`)).status === 200);

// ---------- song view: the real demo song through the relay ----------
const model = S.buildPlayModel(S.demoChart(), { level: 'beginner', capo: 'auto' }, null);
const view = R.buildSongView(model, { title: S.DEMO_RECORDING.title, artist: S.DEMO_RECORDING.artist, showSounding: false });
const song = R.readSongView(view);
const epoch = 'phonecheck01';
let rev = 0;
let seq = 0;
const pub = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
check('fake panel (publisher) connected', pub.status === 101);
const viewer = await wsConnect(lanIp, lanPort, `/viewer${tokenQ}`, viewerHeaders);
const vSong = new R.SongAssembler();
let vView = null;
let vAnchor = null;
viewer.onText((text) => {
  const m = R.validatePublisherMessage(text);
  if (!m) return;
  if (m.t === 'song') {
    const r = vSong.add(m);
    if (typeof r === 'object') vView = r;
  } else if (!vAnchor || R.isNewer({ epoch: vAnchor.epoch, n: vAnchor.seq }, { epoch: m.epoch, n: m.seq })) vAnchor = m;
});
await sleep(50);
// Force several parts (as a long song would need) to check reassembly end to end.
const parts = R.songParts(view, epoch, ++rev, 1500);
for (const p of parts) pub.send(JSON.stringify(p));
await sleep(150);
check('viewer received the song view, reassembled from parts', !!vView && JSON.stringify(vView) === JSON.stringify(view), `${parts.length} parts, ${JSON.stringify(view).length} chars`);
check('song view carries no lyrics, audio or storage keys', !/lyric|audio|chart:|storage/i.test(JSON.stringify(view)));
const real = R.songParts(view, epoch, ++rev);
check('demo song view fits one 8 KiB frame', real.length === 1 && Buffer.byteLength(JSON.stringify(real[0])) <= R.MAX_MESSAGE_BYTES, `${Buffer.byteLength(JSON.stringify(real[0]))} bytes`);
for (const p of real) pub.send(JSON.stringify(p));

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
console.log(`clock offset estimate: ${est.offset.toFixed(3)} ms (±${est.bound.toFixed(3)} ms, consistent ${est.consistent})`);

// ---------- extrapolated chord changes during playback ----------
// Panel: reads its own clock every ms and records when its shown chord changes (the reference).
// Phone: extrapolates from anchors with the estimated offset and records its own changes.
let anchor = { sampledAt: Date.now(), position: 0, rate: 1, paused: true, ad: false, loop: null };
const sendAnchor = () => pub.send(JSON.stringify({ t: 'anchor', epoch, seq: ++seq, ...anchor }));
const setAnchor = (ch) => {
  const t = Date.now();
  anchor = { ...anchor, position: R.positionAt(anchor, view.durationSec, t), ...ch, sampledAt: t };
  sendAnchor();
};
const heartbeat = () => {
  const t = Date.now();
  anchor = { ...anchor, position: R.positionAt(anchor, view.durationSec, t), sampledAt: t };
  sendAnchor();
};
const panelChanges = [];
const phoneChanges = [];
let panelPrev = null;
let phonePrev = null;
const tick = setInterval(() => {
  const t = Date.now();
  const i = R.phoneFrame(song, R.positionAt(anchor, view.durationSec, t)).nowEvent;
  if (panelPrev !== null && panelPrev !== i && i >= 0) panelChanges.push({ index: i, at: t });
  panelPrev = i;
  if (vAnchor && vView) {
    const macNow = clock() + est.offset;
    const j = R.phoneFrame(song, R.positionAt(vAnchor, vView.durationSec, macNow)).nowEvent;
    if (phonePrev !== null && phonePrev !== j && j >= 0) phoneChanges.push({ index: j, at: macNow });
    phonePrev = j;
  }
}, 1);
const hb = setInterval(heartbeat, 1000);
let pingN = 1000;
const vPing = setInterval(() => viewer.send(JSON.stringify({ t: 'ping', id: ++pingN, c: clock() })), 2000);
// Loop four bars so changes keep coming, with the wrap, a slower rate, a pause and a jump.
const b = view.bars;
const loop = { a: b[2 * 4], b: b[2 * 8] };
setAnchor({ paused: false, position: loop.a, loop });
await sleep(14000);
setAnchor({ rate: 0.75 });
await sleep(8000);
setAnchor({ paused: true });
await sleep(1500);
const phonePausedAt = vAnchor && R.positionAt(vAnchor, view.durationSec, clock() + est.offset);
await sleep(500);
const phonePausedLater = vAnchor && R.positionAt(vAnchor, view.durationSec, clock() + est.offset);
check('phone holds the position while paused', vAnchor?.paused === true && phonePausedAt === phonePausedLater);
setAnchor({ paused: false, position: loop.a, rate: 1 }); // loop jump
await sleep(6000);
clearInterval(tick);
clearInterval(hb);
clearInterval(vPing);
const errors = panelChanges.map((c) => R.matchChange(phoneChanges, c)).filter((e) => e !== null);
const s = R.summarizeErrors(errors);
console.log(`phone change vs panel change (n=${s.n} of ${panelChanges.length}): median|e| ${s.medianAbs.toFixed(3)} worst ${s.worstAbs.toFixed(3)} mean ${s.mean.toFixed(3)} ms`);
check('panel and viewer stayed connected through playback', !viewer.closed && viewer.closeCode === null && !pub.closed && pub.closeCode === null);
check('extrapolated chord changes within 100 ms of the panel (scripted, same Mac)', s.n >= 10 && s.n >= panelChanges.length - 1 && s.worstAbs <= 100, `n=${s.n}`);

// ---------- message validation ----------
pub.send(JSON.stringify({ t: 'anchor', epoch, seq: ++seq, ...anchor, rate: 9 }));
await sleep(150);
check('publisher sending an invalid anchor is closed (1008)', pub.closeCode === 1008, `close ${pub.closeCode}`);
const pub2 = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
pub2.send(JSON.stringify({ t: 'song', epoch, rev: 99, i: 0, n: 1, d: JSON.stringify({ ...view, lyrics: 'la la' }) }));
await sleep(150);
check('song view with an unknown field (lyrics) is closed (1008)', pub2.closeCode === 1008, `close ${pub2.closeCode}`);
const pub3 = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
pub3.send('x'.repeat(9000));
await sleep(150);
check('oversized message is closed (1009)', pub3.closeCode === 1009, `close ${pub3.closeCode}`);
viewer.send(JSON.stringify({ t: 'anchor', epoch, seq: 999, ...anchor }));
await sleep(150);
check('viewer sending anything but ping is closed (1008)', viewer.closeCode === 1008, `close ${viewer.closeCode}`);

// ---------- stop ----------
await relay.close();
const after = await get(lanIp, lanPort, `/${tokenQ}`);
const afterPub = await wsConnect('127.0.0.1', pubPort, '/publish', pubHeaders);
check('both ports closed after stop', after.status === 'ECONNREFUSED' && afterPub.status === 'ECONNREFUSED', `${after.status}, ${afterPub.status}`);
// ---------- idle auto-stop (short timer; npm run phone uses --idle-minutes, default 10) ----------
const IDLE_MS = 1500;
let idleStoppedAt = null;
const r2 = await R.startRelay({
  host: opts.host,
  port: 0,
  pubPort: 0,
  extensionId: EXT_ID,
  viewerHtml: '',
  viewerJs: '',
  idleStopMs: IDLE_MS,
  onIdleStop: () => (idleStoppedAt = Date.now()),
  log: () => {},
});
const [ip2, port2] = r2.lanHost.split(':');
const pub2Port = Number(new URL(r2.publisherUrl).port);
const pub2Headers = { Host: `127.0.0.1:${pub2Port}`, Origin: EXT_ORIGIN };
const v2 = await wsConnect(ip2, port2, `/viewer?t=${r2.token}`, { Host: r2.lanHost, Origin: `http://${r2.lanHost}` });
const panel2 = await wsConnect('127.0.0.1', pub2Port, '/publish', pub2Headers);
await sleep(IDLE_MS * 2);
check('idle stop: relay stays up while a panel is connected', idleStoppedAt === null && !v2.closed && !panel2.closed);
const leftAt = Date.now();
panel2.bye();
await sleep(IDLE_MS + 700);
check('idle stop: stops after the idle time once the panel left, although a phone is still connected', idleStoppedAt !== null && v2.closed, idleStoppedAt ? `stopped ${idleStoppedAt - leftAt} ms after the panel left` : 'still running');
const after2 = await get(ip2, port2, `/?t=${r2.token}`);
const after2Pub = await wsConnect('127.0.0.1', pub2Port, '/publish', pub2Headers);
check('idle stop: both ports closed', after2.status === 'ECONNREFUSED' && after2Pub.status === 'ECONNREFUSED', `${after2.status}, ${after2Pub.status}`);
await r2.close();

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
