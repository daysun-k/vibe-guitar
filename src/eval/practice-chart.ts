/**
 * Practice charts (VGT-5 preparation): a ready-to-play chart for one exact upload from a public
 * human chord annotation and a frozen time map (docs/recognition-dev-maps.json), so the chords
 * and their times do not depend on anyone's ear.
 *
 * Time convention as in annotations.ts: media time = offsetSec + rate × annotation time.
 * Chords use the evaluator's Harte mapping (harteToSymbol: concert pitch, sharp names; the play
 * view respells for the key). The bar grid comes from the annotation's own beat file (beats
 * with their position in the bar) through the same map, or, without one, from the beat grid the
 * app's tracker stored for that upload.
 */
import type { Chart, ChordEvent, CoverageRange, Recording, Timing } from '../chart/types';
import { NO_CHORD } from '../chart/types';
import { chordPitchClasses, parseChord } from '../arrange/chord';
import { beatIndexAt, beatTimeAt } from '../chart/timing';
import { harteNotes, harteToSymbol, type AnnotationBeat, type AnnotationSegment } from './annotations';
import { median } from './metrics';

export interface TimeMap {
  offsetSec: number;
  rate: number;
}

export const mapTime = (map: TimeMap, t: number) => map.offsetSec + map.rate * t;
const ms = (x: number) => Math.round(x * 1000) / 1000;

/** How one annotation label became a chart chord. */
export interface LabelUse {
  label: string;
  chord: string;
  /**
   * 'exact': the symbol names the label's notes; 'simplified': the evaluator's nearest symbol names
   * other notes (see `notes`); 'unknown-as-N': Harte "X" (no chord could be named) shown as no chord.
   */
  kind: 'exact' | 'simplified' | 'unknown-as-N';
  /** For 'simplified': note names the symbol adds to and drops from the label's notes. */
  notes?: { added: string[]; dropped: string[] };
  /** Annotated seconds (media time inside coverage) carrying this label. */
  sec: number;
}

export class PracticeChartError extends Error {}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Chart chord for one label: the evaluator's symbol, N for N and X; throws when a label has no symbol. */
export function practiceChord(label: string): { chord: string; kind: LabelUse['kind']; notes?: LabelUse['notes'] } {
  const h = harteToSymbol(label);
  if (h.kind === 'chord') {
    const n = harteNotes(label);
    if ('reason' in n) throw new PracticeChartError(`label "${label}": ${n.reason}`);
    const want = new Set([n.root, ...[...n.semis].map((x) => (n.root + x) % 12), ...(n.bass === null ? [] : [n.bass])]);
    const got = new Set(chordPitchClasses(parseChord(h.symbol)));
    const added = [...got].filter((x) => !want.has(x)).sort((a, b) => a - b).map((x) => NOTE_NAMES[x]);
    const dropped = [...want].filter((x) => !got.has(x)).sort((a, b) => a - b).map((x) => NOTE_NAMES[x]);
    if (added.length || dropped.length) return { chord: h.symbol, kind: 'simplified', notes: { added, dropped } };
    return { chord: h.symbol, kind: 'exact' };
  }
  if (h.kind === 'N') return { chord: NO_CHORD, kind: 'exact' };
  if (h.kind === 'X') return { chord: NO_CHORD, kind: 'unknown-as-N' };
  throw new PracticeChartError(`label "${label}" has no chart symbol (${h.reason})`);
}

export interface PracticeEvents {
  events: ChordEvent[];
  coverage: CoverageRange[];
  labels: LabelUse[];
}

/**
 * Annotation segments → manual events in media time. Coverage is the whole annotated stretch
 * (lead-in N included), cut to [0, mediaDurationSec]. A segment mapped before 0 s starts at 0 s
 * (only the last of those is kept); segments starting at or after the coverage end are dropped;
 * a segment repeating the previous chord continues it (one event).
 */
