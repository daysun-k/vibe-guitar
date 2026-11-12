/**
 * VGT-13 "song view": what the phone music stand needs from the play model, and nothing else.
 *
 * Built in the side panel from the same PlayModel the play view draws (arranged events, the same
 * shape names and diagram voicings, bars, sections, big-beat timing, capo), validated again by the
 * relay and the phone, and read on the phone with `phoneFrame`, which mirrors the play view's
 * `frameAt` + `upcomingShapes`. Lyrics, audio, chart history and storage keys are never part of it.
 */
import type { Finger, Fret, Voicing } from '../arrange/guitar';
import type { Timing } from '../chart/types';
import { findEventIndex } from '../extension/playview';
import { bigBeatInfo, bigBeatsUntil, type BigBeat } from '../music/meter';
import type { PlayModel } from '../play/model';

export const SONG_VIEW_LIMITS = {
  events: 3000,
  bars: 2000,
  beats: 8000,
  shapes: 96,
  sections: 200,
  text: 120,
  name: 16,
  sectionName: 24,
  durationSec: 4 * 3600,
} as const;

/** A distinct shape as the play view shows it: display name, sounding name and diagram voicing. */
export interface ShapeView {
  name: string;
  sounding: string;
  /** Low E to high e; null = muted. Null when the shape has no diagram ("운지 없음"). */
  frets: Fret[] | null;
  fingers: Finger[] | null;
}

export interface SongView {
  v: 1;
  title: string;
  artist: string;
  /** Capo of the shown arrangement (0 = none): shape names are capo shapes when > 0. */
  capo: number;
  /** 실제 음 이름 보기 is on in the panel (the phone then also shows the sounding name). */
  showSounding: boolean;
  durationSec: number;
  timing: { bpm: number; beatsPerBar: number; beatUnit: 4 | 8; firstDownbeatSec: number; beatTimes?: number[] };
  shapes: ShapeView[];
  /**
   * Flat triples per arranged event, in play-model order: startSec, endSec, shape. Shape is an
   * index into `shapes`, -1 for a rest and -2 for a chord without a shape (shown as N.C.).
   */
  events: number[];
  /** Flat pairs per lane bar: startSec, endSec. */
  bars: number[];
  /** Section name, its first bar index and its start time. */
  sections: [string, number, number][];
}

export const REST = -1;
export const NO_SHAPE = -2;

