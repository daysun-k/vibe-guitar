/**
 * VGT-19 K-pop reference check (docs/uncertainty-protocol.md "K-pop reference check"): charts WITH
 * `uncertain` spans against the VGT-21 chord-order references, with the conventions of
 * `npm run sequence-eval -- --whole-chart` (majmin tokens, N dropped, consecutive equal tokens
 * collapsed, X wildcards, whole chart). Reported: how often flagged vs unflagged chart tokens are
 * substituted or inserted in the alignment, and the net change in song-mean recall, precision and F
 * and in deletions and insertions when every flagged span takes its second choice.
 */
import type { Chart } from '../chart/types';
import { validateChart } from '../chart/validate';
import { share, type Share } from '../replay/uncertainty-analysis';
import { chartFromExport, EvalInputError, parseLab } from './annotations';
import { chartIntervals } from './metrics';
import { lookupSongs, type MapEntry, type NamedSongList, type PairedMaps } from './paired';
import { chartTokens, referenceTokens, scoreTokens, viewToken, type SequenceIo, type ViewScore } from './sequence';
import { chartWithSecondChoices } from './uncertain-replace';

export const UNCERTAINTY_SEQUENCE_SCHEMA = 'vibe-guitar-uncertainty-sequence/1';

/** A collapsed majmin chart token with its duration (its chord intervals; N and coverage gaps excluded) and flagged seconds. */
export interface TimedToken {
  token: string;
  durSec: number;
  flaggedSec: number;
  /** At least half of its duration lies in flagged spans. */
  flagged: boolean;
}

export function timedChartTokens(chart: Chart): TimedToken[] {
  const spans = chart.uncertain ?? [];
  const out: TimedToken[] = [];
  for (const i of chartIntervals(chart.events, chart.coverage)) {
    const token = viewToken(i.symbol, 'majmin');
    if (token === null) continue;
    const dur = i.endSec - i.startSec;
    let flagged = 0;
    for (const s of spans) flagged += Math.max(0, Math.min(i.endSec, s.toSec) - Math.max(i.startSec, s.fromSec));
    const last = out[out.length - 1];
    if (last && last.token === token) {
      last.durSec += dur;
      last.flaggedSec += flagged;
    } else out.push({ token, durSec: dur, flaggedSec: flagged, flagged: false });
  }
  for (const t of out) t.flagged = t.flaggedSec >= 0.5 * t.durSec;
  const plain = chartTokens(chart, 'majmin');
  if (plain.length !== out.length || plain.some((t, k) => t !== out[k].token)) throw new Error('timed chart tokens differ from chartTokens (majmin)');
  return out;
}

type Counts = Pick<ViewScore, 'recall' | 'precision' | 'f' | 'matches' | 'substitutions' | 'deletions' | 'insertions'>;
const counts = (s: ViewScore): Counts => ({ recall: s.recall, precision: s.precision, f: s.f, matches: s.matches, substitutions: s.substitutions, deletions: s.deletions, insertions: s.insertions });

export interface UncertainSequenceSong {
  id: string;
  youtubeId: string;
  spans: number;
  /** Chart tokens (not absorbed by a wildcard) by flag, and how many of them are substituted or inserted. */
  flagged: { tokens: number; mismatched: number };
  unflagged: { tokens: number; mismatched: number };
  /** Chart tokens absorbed by a wildcard (left out of both). */
  wildcardAbsorbed: number;
  before: Counts;
  /** Every flagged span replaced by its second choice. */
  after: Counts;
}

export function scoreUncertainSequenceSong(m: MapEntry, entry: { song: { dataset: string; chords: string }; list: { datasets: Record<string, { folder: string }> } }, io: SequenceIo): UncertainSequenceSong | null {
  const folder = entry.list.datasets[entry.song.dataset].folder;
  const lab = io.readAnnotation(folder, entry.song.chords);
  if (lab === null) throw new EvalInputError(`${m.id}: annotation file not found: ${folder}/${entry.song.chords}`);
  const raw = io.readChart(m.youtubeId);
  if (raw === null || raw === undefined) return null;
  const c = chartFromExport(raw);
  const v = validateChart(c);
  if (!c || !v.ok) throw new EvalInputError(`${m.id} ${m.youtubeId}.json: not a valid chart (${v.errors.join('; ')})`);
  const chart = v.chart!;
  if (!Array.isArray(chart.uncertain)) throw new EvalInputError(`${m.id} ${m.youtubeId}.json: no uncertain spans (write the charts with uncertainty-analysis --charts-out)`);
  const ref = referenceTokens(parseLab(lab), 'majmin', null);
  const toks = timedChartTokens(chart);
  const { score, ops } = scoreTokens(
    ref,
    toks.map((t) => t.token),
  );
  if (!score.refTokens) throw new EvalInputError(`${m.id}: no majmin reference tokens`);
  const flagged = { tokens: 0, mismatched: 0 };
  const unflagged = { tokens: 0, mismatched: 0 };
  let wildcardAbsorbed = 0;
  for (const o of ops) {
    if (o.est === null) continue;
    if (o.op === 'wild') {
      wildcardAbsorbed++;
      continue;
    }
    const side = toks[o.est].flagged ? flagged : unflagged;
    side.tokens++;
    if (o.op === 'sub' || o.op === 'ins') side.mismatched++;
  }
  const after = scoreTokens(ref, chartTokens(chartWithSecondChoices(chart), 'majmin')).score;
  return { id: m.id, youtubeId: m.youtubeId, spans: chart.uncertain.length, flagged, unflagged, wildcardAbsorbed, before: counts(score), after: counts(after) };
}