export function practiceEvents(segs: AnnotationSegment[], map: TimeMap, mediaDurationSec: number): PracticeEvents {
  if (!segs.length) throw new PracticeChartError('the annotation has no segments');
  const from = Math.max(0, ms(mapTime(map, segs[0].startSec)));
  const to = Math.min(mediaDurationSec, ms(mapTime(map, Math.max(...segs.map((s) => s.endSec)))));
  if (!(to > from)) throw new PracticeChartError('the mapped annotation does not overlap the upload');
  const events: ChordEvent[] = [];
  const uses = new Map<string, LabelUse>();
  for (const s of segs) {
    const { chord, kind, notes } = practiceChord(s.label);
    const a = Math.max(from, ms(mapTime(map, s.startSec)));
    const b = Math.min(to, ms(mapTime(map, s.endSec)));
    if (b > a) {
      const u = uses.get(s.label) ?? { label: s.label, chord, kind, ...(notes ? { notes } : {}), sec: 0 };
      u.sec += b - a;
      uses.set(s.label, u);
    }
    if (a >= to) continue;
    const last = events[events.length - 1];
    if (last && a <= last.startSec) {
      // Both clamped to the coverage start: the later segment is the one sounding there.
      last.chord = chord;
      continue;
    }
    if (last && last.chord === chord) continue;
    events.push({ startSec: a, chord, confidence: 1, source: 'manual' });
  }
  // Clamping can leave a repeat behind (A clamped, then replaced by B equal to the next one).
  const merged = events.filter((e, i) => i === 0 || e.chord !== events[i - 1].chord);
  const labels = [...uses.values()].map((u) => ({ ...u, sec: ms(u.sec) })).sort((x, y) => y.sec - x.sec);
  return { events: merged, coverage: [{ fromSec: from, toSec: to }], labels };
}

/** A bar of the annotation whose beat count differs from the meter (its grid beats were spread evenly). */
export interface IrregularBar {
  /** Media time of its downbeat. */
  atSec: number;
  beats: number;
}

export interface PracticeGrid {
  timing: Timing;
  irregularBars: IrregularBar[];
  /** Beats before the first downbeat at or after 0 s (pickup), left to the bpm extrapolation. */
  droppedLeadBeats: number;
}

/**
 * Annotated beats with bar positions (Isophonics "time position") → an explicit beat grid whose
 * index 0 is a downbeat, in media time. The meter is the most common bar length. A bar of another
 * length that is followed by a downbeat gets exactly beatsPerBar grid beats spread evenly to the
 * next downbeat, so every later downbeat stays on its annotated time (the lane counts bars as
 * beatsPerBar grid beats); the final bar keeps its beats as annotated.
 */
export function practiceGrid(beats: AnnotationBeat[], map: TimeMap): PracticeGrid {
  if (beats.some((b) => b.position === null)) throw new PracticeChartError('the beat file has no bar positions');
  const mapped = beats.map((b) => ({ sec: mapTime(map, b.sec), position: b.position as number }));
  const bars: number[][] = [];
  let lead = 0;
  for (const b of mapped) {
    if (b.position === 1 && b.sec >= 0) bars.push([b.sec]);
    else if (bars.length) bars[bars.length - 1].push(b.sec);
    else lead++;
  }
  if (bars.length < 2) throw new PracticeChartError('the beat file has fewer than two downbeats at or after 0 s');
  const counts = new Map<number, number>();
  for (const bar of bars.slice(0, -1)) counts.set(bar.length, (counts.get(bar.length) ?? 0) + 1);
  const beatsPerBar = [...counts.entries()].sort((x, y) => y[1] - x[1] || y[0] - x[0])[0][0];
  if (beatsPerBar < 1 || beatsPerBar > 16) throw new PracticeChartError(`unsupported bar length ${beatsPerBar}`);
  const out: number[] = [];
  const irregularBars: IrregularBar[] = [];
  bars.forEach((bar, i) => {
    const next = bars[i + 1];
    if (!next || bar.length === beatsPerBar) {
      out.push(...bar);
      return;
    }
    irregularBars.push({ atSec: ms(bar[0]), beats: bar.length });
    const d = (next[0] - bar[0]) / beatsPerBar;
    for (let k = 0; k < beatsPerBar; k++) out.push(bar[0] + k * d);
  });
  const beatTimes = out.map(ms);
  for (let i = 1; i < beatTimes.length; i++) {
    if (beatTimes[i] <= beatTimes[i - 1]) throw new PracticeChartError(`beat grid not ascending at ${beatTimes[i]} s`);
  }
  const step = median(beatTimes.slice(1).map((x, i) => x - beatTimes[i]));
  const bpm = Math.round((600 / step)) / 10;
  if (!(bpm > 0 && bpm <= 400)) throw new PracticeChartError(`implied tempo ${bpm} bpm is out of range`);
  return {
    timing: { bpm, beatsPerBar, beatUnit: 4, firstDownbeatSec: beatTimes[0], beatTimes },
    irregularBars,
    droppedLeadBeats: lead,
  };
}

