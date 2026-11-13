/**
 * VGT-18 baseline analyses (docs/recognition-candidates.md "Baseline analyses") of one replayed song
 * against its annotation under the FROZEN map (offsetSec, rate): error anatomy, BTC top-k family
 * oracle per beat unit, unit-grid oracle ceilings (beat, half-beat, frame) and the disagreement
 * between btc_majmin and the large model. Every WCSR is the evaluator's own scoreSong on a chart
 * built by buildAutoChart, so ownership, coverage and the evaluated region match the official score.
 */
import { isNoChord, parseChord } from '../arrange/chord';
import { mod12 } from '../arrange/notes';
import type { Chart } from '../chart/types';
import { annotationChart, overlapRanges, scoreSong, type AnnotationSegment } from '../eval/annotations';
import { chartIntervals, reduceSymbol, type LabeledInterval } from '../eval/metrics';
import type { MapEntry } from '../eval/paired';
import {
  candidateUnits,
  classSpace,
  largeToMajmin,
  MAJMIN_FAMILIES,
  SHARP_ROOTS,
  sumClasses,
  unitMeans,
  type CandidateDecodeInput,
} from '../recognize/candidate-decode';
import type { DecodeUnit } from '../recognize/chords';
import type { SegmentAnalysis } from '../recognize/recognizer';

export const ANATOMY_KEYS = ['exact', 'fifthRoot', 'parallel', 'relative', 'semitoneRoot', 'other', 'falseN', 'chordForRefN'] as const;
export type AnatomyKey = (typeof ANATOMY_KEYS)[number];

export interface SongAnalysis {
  id: string;
  youtubeId: string;
  /** Official majmin WCSR of the replayed chart (scoreSong) and its evaluated seconds. */
  majmin: number;
  evaluatedSec: number;
  /** Shares of evaluated majmin time; they sum to 1. */
  anatomy: Record<AnatomyKey, number>;
  /** Share of evaluated majmin time where the reference family is within the top k of the beat unit's mean family probabilities. */
  topK: { top1: number; top2: number; top3: number };
  /** Majmin WCSR if every unit took the reference's majority majmin label. */
  ceilings: { beat: number; halfBeat: number; frame: number };
  majminModel: {
    /** Share of beat units (all analysed units) where the two models' family argmax differ. */
    disagreeUnits: number;
    /** Share of evaluated majmin time inside such units. */
    disagreeTime: number;
    /** Majmin WCSR of per-unit family argmax: large model, majmin model, and the per-unit oracle picking whichever matches. */
    largeArgmax: number;
    majminArgmax: number;
    oracle: number;
  };
}

const famSymbol = (f: string): string => {
  const m = /^(\d+):(maj|min)$/.exec(f);
  return m ? `${SHARP_ROOTS[Number(m[1])]}${m[2] === 'min' ? 'm' : ''}` : f;
};

/** Chart symbol of a reduced majmin label ("7:min" → "Gm", "N" → "N"). */
export function majminLabelSymbol(label: string): string {
  return famSymbol(label);
}

/** One stretch of the evaluated region with its reference label and the estimate-side label. */
interface Piece {
  dur: number;
  /** Reference reduced to majmin (never null: unevaluated time is dropped). */
  ref: string;
  est: string | null;
}

/**
 * The evaluated majmin region of compareCharts: the overlap of reference and estimate coverage,
 * reference labels inside the majmin reduction. `est` intervals label the estimate side.
 */
function pieces(reference: Chart, estCoverage: Chart['coverage'], est: LabeledInterval[]): Piece[] {
  const both = overlapRanges(reference.coverage, estCoverage);
  const ref = chartIntervals(reference.events, reference.coverage);
  const out: Piece[] = [];
  for (const r of both) {
    const cuts = new Set<number>([r.fromSec, r.toSec]);
    for (const i of [...ref, ...est]) for (const t of [i.startSec, i.endSec]) if (t > r.fromSec && t < r.toSec) cuts.add(t);
    const times = [...cuts].sort((a, b) => a - b);
    for (let k = 0; k < times.length - 1; k++) {
      const mid = (times[k] + times[k + 1]) / 2;
      const rr = ref.find((i) => mid >= i.startSec && mid < i.endSec);
      if (!rr) continue;
      const red = reduceSymbol(rr.symbol, 'majmin');
      if (red === null) continue;
      const e = est.find((i) => mid >= i.startSec && mid < i.endSec);
      out.push({ dur: times[k + 1] - times[k], ref: red, est: e ? e.symbol : null });
    }
  }
  return out;
}

