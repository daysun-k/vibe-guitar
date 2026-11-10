/**
 * Lyrics ↔ chart alignment: a constant time offset, chords anchored to words, and the
 * line to pin at the playhead.
 *
 * Offset: lyric databases time words against one release; a video can be shifted by a
 * fraction of a second. Chord changes tend to land on sung syllables, so we slide the
 * lyrics over −1.5…+1.5 s and keep the shift that puts the most chord changes within
 * ±0.15 s of a word onset. The shift is used only when it clearly beats both the
 * unshifted lyrics and the scan's typical (chance) level; otherwise the offset stays 0.
 */
import type { LyricLine, Lyrics } from './types';

export interface OffsetEstimate {
  /** Seconds added to every lyric time to reach chart time. */
  offsetSec: number;
  hits: number;
  hitsAtZero: number;
  /** Median hits over the scan (chance level). */
  baseline: number;
  confident: boolean;
}

export interface OffsetOptions {
  rangeSec?: number;
  stepSec?: number;
  toleranceSec?: number;
}

function onsets(l: Lyrics): number[] {
  const out: number[] = [];
  for (const line of l.lines) {
    if (line.wordTimed) for (const w of line.words) out.push(w.startSec);
    else out.push(line.startSec);
  }
  return out.sort((a, b) => a - b);
}

/** Changes within `tol` of a (shifted) word onset, and their summed distance. */
function countHits(sortedOnsets: number[], changes: number[], shift: number, tol: number): { hits: number; err: number } {
  let hits = 0;
  let err = 0;
  for (const c of changes) {
    const target = c - shift;
    let lo = 0;
    let hi = sortedOnsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedOnsets[mid] < target - tol) lo = mid + 1;
      else hi = mid;
    }
    const d = sortedOnsets.length ? Math.abs(sortedOnsets[lo] - target) : Infinity;
    if (d <= tol) {
      hits++;
      err += d;
    }
  }
  return { hits, err };
}

export function estimateLyricOffset(l: Lyrics, changeTimes: number[], opts: OffsetOptions = {}): OffsetEstimate {
  const range = opts.rangeSec ?? 1.5;
  const step = opts.stepSec ?? 0.05;
  const tol = opts.toleranceSec ?? 0.15;
  const on = onsets(l);
  if (!on.length || !changeTimes.length) return { offsetSec: 0, hits: 0, hitsAtZero: 0, baseline: 0, confident: false };
  const first = on[0] - range - tol;
  const last = on[on.length - 1] + range + tol;
  const changes = changeTimes.filter((c) => c >= first && c <= last);
  const n = Math.round(range / step);
  const scan: { off: number; hits: number; err: number }[] = [];
  for (let i = -n; i <= n; i++) {
    const off = Math.round(i * step * 1000) / 1000;
    scan.push({ off, ...countHits(on, changes, off, tol) });
  }
  const hitsAtZero = scan[n].hits;
  // Most hits; on a plateau of equal hits, the shift with the smallest total distance.
  let best = scan[n];
  for (const s of scan) {
    if (s.hits > best.hits || (s.hits === best.hits && s.err < best.err - 1e-9) || (s.hits === best.hits && Math.abs(s.err - best.err) <= 1e-9 && Math.abs(s.off) < Math.abs(best.off))) best = s;
  }
  const sorted = scan.map((s) => s.hits).sort((a, b) => a - b);
  const baseline = sorted[sorted.length >> 1];
  const confident = best.off !== 0 && best.hits >= 6 && best.hits - hitsAtZero >= 3 && best.hits >= baseline * 1.25 && best.hits - baseline >= 4;
  return { offsetSec: confident ? best.off : 0, hits: best.hits, hitsAtZero, baseline, confident };
}

export function shiftLyrics(l: Lyrics, offsetSec: number): Lyrics {
  if (!offsetSec) return l;
  const r = (x: number) => Math.round((x + offsetSec) * 1000) / 1000;
  return {
    kind: l.kind,
    lines: l.lines.map((line) => ({ ...line, startSec: r(line.startSec), endSec: r(line.endSec), words: line.words.map((w) => ({ ...w, startSec: r(w.startSec) })) })),
  };
}

export interface PlacedLine {
  /** Event index (into the given change list) shown over each word, or null. */
  anchors: (number | null)[];
  /** When word placement is doubtful: every change in the line, shown over the first word. */
  fallback: number[] | null;
}

/** Median |change − nearest word onset| above this marks the line's word placement doubtful. */
const DOUBT_SEC = 0.5;

/**
 * Anchor each chord change inside the line to the word being sung when it happens.
 * `eventStarts` are chart-time starts of the events (ascending).
 */
export function placeChords(line: LyricLine, eventStarts: number[]): PlacedLine {
  const ws = line.words;
  const inside: number[] = [];
  eventStarts.forEach((t, j) => {
    if (t >= line.startSec - 0.35 && t < line.endSec) inside.push(j);
  });
  const anchors: (number | null)[] = ws.map(() => null);
  if (!ws.length) return { anchors, fallback: inside.length ? inside : null };
  if (!line.wordTimed) return { anchors, fallback: inside.length ? inside : null };
  const resid: number[] = [];
  for (const j of inside) {
    const te = eventStarts[j];
    let wi = 0;
    ws.forEach((w, i) => {
      if (w.startSec <= te + 0.25) wi = i;
    });
    if (te < ws[ws.length - 1].startSec + 0.3) {
      let d = Infinity;
      for (const w of ws) d = Math.min(d, Math.abs(w.startSec - te));
      resid.push(d);
    }
    if (anchors[wi] !== null && wi + 1 < ws.length && anchors[wi + 1] === null) wi++;
    anchors[wi] = j; // a later change on the same word wins
  }
  resid.sort((a, b) => a - b);
  const med = resid.length ? resid[resid.length >> 1] : 0;
  if (med > DOUBT_SEC) return { anchors: ws.map(() => null), fallback: inside };
  return { anchors, fallback: null };
}

/**
 * Line to pin at `t`: the sung line (held 1 s after it ends), else the next line when it
 * starts within 1.5 s; -1 = instrumental.
 */
export function pinnedLineAt(lines: LyricLine[], t: number): number {
  let i = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].startSec <= t + 0.05) i = k;
    else break;
  }
  if (i >= 0 && t < lines[i].endSec + 1) {
    const next = lines[i + 1];
    if (next && t >= lines[i].endSec && next.startSec - t <= 1.5) return i + 1;
    return i;
  }
  const next = lines[i + 1];
  if (next && next.startSec - t <= 1.5) return i + 1;
  return -1;
}

/** Index of the first line starting after `t` (for the "다음" preview), or -1. */
export function nextLineAfter(lines: LyricLine[], t: number, pinned: number): number {
  if (pinned >= 0) return pinned + 1 < lines.length ? pinned + 1 : -1;
  const k = lines.findIndex((l) => l.startSec > t);
  return k;
}
