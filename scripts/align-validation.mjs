// Predeclared validation of the chance-level screen (VGT-7, PR #32). Compares the alignment at main
// 389dd75 (old) with the working tree (new) and writes one JSON receipt.
//   node scripts/align-validation.mjs --beatles <isophonics-the-beatles dir> --annotations <annotation root>
//     --charts <auto chart dir> --songs <song list.json> --out <receipt.json> [--datasets 1000]
// N1-N4: null scenarios (landmarks unrelated to the beat grid), screen at a fixed map and at the
//   searched map, full pipeline acceptance, one-sided 95% Clopper-Pearson upper bounds.
// V1: Isophonics Beatles chord changes against the annotated beats under a known map (base,
//   doubled, halved tempo); correctness = max |estimated map - true map| <= 0.1 s over the span.
// V2: song A's chord changes against song B's annotated beats (sorted ids, duration check off).
// V3: the Beatles songs of the song list with real auto charts, weak and strong alignment.
// Never uses chord predictions: auto charts give only their beat times, first downbeat and bar
// length. Fixed seeds (mulberry32). Reads local files only and commits no data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_REF = '389dd75';
const USAGE =
  'usage: node scripts/align-validation.mjs --beatles <isophonics-the-beatles dir> --annotations <annotation root> --charts <auto chart dir> --songs <song list.json> --out <receipt.json> [--datasets 1000]';

function parseArgs(argv) {
  const out = { datasets: 1000 };
  const keys = { '--beatles': 'beatles', '--annotations': 'annotations', '--charts': 'charts', '--songs': 'songs', '--out': 'out', '--datasets': 'datasets' };
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    out[key] = key === 'datasets' ? Number(argv[++i]) : argv[++i];
  }
  for (const k of ['beatles', 'annotations', 'charts', 'songs', 'out']) if (!out[k]) throw new Error(`missing --${k}\n${USAGE}`);
  if (!(Number.isInteger(out.datasets) && out.datasets > 0)) throw new Error('--datasets must be a positive integer');
  return out;
}

