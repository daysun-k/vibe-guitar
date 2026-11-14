// One VGT-18 candidate step (docs/recognition-improvement-protocol.md): evaluates ONE setting against the
// current incumbent on DEV and reports P1..P6, eligibility and the stop-and-ask alarms. It never decides a
// promotion; the parent records the decision.
//   npm run candidate-step -- --incumbent <config.json> --setting <config.json> --incumbent-charts <dir>
//     --baseline-charts <dir> --audio <captures dir> --maps <maps.json> --annotations <dir> --out <dir>
//     [--charts <dir>] [--resource-baseline <json>]
// Evaluated config = incumbent recognizer options deep-merged with the setting's (setting wins per field;
// arrays are replaced). Steps: replay-audio of the merged config (under /usr/bin/time -l for peak memory),
// paired-eval incumbent vs merged and original baseline vs merged (subset btcTraining=not-known), bench
// --config for incumbent and merged, resource checks against the measured baseline.
// "Not lower at one decimal" = Math.round(10 * x) / 10 on pp values, equal is not lower (protocol F8).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE =
  'usage: npm run candidate-step -- --incumbent <config.json> --setting <config.json> --incumbent-charts <dir> --baseline-charts <dir> --audio <dir> --maps <maps.json> --annotations <dir> --out <dir> [--charts <dir>] [--resource-baseline <json>]';
export const STEP_SCHEMA = 'vibe-guitar-candidate-step/1';
export const DEFAULT_RESOURCE_BASELINE = path.join(homedir(), 'Documents/paseo-briefings/vibe-guitar-recognition-improvement/resource-baseline.json');
/** Predeclared alarm groups (protocol "Stop-and-ask alarms"). */
export const ALARM_GROUPS = ['dataset:isophonics-btc-overlap', 'dataset:billboard', 'complexity:simple', 'complexity:moderate', 'complexity:complex'];
export const BILLBOARD_SUBSET = 'btcTraining=not-known';

