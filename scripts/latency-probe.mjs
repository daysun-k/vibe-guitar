// Dev-only capture-latency probe page (Linear VGT-7; docs/latency-probe.md).
//   npm run latency-probe [-- --port 8790]
// Serves, on 127.0.0.1 only: the probe page, its script, the generated click track (WAV)
// and the click plan. Bundles src/probe/*.ts in memory with esbuild. No network calls,
// nothing written to disk, nothing private on the page.
import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';

function parsePort(argv) {
  const i = argv.indexOf('--port');
  const v = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--port='))?.slice('--port='.length);
  if (v === undefined) return 8790;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port: 0..65535 사이의 정수를 적어 주세요 (받은 값: ${v})`);
  return n;
}

async function bundle(entry, platform) {
  const r = await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform,
    format: platform === 'node' ? 'esm' : 'iife',
    target: platform === 'node' ? 'node20' : 'chrome116',
    write: false,
    logLevel: 'error',
  });
  return r.outputFiles[0].text;
}

const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="vibe-guitar-latency-probe" content="1">
<title>Vibe Guitar latency probe (dev)</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 52rem; }
  button { font: inherit; margin-right: .5rem; }
  #log { background: #f4f4f4; padding: .75rem; height: 22rem; overflow: auto; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>Vibe Guitar 캡처 지연 측정 (개발용)</h1>
<p>dist-probe/ 확장에서만 동작합니다. 이 탭에서 Vibe Guitar 툴바 버튼을 한 번 누른 뒤 측정을 시작하세요.
배치 오차만 측정하며 스피커·블루투스 지연은 포함하지 않습니다.</p>
<audio id="vg-probe-audio" src="/probe.wav" preload="auto" controls></audio>
<p>
  <button id="run1">1회 측정</button>
  <button id="run3">3회 측정</button>
  <button id="recapture">캡처 다시 시작</button>
  <button id="download">결과 JSON 받기</button>
</p>
<p id="status"></p>
<pre id="log"></pre>
<script src="/page.js"></script>
</body>
</html>
`;

async function main() {
  const port = parsePort(process.argv.slice(2));
  const lib = await import(`data:text/javascript;base64,${Buffer.from(await bundle('src/probe/latency.ts', 'node')).toString('base64')}`);
  const plan = lib.probePlan();
  const wav = Buffer.from(lib.encodeWav(lib.renderProbeTrack(plan), plan.sampleRate));
  const pageJs = await bundle('src/probe/page.ts', 'browser');
  const routes = {
    '/': ['text/html; charset=utf-8', PAGE],
    '/page.js': ['text/javascript; charset=utf-8', pageJs],
    '/plan.json': ['application/json', JSON.stringify(plan)],
    '/probe.wav': ['audio/wav', wav],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const route = req.method === 'GET' || req.method === 'HEAD' ? routes[url.pathname] : undefined;
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    const [type, body] = route;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    // Range support so the <audio> element can seek in the WAV.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    const headers = { 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, buf.length - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      if (start >= buf.length || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${buf.length}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': end - start + 1 });
      res.end(req.method === 'HEAD' ? undefined : buf.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
  server.listen(port, HOST, () => {
    const addr = server.address();
    console.log(`latency probe: http://${HOST}:${addr.port}/  (${plan.clicks.length} clicks, ${plan.durationSec} s track; Ctrl+C to stop)`);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
