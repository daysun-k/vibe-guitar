/**
 * LRCLIB client (https://lrclib.net): query cleaning, response parsing and the
 * get → search fallback. Only title, artist and duration leave the browser.
 *
 * Response fields used:
 *  - lyricsfile: YAML with per-line `words[].start_ms` (word-level timing)
 *  - syncedLyrics: LRC text with per-line `[mm:ss.xx]` times
 */
import type { LyricLine, Lyrics } from './types';

export const LRCLIB_ORIGIN = 'https://lrclib.net';

export interface LyricsQuery {
  track: string;
  artist: string;
}

/** Bracketed parts that are about the video, not the song. */
const VIDEO_TAG =
  /\b(official|lyric|lyrics|video|audio|visuali[sz]er|mv|m\/v|hd|hq|4k|remaster(ed)?|live|performance|clip|color coded|eng sub|가사|뮤직비디오|공식)\b/i;

function stripVideoTags(s: string): string {
  let out = s.replace(/\s*[[(【「]([^\])】」]*)[\])】」]/g, (m, inner: string) => (VIDEO_TAG.test(inner) || /^\s*(feat|ft)\.?\s/i.test(inner) ? '' : m));
  out = out.replace(/\s+(feat|ft)\.?\s.*$/i, '');
  out = out.replace(/\s*[|｜].*$/, '');
  out = out.replace(/\s+(official\s+)?(music\s+)?(lyric\s+)?video\s*$/i, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

function cleanChannel(s: string): string {
  return s
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*(official|공식)(\s+(channel|youtube))?$/i, '')
    .trim();
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Turn a page title and channel/artist into an LRCLIB query.
 * "Ed Sheeran - Perfect [Official Lyric Video]" by "Ed Sheeran" → { artist: "Ed Sheeran", track: "Perfect" }.
 */
export function cleanTrackQuery(title: string, artist: string): LyricsQuery {
  const channel = cleanChannel(artist || '');
  const t = stripVideoTags(title || '');
  const parts = t.split(/\s+[-–—~]\s+/);
  if (parts.length >= 2) {
    const left = parts[0].trim();
    const right = parts.slice(1).join(' - ').trim();
    // "Artist - Title" is the common order; "Title - Artist" when the channel matches the right side.
    if (channel && norm(right) === norm(channel) && norm(left) !== norm(channel)) return { artist: channel, track: stripVideoTags(left) };
    return { artist: left, track: stripVideoTags(right) };
  }
  return { artist: channel, track: t };
}

export function getUrl(q: LyricsQuery, durationSec: number): string {
  const p = new URLSearchParams({ artist_name: q.artist, track_name: q.track, duration: String(Math.round(durationSec)) });
  return `${LRCLIB_ORIGIN}/api/get?${p}`;
}

export function searchUrl(q: LyricsQuery): string {
  const p = new URLSearchParams({ track_name: q.track });
  if (q.artist) p.set('artist_name', q.artist);
  return `${LRCLIB_ORIGIN}/api/search?${p}`;
}

/** The subset of an LRCLIB record we read. */
export interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  syncedLyrics?: string | null;
  lyricsfile?: string | null;
}

// ---------- lyricsfile (YAML subset) ----------

