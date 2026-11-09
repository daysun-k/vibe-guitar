/**
 * Whole-song arrangement: per-event candidates (voicing changes + harmonic
 * substitutions) chosen jointly by dynamic programming over
 * static difficulty + transition cost, for a given capo; plus capo suggestion.
 */
import { beatsBetween, barSeconds } from '../chart/timing';
import type { Chart, Timing } from '../chart/types';
import { chordKey, formatChord, isNoChord, parseChord, transposeChord, type Chord } from './chord';
import { PENALTY, timePressure, transitionCost, voicingCost } from './cost';
import { fretString, type Voicing } from './guitar';
import { DEFAULT_PROFILE, LEVEL_CONFIGS, type Level, type LevelConfig, type Profile } from './levels';
import { reduceForLevel, substitutionCandidates, type ChordContext, type SubstitutionReason } from './transform';
import { voicingsForChord } from './voicings';

export interface ArrangeInputEvent {
  startSec: number;
  endSec: number;
  chord: string;
  confidence: number;
}

export type TransformationKind = 'voicing' | 'substitution' | 'merge';

export interface Transformation {
  kind: TransformationKind;
  from: string;
  to: string;
  reason: SubstitutionReason | 'easier-shape' | 'short-chord';
  detail?: string;
}

export interface ArrangedEvent {
  startSec: number;
  endSec: number;
  original: string;
  rest: boolean;
  /** Sounding chord after level simplification / substitution. */
  sounding: string | null;
  /** Shape name relative to the capo (equals sounding when capo = 0). */
  shape: string | null;
  voicing: Voicing | null;
  /** True when the sounding chord differs from the original (show a badge). */
  substitution: boolean;
  transformations: Transformation[];
  confidence: number;
  uncertain: boolean;
  /** Short passing chords absorbed into this event. */
  mergedFrom: string[];
  cost: number;
}

export interface Arrangement {
  level: Level;
  capo: number;
  events: ArrangedEvent[];
  totalCost: number;
  meanCost: number;
  unplayable: string[];
}

export interface ArrangeOptions {
  level: Level;
  capo: number;
  profile?: Profile;
}

const UNPLAYABLE_COST = 50;
const UNCERTAIN_BELOW = 0.5;

/**
 * Chart events → events with end times. Each event ends at the next event or at the
 * end of the coverage interval it starts in, whichever comes first (the last event of an
 * interval lasts to the interval end); events that start outside every coverage interval
 * are dropped. With no coverage at all, the last event lasts one bar.
 */
export function chartToInputEvents(chart: Chart): ArrangeInputEvent[] {
  const cov = [...chart.coverage].sort((a, b) => a.fromSec - b.fromSec);
  const out: ArrangeInputEvent[] = [];
  chart.events.forEach((e, i) => {
    const next = chart.events[i + 1];
    let end: number;
    if (cov.length) {
      const range = cov.find((c) => e.startSec >= c.fromSec && e.startSec < c.toSec);
      if (!range) return;
      end = next ? Math.min(next.startSec, range.toSec) : range.toSec;
    } else {
      end = next ? next.startSec : e.startSec + barSeconds(chart.timing);
    }
    out.push({ startSec: e.startSec, endSec: end, chord: e.chord, confidence: e.confidence });
  });
  return out;
}

interface WorkEvent extends ArrangeInputEvent {
  mergedFrom: string[];
}

const GAP_EPS = 1e-6;

/**
 * Merge chords shorter than level.minChordBeats into the previous chord. Never merges
 * across a rest ("N") on either side, nor across a coverage gap.
 */
export function mergeShortEvents(events: ArrangeInputEvent[], timing: Timing, minBeats: number): WorkEvent[] {
  const out: WorkEvent[] = [];
  for (const e of events) {
    const beats = beatsBetween(timing, e.startSec, e.endSec);
    const prev = out[out.length - 1];
    const mergeable =
      prev !== undefined &&
      minBeats > 0 &&
      beats < minBeats - 1e-6 &&
      !isNoChord(e.chord) &&
      !isNoChord(prev.chord) &&
      prev.endSec >= e.startSec - GAP_EPS;
    if (mergeable) {
      prev.endSec = e.endSec;
      prev.mergedFrom.push(e.chord);
      continue;
    }
    out.push({ ...e, mergedFrom: [] });
  }
  return out;
}

