// VGT-16: measured layout check of the phone music stand page (`npm run phone-layout`).
// Starts the relay, a fake side panel that publishes a song whose chord names are long ("C#m7b5/G#",
// the 16-character maximum) with a long title (not shown on the phone), approves the phone, and opens the real phone page in
// headless Chromium at phone sizes (portrait and landscape). For every size and name it measures, in
// the page, that nothing is wider than the screen: the page itself, both diagrams, the four control
// icon buttons, the bar card and the status line. Diagrams and buttons must also be fully on screen
// vertically, and the chord name must not overlap its diagram. In landscape the buttons must fill the
// next chord's column under it and the bar card the current chord's column, on one bottom line, with
// every button at least 44 px wide. Then it stops the relay and Chromium.
//
// Chromium: $CHROME, else Playwright's headless shell / Chromium cache, else Google Chrome (as
// scripts/screens.mjs). Screenshots go to a temp folder (printed) for a look by eye. Without Chromium
// it stops before starting anything (exit 2).
//
// --serve: no Chromium. Keeps the relay and the fake panel running for a browser you drive yourself
// (or a real phone on the same Wi-Fi): prints the phone URL, approves the first phone that connects,
// and switches the chord name on GET http://127.0.0.1:<control port>/name?n=<name>; GET /stop ends it.
// The served page measures itself (MEASURE_SOURCE) every 500 ms and shows the result in its title.
//
// --at <sec>: hold the song at that position instead of the first one with a current and a next chord
// (e.g. --at 12.5: the demo's verse, both chords carrying the uncertain "?" of VGT-19).
// --demo (with --serve): publish the demo song with its own chord names (no long names, no cycling),
// for a screenshot of the stand as a real song looks.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildViewer, loadRelay, loadSongTools, parseArgs } from './phone-lib.mjs';

const R = await loadRelay();
const S = await loadSongTools();
const atArg = process.argv.indexOf('--at');
const atSec = atArg >= 0 ? Number(process.argv[atArg + 1]) : null;
if (atSec !== null && !(Number.isFinite(atSec) && atSec >= 0)) throw new Error('--at needs a song position in seconds');
const opts = parseArgs(process.argv.slice(2).filter((a, i, all) => a !== '--serve' && a !== '--demo' && a !== '--at' && all[i - 1] !== '--at'));
const EXT_ID = 'a'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  for (const base of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base).sort().reverse()) {
      for (const rel of [
        'chrome-headless-shell-mac-arm64/chrome-headless-shell',
        'chrome-headless-shell-mac-x64/chrome-headless-shell',
        'chrome-headless-shell-linux64/chrome-headless-shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux/chrome',
      ]) {
        const p = path.join(base, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome']) if (existsSync(p)) return p;
  return null;
}

const serve = process.argv.includes('--serve');
const demoNames = serve && process.argv.includes('--demo');
const chromePath = serve ? null : findChrome();
if (!serve && !chromePath) {
  console.log('No Chromium found: set CHROME=/path/to/chrome, or run with --serve and measure in another browser');
  process.exit(2);
}

/** Minimal masked WebSocket client (the fake side panel) on top of the relay's frame code. */
function wsConnect(host, port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host,
      port,
      path: p,
      agent: false,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers },
    });
    req.on('response', (res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      let buf = new Uint8Array(0);
      const c = { messages: [], send: (text) => socket.write(R.encodeFrame(R.OP_TEXT, new TextEncoder().encode(text), randomBytes(4))), close: () => socket.destroy() };
      const feed = (chunk) => {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        const r = R.parseFrames(merged, 1 << 20, false);
        buf = r.rest;
        for (const f of r.frames) if (f.opcode === R.OP_TEXT) c.messages.push(JSON.parse(new TextDecoder().decode(f.payload)));
      };
      socket.on('data', feed);
      if (head.length) feed(new Uint8Array(head));
      resolve(c);
    });
    req.end();
  });
}

/**
 * In-page measurement (also pasted into another browser in --serve mode): what leaves a W x H screen.
 * Every element must stay inside the width; with `vertical`, the diagrams and the four buttons must
 * also be fully on screen; a chord name must not overlap its diagram.
 */
