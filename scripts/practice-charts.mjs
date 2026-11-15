// Builds ready-to-play practice charts for exact YouTube uploads from public human chord annotations
// and the frozen time maps in docs/recognition-dev-maps.json (media = offsetSec + rate x annotation time).
//   npm run practice-charts -- [--out <dir>] [--annotations <dir>] [--captures <dir>] [--maps <file>] [--allow-weak] <youtubeId|songId> ...
// Defaults: --out ~/vibe-guitar-audio/practice-charts, --annotations ~/vibe-guitar-audio/annotations/data,
// --captures ~/vibe-guitar-audio/captures, --maps docs/recognition-dev-maps.json.
// Per song it writes <out>/<youtubeId>.json (the chart, importable in the side panel) and
// <out>/<youtubeId>.provenance.json (sources, time map, grid, timing check, agreement with the
// annotation, label mapping). Chords come from the annotation only; the bar grid from the
// annotation's beat file (beats with bar positions), or without one from the tracker beat grid
// stored with the upload's capture. A song whose map is not "strong" (fitted to chord boundaries,
// so it can be a whole beat off) is refused unless --allow-weak. Local files only (no network).
import * as esbuild from 'esbuild';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = os.homedir();
const TOOL = 'scripts/practice-charts.mjs';

const USAGE =
  '사용법: npm run practice-charts -- [--out <폴더>] [--annotations <주석 폴더>] [--captures <캡처 폴더>] [--maps <시간 매핑.json>] [--allow-weak] <youtubeId 또는 곡 id> ...';

export function parseArgs(argv) {
  const out = {
    out: path.join(home, 'vibe-guitar-audio/practice-charts'),
    annotations: path.join(home, 'vibe-guitar-audio/annotations/data'),
    captures: path.join(home, 'vibe-guitar-audio/captures'),
    maps: path.join(root, 'docs/recognition-dev-maps.json'),
    allowWeak: false,
    songs: [],
  };
  const keys = { '--out': 'out', '--annotations': 'annotations', '--captures': 'captures', '--maps': 'maps' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--allow-weak') {
      out.allowWeak = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const flag = eq > 0 ? a.slice(0, eq) : a;
      const key = keys[flag];
      if (!key) throw new Error(`알 수 없는 인자: ${a}\n${USAGE}`);
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i];
      if (!value) throw new Error(`${flag} 뒤에 경로를 적어 주세요.`);
      out[key] = value;
      continue;
    }
    out.songs.push(a);
  }
  if (!out.songs.length) throw new Error(`만들 곡의 youtubeId나 곡 id를 적어 주세요.\n${USAGE}`);
  return out;
}

async function loadModules() {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: [
        "export * from './src/eval/practice-chart.ts';",
        "export { parseLab, parseBeats } from './src/eval/annotations.ts';",
        "export { validateChart } from './src/chart/validate.ts';",
        "export { prepareChart } from './src/play/prepare.ts';",
      ].join('\n'),
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

/** Resolves rel inside base; throws when it would leave base. */
function inside(base, ...rel) {
  const b = path.resolve(base);
  const p = path.resolve(b, ...rel);
  if (p !== b && !p.startsWith(b + path.sep)) throw new Error(`${rel.join('/')}: 주석 폴더 밖의 경로예요.`);
  return p;
}

/** The newest capture of the upload that stored an auto chart with a beat grid, or null. */
function latestCapture(capturesDir, youtubeId) {
  const dir = path.join(capturesDir, youtubeId);
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(youtubeId) || !existsSync(dir)) return null;
  const sessions = readdirSync(dir)
    .filter((d) => existsSync(path.join(dir, d, 'meta.json')))
    .sort()
    .reverse();
  for (const s of sessions) {
    const file = path.join(dir, s, 'meta.json');
    const meta = readJson(file, '캡처 정보');
    const t = meta?.chart?.timing;
    if (t && Array.isArray(t.beatTimes) && t.beatTimes.length >= 8) return { file, timing: t, durationSec: meta.durationSec ?? null };
  }
  return null;
}