export function parseArgs(argv) {
  const keys = ['incumbent', 'setting', 'incumbent-charts', 'baseline-charts', 'audio', 'maps', 'annotations', 'out', 'charts', 'resource-baseline'];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !keys.includes(k) || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}\n${USAGE}`);
    out[k] = argv[++i];
  }
  for (const k of keys.slice(0, 8)) if (!out[k]) throw new Error(`--${k} is required\n${USAGE}`);
  return out;
}

// ---------------------------------------------------------------- pure rules (tests/candidate-step.test.ts)

/** A fraction (0..1) as pp rounded to one decimal (protocol F8). */
export const roundPp = (fraction) => Math.round(10 * (100 * fraction)) / 10;
/** "Not lower at one decimal": equal rounded values are not lower. */
export const notLowerRounded = (candidate, reference) => roundPp(candidate) >= roundPp(reference);

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of recognizer options: the setting wins on the same field; arrays and scalars are replaced. */
export function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

export function mergedConfig(incumbent, setting) {
  return {
    label: `${incumbent.label ?? 'incumbent'} + ${setting.label ?? 'setting'}`,
    recognizer: deepMerge(incumbent.recognizer ?? {}, setting.recognizer ?? {}),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** Song-mean majmin of both arms of a paired result for every alarm group (from the per-song rows). */
export function groupMeans(paired) {
  const out = {};
  for (const g of ALARM_GROUPS) {
    const rows = paired.songs.filter((s) => s.groups.includes(g));
    out[g] = { n: rows.length, reference: mean(rows.map((s) => s.baseline.majmin)), candidate: mean(rows.map((s) => s.candidate.majmin)) };
  }
  return out;
}

/**
 * Resource checks against the measured baseline. Limits: packaged bytes +10%; analysis time +50% and at
 * least +1 s (allowed increase = max(50%, 1 s)); peak memory +20%. Live latency is not measured here.
 */
export function resourceChecks(baseline, measured) {
  const timeLimit = (b) => b + Math.max(0.5 * b, 1000);
  const checks = {
    packagedBytes: { baseline: baseline.distBytesExclMaps, value: measured.packagedBytes, limit: baseline.distBytesExclMaps * 1.1 },
    analysisTime4minMs: { baseline: baseline.replay4min.tot, value: measured.total4minMs, limit: timeLimit(baseline.replay4min.tot) },
    medianAnalyzeMs: { baseline: baseline.medianAnalyzeMs, value: measured.medianAnalyzeMs, limit: timeLimit(baseline.medianAnalyzeMs) },
    peakRssBytes: { baseline: baseline.wholeRun.peakRssBytes, value: measured.peakRssBytes, limit: baseline.wholeRun.peakRssBytes * 1.2 },
  };
  for (const c of Object.values(checks)) c.ok = c.value === null ? null : c.value <= c.limit;
  return checks;
}

/**
 * P1..P6, eligibility and alarms from the two paired results (incumbent vs merged, baseline vs merged),
 * the two bench summaries and the resource checks. Deltas are reported in pp.
 */
export function evaluateStep({ vsIncumbent, vsBaseline, benchIncumbent, benchCandidate, resources }) {
  const a = vsIncumbent.all;
  const sub = vsIncumbent.subset?.aggregate;
  if (!sub) throw new Error('paired result vs incumbent has no Billboard subset');
  const pp = (x) => 100 * x;
  const secondary = Object.fromEntries(
    ['root', 'sevenths'].map((k) => [k, { incumbent: roundPp(a.baseline[k]), candidate: roundPp(a.candidate[k]), ok: notLowerRounded(a.candidate[k], a.baseline[k]) }]),
  );
  const synthetic = Object.fromEntries(
    ['majmin', 'root', 'sevenths'].map((k) => [k, { incumbent: roundPp(benchIncumbent.wcsr[k]), candidate: roundPp(benchCandidate.wcsr[k]), ok: notLowerRounded(benchCandidate.wcsr[k], benchIncumbent.wcsr[k]) }]),
  );
  const precisionDeltaPp = pp(a.boundaries.precision.delta);
  const flicker = { precisionIncumbent: pp(a.boundaries.precision.baseline), precisionCandidate: pp(a.boundaries.precision.candidate), deltaPp: precisionDeltaPp, ok: precisionDeltaPp >= -2.0 };
  const resourceOk = Object.values(resources).every((c) => c.ok !== false);
  const P = {
    P1: pp(a.meanDelta.majmin) >= 0.5,
    P2: a.majminDeltaCi.lower > 0,
    P3: sub.meanDelta.majmin > 0,
    P4: a.leaveOneOut !== null && a.leaveOneOut.min > 0,
    // paired-eval refuses arms whose coverage or evaluated seconds differ, so reaching here means identical.
    P5: Object.values(secondary).every((s) => s.ok) && Object.values(synthetic).every((s) => s.ok) && flicker.ok,
    P6: resourceOk,
  };
  const groupAlarms = [];
  for (const [against, paired] of [['incumbent', vsIncumbent], ['baseline', vsBaseline]]) {
    for (const [g, m] of Object.entries(groupMeans(paired))) {
      if (m.n && !notLowerRounded(m.candidate, m.reference)) groupAlarms.push({ against, group: g, n: m.n, reference: roundPp(m.reference), candidate: roundPp(m.candidate) });
    }
  }
  const songLosses = (paired, against) => paired.songs.map((s) => ({ against, id: s.id, deltaPp: pp(s.delta.majmin) }));
  const losses = [...songLosses(vsIncumbent, 'incumbent'), ...songLosses(vsBaseline, 'baseline')];
  const alarms = {
    groups: groupAlarms,
    songLoss10: losses.filter((l) => l.deltaPp <= -10),
    songLoss5to10: losses.filter((l) => l.deltaPp <= -5 && l.deltaPp > -10),
    resources: Object.entries(resources).filter(([, c]) => c.ok === false).map(([k]) => k),
  };
  return {
    meanDeltaPp: pp(a.meanDelta.majmin),
    bootstrapPp: { p2_5: pp(a.majminDeltaCi.lower), p97_5: pp(a.majminDeltaCi.upper), resamples: a.majminDeltaCi.resamples, seed: a.majminDeltaCi.seed },
    billboardDeltaPp: pp(sub.meanDelta.majmin),
    billboardSongs: sub.songs,
    leaveOneOut: a.leaveOneOut ? { minPp: pp(a.leaveOneOut.min), without: a.leaveOneOut.minWithout } : null,
    majmin: { incumbent: pp(a.baseline.majmin), candidate: pp(a.candidate.majmin) },
    vsOriginalBaseline: { meanDeltaPp: pp(vsBaseline.all.meanDelta.majmin), baseline: pp(vsBaseline.all.baseline.majmin) },
    secondary,
    synthetic,
    flicker,
    changes: { incumbent: a.boundaries.baselinePredicted, candidate: a.boundaries.candidatePredicted, annotated: a.boundaries.annotated },
    resources,
    P,
    eligible: Object.values(P).every(Boolean),
    alarms,
    anyAlarm: groupAlarms.length > 0 || alarms.songLoss10.length > 0 || alarms.resources.length > 0,
  };
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : 'n/a');
const f2 = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}` : 'n/a');

