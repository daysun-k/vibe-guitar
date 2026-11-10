/**
 * Everything the play view draws, computed once per chart / settings / lyrics change:
 * key-aware spelling, bar-phase-aligned timing, big beats, the arrangement, lane bars,
 * sections, the chord-shape strip and lyrics shifted to chart time with chords anchored
 * to words. Per-frame state (current bar, countdown, lyric line) comes from `frameAt`.
 */
import { arrangeChart, suggestCapo, type Arrangement, type CapoSuggestion } from '../arrange/arrange';
import type { Level, Profile } from '../arrange/levels';
import type { Chart, Timing } from '../chart/types';
import { findEventIndex } from '../extension/playview';
import { estimateLyricOffset, nextLineAfter, pinnedLineAt, placeChords, shiftLyrics, type OffsetEstimate, type PlacedLine } from '../lyrics/align';
import { LYRICS_LIMITS } from '../lyrics/lrclib';
import type { Lyrics } from '../lyrics/types';
import { prettyChord, respellChartForKey, type KeyEstimate } from '../music/key';
import { alignBarPhase, bigBeatIndexAt, bigBeatInfo, bigBeatsUntil, type BigBeat, type PhaseEstimate } from '../music/meter';
import { buildLane, buildSections, droppedSeventh, simpleShape, stripItems, type LaneBar, type LaneSection, type StripItem } from './lane';

export interface PlayOptions {
  level: Level;
  capo: 'auto' | number;
  profile?: Profile;
  /** Playback duration from the player (0 = unknown). */
  durationSec?: number;
}

export interface EventLabel {
  /** Display name of the shape to play (♭/♯), "N.C." for rests. */
  name: string;
  /** Sounding chord when a capo is used (else equal to name). */
  sounding: string;
  /** Beginner reduction removed a 7th (tiny superscript 7). */
  had7: boolean;
  /** Intermediate+ and uncertain: an easier shape that also works ("Em도 돼요"). */
  hint: string | null;
}

export interface PlayModel {
  chart: Chart;
  key: KeyEstimate | null;
  timing: Timing;
  phase: PhaseEstimate;
  phaseShifted: boolean;
  big: BigBeat;
  arrangement: Arrangement;
  capoSuggestions: CapoSuggestion[];
  labels: EventLabel[];
  strip: StripItem[];
  stripKeys: string[];
  bars: LaneBar[];
  sections: LaneSection[];
  durationSec: number;
  lyrics: Lyrics | null;
  lyricOffset: OffsetEstimate | null;
  placed: PlacedLine[];
}

const ADVANCED_LEVELS: Level[] = ['intermediate', 'advanced'];

function changeTimes(chart: Chart): number[] {
  const out: number[] = [];
  chart.events.forEach((e, i) => {
    if (i > 0 && e.chord !== chart.events[i - 1].chord) out.push(e.startSec);
  });
  return out;
}

/**
 * Lyrics as stored (cache entries are untrusted): bounded line/word counts, finite and
 * non-negative times within the song, lines in order. Returns null when nothing usable is left.
 */
export function sanitizeLyrics(l: Lyrics, durationSec: number): Lyrics | null {
  const L = LYRICS_LIMITS;
  if (!l || !Array.isArray(l.lines) || l.lines.length === 0 || l.lines.length > L.maxLines) return null;
  const maxSec = durationSec > 0 ? durationSec + 60 : L.maxSec;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= maxSec;
  let words = 0;
  const lines: Lyrics['lines'] = [];
  for (const line of l.lines) {
    if (!line || !ok(line.startSec) || !Array.isArray(line.words) || line.words.length > L.maxWordsPerLine) return null;
    words += line.words.length;
    if (words > L.maxWords) return null;
    const ws = line.words.filter((w) => w && typeof w.text === 'string' && ok(w.startSec)).map((w) => ({ text: w.text.slice(0, 80), startSec: w.startSec }));
    const end = ok(line.endSec) && line.endSec >= line.startSec ? line.endSec : line.startSec + 5;
    lines.push({ startSec: line.startSec, endSec: end, text: String(line.text ?? '').slice(0, 400), words: ws, wordTimed: !!line.wordTimed && ws.length === line.words.length });
  }
  lines.sort((a, b) => a.startSec - b.startSec);
  return { kind: l.kind === 'lines' ? 'lines' : 'words', lines };
}