async function bundle(stdinContents) {
  const built = await esbuild.build({
    absWorkingDir: root,
    stdin: { contents: stdinContents, resolveDir: path.join(root, 'src/eval'), loader: 'ts', sourcefile: 'annotations.ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    write: false,
    logLevel: 'error',
  });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
}

const sha = (text) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------- random numbers

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r) {
  const u = Math.max(r(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

const intIn = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------- statistics

/** One-sided 95% Clopper-Pearson upper bound for x successes in n trials. */
function cpUpper(x, n, tail, conf = 0.95) {
  if (x >= n) return 1;
  const cdf = (p) => 1 - tail(n, x + 1, p);
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) > 1 - conf) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- N: null scenarios

const NULL_SEEDS = { N1: 101, N2: 202, N3: 303, N4: 404 };
const FIXED_MAP = { offsetSec: 0, rate: 1 };
const CB_TOL = 0.1;

function nullDataset(name, r) {
  const D = 150 + 150 * r();
  const P = 0.35 + 0.45 * r();
  const beats = [];
  if (name === 'N4') {
    const T = 30 + 60 * r();
    const phi = 2 * Math.PI * r();
    for (let t = P * r(); t < D; t += P * (1 + 0.03 * Math.sin((2 * Math.PI * t) / T + phi))) beats.push(t + 0.01 * gauss(r));
  } else for (let t = P * r(); t < D; t += P) beats.push(t + 0.01 * gauss(r));
  let landmarks = [];
  if (name === 'N2') {
    const u = r() * 0.65;
    const ratio = u < 0.25 ? 0.7 + u : 1.05 + (u - 0.25);
    const Q = P / ratio;
    for (let t = Q * r() + Q * intIn(r, 0, 3); t < D - 1; t += Q * intIn(r, 2, 8)) landmarks.push(t);
  } else if (name === 'N3') {
    const n = intIn(r, 12, 120);
    const centers = Array.from({ length: intIn(r, 3, 8) }, () => 10 + (D - 20) * r());
    for (let i = 0; i < n; i++) landmarks.push(Math.min(D - 2, Math.max(2, centers[Math.floor(r() * centers.length)] + 3 * gauss(r))));
  } else {
    const n = intIn(r, 12, 120);
    for (let i = 0; i < n; i++) landmarks.push(2 + (D - 4) * r());
  }
  landmarks.sort((a, b) => a - b);
  beats.sort((a, b) => a - b);
  return {
    input: {
      method: 'chord-boundaries',
      landmarks,
      downbeatLandmarks: landmarks,
      annotationDurationSec: D,
      chordSpan: { fromSec: landmarks[0], toSec: landmarks[landmarks.length - 1] },
      estimateBeats: beats,
      estimateFirstDownbeatSec: beats[0],
      estimateBeatsPerBar: 4,
      mediaDurationSec: D,
    },
    period: P,
  };
}

function runNull(name, count, oldM, newM) {
  const r = mulberry32(NULL_SEEDS[name]);
  const c = { datasets: count, fewerThan12: 0, fixedScreen: 0, searchedScreen: 0, newPipeline: 0, oldPipeline: 0, mapDiffers: 0 };
  for (let i = 0; i < count; i++) {
    const { input } = nullDataset(name, r);
    if (input.landmarks.length < 12) c.fewerThan12++;
    const o = oldM.alignAnnotation(input);
    const n = newM.alignAnnotation(input);
    if (Math.abs(o.offsetSec - n.offsetSec) > 1e-12 || Math.abs(o.rate - n.rate) > 1e-15) c.mapDiffers++;
    if (newM.chanceScreen(input.landmarks, input.estimateBeats, FIXED_MAP.offsetSec, FIXED_MAP.rate, CB_TOL).passed) c.fixedScreen++;
    if (n.chance?.passed) c.searchedScreen++;
    if (n.excluded === null) c.newPipeline++;
    if (o.excluded === null) c.oldPipeline++;
  }
  const tail = newM.binomialUpperTail;
  const ub = (x) => cpUpper(x, count, tail);
  return {
    ...c,
    rates: { fixedScreen: c.fixedScreen / count, searchedScreen: c.searchedScreen / count, newPipeline: c.newPipeline / count, oldPipeline: c.oldPipeline / count },
    upper95: { fixedScreen: ub(c.fixedScreen), searchedScreen: ub(c.searchedScreen), newPipeline: ub(c.newPipeline), oldPipeline: ub(c.oldPipeline) },
    meetsRequirement: ub(c.searchedScreen) <= 0.05 && ub(c.newPipeline) <= 0.05,
  };
}

// ---------------------------------------------------------------- Beatles songs

function walk(dir, ext, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, base, out);
    else if (name.endsWith(ext)) out.push(path.relative(base, p).slice(0, -ext.length));
  }
  return out;
}

function loadBeatles(dir, m) {
  const beatIds = walk(path.join(dir, 'beat'), '.txt');
  const chordIds = new Set(walk(path.join(dir, 'chordlab'), '.lab'));
  const counts = { beatFiles: beatIds.length, chordFiles: chordIds.size, withBoth: 0, fewerThan12Changes: 0, used: 0 };
  const songs = [];
  for (const id of beatIds.sort()) {
    if (!chordIds.has(id)) continue;
    counts.withBoth++;
    const segs = m.parseLab(readFileSync(path.join(dir, 'chordlab', `${id}.lab`), 'utf8'));
    const beats = m.parseBeats(readFileSync(path.join(dir, 'beat', `${id}.txt`), 'utf8'));
    const changes = m.chordChangeLandmarks(segs);
    if (changes.length < 12) {
      counts.fewerThan12Changes++;
      continue;
    }
    const times = beats.map((b) => b.sec);
    songs.push({ id, segs, beats, changes, duration: m.labDuration(segs), span: m.chordSpan(segs), period: median(times.slice(1).map((t, i) => t - times[i])) });
  }
  counts.used = songs.length;
  return { songs, counts };
}