/** Error class of an estimate symbol against a reduced majmin reference label. */
export function anatomyOf(ref: string, est: string | null): AnatomyKey {
  const er = est === null ? null : reduceSymbol(est, 'majmin');
  if (er !== null && er === ref) return 'exact';
  if (ref === 'N') return 'chordForRefN';
  if (est === null) return 'other';
  if (isNoChord(est)) return 'falseN';
  let root: number;
  try {
    root = parseChord(est).root;
  } catch {
    return 'other';
  }
  const [refRoot, refTriad] = ref.split(':');
  const d = mod12(root - Number(refRoot));
  const estTriad = er === null ? null : er.split(':')[1];
  if (d === 0) return estTriad !== null ? 'parallel' : 'other';
  if (d === 5 || d === 7) return 'fifthRoot';
  if (d === 1 || d === 11) return 'semitoneRoot';
  if ((refTriad === 'maj' && estTriad === 'min' && d === 9) || (refTriad === 'min' && estTriad === 'maj' && d === 3)) return 'relative';
  return 'other';
}

/** Frame units of a segment: one per CQT frame (boundaries halfway between frame centres). */
export function frameUnits(input: CandidateDecodeInput, startSec: number, endSec: number): DecodeUnit[] {
  const bounds = [startSec];
  for (let f = 0; f < input.frames - 1; f++) {
    const t = input.frameStartSec + (f + 0.5) * input.frameSec;
    if (t > startSec && t < endSec) bounds.push(t);
  }
  bounds.push(endSec);
  return bounds.slice(0, -1).map((t, i) => ({ startSec: t, endSec: bounds[i + 1], strength: 2 as const }));
}

export interface SongAnalysisInput {
  map: MapEntry;
  segs: AnnotationSegment[];
  annBeats: number[] | null;
  chart: Chart;
  analyses: SegmentAnalysis[];
  inputs: CandidateDecodeInput[];
  /** buildAutoChart with the replay's recording and duration. */
  build(analyses: SegmentAnalysis[]): Chart;
}

