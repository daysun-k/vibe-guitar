// Synthetic lyrics only: no real song text and no network calls in these tests.
import { describe, expect, it, vi } from 'vitest';
import { estimateLyricOffset, pinnedLineAt, placeChords, shiftLyrics } from '../src/lyrics/align';
import {
  cleanTrackQuery,
  getUrl,
  lookupLyrics,
  lyricsFromRecord,
  parseLyricsfile,
  parseSyncedLyrics,
  pickSearchResult,
  searchUrl,
  type FetchLike,
} from '../src/lyrics/lrclib';
import type { Lyrics } from '../src/lyrics/types';
import { LyricsService, lyricsKey } from '../src/extension/lyrics-service';

const YAML = `version: '1.0'
metadata:
  title: Demo
  duration_ms: 60000
lines:
- text: alpha beta gamma
  start_ms: 1000
  end_ms: 3000
  words:
  - text: alpha
    start_ms: 1000
  - text: 'beta''s'
    start_ms: 1500
  - text: "gamma"
    start_ms: 2200
- text: delta epsilon
  start_ms: 5000
  end_ms: 6500
  words:
  - text: delta
    start_ms: 5000
  - text: epsilon
    start_ms: 5600
plain: |
  alpha beta gamma
`;

describe('LRCLIB query cleaning', () => {
  it('splits "Artist - Title [Official Lyric Video]"', () => {
    expect(cleanTrackQuery('Some Artist - Song Title [Official Lyric Video]', 'Some Artist')).toEqual({ artist: 'Some Artist', track: 'Song Title' });
    expect(cleanTrackQuery('Some Artist – Song (Official Music Video) (feat. Other)', 'SomeArtistVEVO')).toEqual({ artist: 'Some Artist', track: 'Song' });
  });

  it('uses the channel as artist when the title has no dash, and handles "Title - Artist"', () => {
    expect(cleanTrackQuery('Song Title (Audio)', 'Band - Topic')).toEqual({ artist: 'Band', track: 'Song Title' });
    expect(cleanTrackQuery('Song Title - Band', 'Band')).toEqual({ artist: 'Band', track: 'Song Title' });
    expect(cleanTrackQuery('Song (Live at Somewhere) | Session', 'Band')).toEqual({ artist: 'Band', track: 'Song' });
  });

  it('builds get and search URLs with only title, artist and duration', () => {
    const u = new URL(getUrl({ artist: 'A B', track: 'C' }, 263.4));
    expect(u.origin + u.pathname).toBe('https://lrclib.net/api/get');
    expect([...u.searchParams.keys()].sort()).toEqual(['artist_name', 'duration', 'track_name']);
    expect(u.searchParams.get('duration')).toBe('263');
    expect(new URL(searchUrl({ artist: 'A', track: 'C' })).pathname).toBe('/api/search');
  });
});

describe('LRCLIB parsing', () => {
  it('parses word times from lyricsfile YAML', () => {
    const lines = parseLyricsfile(YAML)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startSec: 1, endSec: 3, wordTimed: true });
    expect(lines[0].words.map((w) => w.text)).toEqual(['alpha', "beta's", 'gamma']);
    expect(lines[1].words[1].startSec).toBeCloseTo(5.6, 6);
  });

  it('falls back to syncedLyrics (line level, interpolated words) and then to none', () => {
    const lrc = '[00:01.00] one two three\n[00:04.50] four five\n[00:07.00]\n';
    const lines = parseSyncedLyrics(lrc)!;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ startSec: 1, endSec: 4.5, wordTimed: false });
    expect(lines[0].words[0].startSec).toBe(1);
    expect(lines[1].endSec).toBe(7);
    expect(lyricsFromRecord({ lyricsfile: YAML, syncedLyrics: lrc })?.kind).toBe('words');
    expect(lyricsFromRecord({ lyricsfile: null, syncedLyrics: lrc })?.kind).toBe('lines');
    expect(lyricsFromRecord({ lyricsfile: null, syncedLyrics: null })).toBeNull();
    expect(lyricsFromRecord({ instrumental: true, syncedLyrics: lrc })).toBeNull();
  });

  it('picks the search result with word timing and a close duration', () => {
    const r = pickSearchResult(
      [
        { id: 1, duration: 300, syncedLyrics: '[00:01.00] x' },
        { id: 2, duration: 262, syncedLyrics: '[00:01.00] x' },
        { id: 3, duration: 264, lyricsfile: YAML },
      ],
      { artist: 'a', track: 't' },
      263,
    );
    expect(r?.id).toBe(3);
  });
});

function fakeFetch(routes: Record<string, { status: number; body?: unknown }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const path = new URL(url).pathname;
    const r = routes[path] ?? { status: 404 };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)) };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('lookupLyrics', () => {
  it('uses /api/get when it has lyrics', async () => {
    const f = fakeFetch({ '/api/get': { status: 200, body: { id: 9, lyricsfile: YAML } } });
    const r = await lookupLyrics({ artist: 'a', track: 't' }, 60, f);
    expect(r.status).toBe('found');
    expect(f.calls).toHaveLength(1);
  });

  it('falls back to /api/search on 404 and reports not-found when nothing matches', async () => {
    const f = fakeFetch({ '/api/search': { status: 200, body: [{ id: 4, duration: 61, syncedLyrics: '[00:02.00] la la' }] } });
    const r = await lookupLyrics({ artist: 'a', track: 't' }, 60, f);
    expect(r.status === 'found' && r.via).toBe('search');
    const none = await lookupLyrics({ artist: 'a', track: 't' }, 60, fakeFetch({ '/api/search': { status: 200, body: [] } }));
    expect(none.status).toBe('not-found');
  });

  it('throws on server errors', async () => {
    await expect(lookupLyrics({ artist: 'a', track: 't' }, 60, fakeFetch({ '/api/get': { status: 503 } }))).rejects.toThrow('503');
  });
});

