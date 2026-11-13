// Scores exported auto charts against public, time-aligned chord annotations and writes a JSON
// result plus a self-contained Korean HTML report.
//   npm run eval-annotations -- --annotations <dir> --charts <dir> [--songs <list.json>] [--out <prefix>] [--label <text>]
// <annotations>: one folder per dataset (the list's datasets[].folder) holding the extracted archive.
// <charts>: uploads.json ({ songId: { youtubeId, durationSec, channel, uploadTitle } }) and one
//   <youtubeId>.json per song (the stored auto chart, the value of autochart:youtube:<id>).
// Default song list: docs/annotation-eval-songs.json. Default output: <charts>/annotation-eval.{json,html}.
// Bundles src/eval/annotations.ts and annotation-report.ts in memory with esbuild; reads and writes
// local files only (no network). --label stores a free-text label in the result (`label`) and shows
// it as a banner at the top of the HTML (e.g. a post-result re-analysis).
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  '사용법: npm run eval-annotations -- --annotations <주석 폴더> --charts <자동 코드표 폴더> [--songs <곡 목록.json>] [--out <결과 경로 앞부분>] [--label <결과에 붙일 표시>]';

export function parseArgs(argv) {
  const out = { songs: path.join(root, 'docs/annotation-eval-songs.json') };
  const keys = { '--annotations': 'annotations', '--charts': 'charts', '--songs': 'songs', '--out': 'out', '--label': 'label' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const eq = a.indexOf('=');
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const key = keys[flag];
    if (!key) throw new Error(`알 수 없는 인자: ${a}\n${USAGE}`);
    const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (!value) throw new Error(`${flag} 뒤에 경로를 적어 주세요.`);
    out[key] = value;
  }
  if (!out.annotations || !out.charts) throw new Error(`--annotations와 --charts가 필요해요.\n${USAGE}`);
  return out;
}

async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: "export * from './src/eval/annotations.ts'; export { renderAnnotationReport } from './src/eval/annotation-report.ts';",
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
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${what}: ${file}을(를) 읽을 수 없어요 (${e.code ?? e.message}).`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: ${file}은(는) JSON 파일이 아니에요.`);
  }
}

/** Resolves rel inside base; null when it would leave base. */
function inside(base, ...rel) {
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel);
  return p === b || p.startsWith(b + path.sep) ? p : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  const listText = readFileSync(args.songs, 'utf8');
  const list = m.parseSongList(readJson(args.songs, '곡 목록'));
  const sha256 = createHash('sha256').update(listText).digest('hex');
  const uploadsFile = path.join(args.charts, 'uploads.json');
  const uploads = existsSync(uploadsFile) ? m.parseUploads(readJson(uploadsFile, 'uploads.json')) : {};
  const io = {
    readAnnotation(folder, rel) {
      const p = inside(args.annotations, folder, rel);
      return p && existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
    readChart(id) {
      const p = inside(args.charts, `${id}.json`);
      return p && existsSync(p) ? readJson(p, '자동 코드표') : null;
    },
  };
  const result = m.evaluateSongs(list, uploads, io, { sha256 });
  if (args.label) result.label = args.label;
  const prefix = path.resolve(args.out ?? path.join(args.charts, 'annotation-eval'));
  await writeFile(`${prefix}.json`, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeFile(`${prefix}.html`, m.renderAnnotationReport(result), 'utf8');
  const count = (s) => result.songs.filter((r) => r.status === s).length;
  console.log(`${prefix}.json`);
  console.log(`${prefix}.html`);
  console.log(`채점 ${count('scored')} · 제외 ${count('excluded')} · 아직 없음 ${count('missing')} · 오류 ${count('error')} (시범 곡 포함 ${result.songs.length}곡)`);
  for (const r of result.songs.filter((x) => x.status === 'error')) console.log(`오류: ${r.id}: ${r.reason}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e.message ?? e);
      process.exit(1);
    },
  );
}