export interface PracticeChartInput {
  segs: AnnotationSegment[];
  map: TimeMap;
  mediaDurationSec: number;
  recording: Recording;
  /** Bar grid: from practiceGrid (annotated beats) or the tracker timing stored for the upload. */
  timing: Timing;
  createdAt: string;
  tool: string;
  note: string;
}

/** Largest move of a chord change onto the grid: the smaller of these seconds and beats. */
export const SNAP_MAX_SEC = 0.15;
export const SNAP_MAX_BEATS = 0.25;

export interface SnapStats {
  /** Chord changes moved onto a half-beat grid point. */
  moved: number;
  /** Already on a grid point (within 1 ms). */
  onGrid: number;
  /** Left as annotated: farther than the limit, a coverage start, or a move that would reorder events. */
  kept: number;
  medianAbsShiftSec: number;
  maxAbsShiftSec: number;
  /** Mean of grid point minus annotated time over the moved ones (positive: annotation was early). */
  meanShiftSec: number;
}

/**
 * Chord changes → the nearest half-beat point of the chart's own grid when it is at most
 * min(SNAP_MAX_SEC, SNAP_MAX_BEATS beats) away, the way the editor quantizes stamps. Annotated
 * chord boundaries sit a few hundredths of a second off the annotated beats (mostly early); left
 * as they are, a two-beat chord measures 1.9x beats and the beginner arrangement (chords shorter
 * than two beats merged into the previous one) folds whole phrases into one chord. A change at a
 * coverage start stays; a move must keep the events strictly increasing and inside coverage.
 */
export function snapEvents(events: ChordEvent[], timing: Timing, coverage: CoverageRange[]): { events: ChordEvent[]; stats: SnapStats } {
  const out: ChordEvent[] = [];
  const shifts: number[] = [];
  let onGrid = 0;
  let kept = 0;
  events.forEach((e, i) => {
    const prev = out[out.length - 1];
    const next = events[i + 1];
    const range = coverage.find((r) => r.fromSec <= e.startSec && e.startSec < r.toSec);
    const k = beatIndexAt(timing, e.startSec);
    const target = ms(beatTimeAt(timing, Math.round(k * 2) / 2));
    const beat = beatTimeAt(timing, Math.floor(k) + 1) - beatTimeAt(timing, Math.floor(k));
    const limit = Math.min(SNAP_MAX_SEC, SNAP_MAX_BEATS * beat);
    const shift = target - e.startSec;
    const allowed =
      range !== undefined &&
      e.startSec !== range.fromSec &&
      Math.abs(shift) <= limit + 1e-9 &&
      target >= range.fromSec &&
      target < range.toSec &&
      (!prev || target > prev.startSec) &&
      (!next || target < next.startSec);
    if (!allowed) {
      kept++;
      out.push(e);
    } else if (Math.abs(shift) <= 0.001) {
      onGrid++;
      out.push(e);
    } else {
      shifts.push(shift);
      out.push({ ...e, startSec: target });
    }
  });
  const abs = shifts.map(Math.abs);
  return {
    events: out,
    stats: {
      moved: shifts.length,
      onGrid,
      kept,
      medianAbsShiftSec: abs.length ? ms(median(abs)) : 0,
      maxAbsShiftSec: abs.length ? ms(Math.max(...abs)) : 0,
      meanShiftSec: shifts.length ? ms(shifts.reduce((a, b) => a + b, 0) / shifts.length) : 0,
    },
  };
}

export function buildPracticeChart(input: PracticeChartInput): { chart: Chart; labels: LabelUse[]; snap: SnapStats } {
  const built = practiceEvents(input.segs, input.map, input.mediaDurationSec);
  const { coverage, labels } = built;
  const { events, stats } = snapEvents(built.events, input.timing, coverage);
  const snapText =
    `Chord changes moved to the nearest half beat of this grid when at most ${SNAP_MAX_SEC} s and ${SNAP_MAX_BEATS} beat away ` +
    `(${stats.moved} moved, median ${stats.medianAbsShiftSec.toFixed(3)} s, max ${stats.maxAbsShiftSec.toFixed(3)} s; ${stats.onGrid} already on it; ${stats.kept} kept as annotated).`;
  const chart: Chart = {
    schemaVersion: 1,
    recording: input.recording,
    timing: input.timing,
    events,
    coverage,
    provenance: { createdBy: 'manual', createdAt: input.createdAt, tool: input.tool, note: `${input.note} ${snapText}` },
  };
  return { chart, labels, snap: stats };
}

