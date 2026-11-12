/**
 * VGT-9: A/B practice loop over lane bars and the 0.5x / 0.75x / 1x speed control, and the
 * listening-mode rules they must not break (slowed audio and loop jumps never become coverage).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { correctChordEvent } from '../src/editor/correct';
import { demoChart } from '../src/play/demo';
import type { LaneBar } from '../src/play/lane';
import { buildPlayModel } from '../src/play/model';
import {
  LOOP_OVERSHOOT_SEC,
  LOOP_SETTLE_MS,
  LoopJumper,
  PRACTICE_RATES,
  explicitStartSec,
  isPracticeRate,
  loopBarIndexes,
  makeLoop,
  pressedRate,
  rateLabel,
  resolveLoop,
} from '../src/play/practice';
import { runCountIn } from '../src/extension/sidepanel/countin-prep';
import { AudioPlacer, type PlayerAnchor } from '../src/recognize/placement';
import { ListeningSession, MAX_SESSION_SEC } from '../src/recognize/session';

/** `n` contiguous 2 s bars (120 bpm, 4/4) starting at `fromSec`, grid numbers from `firstBar`. */
function bars(n: number, fromSec = 0, barSec = 2, firstBar = 0): LaneBar[] {
  return Array.from({ length: n }, (_, i) => ({
    bar: firstBar + i,
    startSec: fromSec + i * barSec,
    endSec: fromSec + (i + 1) * barSec,
    segments: [],
    repeat: false,
  }));
}

const KEY = 'youtube:practice001';

describe('speed control', () => {
  it('offers exactly 0.5x, 0.75x and 1x', () => {
    expect([...PRACTICE_RATES]).toEqual([0.5, 0.75, 1]);
    expect(isPracticeRate(0.75)).toBe(true);
    expect(isPracticeRate(1.25)).toBe(false);
    expect(isPracticeRate('0.5')).toBe(false);
  });

  it('presses the button of the reported rate and shows any other rate the site set', () => {
    expect(pressedRate(0.5)).toBe(0.5);
    expect(pressedRate(0.7500001)).toBe(0.75);
    expect(pressedRate(1)).toBe(1);
    // e.g. the site's own speed menu: no button pressed, the actual rate is shown instead
    expect(pressedRate(1.25)).toBeNull();
    expect(rateLabel(1.25)).toBe('1.25×');
    expect(rateLabel(0.75)).toBe('0.75×');
    expect(rateLabel(1)).toBe('1×');
  });

  it('content scripts set only the offered rates on the page player', () => {
    const yt = readFileSync(new URL('../src/extension/content/youtube.ts', import.meta.url), 'utf8');
    expect(yt).toMatch(/if \(!isPracticeRate\(msg\.rate\)\)[\s\S]*?video\.playbackRate = msg\.rate;/);
    const am = readFileSync(new URL('../src/extension/content/applemusic.ts', import.meta.url), 'utf8');
    expect(am).toContain("msg.action === 'rate' && !isPracticeRate(msg.rate)");
  });
});

describe('loop bounds use the bar grid', () => {
  it('builds a loop from two bars in either order; one bar is a loop too', () => {
    const b = bars(16);
    expect(makeLoop(KEY, b, 7, 4)).toEqual({ key: KEY, fromBar: 4, toBar: 7, startSec: 8, endSec: 16 });
    expect(makeLoop(KEY, b, 3, 3)).toMatchObject({ startSec: 6, endSec: 8 });
    expect(makeLoop(KEY, b, 3, 99)).toBeNull();
    expect(makeLoop('', b, 1, 2)).toBeNull();
  });

  it('a loop over the last bar jumps a little before the song ends', () => {
    const loop = makeLoop(KEY, bars(10), 8, 9, 19.5)!;
    expect(loop.endSec).toBeCloseTo(19.2, 6);
  });

  it('is kept while the recording and both bars still exist (e.g. a chord fix, a level change)', () => {
    const chart = demoChart();
    const before = buildPlayModel(chart, { level: 'beginner', capo: 1 }, null);
    const loop = makeLoop(KEY, before.bars, 4, 7, before.durationSec)!;
    const ev = chart.events.find((e) => e.startSec >= loop.startSec && e.startSec < loop.endSec)!;
    const fixed = correctChordEvent(chart, { startSec: ev.startSec, chord: ev.chord }, ev.chord === 'C' ? 'G' : 'C');
    const after = buildPlayModel(fixed, { level: 'novice', capo: 1 }, null);
    expect(resolveLoop(loop, KEY, after.bars, after.durationSec)).toEqual(loop);
    expect(loopBarIndexes(loop, after.bars)).toEqual([4, 7]);
  });

  it('clears on another recording and when the chart change removed or moved its bars', () => {
    const loop = makeLoop(KEY, bars(16), 4, 7)!;
    expect(resolveLoop(loop, 'youtube:another0001', bars(16))).toBeNull(); // recording / tab change
    expect(resolveLoop(loop, '', bars(16))).toBeNull(); // no player
    expect(resolveLoop(loop, KEY, bars(6))).toBeNull(); // B bar no longer exists
    expect(resolveLoop(loop, KEY, bars(16, 0, 2.1))).toBeNull(); // new tempo: A bar moved
    expect(resolveLoop(loop, KEY, bars(16, 0.5, 2))).toBeNull(); // new first downbeat
    expect(resolveLoop(loop, KEY, [])).toBeNull(); // chart deleted
  });
});