/** Compact text (<= 25 lines). */
export function stepSummary(label, r) {
  const yes = (b) => (b ? 'yes' : 'NO');
  const res = r.resources;
  const lines = [
    `candidate step: ${label}`,
    `majmin ${f2(r.majmin.incumbent)} → ${f2(r.majmin.candidate)}: mean Δ ${f2(r.meanDeltaPp)} pp, bootstrap [${f2(r.bootstrapPp.p2_5)}, ${f2(r.bootstrapPp.p97_5)}]`,
    `Billboard (${r.billboardSongs}) Δ ${f2(r.billboardDeltaPp)}; min leave-one-out Δ ${f2(r.leaveOneOut?.minPp)} (without ${r.leaveOneOut?.without}); vs original baseline Δ ${f2(r.vsOriginalBaseline.meanDeltaPp)}`,
    `root ${f1(r.secondary.root.incumbent)} → ${f1(r.secondary.root.candidate)} (${yes(r.secondary.root.ok)}), sevenths ${f1(r.secondary.sevenths.incumbent)} → ${f1(r.secondary.sevenths.candidate)} (${yes(r.secondary.sevenths.ok)})`,
    `boundary precision ${f1(r.flicker.precisionIncumbent)} → ${f1(r.flicker.precisionCandidate)} (Δ ${f2(r.flicker.deltaPp)}, ok ${yes(r.flicker.ok)}); changes ${r.changes.incumbent} → ${r.changes.candidate} (annotated ${r.changes.annotated})`,
    `synthetic majmin ${f1(r.synthetic.majmin.incumbent)} → ${f1(r.synthetic.majmin.candidate)}, root ${f1(r.synthetic.root.incumbent)} → ${f1(r.synthetic.root.candidate)}, sevenths ${f1(r.synthetic.sevenths.incumbent)} → ${f1(r.synthetic.sevenths.candidate)} (ok ${yes(Object.values(r.synthetic).every((s) => s.ok))})`,
    `resources: bytes ${res.packagedBytes.value} (limit ${Math.round(res.packagedBytes.limit)}), 4-min total ${res.analysisTime4minMs.value} ms (limit ${res.analysisTime4minMs.limit}), median analyze ${res.medianAnalyzeMs.value} ms (limit ${res.medianAnalyzeMs.limit}), peak RSS ${res.peakRssBytes.value ?? 'n/a'} (limit ${Math.round(res.peakRssBytes.limit)})`,
    `P1 ${yes(r.P.P1)} P2 ${yes(r.P.P2)} P3 ${yes(r.P.P3)} P4 ${yes(r.P.P4)} P5 ${yes(r.P.P5)} P6 ${yes(r.P.P6)} → eligible ${yes(r.eligible)} (not a promotion decision)`,
  ];
  const al = r.alarms;
  lines.push(`alarms: groups ${al.groups.length ? al.groups.map((g) => `${g.group} vs ${g.against} ${f1(g.reference)}→${f1(g.candidate)}`).join('; ') : 'none'}`);
  lines.push(`  song losses >= 10 pp: ${al.songLoss10.length ? al.songLoss10.map((l) => `${l.id} vs ${l.against} ${f2(l.deltaPp)}`).join('; ') : 'none'}; resources: ${al.resources.length ? al.resources.join(', ') : 'none'}`);
  lines.push(`  losses 5-10 pp (diagnose): ${al.songLoss5to10.length ? al.songLoss5to10.map((l) => `${l.id} vs ${l.against} ${f2(l.deltaPp)}`).join('; ') : 'none'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- running the steps

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function run(cmd, args, logFile) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  writeFileSync(logFile, `$ ${cmd} ${args.join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}`);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} failed (exit ${r.status}); see ${logFile}`);
  return r;
}

