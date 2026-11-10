// Regression tests for the deep-review findings on the B panel (mock fetch/storage, no network,
// synthetic lyrics only).
import { describe, expect, it } from 'vitest';
import { LyricsService, LYRICS_BLOCKED_KEY } from '../src/extension/lyrics-service';
import { LyricsAsker } from '../src/extension/sidepanel/lyrics-asker';
import { chartWriteTarget, checkSaveTarget, recordingKeyOf } from '../src/editor/drafts';
import { readFileSync } from 'node:fs';
import { arrangeChart } from '../src/arrange/arrange';
import { buildLane } from '../src/play/lane';
import { bigBeatInfo } from '../src/music/meter';
import { buildPlayModel, frameAt } from '../src/play/model';
import { lookupLyrics, parseLyricsfile, type FetchLike, type FetchResponseLike } from '../src/lyrics/lrclib';
import type { Chart } from '../src/chart/types';
import type { Lyrics } from '../src/lyrics/types';

const rec = { source: 'youtube' as const, id: 'vid', title: 'Band - Song', artist: 'Band' };
const YAML = 'lines:\n- text: a b\n  start_ms: 1000\n  end_ms: 2000\n  words:\n  - text: a\n    start_ms: 1000\n  - text: b\n    start_ms: 1500\n';