export const MEASURE_SOURCE = `(W, H, vertical) => {
  const out = [];
  const box = (label, el, vert) => {
    if (!el || el.closest('[hidden]') || !el.getClientRects().length) return;
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.right > W + 0.5) out.push(label + ' x ' + r.left.toFixed(1) + '..' + r.right.toFixed(1));
    if (vert && (r.top < -0.5 || r.bottom > H + 0.5)) out.push(label + ' y ' + r.top.toFixed(1) + '..' + r.bottom.toFixed(1));
  };
  const de = document.documentElement;
  if (de.scrollWidth > W + 0.5) out.push('page scrollWidth ' + de.scrollWidth);
  // Children of a 0 x 0 diagram (a row squeezed to nothing) report unscaled viewBox boxes; nothing is drawn.
  const drawn = (el) => { const svg = el.ownerSVGElement; if (!svg) return true; const s = svg.getBoundingClientRect(); return s.width > 0 && s.height > 0; };
  for (const el of document.querySelectorAll('#app *')) if (drawn(el)) box(el.id || String(el.className?.baseVal ?? el.className) || el.tagName, el, false);
  for (const id of ['ctl-prev', 'ctl-toggle', 'ctl-next', 'ctl-restart']) box(id, document.getElementById(id), vertical);
  box('now diagram', document.querySelector('#now-dia svg'), vertical);
  box('next diagram', document.querySelector('#next-dia svg'), vertical);
  const name = document.getElementById('now-name'), dia = document.querySelector('#now-dia svg');
  if (name && dia && name.getBoundingClientRect().right > dia.getBoundingClientRect().left + 0.5) out.push('now name overlaps its diagram');
  const nn = document.getElementById('next-name'), nd = document.querySelector('#next-dia svg');
  if (nn && nd && nn.getBoundingClientRect().right > nd.getBoundingClientRect().left + 0.5) out.push('next name overlaps its diagram');
  // Landscape: the buttons fill the next chord's column under it, the bar card the current chord's column.
  const ctl = document.getElementById('ctl'), meter = document.getElementById('meter');
  const nowEl = document.querySelector('.now'), nxEl = document.querySelector('.nx');
  if (W > H && ctl && !ctl.hidden && meter && nowEl && nxEl) {
    const inner = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return { left: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight), top: r.top, bottom: r.bottom }; };
    const c = inner(ctl), n = inner(nxEl), m = meter.getBoundingClientRect(), w = nowEl.getBoundingClientRect();
    if (Math.abs(c.left - n.left) > 1 || Math.abs(c.right - n.right) > 1) out.push('buttons not as wide as the next chord column ' + c.left.toFixed(1) + '..' + c.right.toFixed(1) + ' vs ' + n.left.toFixed(1) + '..' + n.right.toFixed(1));
    if (c.top < n.bottom - 0.5) out.push('buttons not under the next chord');
    if (Math.abs(m.left - w.left) > 1 || Math.abs(m.right - w.right) > 1) out.push('bar card not as wide as the current chord column');
    if (m.top < w.bottom - 0.5) out.push('bar card not under the current chord');
    const cb = ctl.getBoundingClientRect().bottom;
    if (Math.abs(m.bottom - cb) > 8) out.push('bar card and buttons not on one bottom line ' + m.bottom.toFixed(1) + ' vs ' + cb.toFixed(1));
    for (const b of ctl.querySelectorAll('button')) if (b.getBoundingClientRect().width < 44) out.push(b.id + ' narrower than 44 px');
  }
  return { out, name: name?.textContent, font: name ? getComputedStyle(name).fontSize : null, clipped: name ? name.scrollWidth > name.clientWidth + 1 : null, controls: !document.getElementById('ctl').hidden };
}`;