function git(...a) {
  try {
    return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  mkdirSync(out, { recursive: true });
  const incumbent = readJson(args.incumbent);
  const setting = readJson(args.setting);
  const merged = mergedConfig(incumbent, setting);
  const mergedFile = path.join(out, 'merged-config.json');
  writeFileSync(mergedFile, `${JSON.stringify(merged, null, 2)}\n`);
  const charts = path.resolve(args.charts ?? path.join(out, 'charts'));
  const resourceBaseline = readJson(args['resource-baseline'] ?? DEFAULT_RESOURCE_BASELINE);
  const common = ['--maps', args.maps, '--annotations', args.annotations, '--subset-field', BILLBOARD_SUBSET];

  // 1. Replay the merged config (peak RSS from /usr/bin/time -l, bytes on macOS).
  const replay = run('/usr/bin/time', ['-l', process.execPath, 'scripts/replay-audio.mjs', '--audio', args.audio, '--out', charts, '--config', mergedFile], path.join(out, 'replay.log'));
  const rss = /(\d+)\s+maximum resident set size/.exec(replay.stderr ?? '');
  const manifest = readJson(path.join(charts, 'replay-manifest.json'));
  const song4 = manifest.songs.find((s) => s.key === resourceBaseline.replay4min.key);

  // 2. Paired evaluations.
  const vsIncFile = path.join(out, 'paired-vs-incumbent.json');
  const vsBaseFile = path.join(out, 'paired-vs-baseline.json');
  run(process.execPath, ['scripts/paired-eval.mjs', ...common, '--baseline', args['incumbent-charts'], '--candidate', charts, '--out', vsIncFile], path.join(out, 'paired-vs-incumbent.log'));
  run(process.execPath, ['scripts/paired-eval.mjs', ...common, '--baseline', args['baseline-charts'], '--candidate', charts, '--out', vsBaseFile], path.join(out, 'paired-vs-baseline.log'));

  // 3. Synthetic guards.
  const incFile = path.join(out, 'incumbent-config.json');
  writeFileSync(incFile, `${JSON.stringify(incumbent, null, 2)}\n`);
  run(process.execPath, ['scripts/bench.mjs', '--config', incFile, '--out', path.join(out, 'bench-incumbent')], path.join(out, 'bench-incumbent.log'));
  run(process.execPath, ['scripts/bench.mjs', '--config', mergedFile, '--out', path.join(out, 'bench-candidate')], path.join(out, 'bench-candidate.log'));
  const benchInc = readJson(path.join(out, 'bench-incumbent', 'bench-node-config.json'));
  const benchCand = readJson(path.join(out, 'bench-candidate', 'bench-node-config.json'));

  // 4. Resources (the candidate path is not packaged; C5 would package btc_majmin.onnx).
  const majminBytes = merged.recognizer.majmin ? statSync(path.join(root, 'models', 'btc_majmin.onnx')).size : 0;
  const resources = resourceChecks(resourceBaseline, {
    packagedBytes: resourceBaseline.distBytesExclMaps + majminBytes,
    total4minMs: song4 ? song4.ms.total : null,
    medianAnalyzeMs: median(manifest.songs.map((s) => s.ms.analyze)),
    peakRssBytes: rss ? Number(rss[1]) : null,
  });

  const vsIncumbent = readJson(vsIncFile);
  const vsBaseline = readJson(vsBaseFile);
  const result = evaluateStep({ vsIncumbent, vsBaseline, benchIncumbent: benchInc.summary, benchCandidate: benchCand.summary, resources });
  const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
  const step = {
    schema: STEP_SCHEMA,
    generatedAt: new Date().toISOString(),
    git: { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' },
    incumbent,
    setting,
    merged,
    inputs: {
      incumbentFile: path.resolve(args.incumbent),
      settingFile: path.resolve(args.setting),
      incumbentCharts: path.resolve(args['incumbent-charts']),
      baselineCharts: path.resolve(args['baseline-charts']),
      charts,
      audio: path.resolve(args.audio),
      maps: path.resolve(args.maps),
      mapsSha256: sha(args.maps),
      annotations: path.resolve(args.annotations),
      resourceBaseline: path.resolve(args['resource-baseline'] ?? DEFAULT_RESOURCE_BASELINE),
    },
    replay: { models: manifest.models, candidateModels: manifest.candidateModels ?? null, song4min: song4 ? { key: song4.key, ms: song4.ms } : null, peakRssBytes: rss ? Number(rss[1]) : null },
    liveLatency: 'not measured: the candidate path is offline only (extension unchanged)',
    rules: 'P1 mean Δ >= 0.50 pp; P2 bootstrap 2.5th pct > 0; P3 Billboard Δ > 0; P4 min LOO > 0; P5 root/sevenths/synthetic not lower at one decimal (Math.round(10*pp)/10), precision Δ >= -2.0 pp, coverage identical; P6 resources',
    ...result,
  };
  writeFileSync(path.join(out, 'step.json'), `${JSON.stringify(step, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2)}\n`);
  console.log(stepSummary(merged.label, result));
  console.log(`wrote ${path.join(out, 'step.json')} (charts ${charts})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}