const NAME_RE = /^[\p{L}\p{N}#♯♭+\-/().,°ø^Δ△*' ]{1,16}$/u;
const TEXT_BAD = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const ms = (x: number) => Math.round(x * 1000) / 1000;

function safeName(s: string): string {
  const out = [...s.replace(/[^\p{L}\p{N}#♯♭+\-/().,°ø^Δ△*' ]/gu, '')].slice(0, SONG_VIEW_LIMITS.name).join('').trim();
  return out || '?';
}

function safeText(s: string | undefined, max: number = SONG_VIEW_LIMITS.text): string {
  return [...String(s ?? '').replace(TEXT_BAD, ' ')].slice(0, max).join('').trim();
}

export interface SongViewOptions {
  title?: string;
  artist?: string;
  showSounding: boolean;
}

/** The song view of a play model; null when it exceeds the limits (the phone then shows no song). */
export function buildSongView(m: Pick<PlayModel, 'arrangement' | 'labels' | 'stripKeys' | 'bars' | 'sections' | 'timing' | 'durationSec'>, opts: SongViewOptions): SongView | null {
  const shapes: ShapeView[] = [];
  const byKey = new Map<string, number>();
  const events: number[] = [];
  m.arrangement.events.forEach((e, i) => {
    let s: number = REST;
    if (!e.rest) {
      const key = m.stripKeys[i];
      if (!key) s = NO_SHAPE;
      else {
        let k = byKey.get(key);
        if (k === undefined) {
          k = shapes.length;
          byKey.set(key, k);
          const lab = m.labels[i]!;
          const v: Voicing | null = e.voicing;
          shapes.push({ name: safeName(lab.name), sounding: safeName(lab.sounding), frets: v ? [...v.frets] : null, fingers: v ? [...v.fingers] : null });
        }
        s = k;
      }
    }
    events.push(ms(e.startSec), ms(Math.max(e.startSec, e.endSec)), s);
  });
  const t = m.timing;
  const timing: SongView['timing'] = { bpm: t.bpm, beatsPerBar: t.beatsPerBar, beatUnit: t.beatUnit === 8 ? 8 : 4, firstDownbeatSec: t.firstDownbeatSec };
  if (t.beatTimes && t.beatTimes.length) timing.beatTimes = t.beatTimes.map(ms);
  const view: SongView = {
    v: 1,
    title: safeText(opts.title),
    artist: safeText(opts.artist),
    capo: m.arrangement.capo,
    showSounding: opts.showSounding,
    durationSec: ms(m.durationSec),
    timing,
    shapes,
    events,
    bars: m.bars.flatMap((b) => [ms(b.startSec), ms(Math.max(b.startSec, b.endSec))]),
    sections: m.sections.map((s) => [safeText(s.name, SONG_VIEW_LIMITS.sectionName) || '–', s.firstBar, ms(s.startSec)]),
  };
  return validateSongView(view);
}

// ---------- validation (relay and phone) ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finite(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}
function int(v: unknown, min: number, max: number): v is number {
  return finite(v, min, max) && Number.isInteger(v);
}
function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}
function text(v: unknown, max: number): v is string {
  return typeof v === 'string' && [...v].length <= max && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v);
}

const T_MIN = -60;
const T_MAX = SONG_VIEW_LIMITS.durationSec + 60;

function sixOf(v: unknown, ok: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.length === 6 && v.every(ok);
}

/** A validated copy of a song view (unknown fields dropped by construction), or null. */
export function validateSongView(v: unknown): SongView | null {
  const L = SONG_VIEW_LIMITS;
  if (!isObj(v) || !onlyKeys(v, ['v', 'title', 'artist', 'capo', 'showSounding', 'durationSec', 'timing', 'shapes', 'events', 'bars', 'sections'])) return null;
  if (v.v !== 1 || !text(v.title, L.text) || !text(v.artist, L.text) || !int(v.capo, 0, 12) || typeof v.showSounding !== 'boolean') return null;
  if (!finite(v.durationSec, 0, L.durationSec)) return null;
  const t = v.timing;
  if (!isObj(t) || !onlyKeys(t, ['bpm', 'beatsPerBar', 'beatUnit', 'firstDownbeatSec', 'beatTimes'])) return null;
  if (!finite(t.bpm, 20, 400) || !int(t.beatsPerBar, 1, 16) || (t.beatUnit !== 4 && t.beatUnit !== 8) || !finite(t.firstDownbeatSec, T_MIN, T_MAX)) return null;
  let beatTimes: number[] | undefined;
  if (t.beatTimes !== undefined) {
    if (!Array.isArray(t.beatTimes) || t.beatTimes.length > L.beats) return null;
    for (let i = 0; i < t.beatTimes.length; i++) {
      const b = t.beatTimes[i];
      if (!finite(b, T_MIN, T_MAX) || (i > 0 && b < t.beatTimes[i - 1])) return null;
    }
    beatTimes = [...t.beatTimes];
  }
  if (!Array.isArray(v.shapes) || v.shapes.length > L.shapes) return null;
  const shapes: ShapeView[] = [];
  for (const s of v.shapes) {
    if (!isObj(s) || !onlyKeys(s, ['name', 'sounding', 'frets', 'fingers'])) return null;
    if (typeof s.name !== 'string' || !NAME_RE.test(s.name) || typeof s.sounding !== 'string' || !NAME_RE.test(s.sounding)) return null;
    if ((s.frets === null) !== (s.fingers === null)) return null;
    if (s.frets !== null && !sixOf(s.frets, (x) => x === null || int(x, 0, 24))) return null;
    if (s.fingers !== null && !sixOf(s.fingers, (x) => x === null || int(x, 0, 4))) return null;
    shapes.push({ name: s.name, sounding: s.sounding, frets: s.frets === null ? null : [...(s.frets as Fret[])], fingers: s.fingers === null ? null : [...(s.fingers as Finger[])] });
  }
  const ev = v.events;
  if (!Array.isArray(ev) || ev.length % 3 !== 0 || ev.length / 3 > L.events) return null;
  for (let i = 0; i < ev.length; i += 3) {
    if (!finite(ev[i], T_MIN, T_MAX) || !finite(ev[i + 1], ev[i], T_MAX) || !int(ev[i + 2], NO_SHAPE, shapes.length - 1)) return null;
    if (i > 0 && ev[i] < ev[i - 3]) return null;
  }
  const bars = v.bars;
  if (!Array.isArray(bars) || bars.length % 2 !== 0 || bars.length / 2 > L.bars) return null;
  for (let i = 0; i < bars.length; i += 2) {
    if (!finite(bars[i], T_MIN, T_MAX) || !finite(bars[i + 1], bars[i], T_MAX)) return null;
    if (i > 0 && bars[i] < bars[i - 2]) return null;
  }
  if (!Array.isArray(v.sections) || v.sections.length > L.sections) return null;
  const sections: [string, number, number][] = [];
  for (const s of v.sections) {
    if (!Array.isArray(s) || s.length !== 3 || !text(s[0], L.sectionName) || !int(s[1], 0, Math.max(0, bars.length / 2 - 1)) || !finite(s[2], T_MIN, T_MAX)) return null;
    sections.push([s[0], s[1], s[2]]);
  }
  const timing: SongView['timing'] = { bpm: t.bpm, beatsPerBar: t.beatsPerBar, beatUnit: t.beatUnit, firstDownbeatSec: t.firstDownbeatSec };
  if (beatTimes) timing.beatTimes = beatTimes;
  return {
    v: 1,
    title: v.title,
    artist: v.artist,
    capo: v.capo,
    showSounding: v.showSounding,
    durationSec: v.durationSec,
    timing,
    shapes,
    events: [...(ev as number[])],
    bars: [...(bars as number[])],
    sections,
  };
}

// ---------- reading a song view (phone) ----------

export interface PhoneSong {
  view: SongView;
  timing: Timing;
  big: BigBeat;
  events: { startSec: number; endSec: number; shape: number }[];
  bars: { startSec: number; endSec: number }[];
}

export function readSongView(view: SongView): PhoneSong {
  const timing: Timing = { ...view.timing };
  const events = [];
  for (let i = 0; i < view.events.length; i += 3) events.push({ startSec: view.events[i]!, endSec: view.events[i + 1]!, shape: view.events[i + 2]! });
  const bars = [];
  for (let i = 0; i < view.bars.length; i += 2) bars.push({ startSec: view.bars[i]!, endSec: view.bars[i + 1]! });
  return { view, timing, big: bigBeatInfo(timing), events, bars };
}

export interface PhoneFrame {
  /** Event sounding now with a shape, -1 when none (rest, gap, N.C.). */
  nowEvent: number;
  /** Next change of shape (the play view's next strip slot), -1 when none is known. */
  nextEvent: number;
  /** Whole big beats until `nextEvent` starts (0 when there is none). */
  beatsLeft: number;
  /** Lane bar under the playhead, -1 outside every bar. */
  bar: number;
  section: number;
}

/**
 * The phone's frame at song time `t`: the same event, bar and section rules as `frameAt`, and the
 * same shape run as `upcomingShapes` (a repeat of the same shape is not a change, a coverage gap
 * ends the run). The countdown targets the next *shape change*, so it never counts down to the
 * chord already under the fingers.
 */
export function phoneFrame(s: PhoneSong, t: number): PhoneFrame {
  const ev = s.events;
  const i = findEventIndex(ev, t);
  const event = i >= 0 && t < ev[i]!.endSec && ev[i]!.shape !== REST ? i : -1;
  let next = -1;
  for (let j = Math.max(0, i + 1); j < ev.length; j++) {
    const prevEnd = j > 0 ? ev[j - 1]!.endSec : -Infinity;
    if (j > 0 && event >= 0 && j === event + 1 && prevEnd < ev[j]!.startSec - 1e-6) break;
    if (ev[j]!.shape !== REST) {
      next = j;
      break;
    }
  }
  // upcomingShapes: start at the sounding event (or the one coming up), collect shape changes.
  const start = event >= 0 ? event : next;
  const up: number[] = [];
  if (start >= 0) {
    let last = -99;
    for (let j = start; j < ev.length && up.length < 2; j++) {
      if (j > start && ev[j - 1]!.endSec < ev[j]!.startSec - 1e-6) break;
      const k = ev[j]!.shape;
      if (k >= 0 && k !== last) {
        up.push(j);
        last = k;
      }
    }
  }
  const nowEvent = event >= 0 && ev[event]!.shape >= 0 && up[0] === event ? event : -1;
  const nextEvent = (nowEvent >= 0 ? up[1] : up[0]) ?? -1;
  const beatsLeft = nextEvent >= 0 ? bigBeatsUntil(s.timing, s.big, t, ev[nextEvent]!.startSec) : 0;
  let bar = -1;
  for (let k = s.bars.length - 1; k >= 0; k--) {
    if (s.bars[k]!.startSec <= t + 1e-3) {
      bar = t < s.bars[k]!.endSec ? k : -1;
      break;
    }
  }
  let section = 0;
  s.view.sections.forEach(([, firstBar, startSec], k) => {
    if (bar >= firstBar || (bar < 0 && t >= startSec)) section = k;
  });
  return { nowEvent, nextEvent, beatsLeft, bar, section };
}

/** Voicing for the diagram renderer (renderShapeDiagram reads chord, frets and fingers). */
export function shapeVoicing(s: ShapeView): Voicing | null {
  if (!s.frets || !s.fingers) return null;
  return { id: 'phone', chord: s.name, frets: s.frets, fingers: s.fingers, kind: 'open', origin: 'db' };
}