function yamlScalar(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Parse the `lines:` block of an LRCLIB lyricsfile:
 *   lines:
 *   - text: ...
 *     start_ms: 2960
 *     end_ms: 7409
 *     words:
 *     - text: ...
 *       start_ms: 2960
 * Returns null when there is no usable line.
 */
export function parseLyricsfile(yaml: string): LyricLine[] | null {
  type Raw = { text: string; start?: number; end?: number; words: { text: string; start?: number }[] };
  const raws: Raw[] = [];
  let inLines = false;
  let cur: Raw | null = null;
  for (const line of yaml.split(/\r?\n/)) {
    if (!inLines) {
      if (/^lines:\s*$/.test(line)) inLines = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('- ')) break; // next top-level key (e.g. "plain:")
    let m = /^- text:\s?(.*)$/.exec(line);
    if (m) {
      cur = { text: yamlScalar(m[1]), words: [] };
      raws.push(cur);
      continue;
    }
    if (!cur) continue;
    m = /^ {2}(start_ms|end_ms):\s*(\d+)\s*$/.exec(line);
    if (m) {
      if (m[1] === 'start_ms') cur.start = Number(m[2]) / 1000;
      else cur.end = Number(m[2]) / 1000;
      continue;
    }
    m = /^ {2}- text:\s?(.*)$/.exec(line);
    if (m) {
      cur.words.push({ text: yamlScalar(m[1]) });
      continue;
    }
    m = /^ {4}start_ms:\s*(\d+)\s*$/.exec(line);
    if (m && cur.words.length) cur.words[cur.words.length - 1].start = Number(m[1]) / 1000;
  }
  const out: LyricLine[] = [];
  raws.forEach((r, i) => {
    const words = r.words.filter((w) => w.text.trim() && w.start !== undefined).map((w) => ({ text: w.text.trim(), startSec: w.start! }));
    const start = r.start ?? words[0]?.startSec;
    if (start === undefined || !r.text.trim()) return;
    const nextStart = raws[i + 1]?.start;
    const end = r.end ?? nextStart ?? start + 5;
    if (words.length && words.length === r.words.length) out.push({ startSec: start, endSec: Math.max(end, start + 0.2), text: r.text.trim(), words, wordTimed: true });
    else out.push(interpolatedLine(r.text.trim(), start, Math.max(end, start + 0.2)));
  });
  return out.length ? out : null;
}

// ---------- syncedLyrics (LRC) ----------

/** Words spread over the line by character count (used when only line times exist). */
export function interpolatedLine(text: string, startSec: number, endSec: number): LyricLine {
  const tokens = text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((a, w) => a + w.length + 1, 0) || 1;
  const span = Math.max(0.2, Math.min(endSec - startSec, 8));
  let acc = 0;
  const words = tokens.map((w) => {
    const startAt = startSec + (acc / total) * span;
    acc += w.length + 1;
    return { text: w, startSec: Math.round(startAt * 1000) / 1000 };
  });
  return { startSec, endSec, text, words, wordTimed: false };
}

/** Parse LRC "[mm:ss.xx] text" lines; an empty text line ends the previous line. */
export function parseSyncedLyrics(lrc: string, durationSec?: number): LyricLine[] | null {
  const stamps: { t: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) stamps.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  stamps.sort((a, b) => a.t - b.t);
  const out: LyricLine[] = [];
  stamps.forEach((s, i) => {
    if (!s.text) return;
    const next = stamps[i + 1]?.t ?? (durationSec ?? s.t + 6);
    const end = Math.min(next, s.t + 8);
    out.push(interpolatedLine(s.text, s.t, Math.max(end, s.t + 0.5)));
  });
  return out.length ? out : null;
}

/** Best lyrics in a record: word-level lyricsfile, then line-level syncedLyrics, else null. */
export function lyricsFromRecord(r: LrclibRecord): Lyrics | null {
  if (r.instrumental) return null;
  if (r.lyricsfile) {
    const lines = parseLyricsfile(r.lyricsfile);
    if (lines && lines.some((l) => l.wordTimed)) return { kind: 'words', lines };
  }
  if (r.syncedLyrics) {
    const lines = parseSyncedLyrics(r.syncedLyrics, r.duration);
    if (lines) return { kind: 'lines', lines };
  }
  return null;
}

/** Pick the search result closest in duration (±4 s) that has synced lyrics; word-level preferred. */
export function pickSearchResult(results: LrclibRecord[], q: LyricsQuery, durationSec: number): LrclibRecord | null {
  const ok = results.filter((r) => !r.instrumental && (r.lyricsfile || r.syncedLyrics) && (r.duration === undefined || Math.abs(r.duration - durationSec) <= 4));
  const score = (r: LrclibRecord) =>
    (r.lyricsfile ? 0 : 10) + Math.abs((r.duration ?? durationSec) - durationSec) + (q.artist && r.artistName && norm(r.artistName) !== norm(q.artist) ? 3 : 0);
  return ok.sort((a, b) => score(a) - score(b))[0] ?? null;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type LyricsLookup =
  | { status: 'found'; lyrics: Lyrics; record: { id?: number; trackName?: string; artistName?: string }; via: 'get' | 'search' }
  | { status: 'not-found' };

/** /api/get first, /api/search as fallback. Network or server errors throw (not cached by callers). */
export async function lookupLyrics(q: LyricsQuery, durationSec: number, fetchFn: FetchLike): Promise<LyricsLookup> {
  if (!q.track) return { status: 'not-found' };
  const headers = { 'Lrclib-Client': 'vibe-guitar (personal chrome extension)' };
  const res = await fetchFn(getUrl(q, durationSec), { headers });
  if (res.ok) {
    const rec = (await res.json()) as LrclibRecord;
    const lyrics = lyricsFromRecord(rec);
    if (lyrics) return { status: 'found', lyrics, record: pickMeta(rec), via: 'get' };
  } else if (res.status !== 404) {
    throw new Error(`lrclib get ${res.status}`);
  }
  const sr = await fetchFn(searchUrl(q), { headers });
  if (!sr.ok) {
    if (sr.status === 404) return { status: 'not-found' };
    throw new Error(`lrclib search ${sr.status}`);
  }
  const list = (await sr.json()) as LrclibRecord[];
  const best = Array.isArray(list) ? pickSearchResult(list, q, durationSec) : null;
  const lyrics = best ? lyricsFromRecord(best) : null;
  return best && lyrics ? { status: 'found', lyrics, record: pickMeta(best), via: 'search' } : { status: 'not-found' };
}

function pickMeta(r: LrclibRecord): { id?: number; trackName?: string; artistName?: string } {
  return { id: r.id, trackName: r.trackName, artistName: r.artistName };
}