interface Candidate {
  /** null for rests ("N"). */
  sounding: Chord | null;
  shape: Chord | null;
  voicing: Voicing | null;
  cost: number;
  substitutionReason: SubstitutionReason | null;
}

interface EventPlan {
  original: Chord | null;
  reducedSteps: string[];
  reduced: Chord | null;
  candidates: Candidate[];
}

function standardVoicing(list: Voicing[]): Voicing | null {
  return list.find((v) => v.kind === 'open') ?? list.find((v) => v.kind === 'barre') ?? list[0] ?? null;
}

function planEvent(original: Chord | null, ctx: ChordContext, level: LevelConfig, profile: Profile, capo: number): EventPlan {
  if (!original) return { original: null, reducedSteps: [], reduced: null, candidates: [{ sounding: null, shape: null, voicing: null, cost: 0, substitutionReason: null }] };
  const red = reduceForLevel(original, level, ctx);
  const options: { chord: Chord; penalty: number; reason: SubstitutionReason | null }[] = [
    { chord: red.chord, penalty: 0, reason: red.changed ? 'level-simplify' : null },
    ...substitutionCandidates(red.chord, ctx, original).map((s) => ({
      chord: s.chord,
      penalty: s.weight * level.substitutionWeight * PENALTY.substitution,
      reason: s.reason,
    })),
  ];
  const candidates: Candidate[] = [];
  for (const opt of options) {
    const shape = transposeChord(opt.chord, -capo);
    for (const v of voicingsForChord(shape)) {
      candidates.push({
        sounding: opt.chord,
        shape,
        voicing: v,
        cost: voicingCost(v, shape.root, level, profile) + opt.penalty,
        substitutionReason: opt.reason,
      });
    }
  }
  if (candidates.length === 0) {
    const shape = transposeChord(red.chord, -capo);
    candidates.push({ sounding: red.chord, shape, voicing: null, cost: UNPLAYABLE_COST, substitutionReason: red.changed ? 'level-simplify' : null });
  }
  return { original, reducedSteps: red.steps, reduced: red.chord, candidates };
}

function parseOrNull(sym: string): Chord | null {
  if (isNoChord(sym)) return null;
  return parseChord(sym);
}

