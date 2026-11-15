/** Pure logic for the side-panel chart editor (sequence paste, stamping, tap tempo). */
import { respellChartForKey, prettyChord } from '../music/key';
import { isNoChord, parseChord } from '../arrange/chord';
import { sameChordSymbol } from './correct';
import { quantizeTime } from '../chart/timing';
import type { Chart, ChordEvent, Recording, Timing } from '../chart/types';
import { validateChart } from '../chart/validate';

export interface ParsedSequence {
  chords: string[];
  errors: string[];
}

/** "C G | Am F" or one chord per line; bar lines, commas and repeat dots are ignored. */
export function parseChordSequence(text: string): ParsedSequence {
  const tokens = text
    .split(/[\s|,]+/)
    .map((t) => t.trim())
    .filter((t) => t && !/^[:.%]+$/.test(t));
  const chords: string[] = [];
  const errors: string[] = [];
  for (const t of tokens) {
    if (isNoChord(t)) {
      chords.push('N');
      continue;
    }
    try {
      parseChord(t);
      chords.push(t);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { chords, errors };
}

export interface TempoFit {
  bpm: number;
  /** Time of the first tap, treated as a downbeat (snapped onto the fitted line). */
  firstDownbeatSec: number;
  /** RMS deviation of taps from the fitted grid, in seconds. */
  jitterSec: number;
  taps: number;
}

/**
 * Least-squares fit of tap times (playback seconds, one tap per beat, first tap on a downbeat).
 * Returns null with fewer than 4 taps.
 */
export function fitTapTempo(tapTimes: number[]): TempoFit | null {
  const n = tapTimes.length;
  if (n < 4) return null;
  const xs = tapTimes.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = tapTimes.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (tapTimes[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxy / sxx;
  if (!(slope > 0)) return null;
  const intercept = my - slope * mx;
  let err = 0;
  for (let i = 0; i < n; i++) err += (tapTimes[i] - (intercept + slope * i)) ** 2;
  return {
    bpm: Math.round((60 / slope) * 10) / 10,
    firstDownbeatSec: Math.max(0, Math.round(intercept * 1000) / 1000),
    jitterSec: Math.sqrt(err / n),
    taps: n,
  };
}

/** Taps further apart than this restart the tap-tempo sequence. */
export const TAP_RESET_GAP_SEC = 2.5;

export function addTap(taps: number[], time: number): number[] {
  const last = taps[taps.length - 1];
  if (last !== undefined && (time - last > TAP_RESET_GAP_SEC || time <= last)) return [time];
  return [...taps, time];
}

export interface StampState {
  chords: string[];
  stamps: number[];
}

export function stamp(state: StampState, time: number): StampState {
  if (state.stamps.length >= state.chords.length) return state;
  const last = state.stamps[state.stamps.length - 1];
  if (last !== undefined && time <= last) return state;
  return { ...state, stamps: [...state.stamps, Math.round(time * 1000) / 1000] };
}

export function undoStamp(state: StampState): StampState {
  return { ...state, stamps: state.stamps.slice(0, -1) };
}

export function nextToStamp(state: StampState): string | null {
  return state.chords[state.stamps.length] ?? null;
}

/**
 * Snap stamps to the beat grid (subdivision steps per beat), keeping them strictly increasing.
 * Times in `keep` (event starts of the loaded chart) are left where they are.
 */
export function quantizeStamps(stamps: number[], timing: Timing, subdivision = 1, keep: ReadonlySet<number> = new Set()): number[] {
  const out: number[] = [];
  for (const s of stamps) {
    let q = keep.has(s) ? s : Math.max(0, Math.round(quantizeTime(timing, s, subdivision) * 1000) / 1000);
    const prev = out[out.length - 1];
    if (prev !== undefined && q <= prev) q = s > prev ? s : prev + 0.001;
    out.push(q);
  }
  return out;
}

export interface BuildChartInput {
  recording: Recording;
  timing: Timing;
  chords: string[];
  stamps: number[];
  /** Song duration if known; used for coverage end. */
  durationSec?: number;
  existing?: Chart | null;
  now?: Date;
}

/**
 * What happened to an automatic (or edited) chart's information on save:
 * - 'kept': event times unchanged, so unchanged events keep their source/confidence and
 *   the heard coverage (gaps included) stays; only changed chords became manual.
 * - 'lost': times changed, so every event became manual and coverage one continuous range.
 * - 'none': nothing to keep (new chart or a hand-made chart).
 */
export type Preservation = 'kept' | 'lost' | 'none';

export interface BuiltChart {
  chart: Chart;
  preservation: Preservation;
  /** Events saved as manual because they are new or their chord changed ('kept' only). */
  changed: number;
}

export function buildChartDetailed(input: BuildChartInput): BuiltChart {
  const n = Math.min(input.chords.length, input.stamps.length);
  const existing = input.existing ?? null;
  const prev = existing && existing.provenance.createdBy !== 'manual' ? existing.events : null;
  const sameTimes = !!prev && prev.length === n && prev.every((e, i) => e.startSec === input.stamps[i]);
  const preservation: Preservation = !prev ? 'none' : sameTimes ? 'kept' : 'lost';
  const events: ChordEvent[] = [];
  let changed = 0;
  for (let i = 0; i < n; i++) {
    const old = sameTimes ? prev![i] : null;
    if (old && sameChordSymbol(old.chord, input.chords[i])) events.push({ ...old });
    else {
      if (sameTimes) changed++;
      // A changed chord at a kept time remembers the first recognized one, as 코드 고치기 does.
      const auto = old ? (old.source === 'auto' ? { chord: old.chord, confidence: old.confidence } : old.auto) : undefined;
      events.push({ startSec: input.stamps[i], chord: input.chords[i], confidence: 1, source: 'manual', ...(auto ? { auto } : {}) });
    }
  }
  const barSec = (60 / input.timing.bpm) * input.timing.beatsPerBar;
  const lastStart = events.length ? events[events.length - 1].startSec : 0;
  const end = input.durationSec && input.durationSec > lastStart ? input.durationSec : lastStart + barSec;
  const nowIso = (input.now ?? new Date()).toISOString();
  const chart: Chart = {
    schemaVersion: 1,
    recording: input.recording,
    timing: input.timing,
    events,
    coverage:
      preservation === 'kept'
        ? existing!.coverage.map((r) => ({ ...r }))
        : events.length ? [{ fromSec: Math.min(events[0].startSec, input.timing.firstDownbeatSec), toSec: end }] : [],
    provenance: existing
      ? { ...existing.provenance, createdBy: 'edited', updatedAt: nowIso, example: undefined }
      : { createdBy: 'manual', createdAt: nowIso, tool: 'vibe-guitar side panel editor' },
  };
  if (chart.provenance.example === undefined) delete chart.provenance.example;
  const v = validateChart(chart);
  if (!v.ok) throw new Error(`built chart is invalid: ${v.errors.join('; ')}`);
  return { chart, preservation, changed };
}

export function buildChart(input: BuildChartInput): Chart {
  return buildChartDetailed(input).chart;
}

/** Re-key a chart (e.g. an example) to another recording, keeping events and timing. */
export function attachChartToRecording(chart: Chart, recording: Recording): Chart {
  return { ...chart, recording: { ...recording }, provenance: { ...chart.provenance, note: `${chart.provenance.note ?? ''} (attached to ${recording.source}:${recording.id})`.trim() } };
}

export function chartToSequenceText(chart: Chart, perLine = 4): string {
  chart = respellChartForKey(chart).chart;
  const lines: string[] = [];
  for (let i = 0; i < chart.events.length; i += perLine) {
    lines.push(chart.events.slice(i, i + perLine).map((e) => prettyChord(e.chord)).join(' '));
  }
  return lines.join('\n');
}
