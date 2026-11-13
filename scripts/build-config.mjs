// Build flags shared by scripts/build.mjs and tests/audio-dump.test.ts.
//   --latency-probe: dev-only capture-latency probe build into dist-probe/ (docs/latency-probe.md).
//   --audio-dump:    dev-only audio dump build into dist-dump/ (docs/recognition-replay.md).
// The default build defines both flags false and adds no plugin, so dist/ is byte-identical to a
// build without these flags (the dump hooks are not even bundled: see audioDumpPlugin).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export function buildFlags(argv) {
  const probe = argv.includes('--latency-probe');
  const dump = argv.includes('--audio-dump');
  if (probe && dump) throw new Error('--latency-probe and --audio-dump are separate builds: pass one');
  return { probe, dump, watch: argv.includes('--watch'), outDir: probe ? 'dist-probe' : dump ? 'dist-dump' : 'dist' };
}

/** Commit and packaged model hashes recorded in every capture of the dump build. */
export function audioDumpInfo(root) {
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  let commit = 'unknown';
  let dirty = true;
  try {
    commit = git('rev-parse', 'HEAD');
    dirty = git('status', '--porcelain', '--untracked-files=no').length > 0;
  } catch {
    // Not a git checkout: recorded as unknown and dirty.
  }
  const manifest = JSON.parse(readFileSync(path.join(root, 'scripts/models.manifest.json'), 'utf8'));
  const models = Object.fromEntries(manifest.files.filter((m) => m.packaged).map((m) => [m.file, m.sha256]));
  return { commit, dirty, models };
}

/** esbuild `define` for a build; info is audioDumpInfo() in the dump build. */
export function buildDefine(flags, info = null) {
  return {
    'import.meta.url': '"chrome-extension://vibe-guitar/"',
    __LATENCY_PROBE__: flags.probe ? 'true' : 'false',
    __AUDIO_DUMP__: flags.dump ? 'true' : 'false',
    __AUDIO_DUMP_INFO__: flags.dump ? JSON.stringify(info) : 'null',
  };
}

/** Imports of listen.ts that the dump build swaps for the hook modules in src/extension/dump. */
export const AUDIO_DUMP_SWAPS = {
  '../../recognize/session': 'src/extension/dump/session-hook.ts',
  '../../recognize/autochart': 'src/extension/dump/autochart-hook.ts',
};

/** Redirects only listen.ts's two imports; every other importer gets the real modules. */
export function audioDumpPlugin(root) {
  const listen = path.join(root, 'src/extension/offscreen/listen.ts');
  return {
    name: 'audio-dump-hooks',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/\.\.\/recognize\/(session|autochart)$/ }, (args) => {
        if (path.resolve(args.importer) !== listen) return undefined;
        return { path: path.join(root, AUDIO_DUMP_SWAPS[args.path]) };
      });
    },
  };
}