export function arrangeEvents(input: ArrangeInputEvent[], timing: Timing, opts: ArrangeOptions): Arrangement {
  const level = LEVEL_CONFIGS[opts.level];
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const capo = opts.capo;
  const events = mergeShortEvents(input, timing, level.minChordBeats);
  const chords = events.map((e) => parseOrNull(e.chord));

  const plans = events.map((_, i) => {
    const ctx: ChordContext = { prev: chords[i - 1] ?? null, next: chords[i + 1] ?? null };
    return planEvent(chords[i], ctx, level, profile, capo);
  });

  // Viterbi over candidates.
  const n = plans.length;
  const best: number[][] = [];
  const back: number[][] = [];
  for (let i = 0; i < n; i++) {
    const cands = plans[i].candidates;
    best[i] = new Array(cands.length).fill(Infinity);
    back[i] = new Array(cands.length).fill(-1);
    for (let j = 0; j < cands.length; j++) {
      if (i === 0) {
        best[i][j] = cands[j].cost;
        continue;
      }
      const prevCands = plans[i - 1].candidates;
      const pressure = timePressure(events[i - 1].endSec - events[i - 1].startSec, profile);
      const gap = events[i - 1].endSec < events[i].startSec - GAP_EPS;
      for (let k = 0; k < prevCands.length; k++) {
        const t = gap ? 0 : transitionCost(prevCands[k].voicing, cands[j].voicing) * pressure;
        const total = best[i - 1][k] + t + cands[j].cost;
        if (total < best[i][j]) {
          best[i][j] = total;
          back[i][j] = k;
        }
      }
    }
  }

  const choice: number[] = new Array(n).fill(0);
  let totalCost = 0;
  if (n > 0) {
    let j = best[n - 1].indexOf(Math.min(...best[n - 1]));
    totalCost = best[n - 1][j];
    for (let i = n - 1; i >= 0; i--) {
      choice[i] = j;
      j = back[i][j];
    }
  }

  const unplayable = new Set<string>();
  const arranged: ArrangedEvent[] = events.map((e, i) => {
    const plan = plans[i];
    const c = plan.candidates[choice[i]];
    const base = {
      startSec: e.startSec,
      endSec: e.endSec,
      original: e.chord,
      confidence: e.confidence,
      uncertain: e.confidence < UNCERTAIN_BELOW,
      mergedFrom: e.mergedFrom,
      cost: c.cost,
    };
    const transformations: Transformation[] = e.mergedFrom.map((m) => ({ kind: 'merge', from: m, to: e.chord, reason: 'short-chord' }));
    if (!plan.original) {
      return { ...base, rest: true, sounding: null, shape: null, voicing: null, substitution: false, transformations };
    }
    const originalName = formatChord(plan.original);
    const reducedName = formatChord(plan.reduced!);
    const soundingName = formatChord(c.sounding!);
    if (reducedName !== originalName) {
      transformations.push({ kind: 'substitution', from: e.chord, to: reducedName, reason: 'level-simplify', detail: plan.reducedSteps.join('; ') });
    }
    if (soundingName !== reducedName) {
      transformations.push({ kind: 'substitution', from: reducedName, to: soundingName, reason: c.substitutionReason ?? 'fallback' });
    }
    if (c.voicing) {
      const std = standardVoicing(voicingsForChord(c.shape!));
      if (std && std.id !== c.voicing.id && c.voicing.kind !== std.kind) {
        transformations.push({
          kind: 'voicing',
          from: `${std.kind} ${fretString(std.frets)}`,
          to: `${c.voicing.kind} ${fretString(c.voicing.frets)}`,
          reason: 'easier-shape',
        });
      }
    } else {
      unplayable.add(soundingName);
    }
    return {
      ...base,
      rest: false,
      sounding: soundingName,
      shape: formatChord(c.shape!),
      voicing: c.voicing,
      substitution: chordKey(c.sounding!) !== chordKey(plan.original),
      transformations,
    };
  });

  return {
    level: opts.level,
    capo,
    events: arranged,
    totalCost,
    meanCost: n ? totalCost / n : 0,
    unplayable: [...unplayable],
  };
}

export function arrangeChart(chart: Chart, opts: ArrangeOptions): Arrangement {
  return arrangeEvents(chartToInputEvents(chart), chart.timing, opts);
}

export interface CapoSuggestion {
  capo: number;
  score: number;
  /** Unique shapes played, in order of first appearance. */
  shapes: string[];
  substitutions: number;
}

/** Rank capo positions by the arranged cost (sounding key always stays the same). */
export function suggestCapo(chart: Chart, level: Level, profile: Profile = DEFAULT_PROFILE): CapoSuggestion[] {
  const input = chartToInputEvents(chart);
  const out: CapoSuggestion[] = [];
  for (let capo = profile.capoMin; capo <= profile.capoMax; capo++) {
    const a = arrangeEvents(input, chart.timing, { level, capo, profile });
    const shapes: string[] = [];
    for (const e of a.events) if (e.shape && !shapes.includes(e.shape)) shapes.push(e.shape);
    const score = a.meanCost + 0.1 * capo + (capo >= 5 ? 0.5 : 0);
    out.push({ capo, score: Math.round(score * 100) / 100, shapes, substitutions: a.events.filter((e) => e.substitution).length });
  }
  return out.sort((x, y) => x.score - y.score || x.capo - y.capo);
}

/** Unique voicings of an arrangement, for the "chords in this song" preview. */
export function uniqueVoicings(a: Arrangement): { shape: string; sounding: string; voicing: Voicing | null; substitution: boolean }[] {
  const seen = new Set<string>();
  const out: { shape: string; sounding: string; voicing: Voicing | null; substitution: boolean }[] = [];
  for (const e of a.events) {
    if (e.rest || !e.shape) continue;
    const key = `${e.shape}|${e.voicing?.id ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ shape: e.shape, sounding: e.sounding!, voicing: e.voicing, substitution: e.substitution });
  }
  return out;
}