/** Median number of grid beats between consecutive downbeats (null without two downbeats). */
function barLength(grid, downbeats) {
  if (downbeats.length < 2) return null;
  const n = [];
  for (let i = 0; i + 1 < downbeats.length; i++) n.push(grid.filter((t) => t >= downbeats[i] - 1e-9 && t < downbeats[i + 1] - 1e-9).length);
  const b = Math.round(median(n));
  return b >= 2 ? b : null;
}

/** Max |a(t) - b(t)| over [from, to] for two linear maps (attained at an end). */
const mapError = (a, b, from, to) => Math.max(...[from, to].map((t) => Math.abs(a.offsetSec + a.rate * t - (b.offsetSec + b.rate * t))));

const VARIANTS = ['base', 'doubled', 'halved'];

function runV1(songs, oldM, newM) {
  const rows = [];
  songs.forEach((s, si) => {
    VARIANTS.forEach((variant, vi) => {
      const r = mulberry32(5000 + si * 3 + vi);
      const u = -1.5 + 3 * r();
      const mapped = s.beats.map((b) => b.sec + u);
      let gridTimes = mapped;
      if (variant === 'doubled') {
        gridTimes = [];
        mapped.forEach((t, i) => {
          gridTimes.push(t);
          if (i + 1 < mapped.length) gridTimes.push((t + mapped[i + 1]) / 2);
        });
      } else if (variant === 'halved') gridTimes = mapped.filter((_, k) => k % 2 === 0);
      const est = [];
      for (const t of gridTimes) {
        const j = t + 0.02 * gauss(r);
        if (r() >= 0.02 && j >= 0) est.push(j);
      }
      est.sort((a, b) => a - b);
      const downs = s.beats.filter((b) => b.position === 1).map((b) => b.sec + u).filter((t) => t >= 0);
      const input = {
        method: 'chord-boundaries',
        landmarks: s.changes,
        downbeatLandmarks: s.changes,
        annotationDurationSec: s.duration,
        chordSpan: s.span,
        estimateBeats: est,
        estimateFirstDownbeatSec: downs.length ? downs[0] : null,
        estimateBeatsPerBar: barLength(gridTimes, downs),
        mediaDurationSec: s.duration,
      };
      const truth = { offsetSec: u, rate: 1 };
      const first = s.changes[0];
      const last = s.changes[s.changes.length - 1];
      const judge = (a) => ({ accepted: a.excluded === null, code: a.excluded?.code ?? null, correct: mapError(a, truth, first, last) <= 0.1 + 1e-9, offsetSec: a.offsetSec, rate: a.rate });
      const o = oldM.alignAnnotation(input);
      const n = newM.alignAnnotation(input);
      const failing = n.chance ? n.chance.windows.filter((w) => !w.passed).map((w) => `${w.part} ${w.matched}/${w.landmarks} c${w.chance.toFixed(2)} p${w.p.toPrecision(2)}${w.insufficient ? ' insufficient' : ''}`) : [];
      rows.push({ id: s.id, variant, trueOffsetSec: u, old: judge(o), new: { ...judge(n), screenPassed: n.chance?.passed ?? null, failingWindows: failing } });
    });
  });
  const transitions = {};
  for (const v of VARIANTS) {
    const t = { oldAcceptCorrect_newAccept: 0, oldAcceptCorrect_newReject: 0, oldAcceptWrong_newAccept: 0, oldAcceptWrong_newReject: 0, oldReject_newAccept: 0, oldReject_newReject: 0 };
    for (const x of rows.filter((y) => y.variant === v)) {
      const key = x.old.accepted ? `oldAccept${x.old.correct ? 'Correct' : 'Wrong'}_new${x.new.accepted ? 'Accept' : 'Reject'}` : `oldReject_new${x.new.accepted ? 'Accept' : 'Reject'}`;
      t[key]++;
    }
    transitions[v] = t;
  }
  const regressions = rows.filter((x) => x.old.accepted && x.old.correct && !x.new.accepted);
  return { rows, transitions, regressions: regressions.map((x) => ({ id: x.id, variant: x.variant, newCode: x.new.code, failingWindows: x.new.failingWindows })) };
}

