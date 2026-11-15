/**
 * Everything the play view draws, computed once per chart / settings / lyrics change:
 * key-aware spelling, bar-phase-aligned timing, big beats, the arrangement, lane bars,
 * sections, the chord-shape strip and lyrics shifted to chart time with chords anchored
 * to words. Per-frame state (current bar, countdown, lyric line) comes from `frameAt`.
 */
import { arrangeChart, suggestCapo, type Arrangement, type CapoSuggestion } from '../arrange/arrange';
import type { Level, Profile } from '../arrange/levels';
import { summarizeArrangement, type LevelSuitability } from '../arrange/suitability';
import { prepareChart } from './prepare';
import { coverageRangeAt, normalizeCoverage } from '../chart/coverage';
import { barSeconds } from '../chart/timing';
import type { Chart, Timing } from '../chart/types';
import { findEventIndex } from '../extension/playview';
import { estimateLyricOffset, nextLineAfter, pinnedLineAt, placeChords, shiftLyrics, type OffsetEstimate, type PlacedLine } from '../lyrics/align';
import { LYRICS_LIMITS } from '../lyrics/lrclib';
import type { Lyrics } from '../lyrics/types';
import { prettyChord, shapeName, type KeyEstimate } from '../music/key';
import { bigBeatIndexAt, bigBeatInfo, bigBeatsUntil, type BigBeat, type PhaseEstimate } from '../music/meter';
import { buildLane, buildSections, droppedSeventh, simpleShape, stripItems, type LaneBar, type LaneSection, type StripItem } from './lane';
import { laneStretches, markAt, uncertainMarks, type UncertainMark } from './uncertain';

export interface PlayOptions {
  level: Level;
  capo: 'auto' | number;
  profile?: Profile;
  /** Playback duration from the player (0 = unknown). */
  durationSec?: number;
  /** Allow root-changing (relative major/minor) substitutions. Default off. */
  allowRootChange?: boolean;
  /** 불확실한 곳 표시 (VGT-19): mark uncertain stretches and offer the second choice. Default on. */
  showUncertain?: boolean;
}

export interface EventLabel {
  /** Display name of the shape to play (♭/♯), "N.C." for rests. */
  name: string;
  /** Sounding chord when a capo is used (else equal to name). */
  sounding: string;
  /** Beginner reduction removed a 7th (shown through the change mark, not next to the name). */
  had7: boolean;
  /** Intermediate+ and uncertain: an easier shape that also works ("Em도 돼요"). */
  hint: string | null;
  /** The chord differs from the original: "F → Fmaj7" and why. */
  change: { from: string; to: string; badge: string; text: string; root: boolean; concert?: { from: string; to: string; text?: string } } | null;
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
  /** Shape suitability of the shown arrangement (current level). */
  suitability: LevelSuitability;
  labels: EventLabel[];
  strip: StripItem[];
  stripKeys: string[];
  bars: LaneBar[];
  sections: LaneSection[];
  durationSec: number;
  /** Visible uncertain stretches (empty when the switch is off or the chart has none). */
  uncertain: UncertainMark[];
  lyrics: Lyrics | null;
  lyricOffset: OffsetEstimate | null;
  placed: PlacedLine[];
}