const viewer = await buildViewer();
// --serve only (a test copy of the page; the page's CSP blocks evaluating scripts from outside): the
// page measures itself every 500 ms and shows the result in its title.
// The title lists every size@name seen so far, and every failure (a name the stand has not drawn
// yet, controls not shown or a name clipped above the minimum font also count as not seen/failed).
if (serve)
  viewer.viewerJs += `;(() => { const seen = new Set(), bad = new Map(); const m = ${MEASURE_SOURCE};
    setInterval(() => { const r = m(innerWidth, innerHeight, true); if (!r.controls || !r.name || r.name === '–') return;
      const k = innerWidth + 'x' + innerHeight + '@' + r.name; seen.add(k);
      if (r.out.length || (r.clipped && parseFloat(r.font) > 16)) bad.set(k, r.out.join('; ') || 'clipped at ' + r.font);
      document.title = 'VGLAYOUT seen ' + seen.size + ' bad ' + JSON.stringify([...bad]) + ' last ' + k + ' ' + r.font; }, 300); })();`;
const NAMES = ['Bm7', 'Bbmaj7', 'F#7sus4', 'C#m7b5/G#', 'C#m7b5(add11)/G#'];
const relay = await R.startRelay({ host: opts.host, port: opts.port ?? 0, pubPort: opts.pubPort ?? 0, extensionId: EXT_ID, ...viewer, log: () => {} });
const [lanIp, lanPort] = relay.lanHost.split(':');
const pubPort = Number(new URL(relay.publisherUrl).port);
const userDir = path.join(os.tmpdir(), `vg-phone-layout-${process.pid}`);
const shotDir = path.join(os.tmpdir(), 'vg-phone-layout-shots');
mkdirSync(shotDir, { recursive: true });
const cdpPort = 9800 + Math.floor(Math.random() * 500);
const chrome = serve ? null : spawn(chromePath, ['--headless', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDir}`, '--no-first-run', '--hide-scrollbars', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let anchorTimer = null;
const stop = async () => {
  clearInterval(anchorTimer);
  chrome?.kill();
  await relay.close();
  try {
    rmSync(userDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

try {
  // ---------- fake side panel: a song with long names, approved phone ----------
  const model = S.buildPlayModel(S.demoChart(), { level: 'beginner', capo: 'auto' }, null);
  const base = R.buildSongView(model, { title: S.DEMO_RECORDING.title, artist: S.DEMO_RECORDING.artist, showSounding: true });
  const TITLE = '아이유(IU) - 밤편지 [가사/Lyrics] Through the Night 공식 뮤직비디오 가사 포함 1시간 연속 듣기';
  const epoch = 'phonelayout1';
  let rev = 0;
  const viewWith = (name) => (demoNames ? base : { ...base, title: TITLE, capo: 2, showSounding: true, shapes: base.shapes.map((s) => ({ ...s, name, sounding: name })) });
  const song0 = R.readSongView(viewWith('C#m7b5/G#'));
  if (!song0) throw new Error('song view with long names did not validate');
  // A position with a chord now and a next chord.
  let pos = 0;
  while (pos < base.durationSec && !(R.phoneFrame(song0, pos).nowEvent >= 0 && R.phoneFrame(song0, pos).nextEvent >= 0)) pos += 0.25;
  if (atSec !== null) pos = Math.min(atSec, base.durationSec);
  const pub = await wsConnect('127.0.0.1', pubPort, '/publish', { Host: `127.0.0.1:${pubPort}`, Origin: `chrome-extension://${EXT_ID}` });
  const publish = (name) => {
    const v = viewWith(name);
    if (!R.readSongView(v)) throw new Error(`song view with ${name} did not validate`);
    for (const p of R.songParts(v, epoch, ++rev)) pub.send(JSON.stringify(p));
  };
  let seq = 0;
  const sendAnchor = () => pub.send(JSON.stringify({ t: 'anchor', epoch, seq: ++seq, sampledAt: Date.now(), position: pos, rate: 1, paused: true, ad: false, loop: null }));
  pub.send(JSON.stringify({ t: 'control', on: true }));
  publish('C#m7b5/G#');
  sendAnchor();
  anchorTimer = setInterval(sendAnchor, 500);

  if (serve) {
    // Approve the first phone that shows a code; switch names over a local control port.
    const approver = setInterval(() => {
      const p = pub.messages.findLast((m) => m.t === 'phones');
      const e = p?.list.find((x) => x.state === 'pending');
      if (e) pub.send(JSON.stringify({ t: 'approve', id: e.id, code: e.code, grant: 1 }));
    }, 300);
    const ctl = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (u.pathname === '/name' && u.searchParams.get('n')) {
        picked = true;
        try {
          publish(u.searchParams.get('n'));
          res.end('ok');
        } catch (e) {
          res.statusCode = 400;
          res.end(String(e.message));
        }
      } else if (u.pathname === '/stop') {
        res.end('stopping');
        clearInterval(approver);
        ctl.close();
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((r) => ctl.listen(0, '127.0.0.1', r));
    // Cycle through the long names (one per second) unless one was picked on the control port.
    let cycle = 0;
    let picked = false;
    const cycler = setInterval(() => !picked && !demoNames && publish(NAMES[++cycle % NAMES.length]), 1000);
    ctl.on('close', () => clearInterval(cycler));
    console.log(`phone page: http://${relay.lanHost}/?t=${relay.token}`);
    console.log(`control: http://127.0.0.1:${ctl.address().port}/name?n=<chord name>  (/stop ends)`);
    await new Promise((r) => ctl.on('close', r));
    pub.close();
    throw null; // done: skip the Chromium checks, stop in finally
  }

  // ---------- Chromium over CDP ----------
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch {
      /* not up yet */
    }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) throw new Error('Chromium did not start');
  const cdp = new WebSocket(wsUrl);
  await new Promise((r) => cdp.addEventListener('open', r, { once: true }));
  let cdpSeq = 0;
  const waiting = new Map();
  cdp.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++cdpSeq;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const setSize = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from(s.data, 'base64'));
  };

  const measure = (W, H, vertical) => `(${MEASURE_SOURCE})(${W}, ${H}, ${vertical})`;

  await send('Page.enable');
  const SIZES = [
    { name: 'portrait-390', w: 390, h: 664 },
    { name: 'portrait-320', w: 320, h: 548 },
    { name: 'landscape-844', w: 844, h: 340 },
    { name: 'landscape-874', w: 874, h: 338 },
    { name: 'landscape-568', w: 568, h: 280 },
  ];
  await setSize(320, 548);
  await send('Page.navigate', { url: `http://${relay.lanHost}/?t=${relay.token}` });

  // Before approval: the pairing code is shown (width only).
  const pending = await (async () => {
    for (let i = 0; i < 50; i++) {
      const p = pub.messages.findLast((m) => m.t === 'phones' && m.list.some((e) => e.state === 'pending'));
      if (p) return p.list.find((e) => e.state === 'pending');
      await sleep(100);
    }
    return null;
  })();
  check('phone page connected and shows a pairing code', !!pending, pending?.code);
  await sleep(400);
  for (const s of [SIZES[1], SIZES[3]]) {
    await setSize(s.w, s.h);
    await sleep(300);
    const m = await evaluate(measure(s.w, s.h, false));
    await shot(`${s.name}-pairing`);
    check(`${s.name} before approval (pairing code): nothing wider than the screen`, m.out.length === 0, m.out.join('; '));
  }
  pub.send(JSON.stringify({ t: 'approve', id: pending.id, code: pending.code, grant: 1 }));
  await sleep(500);

  for (const s of SIZES) {
    await setSize(s.w, s.h);
    for (const name of NAMES) {
      publish(name);
      await sleep(350);
      const m = await evaluate(measure(s.w, s.h, true));
      if (name === 'C#m7b5/G#' || name === 'Bm7') await shot(`${s.name}-${name.replace(/[^\w]/g, '_')}`);
      const ok = m.out.length === 0 && m.controls && m.name === name && !(m.clipped && parseFloat(m.font) > 16);
      check(`${s.name} "${name}": fits (name ${m.font}${m.clipped ? ', clipped' : ''}, controls ${m.controls ? 'shown' : 'hidden'})`, ok, m.out.join('; '));
    }
  }
  cdp.close();
  pub.close();
  console.log(`screenshots: ${shotDir}`);
} catch (e) {
  if (e !== null) check(`layout check ran (${e.message})`, false);
} finally {
  await stop();
}

const failed = results.filter((ok) => !ok).length;
if (serve && !failed) {
  console.log('stopped (serve mode: the results were in the page title)');
  process.exit(0);
}
console.log(failed ? `${failed} check(s) FAILED` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