function runV2(songs, oldM, newM) {
  const rows = [];
  for (let i = 0; i < songs.length; i++) {
    const a = songs[i];
    const b = songs[(i + 1) % songs.length];
    const est = b.beats.map((x) => x.sec);
    const downs = b.beats.filter((x) => x.position === 1).map((x) => x.sec);
    const input = {
      method: 'chord-boundaries',
      landmarks: a.changes,
      downbeatLandmarks: a.changes,
      annotationDurationSec: a.duration,
      chordSpan: a.span,
      estimateBeats: est,
      estimateFirstDownbeatSec: downs.length ? downs[0] : null,
      estimateBeatsPerBar: barLength(est, downs),
      mediaDurationSec: null,
    };
    const o = oldM.alignAnnotation(input);
    const n = newM.alignAnnotation(input);
    rows.push({ a: a.id, b: b.id, tempoMatched: Math.abs(a.period / b.period - 1) <= 0.03, old: o.excluded?.code ?? 'accepted', new: n.excluded?.code ?? 'accepted' });
  }
  const tally = (xs) => ({ pairs: xs.length, oldAccepted: xs.filter((x) => x.old === 'accepted').length, newAccepted: xs.filter((x) => x.new === 'accepted').length });
  return { rows, all: tally(rows), tempoMatched: tally(rows.filter((x) => x.tempoMatched)), notTempoMatched: tally(rows.filter((x) => !x.tempoMatched)) };
}

