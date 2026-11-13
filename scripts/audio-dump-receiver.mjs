// Local receiver for the dev-only audio dump build (docs/recognition-replay.md).
//   npm run audio-dump-receiver -- --out <dir outside the repository> [--port 8791]
// Listens on 127.0.0.1 only. Each POST /capture from the dump build (one per analysed auto chart)
// is written to <out>/<youtubeId or safe key>/<captureId>/seg-<i>.f32 + meta.json; an existing
// capture folder is never overwritten. Allows CORS for chrome-extension:// origins only (a request
// from a web page origin is refused). Makes no other network connections.
import * as esbuild from 'esbuild';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: npm run audio-dump-receiver -- --out <dir outside the repository> [--port 8791]';
/** Upper bound on one POST: 20 min of 22.05 kHz Float32 is 106 MB; allow headroom for the JSON. */
export const MAX_BODY_BYTES = 160 * 1024 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

let formatModule = null;
/** src/replay/capture.ts bundled in memory (the same decoder replay uses). */
export async function loadCaptureFormat() {
  if (formatModule) return formatModule;
  const built = await esbuild.build({ absWorkingDir: root, entryPoints: ['src/replay/capture.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', write: false, logLevel: 'error' });
  formatModule = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  return formatModule;
}

/** Real path of p, or of its nearest existing ancestor joined with the rest (p may not exist yet). */
function realish(p) {
  const abs = path.resolve(p);
  let head = abs;
  const tail = [];
  while (!existsSync(head)) {
    tail.unshift(path.basename(head));
    const up = path.dirname(head);
    if (up === head) break;
    head = up;
  }
  return path.join(realpathSync(head), ...tail);
}

/** True when dir is the repository or inside it (symlinks resolved). */
export function isInsideRepo(dir, repoRoot = root) {
  const r = realish(repoRoot);
  const d = realish(dir);
  return d === r || d.startsWith(r + path.sep);
}

export function parseArgs(argv, repoRoot = root) {
  const out = { port: 8791 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--out') out.out = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}\n${USAGE}`);
  }
  if (!out.out) throw new Error(`--out is required\n${USAGE}`);
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port must be a port number');
  if (isInsideRepo(out.out, repoRoot)) throw new Error(`--out ${out.out} is inside the repository: captured audio must stay outside it`);
  out.out = path.resolve(out.out);
  return out;
}

function captureIdNow(date = new Date()) {
  return `${date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(3).toString('hex')}`;
}

/**
 * Writes one capture; returns { dir, meta }. Writes into a temporary folder, then renames it to the
 * capture folder; rename fails (and nothing is replaced) when the capture folder already exists.
 */
export async function saveCapture(outDir, body, opts = {}) {
  const fmt = await loadCaptureFormat();
  const { header, segmentBytes } = fmt.decodeCaptureBody(body);
  const keyDir = path.join(outDir, fmt.captureFolderName(header.recording));
  await mkdir(keyDir, { recursive: true });
  const captureId = opts.captureId ?? captureIdNow();
  if (!/^[A-Za-z0-9_-]+$/.test(captureId)) throw new Error(`bad capture id ${captureId}`);
  const dir = path.join(keyDir, captureId);
  if (existsSync(dir)) throw Object.assign(new Error(`capture ${dir} already exists; not overwritten`), { code: 'EEXIST' });
  const tmp = path.join(keyDir, `.tmp-${captureId}-${randomBytes(3).toString('hex')}`);
  mkdirSync(tmp);
  try {
    const segments = header.segments.map((s, i) => ({ ...s, file: `seg-${i}.f32` }));
    for (let i = 0; i < segmentBytes.length; i++) await writeFile(path.join(tmp, segments[i].file), segmentBytes[i], { flag: 'wx' });
    const { segments: _, ...rest } = header;
    const meta = { ...rest, captureId, receivedAt: new Date().toISOString(), segments };
    await writeFile(path.join(tmp, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
    if (existsSync(dir)) throw Object.assign(new Error(`capture ${dir} already exists; not overwritten`), { code: 'EEXIST' });
    // A non-empty target makes rename fail on macOS and Linux, so an existing capture is never replaced.
    await rename(tmp, dir);
    return { dir, meta };
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

function corsHeaders(origin) {
  return origin && EXTENSION_ORIGIN.test(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' }
    : {};
}

/** The HTTP server (not listening yet). onSaved(result) is called once per saved capture. */
export function createReceiver(outDir, onSaved = () => {}) {
  return createServer((req, res) => {
    const origin = req.headers.origin;
    // Browsers send Origin; only the extension may post. Local tools without Origin are allowed.
    if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('origin not allowed');
      return;
    }
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/capture') {
      res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' }).end('POST /capture only');
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES && !aborted) {
        aborted = true;
        res.writeHead(413, { ...cors, 'Content-Type': 'text/plain' }).end('capture too large');
        req.destroy();
      } else if (!aborted) chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      saveCapture(outDir, new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).then(
        (r) => {
          onSaved(r);
          res.writeHead(201, { ...cors, 'Content-Type': 'text/plain' }).end(r.dir);
        },
        (e) => {
          const status = e.code === 'EEXIST' ? 409 : e.name === 'CaptureFormatError' || /^capture:/.test(e.message) ? 400 : 500;
          console.error(`refused: ${e.message}`);
          res.writeHead(status, { ...cors, 'Content-Type': 'text/plain' }).end(e.message);
        },
      );
    });
  });
}

function describe({ dir, meta }) {
  const sec = meta.segments.reduce((s, g) => s + g.samples, 0) / meta.sampleRate;
  return `saved ${dir}: ${meta.recordingKey} "${meta.recording.title}", ${meta.segments.length} segments, ${sec.toFixed(1)} s audio, ${meta.chart.events.length} events, build ${meta.build.commit.slice(0, 7)}${meta.build.dirty ? '+dirty' : ''}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  await mkdir(args.out, { recursive: true });
  await loadCaptureFormat();
  const server = createReceiver(args.out, (r) => console.log(describe(r)));
  server.listen(args.port, '127.0.0.1', () => console.log(`audio dump receiver on http://127.0.0.1:${args.port}/capture → ${args.out} (Ctrl+C to stop)`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
