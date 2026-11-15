import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPracticeRate,
  createRateBridge,
  handleRateRequest,
  parseRateReply,
  RATE_REPLY_TIMEOUT_MS,
  RATE_REQUEST,
  RATE_RESULT,
  type BridgeMessage,
  type BridgeWindow,
  type PagePlayer,
} from '../src/extension/content/yt-rate';
import manifest from '../src/extension/static/manifest.json';

/** A YouTube player whose setPlaybackRate moves the <video> rate too (what the real one does). */
function fakePlayer(video: { playbackRate: number }): PagePlayer & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    setPlaybackRate(rate: number) {
      calls.push(rate);
      video.playbackRate = rate;
    },
  };
}

describe('practice speed through YouTube\'s own player: page (MAIN) world', () => {
  it('calls setPlaybackRate for a practice rate and answers ok with the same seq', () => {
    const video = { playbackRate: 1 };
    const p = fakePlayer(video);
    expect(handleRateRequest({ __vibeGuitar: RATE_REQUEST, seq: 7, rate: 0.5 }, () => p)).toEqual({ __vibeGuitar: RATE_RESULT, seq: 7, ok: true });
    expect(p.calls).toEqual([0.5]);
  });

  it('refuses any rate that is not a practice rate without touching the player', () => {
    const p = fakePlayer({ playbackRate: 1 });
    for (const rate of [2, 1.25, 0, -1, Number.NaN, '0.5', null]) {
      expect(handleRateRequest({ __vibeGuitar: RATE_REQUEST, seq: 1, rate }, () => p)).toMatchObject({ ok: false, reason: 'unsupported rate' });
    }
    expect(p.calls).toEqual([]);
  });

  it('ignores messages that are not namespaced rate requests (no reply at all)', () => {
    const p = fakePlayer({ playbackRate: 1 });
    for (const data of [null, 'yt-rate', { rate: 0.5, seq: 1 }, { __vibeGuitar: 'yt-video-data', seq: 1, rate: 0.5 }, { __vibeGuitar: RATE_REQUEST, rate: 0.5 }, { __vibeGuitar: RATE_REQUEST, seq: 1.5, rate: 0.5 }, { __vibeGuitar: RATE_RESULT, seq: 1, ok: true }]) {
      expect(handleRateRequest(data, () => p)).toBeNull();
    }
    expect(p.calls).toEqual([]);
  });

  it('answers not ok with a fixed reason when the player API is missing or throws', () => {
    const req = { __vibeGuitar: RATE_REQUEST, seq: 3, rate: 0.75 };
    expect(handleRateRequest(req, () => null)).toEqual({ __vibeGuitar: RATE_RESULT, seq: 3, ok: false, reason: 'player API not available' });
    expect(handleRateRequest(req, () => ({}))).toMatchObject({ ok: false, reason: 'player API not available' });
    expect(handleRateRequest(req, () => { throw new Error('boom'); })).toMatchObject({ ok: false, reason: 'player API not available' });
    const throwing: PagePlayer = { setPlaybackRate: () => { throw new Error('secret page detail'); } };
    expect(handleRateRequest(req, () => throwing)).toEqual({ __vibeGuitar: RATE_RESULT, seq: 3, ok: false, reason: 'player API failed' });
  });
});

describe('practice speed through YouTube\'s own player: isolated world', () => {
  it('keeps only seq, ok and a short text reason from the page\'s reply', () => {
    expect(parseRateReply({ __vibeGuitar: RATE_RESULT, seq: 2, ok: true, extra: 'x' })).toEqual({ seq: 2, ok: true });
    expect(parseRateReply({ __vibeGuitar: RATE_RESULT, seq: 2, ok: 'yes' })).toEqual({ seq: 2, ok: false });
    expect(parseRateReply({ __vibeGuitar: RATE_RESULT, seq: 2, ok: false, reason: { html: '<b>' } })).toEqual({ seq: 2, ok: false });
    expect(parseRateReply({ __vibeGuitar: RATE_RESULT, seq: 2, ok: false, reason: 'r'.repeat(500) })?.reason).toHaveLength(80);
    expect(parseRateReply({ __vibeGuitar: RATE_REQUEST, seq: 2, ok: true })).toBeNull();
    expect(parseRateReply({ __vibeGuitar: RATE_RESULT, seq: '2', ok: true })).toBeNull();
    expect(parseRateReply(undefined)).toBeNull();
  });

  it('uses the page\'s player when it answers ok and the <video> follows', async () => {
    const video = { playbackRate: 1 };
    const p = fakePlayer(video);
    const via = await applyPracticeRate(video, 0.5, async (rate) => ({ ok: handleRateRequest({ __vibeGuitar: RATE_REQUEST, seq: 1, rate }, () => p)!.ok }));
    expect(via).toBe('player-api');
    expect(p.calls).toEqual([0.5]);
    expect(video.playbackRate).toBe(0.5);
  });

  it('falls back to the <video> rate when the page world is absent, says no, throws or lies', async () => {
    for (const viaPage of [
      async () => ({ ok: false }), // timeout or no player API
      async () => { throw new Error('x'); },
      async () => ({ ok: true }), // forged ok: the <video> did not change
    ]) {
      const video = { playbackRate: 1 };
      expect(await applyPracticeRate(video, 0.75, viaPage)).toBe('video-element');
      expect(video.playbackRate).toBe(0.75);
    }
  });

  it('back to 1x goes through the player too (next-video reset, 1x button)', async () => {
    const video = { playbackRate: 0.5 };
    const p = fakePlayer(video);
    expect(await applyPracticeRate(video, 1, async (rate) => ({ ok: handleRateRequest({ __vibeGuitar: RATE_REQUEST, seq: 9, rate }, () => p)!.ok }))).toBe('player-api');
    expect(video.playbackRate).toBe(1);
  });
});