export function analyzeSong(x: SongAnalysisInput): SongAnalysis {
  const { map: m, segs, annBeats, analyses, inputs } = x;
  if (analyses.length !== inputs.length) throw new Error(`${m.id}: one decode input per analysis expected`);
  const reference = annotationChart(segs, m.offsetSec, null, m.mediaDurationSec, false, m.rate);
  const wcsrOf = (chart: Chart) => {
    const s = scoreSong(segs, annBeats, chart, m.offsetSec, m.mediaDurationSec, 1, m.rate).comparison.majmin;
    return { score: s.score, evaluatedSec: s.evaluatedSec };
  };
  const official = wcsrOf(x.chart);
  if (!(official.evaluatedSec > 0)) throw new Error(`${m.id}: no majmin-evaluated seconds under this map`);

  // Error anatomy of the replayed chart.
  const anatomySec = Object.fromEntries(ANATOMY_KEYS.map((k) => [k, 0])) as Record<AnatomyKey, number>;
  const chartPieces = pieces(reference, x.chart.coverage, chartIntervals(x.chart.events, x.chart.coverage));
  for (const p of chartPieces) anatomySec[anatomyOf(p.ref, p.est)] += p.dur;
  const total = chartPieces.reduce((a, p) => a + p.dur, 0);
  if (Math.abs(total - official.evaluatedSec) > 1e-6 || Math.abs(anatomySec.exact / total - official.score) > 1e-6)
    throw new Error(`${m.id}: anatomy region differs from scoreSong (${total} vs ${official.evaluatedSec} s)`);

  /**
   * Labels every unit of a grid with an id, builds the chart (same ownership as the real one) and
   * returns the evaluated pieces with their unit, plus a function scoring per-unit labels.
   */
  const grid = (unitsOf: (input: CandidateDecodeInput, a: SegmentAnalysis) => DecodeUnit[]) => {
    const units = analyses.map((a, s) => unitsOf(inputs[s], a));
    const ids = analyses.map((a, s) => ({ ...a, units: units[s].map((u, i) => ({ ...u, symbol: `${s}.${i}`, confidence: 0 })) }));
    const idChart = x.build(ids);
    const unitPieces = pieces(reference, idChart.coverage, chartIntervals(idChart.events, idChart.coverage));
    const score = (label: (s: number, i: number) => string) => wcsrOf(x.build(analyses.map((a, s) => ({ ...a, units: units[s].map((u, i) => ({ ...u, symbol: label(s, i), confidence: 0 })) })))).score;
    return { units, unitPieces, score };
  };
  const majority = (unitPieces: Piece[]) => {
    const time = new Map<string, Map<string, number>>();
    for (const p of unitPieces) {
      if (p.est === null) continue;
      const t = time.get(p.est) ?? new Map<string, number>();
      t.set(p.ref, (t.get(p.ref) ?? 0) + p.dur);
      time.set(p.est, t);
    }
    return (s: number, i: number) => {
      const t = time.get(`${s}.${i}`);
      if (!t) return 'N';
      let best = '';
      let bestT = -1;
      for (const [label, sec] of t) if (sec > bestT) [best, bestT] = [label, sec];
      return majminLabelSymbol(best);
    };
  };

  const beat = grid((input) => input.units);
  const half = grid((input) => candidateUnits(input.units, { halfBeat: true, offbeatExtraPenalty: 0 }));
  const frame = grid((input, a) => frameUnits(input, a.startSec, a.endSec));
  const ceilings = { beat: beat.score(majority(beat.unitPieces)), halfBeat: half.score(majority(half.unitPieces)), frame: frame.score(majority(frame.unitPieces)) };

  // Top-k family oracle per beat unit (C1 family classes of the large model).
  const fam = inputs.map((input, s) => {
    const space = classSpace(input, { decode: { familyFirst: { penaltyScale: 1 } } });
    return { names: space.names, avg: unitMeans(space.probs, input.frames, space.names.length, input.frameSec, input.frameStartSec, beat.units[s]) };
  });
  const topSec = [0, 0, 0];
  let topTotal = 0;
  for (const p of beat.unitPieces) {
    if (p.est === null) continue;
    const [s, i] = p.est.split('.').map(Number);
    const { names, avg } = fam[s];
    const K = names.length;
    const j = names.indexOf(majminLabelSymbol(p.ref));
    let rank = Infinity;
    if (j >= 0) {
      rank = 1;
      for (let k = 0; k < K; k++) if (avg[i * K + k] > avg[i * K + j]) rank++;
    }
    topTotal += p.dur;
    for (let k = 0; k < 3; k++) if (rank <= k + 1) topSec[k] += p.dur;
  }

  // btc_majmin vs the large model (collapsed to the 25 majmin families), per beat unit.
  const argmax = (avg: Float32Array, i: number, K: number) => {
    let b = 0;
    for (let k = 1; k < K; k++) if (avg[i * K + k] > avg[i * K + b]) b = k;
    return b;
  };
  const F = MAJMIN_FAMILIES.length;
  const picks = inputs.map((input, s) => {
    if (!input.majminProbs) throw new Error(`${m.id}: the majmin model did not run`);
    const large = sumClasses(input.probs, input.frames, input.symbols.length, largeToMajmin(input.symbols), F);
    const la = unitMeans(large, input.frames, F, input.frameSec, input.frameStartSec, beat.units[s]);
    const ma = unitMeans(input.majminProbs, input.frames, F, input.frameSec, input.frameStartSec, beat.units[s]);
    return beat.units[s].map((_, i) => ({ large: famSymbol(MAJMIN_FAMILIES[argmax(la, i, F)]), majmin: famSymbol(MAJMIN_FAMILIES[argmax(ma, i, F)]) }));
  });
  const allUnits = picks.flat();
  const matched = new Map<string, { large: number; majmin: number }>();
  let disagreeSec = 0;
  for (const p of beat.unitPieces) {
    if (p.est === null) continue;
    const [s, i] = p.est.split('.').map(Number);
    const pk = picks[s][i];
    if (pk.large !== pk.majmin) disagreeSec += p.dur;
    const t = matched.get(p.est) ?? { large: 0, majmin: 0 };
    const ref = majminLabelSymbol(p.ref);
    if (pk.large === ref) t.large += p.dur;
    if (pk.majmin === ref) t.majmin += p.dur;
    matched.set(p.est, t);
  }
  const oracle = beat.score((s, i) => {
    const t = matched.get(`${s}.${i}`);
    return t && t.majmin > t.large ? picks[s][i].majmin : picks[s][i].large;
  });

  return {
    id: m.id,
    youtubeId: m.youtubeId,
    majmin: official.score,
    evaluatedSec: official.evaluatedSec,
    anatomy: Object.fromEntries(ANATOMY_KEYS.map((k) => [k, anatomySec[k] / total])) as Record<AnatomyKey, number>,
    topK: { top1: topSec[0] / topTotal, top2: topSec[1] / topTotal, top3: topSec[2] / topTotal },
    ceilings,
    majminModel: {
      disagreeUnits: allUnits.filter((u) => u.large !== u.majmin).length / allUnits.length,
      disagreeTime: disagreeSec / topTotal,
      largeArgmax: beat.score((s, i) => picks[s][i].large),
      majminArgmax: beat.score((s, i) => picks[s][i].majmin),
      oracle,
    },
  };
}