const pct = (x) => `${(100 * x).toFixed(2)}%`;

function buildOne(m, args, maps, key) {
  const entry = maps.songs.find((s) => s.youtubeId === key || s.id === key);
  if (!entry) throw new Error(`${key}: ${args.maps}에 없는 곡이에요.`);
  const list = readJson(path.resolve(root, entry.songList), '곡 목록');
  const song = list.songs.find((s) => s.id === entry.id);
  if (!song) throw new Error(`${entry.id}: ${entry.songList}에 없는 곡이에요.`);
  const dataset = list.datasets[song.dataset];
  if (entry.alignStrength !== 'strong' && !args.allowWeak) {
    throw new Error(
      `${entry.id} (${entry.youtubeId}): 시간 매핑이 '${entry.alignStrength}'(${entry.alignMethod})예요. 코드 경계만으로 맞춘 매핑은 한 박 단위로 어긋날 수 있어서 만들지 않았어요 (--allow-weak로 강제할 수 있어요).`,
    );
  }
  const map = { offsetSec: entry.offsetSec, rate: entry.rate };
  const labFile = inside(args.annotations, dataset.folder, song.chords);
  const segs = m.parseLab(readFileSync(labFile, 'utf8'));
  const capture = latestCapture(args.captures, entry.youtubeId);

  let grid;
  let gridSource;
  if (song.beats) {
    const beatFile = inside(args.annotations, dataset.folder, song.beats);
    grid = m.practiceGrid(m.parseBeats(readFileSync(beatFile, 'utf8')), map);
    gridSource = { kind: 'annotation-beats', file: `${dataset.folder}/${song.beats}` };
  } else if (capture) {
    const t = capture.timing;
    grid = { timing: { bpm: t.bpm, beatsPerBar: t.beatsPerBar, beatUnit: t.beatUnit ?? 4, firstDownbeatSec: t.firstDownbeatSec, beatTimes: t.beatTimes, ...(t.feel ? { feel: t.feel } : {}) }, irregularBars: [], droppedLeadBeats: 0 };
    gridSource = { kind: 'tracker-capture', file: path.relative(home, capture.file) };
  } else {
    throw new Error(`${entry.id}: 박자 파일도 저장된 캡처도 없어서 마디 격자를 만들 수 없어요.`);
  }

  const check = capture ? m.gridCheck(grid.timing.beatTimes, capture.timing.beatTimes) : null;
  const gridText =
    gridSource.kind === 'annotation-beats'
      ? `Bars: annotated beats and downbeats (${song.beats}) through the same map${grid.irregularBars.length ? `; ${grid.irregularBars.length} bar(s) of another length spread evenly to the next downbeat` : ''}.`
      : 'Bars: beat grid the app tracked in this upload (stored capture); the bar phase may be off, the play view re-aligns it to chord changes.';
  const confidence =
    entry.alignStrength === 'strong'
      ? `Timing confidence: high. Chord and beat times are the annotators'; the map was fitted to the beats tracked in this upload (beats alignment, tolerance 0.07 s)${check ? `; grid vs beats tracked in the newest stored capture: median ${check.medianAbsSec.toFixed(3)} s, ${pct(check.within70ms)} within 0.07 s (captures of one upload differ by a few hundredths of a second)` : ''}.`
      : 'Timing confidence: LOW. The map was fitted to chord boundaries only and can be a whole beat off.';
  const note = [
    `Practice chart (VGT-5) from a human annotation: ${dataset.name}, ${song.chords}.`,
    `Times: media = ${map.offsetSec.toFixed(4)} + ${map.rate.toFixed(6)} x annotation time (docs/recognition-dev-maps.json, ${entry.alignMethod} alignment, ${entry.alignStrength}).`,
    gridText,
    confidence,
    'Chords as annotated (Harte labels mapped to chart symbols); X (unknown) shown as no chord.',
  ].join(' ');
  const recording = { source: 'youtube', id: entry.youtubeId, title: song.title, artist: song.artist };
  const { chart, labels } = m.buildPracticeChart({ segs, map, mediaDurationSec: entry.mediaDurationSec, recording, timing: grid.timing, createdAt: new Date().toISOString(), tool: TOOL, note });

  const v = m.validateChart(JSON.parse(JSON.stringify(chart)));
  if (!v.ok) throw new Error(`${entry.id}: 형식 오류: ${v.errors.slice(0, 5).join('; ')}`);
  const prepared = m.prepareChart(chart);
  const agreement = m.practiceAgreement(chart, segs, map);
  const sidecar = {
    schema: 'vibe-guitar-practice-chart-provenance/1',
    song: { id: entry.id, artist: song.artist, title: song.title, release: song.release, youtubeId: entry.youtubeId },
    chords: { dataset: dataset.name, file: `${dataset.folder}/${song.chords}`, page: dataset.page, attribution: dataset.attribution, licence: dataset.licence },
    timeMap: { offsetSec: map.offsetSec, rate: map.rate, alignMethod: entry.alignMethod, alignStrength: entry.alignStrength, mediaDurationSec: entry.mediaDurationSec, from: 'docs/recognition-dev-maps.json' },
    grid: { ...gridSource, beatsPerBar: grid.timing.beatsPerBar, bpm: grid.timing.bpm, beats: grid.timing.beatTimes.length, firstDownbeatSec: grid.timing.firstDownbeatSec, irregularBars: grid.irregularBars, droppedLeadBeats: grid.droppedLeadBeats },
    timingCheck: check ? { against: path.relative(home, capture.file), ...check } : null,
    playView: { barPhaseShifted: prepared.phaseShifted, phase: prepared.phase, key: prepared.key ? { tonic: prepared.key.tonic, mode: prepared.key.mode } : null },
    validator: { ok: v.ok, warnings: v.warnings },
    agreement,
    labels,
    events: chart.events.length,
    coverage: chart.coverage,
  };
  return { entry, chart, sidecar };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const m = await loadModules();
  const maps = readJson(args.maps, '시간 매핑');
  mkdirSync(args.out, { recursive: true });
  let failed = 0;
  for (const key of args.songs) {
    try {
      const { entry, chart, sidecar } = buildOne(m, args, maps, key);
      const file = path.join(args.out, `${entry.youtubeId}.json`);
      await writeFile(file, `${JSON.stringify(chart, null, 2)}\n`, 'utf8');
      await writeFile(path.join(args.out, `${entry.youtubeId}.provenance.json`), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');
      const a = sidecar.agreement;
      const simplified = sidecar.labels
        .filter((l) => l.kind !== 'exact')
        .map((l) => {
          const notes = l.notes ? ` (더한 음 ${l.notes.added.join(' ') || '없음'}, 뺀 음 ${l.notes.dropped.join(' ') || '없음'})` : ' (코드 없음으로 표시)';
          return `${l.label}→${l.chord}${notes} ${l.sec.toFixed(1)}초`;
        });
      console.log(
        `${file}: ${chart.events.length}개 코드, ${chart.timing.beatsPerBar}/4 ${chart.timing.bpm} bpm, 주석 일치 ${pct(a.exact)} (${a.evaluatedSec.toFixed(1)}초), ` +
          `박자 대조 ${sidecar.timingCheck ? `중앙값 ${sidecar.timingCheck.medianAbsSec.toFixed(3)}초 · 0.07초 안 ${pct(sidecar.timingCheck.within70ms)}` : '없음'}, ` +
          `마디 위상 이동 ${sidecar.playView.barPhaseShifted ? '있음' : '없음'}, 불규칙 마디 ${sidecar.grid.irregularBars.length}, ` +
          `단순화 ${simplified.length ? simplified.join(', ') : '없음'}`,
      );
    } catch (e) {
      failed++;
      console.error(`실패: ${e.message ?? e}`);
    }
  }
  return failed ? 1 : 0;
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