function memory() {
  const data: Record<string, unknown> = {};
  return { data, get: async (keys: string[] | null) => Object.fromEntries((keys ?? Object.keys(data)).filter((k) => k in data).map((k) => [k, data[k]])), set: async (o: Record<string, unknown>) => void Object.assign(data, o) };
}
const res = (status: number, body: unknown = null, headers: Record<string, string> = {}): FetchResponseLike => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
});
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe('[P1] lyrics OFF stops every request', () => {
  it('a delayed 404 from /api/get does not lead to /api/search after the setting turns off', async () => {
    let on = true;
    const calls: string[] = [];
    const get404 = deferred<FetchResponseLike>();
    const fetchFn: FetchLike = (url) => {
      calls.push(new URL(url).pathname);
      return calls.length === 1 ? get404.promise : Promise.resolve(res(200, []));
    };
    const area = memory();
    const s = new LyricsService(area, fetchFn, () => new Date(), () => on);
    const p = s.get({ recording: rec, durationSec: 60, allowFetch: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['/api/get']);
    on = false; // user turns "가사 가져오기" off while /api/get is in flight
    get404.resolve(res(404));
    const r = await p;
    expect(r).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(calls).toEqual(['/api/get']);
    expect(Object.keys(area.data)).toEqual([]); // nothing cached
  });

  it('abortAll cancels an in-flight lookup and nothing starts while the setting is off', async () => {
    const calls: string[] = [];
    const fetchFn: FetchLike = (url, init) =>
      new Promise((resolve, reject) => {
        calls.push(url);
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const s = new LyricsService(memory(), fetchFn);
    const p = s.get({ recording: rec, durationSec: 60, allowFetch: true });
    await new Promise((r) => setTimeout(r, 0));
    s.abortAll();
    expect(await p).toMatchObject({ ok: false, reason: 'cancelled' });

    // Setting off by the time the (slow) cache read finishes: no request at all.
    let on = true;
    const slowArea = { ...memory(), get: async () => (await new Promise((r) => setTimeout(r, 5)), (on = false), {}) };
    const calls2: string[] = [];
    const s2 = new LyricsService(slowArea, async (u) => (calls2.push(u), res(404)), () => new Date(), () => on);
    expect(await s2.get({ recording: rec, durationSec: 60, allowFetch: true })).toEqual({ ok: true, entry: null });
    expect(calls2).toEqual([]);
  });

  it('lookupLyrics checks `allowed` before each request', async () => {
    const calls: string[] = [];
    let n = 0;
    const r = lookupLyrics({ artist: 'a', track: 't' }, 60, async (u) => (calls.push(u), res(404)), { allowed: () => n++ === 0 });
    await expect(r).rejects.toThrow('cancelled');
    expect(calls).toHaveLength(1);
  });
});

describe('[P1] demo never writes real charts', () => {
  it('blocks saving while demo playback runs, even when the draft matches the real song', () => {
    const songA = { source: 'youtube' as const, id: 'A', title: 'A', artist: '' };
    const draft = { recordingKey: recordingKeyOf(songA), recording: songA, seqText: 'C G', chords: ['C', 'G'], stamps: [1, 2], timing: { bpm: 100, beatsPerBar: 4, firstDownbeatSec: 0 } };
    expect(checkSaveTarget(draft, songA)).toMatchObject({ ok: true });
    expect(checkSaveTarget(draft, songA, { demo: true })).toEqual({ ok: false, reason: 'demo' });
    const songB = { ...songA, id: 'B' };
    expect(checkSaveTarget(draft, songB)).toEqual({ ok: false, reason: 'recording-mismatch' });
  });

  it('real song A open + demo song B chosen: no write target while the demo runs, A again after it', () => {
    const songA = { source: 'youtube' as const, id: 'A', title: 'A', artist: '' };
    // The demo keeps its own state; the real player (song A) stays the only write target.
    expect(chartWriteTarget(songA, true)).toEqual({ ok: false, reason: 'demo' });
    expect(chartWriteTarget(songA, false)).toEqual({ ok: true, recording: songA });
    expect(chartWriteTarget(null, false)).toEqual({ ok: false, reason: 'no-recording' });
  });

  it('the side panel keeps demo state apart from the real player and guards every chart write', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const body = (name: string): string => {
      const at = src.indexOf(`function ${name}(`);
      expect(at).toBeGreaterThan(-1);
      const next = src.indexOf('\nfunction ', at + 10);
      const nextAsync = src.indexOf('\nasync function ', at + 10);
      const end = Math.min(...[next, nextAsync].filter((x) => x > 0));
      return src.slice(at, end);
    };
    // Starting/stopping a demo never touches the real player, tab or chart.
    for (const fn of ['startDemo', 'exitDemo', 'loop']) expect(body(fn)).not.toMatch(/\b(player|playerTabId|chartKey|chart)\s*=[^=]/);
    // Every function that writes a chart checks the demo first.
    const writers = ['doSave', 'importJson', 'attachExample', 'doAdoptAuto'];
    for (const fn of writers) expect(body(fn)).toMatch(/demo/);
    const calls = [...src.matchAll(/\b(saveChart|adoptAutoChart)\(/g)].length; // every call site in the panel
    const inWriters = writers.map((fn) => [...body(fn).matchAll(/\b(saveChart|adoptAutoChart)\(/g)].length).reduce((a, b) => a + b, 0);
    expect(inWriters).toBe(calls);
  });
});

describe('[P2] failed lyrics lookups do not retry on every player update', () => {
  it('asks once per visit even after failures; a new visit asks again', () => {
    const a = new LyricsAsker();
    const asks = [1, 2, 3, 4, 5].map(() => a.shouldAsk('youtube:vid', true, true)).filter(Boolean).length;
    expect(asks).toBe(1);
    expect(a.shouldAsk('youtube:other', true, true)).toBe(true);
    expect(a.shouldAsk('youtube:vid', true, true)).toBe(true); // came back: new visit
    a.reset();
    expect(a.shouldAsk('youtube:vid', true, true)).toBe(true);
    // The panel no longer forgets the attempt when a lookup fails.
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const req = src.slice(src.indexOf('async function requestLyrics('), src.indexOf('\n}\n', src.indexOf('async function requestLyrics(')));
    expect(req).toMatch(/lyricsAsker\.shouldAsk\(/);
    expect(req).not.toMatch(/lyricsAsker\.reset|lyricsAskedFor\s*=/);
  });

  it('honours 429 with a backoff that survives a service-worker restart', async () => {
    let now = 1_000_000;
    const calls: string[] = [];
    const area = memory();
    const f: FetchLike = async (u) => (calls.push(u), res(429, null, { 'retry-after': '120' }));
    const s = new LyricsService(area, f, () => new Date(now));
    expect(await s.get({ recording: rec, durationSec: 60, allowFetch: true })).toMatchObject({ ok: false, reason: 'rate-limited', retryAt: now + 120_000 });
    expect(area.data[LYRICS_BLOCKED_KEY]).toBe(now + 120_000);
    const restarted = new LyricsService(area, f, () => new Date(now));
    expect(await restarted.get({ recording: { ...rec, id: 'x2' }, durationSec: 60, allowFetch: true })).toMatchObject({ reason: 'rate-limited' });
    expect(calls).toHaveLength(1);
    now += 121_000;
    await restarted.get({ recording: { ...rec, id: 'x2' }, durationSec: 60, allowFetch: true });
    expect(calls).toHaveLength(2);
  });
});

describe('[P2] lane shows no chord over unanalysed time', () => {
  it('splits a bar at the end of coverage', () => {
    const chart: Chart = {
      schemaVersion: 1,
      recording: rec,
      timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 },
      events: [
        { startSec: 0, chord: 'C', confidence: 1, source: 'manual' },
        { startSec: 3, chord: 'G', confidence: 1, source: 'manual' },
      ],
      coverage: [
        { fromSec: 0, toSec: 1 },
        { fromSec: 3, toSec: 5 },
      ],
      provenance: { createdBy: 'manual', createdAt: '2026-11-10T00:00:00Z' },
    };
    const a = arrangeChart(chart, { level: 'advanced', capo: 0 });
    const bars = buildLane(a, chart.timing, bigBeatInfo(chart.timing), 5, (i) => a.events[i].shape ?? '');
    expect(bars[0].segments.map((s) => [s.event >= 0 ? a.events[s.event].shape : '-', s.startSec, s.endSec])).toEqual([
      ['C', 0, 1],
      ['-', 1, 2],
    ]);
    expect(bars[1].segments[0].event).toBe(-1); // 2–3 s: gap
    const m = buildPlayModel(chart, { level: 'advanced', capo: 0 }, null);
    expect(frameAt(m, 1.5).event).toBe(-1);
  });
});

describe('[P2] huge or broken lyrics degrade to "no lyrics"', () => {
  function hugeYaml(words: number): string {
    const parts = ['lines:', '- text: x', '  start_ms: 0', '  end_ms: 1000', '  words:'];
    for (let i = 0; i < words; i++) parts.push(`  - text: w${i}`, `    start_ms: ${i}`);
    return parts.join('\n');
  }

  it('rejects a 150,001-word lyricsfile and an oversized response', async () => {
    expect(parseLyricsfile(hugeYaml(150_001))).toBeNull();
    const big = JSON.stringify({ lyricsfile: hugeYaml(150_001) });
    expect(big.length).toBeGreaterThan(4_000_000);
    const calls: string[] = [];
    const r = await lookupLyrics({ artist: 'a', track: 't' }, 60, async (u) => (calls.push(u), new URL(u).pathname === '/api/get' ? res(200, big) : res(200, [])));
    expect(r.status).toBe('not-found');
  });

  it('a 4 MB lyricsfile is cached as "not found", never as lyrics', async () => {
    const big = JSON.stringify({ lyricsfile: hugeYaml(150_001) });
    const area = memory();
    const s = new LyricsService(area, async (u) => (new URL(u).pathname === '/api/get' ? res(200, big) : res(200, [])));
    const r = await s.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(r).toMatchObject({ ok: true, entry: { result: 'not-found' } });
    expect(JSON.stringify(area.data).length).toBeLessThan(2000);
  });

  it('drops non-finite, negative and beyond-duration times from LRC lyrics', async () => {
    const { parseSyncedLyrics } = await import('../src/lyrics/lrclib');
    const lines = parseSyncedLyrics('[00:01.00] one\n[99:00.00] far\n[00:02.00] two', 60)!;
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
    expect(parseSyncedLyrics(Array.from({ length: 2000 }, (_, i) => `[00:${String(i % 60).padStart(2, '0')}.00] x`).join('\n'), 60)).toBeNull();
  });

  it('drops invalid times and keeps the chord view when cached lyrics are huge or broken', () => {
    const lines = parseLyricsfile(YAML.replace('start_ms: 1500', 'start_ms: 99999999'), 60)!;
    expect(lines[0].words.map((w) => w.text)).toEqual(['a', 'b']); // interpolated: the bad time was dropped
    expect(lines[0].wordTimed).toBe(false);
    const chart: Chart = {
      schemaVersion: 1,
      recording: rec,
      timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 },
      events: [{ startSec: 0, chord: 'C', confidence: 1, source: 'manual' }],
      coverage: [{ fromSec: 0, toSec: 8 }],
      provenance: { createdBy: 'manual', createdAt: '2026-11-10T00:00:00Z' },
    };
    const huge: Lyrics = { kind: 'words', lines: [{ startSec: 0, endSec: 1, text: 'x', wordTimed: true, words: Array.from({ length: 150_001 }, (_, i) => ({ text: 'w', startSec: i / 1000 })) }] };
    const m = buildPlayModel(chart, { level: 'novice', capo: 0 }, huge);
    expect(m.lyrics).toBeNull();
    expect(m.bars.length).toBeGreaterThan(0);
    const broken = { kind: 'words', lines: [{ startSec: Number.NaN, endSec: -1, text: 'x', wordTimed: true, words: [] }] } as Lyrics;
    expect(buildPlayModel(chart, { level: 'novice', capo: 0 }, broken).lyrics).toBeNull();
  });
});
