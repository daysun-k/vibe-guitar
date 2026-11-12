// Turns accuracy overview exports ("결과 내보내기" JSON files) into one self-contained HTML report.
//   npm run accuracy-report -- <export.json> [more.json ...] [--out <file.html>]
// Default output: <first input without .json>-report.html next to the first input. Prints the path.
// Bundles src/eval/report.ts in memory with esbuild; reads and writes local files only (no network).
import * as esbuild from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = '사용법: npm run accuracy-report -- <내보낸 파일.json> [다른 파일.json ...] [--out <보고서.html>]';

function parseArgs(argv) {
  const inputs = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--out' || a === '-o') {
      out = argv[++i];
      if (!out) throw new Error('--out 뒤에 저장할 파일 이름을 적어 주세요.');
    } else if (a.startsWith('--out=')) out = a.slice('--out='.length);
    else if (a.startsWith('-')) throw new Error(`알 수 없는 옵션: ${a}`);
    else inputs.push(a);
  }
  return { inputs, out };
}

async function loadReport() {
  const built = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['src/eval/report.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

export function defaultOutPath(firstInput) {
  const abs = path.resolve(firstInput);
  return path.join(path.dirname(abs), `${path.basename(abs).replace(/\.json$/i, '')}-report.html`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (!args.inputs.length) throw new Error(`입력 파일이 없어요.\n${USAGE}`);
  const report = await loadReport();
  const exports = [];
  for (const file of args.inputs) {
    const name = path.basename(file);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (e) {
      throw new Error(`${file}: 파일을 읽을 수 없어요 (${e.code ?? e.message}).`);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`${name}: JSON 파일이 아니에요. 정확도 모아 보기의 "결과 내보내기"로 받은 파일을 넣어 주세요.`);
    }
    exports.push(report.parseAccuracyExport(value, name));
  }
  const merged = report.mergeExports(exports);
  const html = report.renderAccuracyReport(merged, { generatedAt: new Date() });
  const out = path.resolve(args.out ?? defaultOutPath(args.inputs[0]));
  await writeFile(out, html, 'utf8');
  console.log(out);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
