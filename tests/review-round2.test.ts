// Regression tests for the deep delta-review findings (round 2): lyrics OFF→ON on the same song,
// and player commands after leaving demo playback. Mock fetch/storage, no network.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FetchLike, FetchResponseLike } from '../src/lyrics/lrclib';
import { LyricsService } from '../src/extension/lyrics-service';
import { LyricsAsker, lyricsOutcome } from '../src/extension/sidepanel/lyrics-asker';
import { controlTabId, keepPlayerAfterDemo } from '../src/extension/sidepanel/player-target';

const rec = { source: 'youtube' as const, id: 'vid', title: 'Band - Song', artist: 'Band' };
const KEY = 'youtube:vid';
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
const tick = () => new Promise((r) => setTimeout(r, 0));
const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
const fnBody = (head: string) => {
  const i = src.indexOf(head);
  expect(i).toBeGreaterThan(-1);
  return src.slice(i, src.indexOf('\n}\n', i));
};

/** The panel's lyrics state, driven the way requestLyrics() drives it. */
function panel(s: LyricsService) {
  const asker = new LyricsAsker();
  const state = { fetchOn: true, lyrics: null as unknown, note: '', sent: 0 };
  const request = async () => {
    if (!asker.shouldAsk(KEY, state.fetchOn, true)) return;
    const ticket = asker.begin();
    state.sent++;
    const reply = await s.get({ recording: rec, durationSec: 60, allowFetch: state.fetchOn });
    const out = lyricsOutcome(reply, state.fetchOn);
    if (!asker.isLatest(ticket) && !out.lyrics) return;
    if (out.lyrics !== undefined) state.lyrics = out.lyrics;
    state.note = out.note;
  };
  return { asker, state, request };
}

describe('[P2] lyrics OFF→ON on the same song looks up again once', () => {
  it('lookup in flight → OFF (aborted) → ON → exactly one new lookup, lyrics shown', async () => {
    let on = true;
    const calls: string[] = [];
    const fetchFn: FetchLike = (url, init) => {
      calls.push(new URL(url).pathname);
      if (calls.length === 1) return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      return Promise.resolve(res(200, { id: 9, lyricsfile: YAML }));
    };
    const s = new LyricsService(memory(), fetchFn, () => new Date(), () => on);
    const p = panel(s);

    const first = p.request(); // player reports: lookup starts
    await tick();
    expect(calls).toEqual(['/api/get']);

    on = false; // user turns "가사 가져오기" off: background aborts, the panel asks the cache only
    p.state.fetchOn = false;
    s.abortAll();
    await p.request();
    await first; // the cancelled reply arrives late and must not overwrite the newer status
    expect(p.state.note).toBe('가사 가져오기가 꺼져 있어요.');
    expect(p.state.lyrics).toBeNull();

    on = true; // user turns it back on
    p.state.fetchOn = true;
    p.asker.fetchTurnedOn(KEY);
    await p.request();
    expect(calls).toEqual(['/api/get', '/api/get']); // exactly one new lookup
    expect(p.state.sent).toBe(3);
    expect((p.state.lyrics as { kind: string } | null)?.kind).toBe('words');
    expect(p.state.note).toMatch(/^가사: LRCLIB 단어 단위/);

    for (let i = 0; i < 5; i++) await p.request(); // player updates: no further lookups
    expect(p.state.sent).toBe(3);
    expect(calls).toHaveLength(2);
  });

  it('ON before the aborted lookup settles starts a fresh lookup instead of joining it', async () => {
    let on = true;
    const calls: string[] = [];
    const slow = deferred<FetchResponseLike>();
    const fetchFn: FetchLike = (url) => (calls.push(new URL(url).pathname), calls.length === 1 ? slow.promise : Promise.resolve(res(200, { id: 9, lyricsfile: YAML })));
    const s = new LyricsService(memory(), fetchFn, () => new Date(), () => on);
    const old = s.get({ recording: rec, durationSec: 60, allowFetch: true });
    await tick();
    on = false;
    s.abortAll();
    on = true;
    const fresh = await s.get({ recording: rec, durationSec: 60, allowFetch: true });
    expect(fresh).toMatchObject({ ok: true, entry: { result: 'found' } });
    slow.resolve(res(404));
    expect(await old).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(calls).toEqual(['/api/get', '/api/get']);
  });

  it('OFF→ON still honours an active 429 backoff and only touches the current song', async () => {
    const calls: string[] = [];
    const s = new LyricsService(memory(), async (u) => (calls.push(u), res(429, null, { 'retry-after': '600' })), () => new Date(1_000_000));
    const p = panel(s);
    await p.request();
    expect(p.state.note).toMatch(/^LRCLIB 요청이 많아/);
    p.asker.fetchTurnedOn(KEY);
    await p.request();
    expect(p.state.sent).toBe(2);
    expect(calls).toHaveLength(1); // the service worker answers from its backoff, no network
    expect(p.state.note).toMatch(/^LRCLIB 요청이 많아/);

    const a = new LyricsAsker();
    expect(a.shouldAsk(KEY, true, true)).toBe(true);
    a.fetchTurnedOn('youtube:other'); // not the current song: nothing reopens
    expect(a.shouldAsk(KEY, true, true)).toBe(false);
  });

  it('the panel stores the setting before asking and reopens the lookup only on an explicit ON', () => {
    const sw = src.slice(src.indexOf("$('lyrics-sw').onclick"), src.indexOf('};', src.indexOf("$('lyrics-sw').onclick")));
    expect(sw).toMatch(/await persist\(false\)[\s\S]*if \(on\) lyricsAsker\.fetchTurnedOn\(chartKey\)[\s\S]*requestLyrics\(\)/);
    const req = fnBody('async function requestLyrics(');
    expect(req).toMatch(/lyricsAsker\.isLatest\(ticket\)/);
    expect(req).not.toMatch(/fetchTurnedOn|lyricsAsker\.reset/); // player updates never reopen it
  });
});