const ADVANCED_LEVELS: Level[] = ['intermediate', 'advanced'];

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
  const prep = prepareChart(source);
  const { chart, key, timing, changes } = prep;
  const big = bigBeatInfo(timing);
  const manual = opts.capo === 'auto' ? undefined : opts.capo;
  const capoSuggestions = suggestCapo(chart, opts.level, opts.profile, { allowRootChange: opts.allowRootChange, extraCapo: manual });
  // The winning capo's arrangement is reused; a manual capo outside the ranked range is arranged here.
  const ranked = manual === undefined ? capoSuggestions[0] : capoSuggestions.find((s) => s.capo === manual);
  const capo = manual ?? capoSuggestions[0]?.capo ?? 0;
  const arrangement = ranked?.arrangement ?? arrangeChart(chart, { level: opts.level, capo, profile: opts.profile, allowRootChange: opts.allowRootChange });
  const suitability = summarizeArrangement(arrangement, timing, opts.capo === 'auto');
  const labels: EventLabel[] = arrangement.events.map((e) => {
    if (e.rest || !e.shape) return { name: 'N.C.', sounding: 'N.C.', had7: false, hint: null, change: null };
    const name = capo ? e.shape : (e.sounding ?? e.shape);
    const simple = simpleShape(name);
    return {
      name: prettyChord(name),
      sounding: prettyChord(e.sounding ?? name),
      had7: droppedSeventh(e),
      hint: ADVANCED_LEVELS.includes(opts.level) && e.uncertain && simple !== name ? `${prettyChord(simple)}도 돼요` : null,
      change: e.change ? { from: shapeName(e.change.original, capo), to: prettyChord(e.shape),
        badge: e.change.codes.length === 1 && e.change.code === 'merge' && shapeName(e.change.original, capo) === prettyChord(e.shape)
          ? `${e.mergedFrom.map((n) => shapeName(n, capo)).join('·')} 합침`
          : `${shapeName(e.change.original, capo)}→${prettyChord(e.shape)}`, concert: capo ? { from: prettyChord(e.change.original), to: prettyChord(e.change.sounding), text: e.mergedFrom.length ? `합친 실제 코드: ${e.mergedFrom.map(prettyChord).join(', ')}` : undefined } : undefined, text: e.change.text, root: e.change.rootChanged } : null,
    };
  });
  const { items, keys } = stripItems(arrangement);
  let coverEnd = 0;
  for (const r of chart.coverage) coverEnd = Math.max(coverEnd, r.toSec);
  for (const e of arrangement.events) coverEnd = Math.max(coverEnd, e.endSec);
  const durationSec = Math.max(opts.durationSec ?? 0, coverEnd);
  const labelAt = (sec: number): string | null => {
    const i = arrangement.events.findIndex((e) => sec >= e.startSec && sec < e.endSec);
    return i >= 0 ? labels[i].name : null;
  };
  const uncertain = uncertainMarks(source, arrangement, key, timing, labelAt, opts.showUncertain !== false, { level: opts.level, capo, profile: opts.profile, allowRootChange: opts.allowRootChange });
  // The lane draws marks joined over small gaps (VGT-19 Amendment 2); a segment's flag then names
  // the stretch's first mark, so `flag` stays an index into model.uncertain.
  const stretches = laneStretches(uncertain);
  const bars = buildLane(arrangement, timing, big, Math.min(durationSec, coverEnd + 0.01), (i) => keys[i] || labels[i].name, (i) => !!arrangement.events[i]?.change, stretches.length ? stretches : undefined);
  for (const b of bars) for (const s of b.segments) if (s.flag >= 0) s.flag = stretches[s.flag].parts[0];

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
    phase: prep.phase,
    phaseShifted: prep.phaseShifted,
    big,
    arrangement,
    capoSuggestions,
    suitability,
    labels,
    strip: items,
    stripKeys: keys,
    bars,
    sections,
    durationSec,
    uncertain,
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
  /** Index into model.uncertain of the uncertain stretch under the playhead, -1 when none. */
  uncertain: number;
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
  // A chord stretch counts under a sounding chord, a no-chord stretch where none sounds.
  const k = markAt(m.uncertain, t);
  const uncertain = k >= 0 && m.uncertain[k].noChord === event < 0 ? k : -1;
  return { event, next, bigLeft, bar, bigInBar, barFraction, section, line, nextLine, uncertain };
}

/**
 * Time range of chart event i as 코드 고치기 shows it, the same end the arrangement gives it: the next
 * event's start or the end of the heard range it starts in, whichever comes first (the last event of a
 * range lasts to the range end). With no heard ranges the last event lasts one bar; an event starting
 * outside every heard range ends at the next event (or at its own start).
 */
export function chartEventRange(chart: Pick<Chart, 'events' | 'coverage' | 'timing'>, i: number): { startSec: number; endSec: number } {
  const e = chart.events[i];
  const next = chart.events[i + 1];
  const cov = normalizeCoverage(chart.coverage);
  if (!cov.length) return { startSec: e.startSec, endSec: next ? next.startSec : e.startSec + barSeconds(chart.timing) };
  const range = coverageRangeAt(cov, e.startSec);
  if (!range) return { startSec: e.startSec, endSec: next ? Math.max(e.startSec, next.startSec) : e.startSec };
  return { startSec: e.startSec, endSec: next ? Math.min(next.startSec, range.toSec) : range.toSec };
}

/**
 * Lane bars (indexes into m.bars) that draw chart event i, for 코드 고치기's outline: a bar holding a
 * segment that shows the event's arranged event (an empty segment for a rest) and overlaps the event's
 * range. The lane's own cut rules decide, so a sliver the lane leaves out of a bar does not count, and a
 * short chord merged into the previous one counts only where its own time is drawn. When the lane draws
 * the event nowhere (a sliver at a bar's start), the bar holding its start stands in.
 */
export function barsForChartEvent(m: Pick<PlayModel, 'chart' | 'arrangement' | 'bars'>, i: number): number[] {
  if (!m.chart.events[i]) return [];
  const { startSec, endSec } = chartEventRange(m.chart, i);
  const ev = m.arrangement.events;
  const k = findEventIndex(ev, startSec + 1e-6);
  const id = k >= 0 && startSec < ev[k].endSec && !ev[k].rest ? k : -1;
  const out = m.bars.flatMap((b, n) => b.segments.some((s) => s.event === id && Math.min(s.endSec, endSec) - Math.max(s.startSec, startSec) > 1e-6) ? [n] : []);
  if (out.length) return out;
  const at = m.bars.findIndex((b) => startSec + 0.001 >= b.startSec && startSec + 0.001 < b.endSec);
  return at >= 0 ? [at] : [];
}

/** Every bar occupied by this hard shape, including sustained events and repeat bars. */
export function barsForHardChord(m: PlayModel, shape: string): number[] {
  return m.bars.flatMap((b, i) => b.segments.some((s) => s.event >= 0 && m.arrangement.events[s.event].shape === shape) ? [i] : []);
}

/** Optional secondary text; the primary shape names never depend on this switch. */
export function changeConcertLabel(c: NonNullable<EventLabel['change']>, showSounding: boolean, includeMerge = true): string {
  return showSounding && c.concert ? `실제 ${c.concert.from} → ${c.concert.to}${includeMerge && c.concert.text ? ` · ${c.concert.text}` : ''}` : '';
}