export function buildPlayModel(source: Chart, opts: PlayOptions, rawLyrics: Lyrics | null): PlayModel {
  const { chart, key } = respellChartForKey(source);
  const changes = changeTimes(chart);
  const aligned = alignBarPhase(chart.timing, changes);
  const timing = aligned.timing;
  const big = bigBeatInfo(timing);
  const capoSuggestions = suggestCapo(chart, opts.level, opts.profile);
  const capo = opts.capo === 'auto' ? (capoSuggestions[0]?.capo ?? 0) : opts.capo;
  const arrangement = arrangeChart({ ...chart, timing }, { level: opts.level, capo, profile: opts.profile });
  const labels: EventLabel[] = arrangement.events.map((e) => {
    if (e.rest || !e.shape) return { name: 'N.C.', sounding: 'N.C.', had7: false, hint: null };
    const name = capo ? e.shape : (e.sounding ?? e.shape);
    const simple = simpleShape(name);
    return {
      name: prettyChord(name),
      sounding: prettyChord(e.sounding ?? name),
      had7: droppedSeventh(e),
      hint: ADVANCED_LEVELS.includes(opts.level) && e.uncertain && simple !== name ? `${prettyChord(simple)}도 돼요` : null,
    };
  });
  const { items, keys } = stripItems(arrangement);
  let coverEnd = 0;
  for (const r of chart.coverage) coverEnd = Math.max(coverEnd, r.toSec);
  for (const e of arrangement.events) coverEnd = Math.max(coverEnd, e.endSec);
  const durationSec = Math.max(opts.durationSec ?? 0, coverEnd);
  const bars = buildLane(arrangement, timing, big, Math.min(durationSec, coverEnd + 0.01), (i) => keys[i] || labels[i].name);

  // Lyrics are optional: anything wrong with them degrades to "no lyrics", never to no chords.
  let lyrics: Lyrics | null = null;
  let lyricOffset: OffsetEstimate | null = null;
  let placed: PlacedLine[] = [];
  const usable = rawLyrics ? sanitizeLyrics(rawLyrics, durationSec) : null;
  if (usable) {
    try {
      lyricOffset = estimateLyricOffset(usable, changes);
      lyrics = shiftLyrics(usable, lyricOffset.offsetSec);
      const starts = arrangement.events.map((e) => e.startSec);
      placed = lyrics.lines.map((l) => placeChords(l, starts));
    } catch (e) {
      console.warn('lyrics ignored', e);
      lyrics = null;
      lyricOffset = null;
      placed = [];
    }
  }
  const sections = buildSections(bars, lyrics?.lines ?? null);
  return {
    chart,
    key,
    timing,
    phase: aligned.estimate,
    phaseShifted: aligned.shifted,
    big,
    arrangement,
    capoSuggestions,
    labels,
    strip: items,
    stripKeys: keys,
    bars,
    sections,
    durationSec,
    lyrics,
    lyricOffset,
    placed,
  };
}

export interface Frame {
  /** Active event index, -1 when no chord sounds. */
  event: number;
  /** Next chord event (skipping rests), -1 at the end or before a coverage gap. */
  next: number;
  /** Big beats until the next change (0 = none ahead). */
  bigLeft: number;
  /** Index into model.bars of the bar under the playhead, -1 before the first bar. */
  bar: number;
  /** Big beat inside the bar (0-based) and progress 0..1 through the bar. */
  bigInBar: number;
  barFraction: number;
  section: number;
  /** Pinned lyric line (-1 instrumental) and the following line. */
  line: number;
  nextLine: number;
}

/**
 * Event indices for the three-up shape strip: the sounding chord (or, between chords, the one coming
 * up), then each following change of shape. Rests and shapeless events are skipped, a repeat of the
 * same shape is not a change, and a coverage gap ends the run (what plays inside it is unknown).
 */
export function upcomingShapes(m: Pick<PlayModel, 'arrangement' | 'stripKeys'>, f: Pick<Frame, 'event' | 'next'>, count = 3): number[] {
  const ev = m.arrangement.events;
  const start = f.event >= 0 ? f.event : f.next;
  const out: number[] = [];
  if (start < 0) return out;
  let lastKey = '';
  for (let j = start; j < ev.length && out.length < count; j++) {
    if (j > start && ev[j - 1].endSec < ev[j].startSec - 1e-6) break;
    const k = m.stripKeys[j];
    if (k && k !== lastKey) {
      out.push(j);
      lastKey = k;
    }
  }
  return out;
}

export function frameAt(m: PlayModel, t: number): Frame {
  const ev = m.arrangement.events;
  const i = findEventIndex(ev, t);
  const event = i >= 0 && t < ev[i].endSec && !ev[i].rest ? i : -1;
  let next = -1;
  for (let j = Math.max(0, i + 1); j < ev.length; j++) {
    const prevEnd = j > 0 ? ev[j - 1].endSec : -Infinity;
    if (j > 0 && event >= 0 && j === event + 1 && prevEnd < ev[j].startSec - 1e-6) break; // coverage gap: next change unknown
    if (!ev[j].rest) {
      next = j;
      break;
    }
  }
  const bigLeft = next >= 0 ? bigBeatsUntil(m.timing, m.big, t, ev[next].startSec) : 0;
  let bar = -1;
  for (let k = m.bars.length - 1; k >= 0; k--) {
    if (m.bars[k].startSec <= t + 1e-3) {
      // Past the end of the last bar (a chart covering only part of a recording) there is no bar.
      bar = t < m.bars[k].endSec ? k : -1;
      break;
    }
  }
  let bigInBar = 0;
  let barFraction = 0;
  if (bar >= 0) {
    const b = m.bars[bar];
    barFraction = Math.min(1, Math.max(0, (t - b.startSec) / (b.endSec - b.startSec)));
    bigInBar = Math.floor(bigBeatIndexAt(m.timing, m.big, t) - bigBeatIndexAt(m.timing, m.big, b.startSec) + 1e-6);
  }
  let section = 0;
  m.sections.forEach((s, k) => {
    if (bar >= s.firstBar || (bar < 0 && t >= s.startSec)) section = k;
  });
  const lines = m.lyrics?.lines ?? [];
  const line = lines.length ? pinnedLineAt(lines, t) : -1;
  const nextLine = lines.length ? nextLineAfter(lines, t, line) : -1;
  return { event, next, bigLeft, bar, bigInBar, barFraction, section, line, nextLine };
}
