import { describe, expect, it } from 'vitest';
import { applyPracticeRate, handleRateRequest, parseRateReply, RATE_REQUEST, RATE_RESULT, type PagePlayer } from '../src/extension/content/yt-rate';
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

describe('manifest: the page-world part runs on both YouTube sites', () => {
  it('matches youtube-main.js on www.youtube.com and music.youtube.com in the MAIN world', () => {
    const entry = manifest.content_scripts.find((c) => c.js.includes('youtube-main.js')) as { matches: string[]; world?: string } | undefined;
    expect(entry?.world).toBe('MAIN');
    expect(entry?.matches).toEqual(expect.arrayContaining(['https://www.youtube.com/*', 'https://music.youtube.com/*']));
  });
});
