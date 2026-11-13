// Statistics of a latency-probe result file (Linear VGT-7; docs/latency-probe.md).
//   npm run latency-report -- <latency-probe-….json> [--json]
// Matches placed clicks to source clicks, fits the correction on half of the clicks,
// validates on the other half, and prints the suggested CAPTURE_LATENCY_SEC.
// Bundles src/probe/latency.ts in memory with esbuild; reads one local file (no network).
import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = '사용법: npm run latency-report -- <측정 결과.json> [--json]';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const asJson = args.includes('--json');
  const inputs = args.filter((a) => !a.startsWith('-'));
  if (inputs.length !== 1) throw new Error(`결과 파일 하나를 적어 주세요.\n${USAGE}`);
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/probe/latency.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  const lib = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  let dump;
  try {
    dump = JSON.parse(await readFile(inputs[0], 'utf8'));
  } catch (e) {
    throw new Error(`${inputs[0]}: 읽을 수 없거나 JSON이 아닙니다 (${e.code ?? e.message})`);
  }
  if (dump?.tool !== 'vibe-guitar latency probe') throw new Error(`${inputs[0]}: 지연 측정 페이지에서 받은 결과 파일이 아닙니다`);
  const report = lib.analyzeProbeDump(dump);
  console.log(asJson ? JSON.stringify(report, null, 2) : lib.formatProbeReport(report));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