describe('loop jumps are decided from the observed position', () => {
  const at = (positionSec: number, nowMs: number, extra: { playing?: boolean; isAd?: boolean } = {}) => ({
    positionSec,
    nowMs,
    playing: extra.playing ?? true,
    isAd: extra.isAd ?? false,
  });
  /** Loop over 8..16 s (bars 5–8 of a 2 s grid), playing inside it. */
  const inside = () => {
    const j = new LoopJumper();
    j.set(makeLoop(KEY, bars(16), 4, 7));
    expect(j.observe(at(12, 0))).toBeNull();
    return j;
  };

  it('jumps back to the start of A when playback passes the end of B', () => {
    const j = inside();
    expect(j.observe(at(15.9, 3900))).toBeNull();
    expect(j.observe(at(16.02, 4020))).toBeCloseTo(8.01, 6);
  });

  it('does not jump twice while reports still show the old position (debounce until back inside)', () => {
    const j = inside();
    expect(j.observe(at(16.05, 4050))).toBeCloseTo(8.01, 6);
    // The seek reply came back, but the next reports were read before the seek took effect.
    expect(j.observe(at(16.2, 4200))).toBeNull();
    expect(j.observe(at(16.45, 4450))).toBeNull();
    // Back inside the loop: the next pass jumps again.
    expect(j.observe(at(8.3, 4600))).toBeNull();
    expect(j.observe(at(12, 8300))).toBeNull();
    expect(j.observe(at(16.01, 12310))).toBeCloseTo(8.01, 6);
  });

  it('tolerates overshoot past B (late reports) but not a move far away', () => {
    const late = inside();
    expect(late.observe(at(17.4, 5400))).toBeCloseTo(8.01, 6); // 1.4 s late: still a crossing of B
    const far = inside();
    expect(far.observe(at(16 + LOOP_OVERSHOOT_SEC + 2, 6000))).toBeNull(); // the site's own slider moved it
    expect(far.observe(at(16 + LOOP_OVERSHOOT_SEC + 2.5, 6500))).toBeNull();
  });

  it('never jumps while an ad plays', () => {
    const j = inside();
    expect(j.observe(at(16.1, 4100, { isAd: true }))).toBeNull();
    expect(j.observe(at(30, 4400, { isAd: true }))).toBeNull(); // the ad's own time
    expect(j.observe(at(14, 9000))).toBeNull(); // the song resumes inside the loop
    expect(j.observe(at(16.05, 11050))).toBeCloseTo(8.01, 6);
  });

  it('waits while paused just after B and jumps when playback resumes', () => {
    const j = inside();
    expect(j.observe(at(16.1, 4100, { playing: false }))).toBeNull();
    expect(j.observe(at(16.1, 9000))).toBeCloseTo(8.01, 6);
  });

  it("the user's own seek just past B is not undone by stale reports", () => {
    const j = inside();
    j.seeked(16.01, 5000); // bar 9 clicked (plain bar click still seeks)
    expect(j.observe(at(15.95, 5100))).toBeNull(); // report from before the click
    expect(j.observe(at(16.2, 5300))).toBeNull(); // landed after B: playback goes on
    expect(j.observe(at(17.5, 6600))).toBeNull();
  });

  it('a lead-in before A plays into the loop, then loops', () => {
    const j = new LoopJumper();
    j.set(makeLoop(KEY, bars(16), 4, 7));
    expect(j.observe(at(5, 0))).toBeNull();
    expect(j.observe(at(9, 4000))).toBeNull();
    expect(j.observe(at(16.03, 11030))).toBeCloseTo(8.01, 6);
  });

  it('retries a seek that never showed up only while still near B, then gives up', () => {
    const j = inside();
    expect(j.observe(at(16.02, 4000))).toBeCloseTo(8.01, 6);
    expect(j.observe(at(17, 4000 + LOOP_SETTLE_MS - 100))).toBeNull();
    expect(j.observe(at(17.6, 4000 + LOOP_SETTLE_MS + 100))).toBeCloseTo(8.01, 6); // one retry
    const later = 4000 + 3 * LOOP_SETTLE_MS;
    expect(j.observe(at(16 + LOOP_OVERSHOOT_SEC + 0.5, later))).toBeNull(); // too far: stop chasing
    expect(j.observe(at(16 + LOOP_OVERSHOOT_SEC + 1, later + 500))).toBeNull();
  });

  it('no loop, no jumps; a new loop starts fresh', () => {
    const j = inside();
    j.set(null);
    expect(j.active).toBe(false);
    expect(j.observe(at(16.1, 4100))).toBeNull();
    j.set(makeLoop(KEY, bars(16), 0, 1));
    expect(j.observe(at(4.1, 5000))).toBeNull(); // never observed inside the new loop
  });
});

