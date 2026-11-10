import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { demoChart } from '../src/play/demo';
import { buildPlayModel, frameAt } from '../src/play/model';

// Codex connector review on PR #4 (head a2d8d4f): two P2 findings.
describe('connector review: no bar after the chart ends', () => {
  it('returns bar -1 past the end of the last bar, so count-in resumes near the playhead', () => {
    const m = buildPlayModel(demoChart(), { level: 'novice', capo: 0 }, null);
    const last = m.bars[m.bars.length - 1];
    expect(frameAt(m, last.startSec + 0.01).bar).toBe(m.bars.length - 1);
    expect(frameAt(m, last.endSec + 0.5).bar).toBe(-1);
    expect(frameAt(m, last.endSec + 120).bar).toBe(-1);
  });
});

describe('connector review: count-in never outlives its model', () => {
  const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
  const body = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
    }
    throw new Error('unbalanced');
  };

  it('forgetting the player and changing recordings cancel a pending count-in', () => {
    expect(body('forgetPlayer')).toContain('stopCountIn()');
    const onState = src.slice(src.indexOf('if (key !== chartKey) {'), src.indexOf('if (key !== chartKey) {') + 80);
    expect(onState).toContain('stopCountIn()');
  });

  it('togglePlay uses a local copy of the model after its first await', () => {
    const t = body('togglePlay');
    const afterCopy = t.slice(t.indexOf('const m = model;'));
    expect(t).toContain('const m = model;');
    expect(afterCopy).not.toMatch(/\bmodel\./);
  });
});

import { prepareCountIn } from '../src/extension/sidepanel/countin-prep';
import type { PlayerControlMessage, PlayerControlResult } from '../src/extension/messages';

describe('delta review: a cancelled count-in stops after each pending reply', () => {
  function deferredSend() {
    const sent: PlayerControlMessage[] = [];
    const pending: ((r: PlayerControlResult) => void)[] = [];
    const send = (msg: PlayerControlMessage) => { sent.push(msg); return new Promise<PlayerControlResult>((res) => pending.push(res)); };
    return { sent, pending, send };
  }

  it('cancelled while the pause reply is pending: no seek, no overlay', async () => {
    const d = deferredSend();
    let current = true;
    const p = prepareCountIn(d.send, () => current, 12);
    current = false; // recording changed while waiting
    d.pending[0]({ ok: true });
    await expect(p).resolves.toEqual({ kind: 'cancelled' });
    expect(d.sent.map((m) => m.action)).toEqual(['pause']);
  });

  it('cancelled while the seek reply is pending: reports cancelled, not ready', async () => {
    const d = deferredSend();
    let current = true;
    const p = prepareCountIn(d.send, () => current, 12);
    d.pending[0]({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    expect(d.sent.map((m) => m.action)).toEqual(['pause', 'seek']);
    current = false;
    d.pending[1]({ ok: true });
    await expect(p).resolves.toEqual({ kind: 'cancelled' });
  });

  it('a current run becomes ready only after both replies succeed', async () => {
    const d = deferredSend();
    const p = prepareCountIn(d.send, () => true, 7.5);
    d.pending[0]({ ok: true });
    await Promise.resolve(); await Promise.resolve();
    d.pending[1]({ ok: true });
    await expect(p).resolves.toEqual({ kind: 'ready' });
    expect(d.sent[1]).toMatchObject({ action: 'seek', time: 7.5 });
  });

  it('togglePlay sets the count-in overlay only after preparation reports ready', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const t = src.slice(src.indexOf('async function togglePlay('));
    expect(t.indexOf('prepareCountIn(')).toBeGreaterThan(0);
    expect(t.indexOf("if (prep.kind === 'cancelled') return;")).toBeLessThan(t.indexOf('countingIn = true'));
  });
});

import { LyricsAsker, lyricsLookupReady } from '../src/extension/sidepanel/lyrics-asker';

describe('connector review 2: no lyrics lookup during an ad', () => {
  it('skips ads and implausibly short durations without marking an attempt', () => {
    expect(lyricsLookupReady({ isAd: true, duration: 263 })).toBe(false);
    expect(lyricsLookupReady({ isAd: false, duration: 15 })).toBe(false);
    expect(lyricsLookupReady({ isAd: false, duration: 263 })).toBe(true);
    expect(lyricsLookupReady({ isAd: false, duration: 0 })).toBe(true); // unknown yet: the asker records it as duration-less
    expect(lyricsLookupReady(null)).toBe(false);
  });

  it('the song is still looked up once after the ad ends', () => {
    const asker = new LyricsAsker();
    const states = [{ isAd: true, duration: 15 }, { isAd: true, duration: 15 }, { isAd: false, duration: 263 }, { isAd: false, duration: 263 }];
    let asked = 0;
    for (const p of states) if (lyricsLookupReady(p) && asker.shouldAsk('youtube:x', true, p.duration > 0)) asked++;
    expect(asked).toBe(1);
  });

  it('requestLyrics checks the ad guard before recording an attempt', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const f = src.slice(src.indexOf('async function requestLyrics('));
    expect(f.indexOf('lyricsLookupReady(player)')).toBeGreaterThan(0);
    expect(f.indexOf('lyricsLookupReady(player)')).toBeLessThan(f.indexOf('lyricsAsker.shouldAsk('));
  });
});