describe('[P2] leaving demo never controls a player outside the active tab', () => {
  it('controlTabId only allows the player tab while it is the active tab', () => {
    expect(controlTabId(11, 11)).toBe(11);
    expect(controlTabId(11, 22)).toBeNull(); // demo started on music tab 11, user is now on tab 22
    expect(controlTabId(11, null)).toBeNull(); // active tab unknown: block
    expect(controlTabId(null, 22)).toBeNull();
    expect(keepPlayerAfterDemo(11, 11)).toBe(true);
    expect(keepPlayerAfterDemo(11, 22)).toBe(false);
    expect(keepPlayerAfterDemo(11, null)).toBe(false);
  });

  it('the panel follows the active tab during demo, re-checks it on exit and gates every command', () => {
    const control = fnBody('async function sendControl(');
    expect(control).toMatch(/controlTabId\(playerTabId, activeTabId\)/);
    expect(control).toMatch(/chrome\.tabs\.sendMessage\(target,/);
    expect(control).not.toMatch(/sendMessage\(playerTabId/);

    const exit = fnBody('async function exitDemo(');
    expect(exit).toMatch(/keepPlayerAfterDemo\(playerTabId, activeTabId\)\) forgetPlayer\(\)[\s\S]*await refreshActiveTab\(\)[\s\S]*keepPlayerAfterDemo\(playerTabId, activeTabId\)\) forgetPlayer\(\)/);

    const activated = src.slice(src.indexOf('chrome.tabs.onActivated.addListener('), src.indexOf('});', src.indexOf('chrome.tabs.onActivated.addListener(')));
    expect(activated.indexOf('activeTabId = info.tabId')).toBeGreaterThan(-1);
    expect(activated.indexOf('activeTabId = info.tabId')).toBeLessThan(activated.indexOf('if (demo) return'));

    const state = fnBody('async function onPlayerState(');
    expect(state.indexOf('activeTabId = tab.id')).toBeLessThan(state.indexOf('if (demo) return'));
    expect(state.indexOf('if (!tab.active) return')).toBeLessThan(state.indexOf('activeTabId = tab.id'));
  });
});
