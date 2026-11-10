// Screenshots of the side panel's demo mode (sidepanel.html?demo=1) in headless Chromium.
// No network: the page is loaded from dist/ via file://, the synthetic demo song brings its
// own placeholder lyrics, and every request outside file:// is blocked.
//
//   npm run build && node scripts/screens.mjs [--out docs/screens] [--eval "js expr"]
//
// Chromium: $CHROME, else Playwright's headless shell / Chromium cache, else Google Chrome.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const outDir = path.resolve(root, arg('--out', 'docs/screens'));
const evalExpr = arg('--eval', null);
const extraQuery = arg('--q', '');
const waitMs = Number(arg('--wait', '1200'));

function findChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  const pw = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const linuxPw = path.join(os.homedir(), '.cache/ms-playwright');
  for (const base of [pw, linuxPw]) {
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
  throw new Error('No Chromium found: set CHROME=/path/to/chrome');
}

const page = path.join(root, 'dist/sidepanel.html');
if (!existsSync(page)) throw new Error('dist/sidepanel.html missing: run `npm run build` first');

const port = 9300 + Math.floor(Math.random() * 500);
const userDir = path.join(os.tmpdir(), `vg-shots-${process.pid}`);
const chrome = spawn(findChrome(), ['--headless', `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, '--no-first-run', '--hide-scrollbars', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });

async function wsUrl() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chromium did not start');
}

const ws = new WebSocket(await wsUrl());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Network.enable');
// Block everything that is not a local file: the screenshots must not touch the network.
await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*', 'ws://*', 'wss://*'] });

/** t: demo position (s). Chosen to land inside a sung line just before a chord change. */
const SHOTS = [
  { name: 'demo-400-light', width: 400, height: 860, theme: 'light', q: 't=31.2' },
  { name: 'demo-400-dark', width: 400, height: 860, theme: 'dark', q: 't=31.2' },
  { name: 'demo-600-light', width: 600, height: 860, theme: 'light', q: 't=31.2' },
  { name: 'demo-600-dark', width: 600, height: 860, theme: 'dark', q: 't=31.2' },
  { name: 'demo-400-light-intermediate-snd', width: 400, height: 860, theme: 'light', q: 't=31.2&level=intermediate&capo=1&snd=1' },
  { name: 'demo-400-light-sheet', width: 400, height: 860, theme: 'light', q: 't=31.2&sheet=1' },
];

const only = arg('--only', null);
mkdirSync(outDir, { recursive: true });
for (const s of SHOTS.filter((x) => !only || x.name === only)) {
  await send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 2, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.theme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  const url = `file://${page}?demo=1&mute=1&theme=${s.theme}&${s.q}${extraQuery ? `&${extraQuery}` : ''}`;
  await send('Page.navigate', { url });
  await sleep(waitMs);
  if (evalExpr) {
    const r = await send('Runtime.evaluate', { expression: evalExpr, returnByValue: true, awaitPromise: true });
    console.log(s.name, JSON.stringify(r.result.value ?? r.result.description));
  }
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${s.name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('wrote', path.relative(root, file));
}
ws.close();
chrome.kill();