const ORIGIN = 'https://www.youtube.com';

/**
 * A window whose postMessage delivers asynchronously (a task, like the real one) to every
 * listener whose signal is not aborted, and a page (MAIN) world that answers like
 * youtube-main.ts after `pageDelayMs` (null = the page world is absent).
 */
class FakeWindow implements BridgeWindow {
  private listeners: { fn: (e: BridgeMessage) => void; signal?: AbortSignal }[] = [];
  readonly requests: { seq: number; rate: number }[] = [];
  pageDelayMs: number | null = 5;
  /** Replies the page world posts per request (2 = a duplicate reply). */
  repliesPerRequest = 1;

  constructor(readonly player: PagePlayer | null) {
    this.addEventListener('message', (e) => {
      if (e.source !== this || e.origin !== ORIGIN || this.pageDelayMs === null) return;
      const reply = handleRateRequest(e.data, () => this.player);
      if (!reply) return;
      this.requests.push({ seq: reply.seq, rate: (e.data as { rate: number }).rate });
      for (let k = 0; k < this.repliesPerRequest; k++) setTimeout(() => this.postMessage(reply, ORIGIN), this.pageDelayMs);
    });
  }

  postMessage(data: unknown, targetOrigin: string): void {
    setTimeout(() => this.deliver({ data, origin: targetOrigin, source: this }), 0);
  }

  /** A message as another frame or origin would post it. */
  deliver(e: BridgeMessage): void {
    for (const l of [...this.listeners]) if (!l.signal?.aborted) l.fn(e);
  }

  addEventListener(_type: 'message', fn: (e: BridgeMessage) => void, options?: { signal: AbortSignal }): void {
    this.listeners.push({ fn, signal: options?.signal });
  }
}

/** The isolated-world bridge on a fake window, with the (fake) timers. */
function bridgeOn(win: FakeWindow, signal = new AbortController().signal) {
  return createRateBridge({ win, origin: ORIGIN, signal, setTimeout: (fn, ms) => setTimeout(fn, ms) });
}

/** Resolves state of a promise without waiting for it. */
function track<T>(p: Promise<T>): { done: boolean; value?: T } {
  const t: { done: boolean; value?: T } = { done: false };
  void p.then((v) => {
    t.done = true;
    t.value = v;
  });
  return t;
}