describe('LyricsService cache', () => {
  const rec = { source: 'youtube' as const, id: 'vid', title: 'Band - Song (Official Video)', artist: 'Band' };
  const memory = () => {
    const data: Record<string, unknown> = {};
    return { data, get: async (keys: string[] | null) => Object.fromEntries((keys ?? Object.keys(data)).filter((k) => k in data).map((k) => [k, data[k]])), set: async (o: Record<string, unknown>) => void Object.assign(data, o) };
  };

  it('fetches once per recording and caches found and not-found results', async () => {
    const area = memory();
    const f = fakeFetch({ '/api/get': { status: 200, body: { lyricsfile: YAML } } });
    const s = new LyricsService(area, f);
    const [a, b] = await Promise.all([s.get({ recording: rec, durationSec: 60, allowFetch: true }), s.get({ recording: rec, durationSec: 60, allowFetch: true })]);
    expect(a.ok && a.entry?.result).toBe('found');
    expect(b.ok && b.entry?.result).toBe('found');
    expect(f.calls).toHaveLength(1);
    await s.get({ recording: { ...rec, source: 'ytmusic' }, durationSec: 60, allowFetch: true });
    expect(f.calls).toHaveLength(1); // YouTube Music shares the cached entry
    expect(area.data[lyricsKey('youtube', 'vid')]).toMatchObject({ query: { artist: 'Band', track: 'Song', durationSec: 60 } });

    const g = fakeFetch({});
    const s2 = new LyricsService(memory(), g);
    const miss = await s2.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(miss.ok && miss.entry?.result).toBe('not-found');
    await s2.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(g.calls).toHaveLength(2); // get + search, once
  });

  it('makes no request when fetching is off or the duration is unknown, and does not cache errors', async () => {
    const f = fakeFetch({ '/api/get': { status: 500 } });
    const s = new LyricsService(memory(), f);
    expect(await s.get({ recording: rec, durationSec: 60, allowFetch: false })).toEqual({ ok: true, entry: null });
    expect(await s.get({ recording: rec, durationSec: 0, allowFetch: true })).toEqual({ ok: true, entry: null });
    expect(f.calls).toHaveLength(0);
    const err = await s.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(err.ok).toBe(false);
    await s.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(f.calls).toHaveLength(2);
  });
});

/** Synthetic word-timed lyrics with irregular onsets. */
function synthLyrics(): Lyrics {
  const lines = [];
  let t = 2;
  for (let l = 0; l < 12; l++) {
    const words = [0, 0.31, 0.93, 1.21, 1.88, 2.64].map((d, i) => ({ text: `w${l}_${i}`, startSec: Math.round((t + d) * 1000) / 1000 }));
    lines.push({ startSec: words[0].startSec, endSec: t + 3.2, text: words.map((w) => w.text).join(' '), words, wordTimed: true });
    t += 4.1;
  }
  return { kind: 'words', lines };
}

describe('lyric offset and chord placement', () => {
  it('finds a +0.45 s offset when chord changes follow the words 0.45 s later', () => {
    const ly = synthLyrics();
    const changes = ly.lines.flatMap((l) => [l.words[0].startSec + 0.45, l.words[3].startSec + 0.45]);
    const est = estimateLyricOffset(ly, changes);
    expect(est.confident).toBe(true);
    expect(est.offsetSec).toBeCloseTo(0.45, 2);
    const shifted = shiftLyrics(ly, est.offsetSec);
    expect(shifted.lines[0].words[0].startSec).toBeCloseTo(2.45, 3);
  });

  it('keeps 0 when the evidence is weak', () => {
    const ly = synthLyrics();
    const est = estimateLyricOffset(ly, [5.5, 13.3, 40.1]);
    expect(est.offsetSec).toBe(0);
    expect(est.confident).toBe(false);
  });

  it('anchors changes to the sung word and falls back to a line listing when doubtful', () => {
    const line = synthLyrics().lines[0]; // words at 2, 2.31, 2.93, 3.21, 3.88, 4.64
    const placed = placeChords(line, [0, 2.0, 3.25]);
    expect(placed.fallback).toBeNull();
    expect(placed.anchors).toEqual([1, null, null, 2, null, null]);
    const loose = { ...line, wordTimed: false };
    expect(placeChords(loose, [0, 2.0, 3.25]).fallback).toEqual([1, 2]);
  });

  it('pins the sung line, holds it briefly, then shows instrumental', () => {
    const lines = synthLyrics().lines; // line 0: 2–5.2, line 1: 6.1–9.3
    expect(pinnedLineAt(lines, 0)).toBe(-1);
    expect(pinnedLineAt(lines, 1)).toBe(0); // next line within 1.5 s
    expect(pinnedLineAt(lines, 3)).toBe(0);
    expect(pinnedLineAt(lines, 5.0)).toBe(0);
    expect(pinnedLineAt(lines, 5.8)).toBe(1);
    const sparse = [lines[0], { ...lines[1], startSec: 20, endSec: 22, words: [] }];
    expect(pinnedLineAt(sparse, 10)).toBe(-1);
  });
});

vi.restoreAllMocks();