/** Chord sounding at media time t in a chart (the last event at or before t), or null before the first. */
function chordAt(events: ChordEvent[], t: number): string | null {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].startSec <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : events[found].chord;
}

export interface Agreement {
  /** Sampled seconds inside the chart's coverage. */
  evaluatedSec: number;
  /** Share of them where the chart chord equals the annotation label's symbol at that time. */
  exact: number;
  /** Seconds where the annotation says X (unknown) and the chart shows no chord. */
  unknownAsNoChordSec: number;
  /** Disagreeing stretches (media time), merged, longest first, at most 20. */
  mismatches: { fromSec: number; toSec: number; chart: string | null; annotation: string }[];
}

/**
 * Time-weighted agreement of a chart with the annotation, checked independently of the event
 * construction: every `stepSec` of the coverage is mapped back to annotation time, the label there
 * is looked up and mapped (X counts as no chord) and compared with the chart's chord at that time.
 * With `boundaryTolSec`, times that close to a mapped annotation boundary are skipped (the chord
 * order check once changes were moved onto the grid).
 */
export function practiceAgreement(chart: Chart, segs: AnnotationSegment[], map: TimeMap, stepSec = 0.005, boundaryTolSec = 0): Agreement {
  let total = 0;
  let same = 0;
  let unknown = 0;
  const bad: Agreement['mismatches'] = [];
  for (const r of chart.coverage) {
    for (let t = r.fromSec + stepSec / 2; t < r.toSec; t += stepSec) {
      const a = (t - map.offsetSec) / map.rate;
      const seg = segs.find((s) => s.startSec <= a && a < s.endSec);
      if (!seg) continue;
      if (boundaryTolSec > 0 && Math.min(t - mapTime(map, seg.startSec), mapTime(map, seg.endSec) - t) < boundaryTolSec) continue;
      const want = practiceChord(seg.label);
      const got = chordAt(chart.events, t);
      total += stepSec;
      if (got === want.chord) {
        same += stepSec;
        if (want.kind === 'unknown-as-N') unknown += stepSec;
      } else {
        const last = bad[bad.length - 1];
        if (last && Math.abs(last.toSec - (t - stepSec / 2)) < 1e-6 && last.chart === got && last.annotation === seg.label) last.toSec = t + stepSec / 2;
        else bad.push({ fromSec: t - stepSec / 2, toSec: t + stepSec / 2, chart: got, annotation: seg.label });
      }
    }
  }
  const mismatches = bad
    .map((m) => ({ ...m, fromSec: ms(m.fromSec), toSec: ms(m.toSec) }))
    .sort((x, y) => y.toSec - y.fromSec - (x.toSec - x.fromSec))
    .slice(0, 20);
  return { evaluatedSec: ms(total), exact: total ? same / total : 0, unknownAsNoChordSec: ms(unknown), mismatches };
}

export interface GridCheck {
  /** Chart grid beats inside the tracker's range. */
  compared: number;
  /** Median absolute distance to the nearest tracker beat (s). */
  medianAbsSec: number;
  /** Median of nearest tracker beat minus grid beat (s): a constant phase difference shows here. */
  medianSignedSec: number;
  /** Share within ±0.07 s (the evaluator's beat tolerance). */
  within70ms: number;
}

/**
 * Agreement of the chart's beat grid with beats the app's tracker found in the same upload (an
 * audio check that does not use the annotation's chords): how far each grid beat is from the
 * nearest tracker beat.
 */
export function gridCheck(gridBeats: number[], trackerBeats: number[]): GridCheck | null {
  const tb = [...trackerBeats].sort((a, b) => a - b);
  if (tb.length < 8) return null;
  const inside = gridBeats.filter((b) => b >= tb[0] && b <= tb[tb.length - 1]);
  if (!inside.length) return null;
  const res = inside.map((b) => {
    let lo = 0;
    let hi = tb.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tb[mid] <= b) lo = mid;
      else hi = mid;
    }
    return Math.abs(tb[lo] - b) <= Math.abs(tb[hi] - b) ? tb[lo] - b : tb[hi] - b;
  });
  const abs = res.map(Math.abs);
  return {
    compared: inside.length,
    medianAbsSec: ms(median(abs)),
    medianSignedSec: ms(median(res)),
    within70ms: abs.filter((x) => x <= 0.07 + 1e-9).length / abs.length,
  };
}