type Numeric = { [k: string]: number | Numeric };

/** Song means of every numeric field (same shape as SongAnalysis minus ids). */
export function songMeans(rows: SongAnalysis[]): Numeric {
  const pick = ({ id: _i, youtubeId: _y, ...rest }: SongAnalysis) => rest as unknown as Numeric;
  const meanOf = (xs: Numeric[]): Numeric => {
    const out: Numeric = {};
    for (const k of Object.keys(xs[0])) {
      const v = xs[0][k];
      out[k] = typeof v === 'number' ? xs.reduce((a, x) => a + (x[k] as number), 0) / xs.length : meanOf(xs.map((x) => x[k] as Numeric));
    }
    return out;
  };
  return rows.length ? meanOf(rows.map(pick)) : {};
}

const pc = (x: number) => `${(100 * x).toFixed(1)}`;

/** Short text: one line per song and the song means. */
export function analysisText(rows: SongAnalysis[]): string {
  const line = (name: string, r: Omit<SongAnalysis, 'id' | 'youtubeId'>) =>
    `${name}: majmin ${pc(r.majmin)} | exact ${pc(r.anatomy.exact)} fifth ${pc(r.anatomy.fifthRoot)} par ${pc(r.anatomy.parallel)} rel ${pc(r.anatomy.relative)} semi ${pc(r.anatomy.semitoneRoot)} other ${pc(r.anatomy.other)} falseN ${pc(r.anatomy.falseN)} chord@N ${pc(r.anatomy.chordForRefN)}` +
    ` | top1/2/3 ${pc(r.topK.top1)}/${pc(r.topK.top2)}/${pc(r.topK.top3)} | ceil beat ${pc(r.ceilings.beat)} half ${pc(r.ceilings.halfBeat)} frame ${pc(r.ceilings.frame)}` +
    ` | majmin model: disagree ${pc(r.majminModel.disagreeUnits)}% units, large ${pc(r.majminModel.largeArgmax)} mm ${pc(r.majminModel.majminArgmax)} oracle ${pc(r.majminModel.oracle)}`;
  const out = rows.map((r) => line(r.id, r));
  if (rows.length) out.push(line(`song mean (${rows.length})`, songMeans(rows) as unknown as SongAnalysis));
  return out.join('\n');
}
