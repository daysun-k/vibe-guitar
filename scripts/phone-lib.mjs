// VGT-13: shared helpers for `npm run phone` and `npm run phone-check`. Bundles the relay and the
// phone page in memory with esbuild (nothing is written to disk).
import * as esbuild from 'esbuild';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function importBundle(contents) {
  const out = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

/** The relay, QR encoder, protocol and frame code (node: builtins stay external). */
export function loadRelay() {
  return importBundle(
    "export * from './src/phone/relay.ts'; export * from './src/phone/qr.ts'; export * from './src/phone/protocol.ts'; export * from './src/phone/ws-frame.ts'; export * from './src/phone/song-view.ts';",
  );
}

/** For phone-check: the real play model and demo song, to build a real song view. */
export function loadSongTools() {
  return importBundle("export { buildPlayModel } from './src/play/model.ts'; export { demoChart, DEMO_RECORDING } from './src/play/demo.ts';");
}

/** The phone page: static HTML plus its bundled script (served at /viewer.js). */
export async function buildViewer() {
  const out = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/phone/viewer.ts'],
    bundle: true,
    format: 'iife',
    target: ['safari15', 'chrome110'],
    minify: true,
    write: false,
    logLevel: 'error',
  });
  return {
    viewerHtml: await readFile(path.join(root, 'src/phone/viewer.html'), 'utf8'),
    viewerJs: out.outputFiles[0].text,
  };
}

/** The dist folder Chrome loads the unpacked extension from (symlinks resolved, like Chrome does). */
export async function distPath() {
  try {
    return await realpath(path.join(root, 'dist'));
  } catch {
    return path.join(root, 'dist');
  }
}

export function parseArgs(argv) {
  const opts = {};
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} needs a port number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--host') {
      if (v === undefined || v.startsWith('--')) throw new Error('--host needs this Mac\'s home-network IPv4 address, e.g. 192.168.0.23');
      opts.host = v;
      i++;
    }
    else if (a === '--port') (opts.port = num(v, a)), i++;
    else if (a === '--pub-port') (opts.pubPort = num(v, a)), i++;
    else if (a === '--extension-id') {
      if (!/^[a-p]{32}$/.test(v ?? '')) throw new Error('--extension-id needs the 32-letter id shown in chrome://extensions');
      opts.extensionId = v;
      i++;
    } else if (a === '--any-extension') opts.anyExtension = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}