const mean = (xs: number[]): number | null => {
  const f = xs.filter(Number.isFinite);
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
};

export interface UncertainSequenceResult {
  schema: string;
  generatedAt: string;
  inputs: Record<string, string | boolean | null>;
  referenceWindow: 'none';
  /** Map songs without a chart (the check is then incomplete). */
  missing: string[];
  complete: boolean;
  songs: UncertainSequenceSong[];
  mismatch: { flagged: Share; unflagged: Share };
  recovery: {
    songMean: Record<'recall' | 'precision' | 'f', { before: number | null; after: number | null; change: number | null }>;
    totals: Record<'deletions' | 'insertions' | 'substitutions' | 'matches', { before: number; after: number }>;
  };
}

export function uncertainSequenceEvaluate(maps: PairedMaps, lists: NamedSongList[], io: SequenceIo, opts: { fallbackLists?: string[]; inputs?: Record<string, string | null>; now?: Date } = {}): UncertainSequenceResult {
  const entries = lookupSongs(lists, maps, opts.fallbackLists);
  const songs: UncertainSequenceSong[] = [];
  const missing: string[] = [];
  for (const m of maps.songs) {
    const r = scoreUncertainSequenceSong(m, entries.get(m.id)!, io);
    if (r) songs.push(r);
    else missing.push(m.id);
  }
  const rates = ['recall', 'precision', 'f'] as const;
  const songMean = Object.fromEntries(
    rates.map((k) => {
      const before = mean(songs.map((s) => s.before[k]));
      const after = mean(songs.map((s) => s.after[k]));
      return [k, { before, after, change: mean(songs.map((s) => s.after[k] - s.before[k])) }];
    }),
  ) as UncertainSequenceResult['recovery']['songMean'];
  const total = (k: 'deletions' | 'insertions' | 'substitutions' | 'matches') => ({ before: songs.reduce((a, s) => a + s.before[k], 0), after: songs.reduce((a, s) => a + s.after[k], 0) });
  return {
    schema: UNCERTAINTY_SEQUENCE_SCHEMA,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    inputs: { ...opts.inputs, wholeChart: true },
    referenceWindow: 'none',
    missing,
    complete: missing.length === 0,
    songs,
    mismatch: {
      flagged: share(songs.map((s) => [s.flagged.mismatched, s.flagged.tokens])),
      unflagged: share(songs.map((s) => [s.unflagged.mismatched, s.unflagged.tokens])),
    },
    recovery: { songMean, totals: { deletions: total('deletions'), insertions: total('insertions'), substitutions: total('substitutions'), matches: total('matches') } },
  };
}

const pc = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const pp = (x: number | null) => (x === null ? 'n/a' : `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)} pp`);

export function uncertainSequenceSummary(r: UncertainSequenceResult): string {
  const m = r.mismatch;
  const rec = r.recovery;
  return [
    `uncertainty sequence check: ${r.songs.length} songs${r.complete ? '' : `, INCOMPLETE (no chart: ${r.missing.join(', ')})`}`,
    `mismatch (sub+ins) flagged ${pc(m.flagged.value)} of ${m.flagged.den} tokens (song mean ${pc(m.flagged.songMean)}) vs unflagged ${pc(m.unflagged.value)} of ${m.unflagged.den} (song mean ${pc(m.unflagged.songMean)})`,
    `second choices: song-mean recall ${pc(rec.songMean.recall.before)} -> ${pc(rec.songMean.recall.after)} (${pp(rec.songMean.recall.change)}), precision ${pc(rec.songMean.precision.before)} -> ${pc(rec.songMean.precision.after)} (${pp(rec.songMean.precision.change)}), F ${pc(rec.songMean.f.before)} -> ${pc(rec.songMean.f.after)} (${pp(rec.songMean.f.change)})`,
    `deletions ${rec.totals.deletions.before} -> ${rec.totals.deletions.after}, insertions ${rec.totals.insertions.before} -> ${rec.totals.insertions.after} (net change; realignment can relabel operations)`,
  ].join('\n');
}