function runV3(args, oldM, newM) {
  const list = newM.parseSongList(JSON.parse(readFileSync(args.songs, 'utf8')));
  const uploads = newM.parseUploads(JSON.parse(readFileSync(path.join(args.charts, 'uploads.json'), 'utf8')));
  const rows = [];
  for (const song of list.songs.filter((s) => s.dataset === 'isophonics-the-beatles' && s.beats)) {
    const folder = list.datasets[song.dataset].folder;
    const up = uploads[song.id];
    const chartFile = up ? path.join(args.charts, `${up.youtubeId}.json`) : null;
    if (!up || !existsSync(chartFile)) {
      rows.push({ id: song.id, missing: true });
      continue;
    }
    const chart = newM.chartFromExport(JSON.parse(readFileSync(chartFile, 'utf8')));
    const segs = newM.parseLab(readFileSync(path.join(args.annotations, folder, song.chords), 'utf8'));
    const beats = newM.parseBeats(readFileSync(path.join(args.annotations, folder, song.beats), 'utf8'));
    const coverageEnd = chart.coverage.length ? Math.max(...chart.coverage.map((c) => c.toSec)) : null;
    const changes = newM.chordChangeLandmarks(segs);
    const common = {
      annotationDurationSec: newM.labDuration(segs),
      chordSpan: newM.chordSpan(segs),
      estimateBeats: chart.timing.beatTimes ?? [],
      estimateFirstDownbeatSec: Number.isFinite(chart.timing.firstDownbeatSec) ? chart.timing.firstDownbeatSec : null,
      estimateBeatsPerBar: chart.timing.beatsPerBar ?? null,
      mediaDurationSec: up.durationSec ?? coverageEnd,
    };
    const strongIn = { ...common, method: 'beats', landmarks: beats.map((b) => b.sec), downbeatLandmarks: beats.filter((b) => b.position === 1).map((b) => b.sec) };
    const weakIn = { ...common, method: 'chord-boundaries', landmarks: changes, downbeatLandmarks: changes };
    const brief = (a) => ({ accepted: a.excluded === null, code: a.excluded?.code ?? null, offsetSec: a.offsetSec, rate: a.rate, screenPassed: a.chance ? a.chance.passed : undefined });
    const so = oldM.alignAnnotation(strongIn);
    const sn = newM.alignAnnotation(strongIn);
    const wo = oldM.alignAnnotation(weakIn);
    const wn = newM.alignAnnotation(weakIn);
    const agreeSec = mapError(wo, so, changes[0], changes[changes.length - 1]);
    const failing = (a) => (a.chance ? a.chance.windows.filter((w) => !w.passed).map((w) => `${w.part} ${w.matched}/${w.landmarks} c${w.chance.toFixed(2)} p${w.p.toPrecision(2)}`) : []);
    rows.push({
      id: song.id,
      strong: { old: brief(so), new: { ...brief(sn), failingWindows: failing(sn) } },
      weak: { old: brief(wo), new: { ...brief(wn), failingWindows: failing(wn) } },
      weakStrongMaxDiffSec: agreeSec,
      weakAgreesWithOldStrong: so.excluded === null && agreeSec <= 0.1 + 1e-9,
    });
  }
  const stops = [];
  for (const x of rows.filter((y) => !y.missing)) {
    if (x.strong.old.accepted && !x.strong.new.accepted) stops.push(`${x.id}: old-accepted strong alignment rejected (${x.strong.new.code})`);
    if (x.weak.old.accepted && x.weakAgreesWithOldStrong && !x.weak.new.accepted) stops.push(`${x.id}: old-accepted weak map agreeing with the old-accepted strong map rejected (${x.weak.new.code})`);
  }
  return { rows, stops };
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const oldText = execFileSync('git', ['show', `${OLD_REF}:src/eval/annotations.ts`], { cwd: root, encoding: 'utf8' });
  const newText = readFileSync(path.join(root, 'src/eval/annotations.ts'), 'utf8');
  const deps = ['src/eval/metrics.ts', 'src/eval/song-mean.ts', 'src/arrange', 'src/chart'];
  let depsUnchanged = true;
  try {
    execFileSync('git', ['diff', '--quiet', OLD_REF, '--', ...deps], { cwd: root });
  } catch {
    depsUnchanged = false;
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts/align-validation.mjs'], { cwd: root, encoding: 'utf8' }).trim() !== '';
  const oldM = await bundle(oldText);
  const newM = await bundle(newText);
  const started = Date.now();

  const nulls = {};
  for (const name of Object.keys(NULL_SEEDS)) {
    nulls[name] = runNull(name, args.datasets, oldM, newM);
    console.error(`${name} done (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  const { songs, counts } = loadBeatles(args.beatles, newM);
  const v1 = runV1(songs, oldM, newM);
  console.error(`V1 done (${Math.round((Date.now() - started) / 1000)} s)`);
  const v2 = runV2(songs, oldM, newM);
  const v3 = runV3(args, oldM, newM);

  const stop = {
    nullScenarios: Object.entries(nulls).filter(([, s]) => !s.meetsRequirement).map(([k, s]) => `${k}: searched-map screen upper bound ${s.upper95.searchedScreen.toFixed(4)}, new pipeline upper bound ${s.upper95.newPipeline.toFixed(4)}`),
    v1: v1.regressions.map((x) => `${x.variant} ${x.id}: ${x.newCode}; ${x.failingWindows.join('; ')}`),
    v3: v3.stops,
  };
  const receipt = {
    schema: 'vibe-guitar-align-validation/1',
    generatedAt: new Date().toISOString(),
    pr: 32,
    head,
    workingTreeDirty: dirty,
    old: { ref: OLD_REF, annotationsSha256: sha(oldText) },
    new: { annotationsSha256: sha(newText) },
    dependenciesUnchangedSinceOld: depsUnchanged,
    settings: {
      datasetsPerScenario: args.datasets,
      seeds: { ...NULL_SEEDS, V1: '5000 + songIndex * 3 + variantIndex' },
      nullMethod: 'chord-boundaries',
      fixedMap: FIXED_MAP,
      alpha: newM.CHANCE_ALPHA,
      v1: { offsetRangeSec: [-1.5, 1.5], jitterSdSec: 0.02, dropShare: 0.02, correctWithinSec: 0.1 },
      v2: { pairing: 'sorted id i with i + 1 (wrapping)', tempoMatchedWithin: 0.03, durationCheck: 'off' },
    },
    inputs: { beatles: counts, v3SongList: path.relative(root, path.resolve(args.songs)) },
    nullScenarios: nulls,
    v1: { transitions: v1.transitions, regressions: v1.regressions, rows: v1.rows },
    v2: { all: v2.all, tempoMatched: v2.tempoMatched, notTempoMatched: v2.notTempoMatched, rows: v2.rows },
    v3: v3.rows,
    stopConditions: { triggered: stop.nullScenarios.length + stop.v1.length + stop.v3.length > 0, ...stop },
    elapsedSec: Math.round((Date.now() - started) / 1000),
  };
  await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(receipt, null, 1)}\n`, 'utf8');

  const p = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [`receipt ${args.out} (head ${head.slice(0, 7)}${dirty ? ' + uncommitted' : ''}, old ${OLD_REF}, deps unchanged ${depsUnchanged}, ${receipt.elapsedSec} s)`];
  lines.push(`Beatles: ${counts.beatFiles} beat files, ${counts.chordFiles} chord files, ${counts.withBoth} with both, ${counts.fewerThan12Changes} with < 12 changes skipped, ${counts.used} used`);
  for (const [k, s] of Object.entries(nulls))
    lines.push(
      `${k} (n=${s.datasets}${s.fewerThan12 ? `, ${s.fewerThan12} with < 12 landmarks` : ''}${s.mapDiffers ? `, map differs ${s.mapDiffers}` : ''}): old ${p(s.rates.oldPipeline)} | fixed-map screen ${p(s.rates.fixedScreen)} (ub ${p(s.upper95.fixedScreen)}) | searched-map screen ${p(s.rates.searchedScreen)} (ub ${p(s.upper95.searchedScreen)}) | new pipeline ${p(s.rates.newPipeline)} (ub ${p(s.upper95.newPipeline)}) | ${s.meetsRequirement ? 'meets' : 'MISSES'} <= 5%`,
    );
  for (const v of VARIANTS) lines.push(`V1 ${v}: ${Object.entries(v1.transitions[v]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  for (const x of v1.regressions) lines.push(`  V1 regression ${x.variant} ${x.id}: ${x.newCode}; ${x.failingWindows.join('; ')}`);
  lines.push(`V2 all: old ${v2.all.oldAccepted}/${v2.all.pairs}, new ${v2.all.newAccepted}/${v2.all.pairs}; tempo-matched: old ${v2.tempoMatched.oldAccepted}/${v2.tempoMatched.pairs}, new ${v2.tempoMatched.newAccepted}/${v2.tempoMatched.pairs}`);
  const st = (x) => (x.accepted ? 'ok' : x.code);
  for (const x of v3.rows)
    lines.push(
      x.missing
        ? `V3 ${x.id}: no upload or chart`
        : `V3 ${x.id}: strong old ${st(x.strong.old)} new ${st(x.strong.new)} | weak old ${st(x.weak.old)} new ${st(x.weak.new)} | weak-strong max diff ${x.weakStrongMaxDiffSec.toFixed(3)} s${x.weakAgreesWithOldStrong ? ' (agrees)' : ''}`,
    );
  lines.push(`stop conditions: ${receipt.stopConditions.triggered ? 'TRIGGERED' : 'none'}`);
  for (const s of [...stop.nullScenarios, ...stop.v1, ...stop.v3]) lines.push(`  ${s}`);
  console.log(lines.join('\n'));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e.stack ?? e);
    process.exit(1);
  },
);