describe('count-in only on an explicit start', () => {
  const loop = makeLoop(KEY, bars(16), 4, 7)!;

  it('an explicit start outside the loop begins at A; inside it, at the current bar', () => {
    expect(explicitStartSec(loop, 30, 30)).toBeCloseTo(8.01, 6);
    expect(explicitStartSec(loop, 2, 2)).toBeCloseTo(8.01, 6);
    expect(explicitStartSec(loop, 11.3, 10)).toBe(10);
    expect(explicitStartSec(null, 11.3, 10)).toBe(10);
    expect(explicitStartSec(null, 0.4, null)).toBe(0.4);
  });

  it('automatic loop repeats only seek: no play command, no count-in', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('function checkLoop(): void {'), src.indexOf('// ---------- demo playback'));
    expect(body).toContain("action: 'seek'");
    expect(body).not.toMatch(/togglePlay|prepareCountIn|countInRun|action: 'play'/);
    expect(body).toContain('countingIn) return'); // no loop decisions during a count-in either
  });

  /** Runs a 4-beat count-in at 1x; `change(k)` may change the reported rate during wait k (0-based). */
  async function countIn(change: (waitIndex: number, setRate: (r: number) => void) => void, current = () => true) {
    let rate = 1;
    const beats: number[] = [];
    let plays = 0;
    let waits = 0;
    const r = await runCountIn({
      beats: 4,
      stepMs: 500,
      startRate: 1,
      rate: () => rate,
      isCurrent: current,
      onBeat: (left) => beats.push(left),
      play: async () => {
        plays++;
        return { ok: true };
      },
      wait: async () => {
        change(waits++, (x) => (rate = x)); // a status report arrives while this beat waits
      },
    });
    return { r, beats, plays };
  }

  it('plays after all beats when nothing changes', async () => {
    const { r, beats, plays } = await countIn(() => undefined);
    expect(r).toEqual({ kind: 'played', result: { ok: true } });
    expect(beats).toEqual([4, 3, 2, 1]);
    expect(plays).toBe(1);
  });

  it('a speed change during the first beat cancels the count-in without playing', async () => {
    const { r, beats, plays } = await countIn((k, set) => k === 0 && set(0.5));
    expect(r).toEqual({ kind: 'rate-changed' });
    expect(beats).toEqual([4]);
    expect(plays).toBe(0);
  });

  it('a speed change during the LAST beat (e.g. the site menu) cancels it too: no play command (review VGT9-R1-01)', async () => {
    const { r, beats, plays } = await countIn((k, set) => k === 3 && set(0.75));
    expect(r).toEqual({ kind: 'rate-changed' });
    expect(beats).toEqual([4, 3, 2, 1]);
    expect(plays).toBe(0);
  });

  it('a count-in stopped during its last beat (play pressed again, tab change) does not play', async () => {
    let live = true;
    const { r, plays } = await countIn((k) => {
      if (k === 3) live = false;
    }, () => live);
    expect(r).toEqual({ kind: 'cancelled' });
    expect(plays).toBe(0);
  });

  it('the panel uses runCountIn for its count-in and plays only through it', () => {
    const src = readFileSync(new URL('../src/extension/sidepanel/sidepanel.ts', import.meta.url), 'utf8');
    // The play button's steps live in play-toggle.ts; togglePlay only hands them the panel.
    const toggle = readFileSync(new URL('../src/extension/sidepanel/play-toggle.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/async function togglePlay\([\s\S]{0,120}?\): Promise<TransportResult> \{\s*return playToggle\(playToggleEnv,/);
    expect(toggle).toContain('await runCountIn({');
    expect(toggle).toMatch(/done\.kind === 'rate-changed'\) \{\s*env\.stopCountIn\(\);\s*env\.status\(RATE_CANCELS_COUNTIN\);\s*return CANCELLED;/);
    const setRate = src.slice(src.indexOf('async function setRate('), src.indexOf('function resetRateForNewRecording'));
    expect(setRate).toMatch(/if \(countingIn\) \{\s*stopCountIn\(\);/);
  });
});

describe('listening mode: slowed playback and loop jumps never become coverage', () => {
  const RATE = 48000;
  const BLOCK = 4800; // 100 ms
  const LAT = 0.05;
  const anchor = (ctxTime: number, position: number, extra: Partial<PlayerAnchor> = {}): PlayerAnchor => ({
    ctxTime,
    key: 'A',
    position,
    paused: false,
    rate: 1,
    isAd: false,
    ...extra,
  });
  const pushBlocks = (p: AudioPlacer, fromSec: number, untilSec: number) => {
    for (let end = Math.round((fromSec + 0.1) * RATE); end <= Math.round(untilSec * RATE); end += BLOCK) {
      p.pushBlock(new Float32Array(BLOCK).fill(0.01), RATE, end);
    }
  };

  it('stores nothing at 0.5x or 0.75x, then records again at 1x', () => {
    for (const rate of [0.5, 0.75]) {
      const s = new ListeningSession('A', 200);
      const p = new AudioPlacer(LAT);
      p.addAnchor(anchor(0, 10, { rate }));
      pushBlocks(p, 0, 2);
      p.drain(3, () => s);
      expect(s.storedSec).toBe(0);
      expect(s.coverage()).toEqual([]);
      expect(p.idleReason).toContain('1x에서만 기록');
    }
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    p.addAnchor(anchor(0, 10, { rate: 0.5 }));
    p.addAnchor(anchor(1, 10.5, { rate: 1 }));
    pushBlocks(p, 0, 2);
    p.drain(3, () => s);
    const cov = s.coverage();
    expect(cov).toHaveLength(1);
    expect(cov[0].fromSec).toBeCloseTo(10.5 - LAT, 2); // only the 1x part, none of the slowed second
    expect(cov[0].toSec).toBeCloseTo(11.5 - LAT, 2);
  });

  it('1x loop passes cover only the looped bars, not the unheard gap they jump over', () => {
    const s = new ListeningSession('A', 200);
    const p = new AudioPlacer(LAT);
    // Heard 40..44, then a loop over 8..12 s played three times (each pass jumps back from 12 to 8),
    // with a player report every 250 ms like the content script.
    const positionAt = (ctx: number) => (ctx < 4 ? 40 + ctx : 8 + ((ctx - 4) % 4));
    for (let ctx = 0; ctx < 16; ctx += 0.25) p.addAnchor(anchor(ctx, positionAt(ctx)));
    pushBlocks(p, 0, 16);
    p.drain(20, () => s);
    const cov = s.coverage();
    expect(cov).toHaveLength(2);
    // The blocks that span a jump are dropped; the last pass runs to 12 s.
    expect(cov[0].fromSec).toBeCloseTo(8 - LAT, 2);
    expect(cov[0].toSec).toBeCloseTo(12 - LAT, 2);
    expect(cov[1].fromSec).toBeCloseTo(40 - LAT, 2);
    expect(cov[1].toSec).toBeCloseTo(43.9 - LAT, 2);
    // Nothing between the loop and the earlier range counts as heard.
    expect(s.coverage().some((r) => r.fromSec < 30 && r.toSec > 13)).toBe(false);
    expect(s.segments.length).toBeGreaterThanOrEqual(4); // every pass is its own segment
  });

  it('repeating a 1x loop keeps stored audio under the session cap', () => {
    const s = new ListeningSession('A', 600);
    const pass = new Float32Array(8 * MODEL_SAMPLE_RATE).fill(0.01); // an 8 s loop
    for (let i = 0; i < 200; i++) {
      s.breakSegment(); // the jump back
      s.append(pass, 16);
    }
    expect(s.full).toBe(true);
    expect(s.storedSec).toBeLessThanOrEqual(MAX_SESSION_SEC);
    expect(s.coverage()).toEqual([{ fromSec: 8, toSec: 16 }]);
  });
});