describe('practice speed bridge: timer, late and duplicate replies, overlap, instance abort (PR #23 R1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a prompt reply from the page player: player API used, the <video> follows', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    const via = applyPracticeRate(video, 0.5, bridgeOn(win));
    await vi.advanceTimersByTimeAsync(20);
    expect(await via).toBe('player-api');
    expect(video.playbackRate).toBe(0.5);
    expect(win.requests).toEqual([{ seq: 1, rate: 0.5 }]);
  });

  it('no page world (page not reloaded after an install): waits exactly the timeout, then sets the <video>', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    win.pageDelayMs = null;
    const t = track(applyPracticeRate(video, 0.75, bridgeOn(win)));
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS - 1);
    expect(t.done).toBe(false);
    expect(video.playbackRate).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t).toEqual({ done: true, value: 'video-element' });
    expect(video.playbackRate).toBe(0.75);
  });

  it('a reply after the timeout is ignored and does not answer the next request', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    const bridge = bridgeOn(win);
    win.pageDelayMs = RATE_REPLY_TIMEOUT_MS + 200; // answers seq 1 late
    const first = track(bridge(0.5));
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS);
    expect(first).toEqual({ done: true, value: { ok: false } });
    win.pageDelayMs = null; // seq 2 gets no answer at all
    const second = track(bridge(0.75));
    await vi.advanceTimersByTimeAsync(250); // seq 1's late ok arrives meanwhile
    expect(second.done).toBe(false);
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS);
    expect(second).toEqual({ done: true, value: { ok: false } });
  });

  it('a duplicate reply resolves its request once and is ignored afterwards', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    win.repliesPerRequest = 2;
    const bridge = bridgeOn(win);
    const calls: { ok: boolean }[] = [];
    const p = bridge(0.5).then((r) => calls.push(r));
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS + 50);
    await p;
    expect(calls).toEqual([{ ok: true }]);
    // The next request is still answered by its own reply, not by the leftover duplicate.
    win.repliesPerRequest = 1;
    win.player!.setPlaybackRate = () => {
      throw new Error('player failed');
    };
    const next = track(bridge(0.75));
    await vi.advanceTimersByTimeAsync(20);
    expect(next).toEqual({ done: true, value: { ok: false } });
  });

  it('a reply posted before its request (forged or stale seq) is ignored: the request still times out', async () => {
    const win = new FakeWindow(null);
    win.pageDelayMs = null;
    const bridge = bridgeOn(win);
    win.postMessage({ __vibeGuitar: RATE_RESULT, seq: 1, ok: true }, ORIGIN);
    await vi.advanceTimersByTimeAsync(1);
    const t = track(bridge(0.5)); // gets seq 1
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS - 1);
    expect(t.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.value).toEqual({ ok: false });
  });

  it('overlapping requests each get their own answer, also when the replies come in reverse order', async () => {
    const win = new FakeWindow(null);
    win.pageDelayMs = null;
    const bridge = bridgeOn(win);
    const a = track(bridge(0.5)); // seq 1
    const b = track(bridge(0.75)); // seq 2
    win.postMessage({ __vibeGuitar: RATE_RESULT, seq: 2, ok: true }, ORIGIN);
    await vi.advanceTimersByTimeAsync(10);
    expect(a.done).toBe(false);
    expect(b).toEqual({ done: true, value: { ok: true } });
    win.postMessage({ __vibeGuitar: RATE_RESULT, seq: 1, ok: false, reason: 'player API not available' }, ORIGIN);
    await vi.advanceTimersByTimeAsync(10);
    expect(a).toEqual({ done: true, value: { ok: false } });
  });

  it('ignores replies from another frame or origin', async () => {
    const win = new FakeWindow(null);
    win.pageDelayMs = null;
    const t = track(bridgeOn(win)(0.5));
    const reply = { __vibeGuitar: RATE_RESULT, seq: 1, ok: true };
    win.deliver({ data: reply, origin: ORIGIN, source: {} }); // an iframe
    win.deliver({ data: reply, origin: 'https://evil.example', source: win });
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS);
    expect(t.value).toEqual({ ok: false });
  });

  it('an aborted instance posts nothing and leaves the <video> alone', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    const instance = new AbortController();
    instance.abort();
    const t = track(applyPracticeRate(video, 0.5, bridgeOn(win, instance.signal), instance.signal));
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS);
    expect(t).toEqual({ done: true, value: 'aborted' });
    expect(win.requests).toEqual([]);
    expect(video.playbackRate).toBe(1);
  });

  it('after the instance is aborted its replies are ignored; the replacement instance still ends at the requested rate', async () => {
    const video = { playbackRate: 1 };
    const win = new FakeWindow(fakePlayer(video));
    win.pageDelayMs = 50;
    const oldInstance = new AbortController();
    const old = track(applyPracticeRate(video, 0.5, bridgeOn(win, oldInstance.signal), oldInstance.signal));
    await vi.advanceTimersByTimeAsync(10);
    oldInstance.abort(); // extension reloaded: a new content script claims the page
    // The old request ends at once and leaves the <video> alone. (Before this was tested, its
    // timeout still fired the <video> fallback and put the rate back to 0.5 after the new
    // instance had set 0.75.)
    await vi.advanceTimersByTimeAsync(0);
    expect(old).toEqual({ done: true, value: 'aborted' });
    // The new instance starts its own seq at 1 too; the page answers the old seq 1 first.
    const fresh = track(applyPracticeRate(video, 0.75, bridgeOn(win)));
    await vi.advanceTimersByTimeAsync(RATE_REPLY_TIMEOUT_MS + 100);
    // The new request may take the old request's ok (same seq), but the <video> check refuses
    // to trust it while the rate is wrong, and the final state is the newest request's rate.
    expect(fresh.done).toBe(true);
    expect(video.playbackRate).toBe(0.75);
    expect(win.requests).toEqual([
      { seq: 1, rate: 0.5 },
      { seq: 1, rate: 0.75 },
    ]);
  });
});

describe('manifest: the page-world part runs on both YouTube sites', () => {
  it('matches youtube-main.js on www.youtube.com and music.youtube.com in the MAIN world', () => {
    const entry = manifest.content_scripts.find((c) => c.js.includes('youtube-main.js')) as { matches: string[]; world?: string } | undefined;
    expect(entry?.world).toBe('MAIN');
    expect(entry?.matches).toEqual(expect.arrayContaining(['https://www.youtube.com/*', 'https://music.youtube.com/*']));
  });
});
