// VGT-13 spike: bundles the relay and the phone page in memory with esbuild (no files written).
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Imports src/phone/{relay,qr}.ts from an in-memory ESM bundle (data: URL; node: builtins stay external). */
export async function loadRelay() {
  const out = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/phone/relay.ts'; export * from './src/phone/qr.ts'; export * from './src/phone/protocol.ts'; export * from './src/phone/ws-frame.ts'; export * from './src/phone/synthetic.ts';",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  const code = out.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

/** The phone page: static HTML plus its bundled script (served at /viewer.js). */
export async function buildViewer() {
  const out = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/phone/viewer.ts'],
    bundle: true,
    format: 'iife',
    target: ['safari15', 'chrome110'],
    write: false,
    logLevel: 'error',
  });
  return {
    viewerHtml: await readFile(path.join(root, 'src/phone/viewer.html'), 'utf8'),
    viewerJs: out.outputFiles[0].text,
  };
}

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--host') (opts.host = v), i++;
    else if (a === '--port') (opts.port = Number(v)), i++;
    else if (a === '--pub-port') (opts.pubPort = Number(v)), i++;
    else if (a === '--extension-id') (opts.extensionId = v), i++;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}
