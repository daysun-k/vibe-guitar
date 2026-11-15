import { describe, expect, it } from 'vitest';
import type { Timing } from '../src/chart/types';
import {
  LEVEL_CONFIGS,
  arrangeEvents,
  groupShortEvents,
  levelChordKey,
  levelEvents,
  mergeShortEvents,
  type ArrangeInputEvent,
  type WorkEvent,
} from '../src/arrange';

// 60 bpm: one beat is one second, so the spans below read in beats.
const timing: Timing = { bpm: 60, beatsPerBar: 4, firstDownbeatSec: 0 };
const beginner = LEVEL_CONFIGS.beginner;

/** Consecutive chords from [chord, beats] pairs, starting at 0. */
function seq(pairs: [string, number][], start = 0): ArrangeInputEvent[] {
  let t = start;
  return pairs.map(([chord, beats]) => {
    const e = { chord, startSec: t, endSec: t + beats, confidence: 1 };
    t += beats;
    return e;
  });
}

const spans = (evs: WorkEvent[]): [string, number, number][] => evs.map((e) => [e.chord, e.startSec, e.endSec]);

// Let It Be practice chart, bars 1-3: C G | Am Am/G Fmaj7 F6 | C.
const LET_IT_BE = seq([
  ['C', 2],
  ['G', 2],
  ['Am', 1.5],
  ['Am/G', 0.5],
  ['Fmaj7', 1],
  ['F6', 1],
  ['C', 2],
]);

describe('입문 short chords (VGT-23)', () => {
  it('reproduction: the previous-chord rule swallowed the whole run into G', () => {
    expect(spans(mergeShortEvents(LET_IT_BE, timing, beginner.minChordBeats))).toEqual([
      ['C', 0, 2],
      ['G', 2, 8],
      ['C', 8, 10],
    ]);
  });

  it('reproduction: 입문 keeps C G | Am F | C, joining equal 입문 chords', () => {
    const out = groupShortEvents(LET_IT_BE, timing, beginner);
    expect(spans(out)).toEqual([
      ['C', 0, 2],
      ['G', 2, 4],
      ['Am', 4, 6],
      ['Fmaj7', 6, 8],
      ['C', 8, 10],
    ]);
    expect(out.map((e) => levelChordKey(e.chord, beginner))).toEqual(['C', 'G', 'Am', 'F', 'C']);
    expect(out.map((e) => e.mergedFrom)).toEqual([[], [], ['Am/G'], ['F6'], []]);
    expect(levelChordKey('Am/G', beginner)).toBe('Am');
    expect(levelChordKey('F6', beginner)).toBe('F');

    const a = arrangeEvents(LET_IT_BE, timing, { level: 'beginner', capo: 0 });
    expect(a.events.map((e) => e.original)).toEqual(['C', 'G', 'Am', 'Fmaj7', 'C']);
    expect(a.events.map((e) => levelChordKey(e.sounding!, beginner))).toEqual(['C', 'G', 'Am', 'F', 'C']);
    expect(a.events[2].change!.text).toContain('짧게 지나가는 코드(Am/G)를 앞 코드에 합쳤어요');
  });

  it('counts a pair a millisecond short of two beats as two beats (chart times are rounded to ms)', () => {
    // Let It Be bar 5: Am 1.5 beats, Am/G 0.4986 beats (ends 1 ms before the beat).
    const input = seq([['G', 2], ['Am', 1.5], ['Am/G', 0.4986], ['Fmaj7', 1.0014], ['F6', 1], ['C', 2]]);
    expect(groupShortEvents(input, timing, beginner).map((e) => e.chord)).toEqual(['G', 'Am', 'Fmaj7', 'C']);
  });

  it('merges a lone short chord into the chord before it, and an equal chord after it too', () => {
    expect(spans(groupShortEvents(seq([['C', 4], ['G', 1], ['Am', 3]]), timing, beginner))).toEqual([
      ['C', 0, 5],
      ['Am', 5, 8],
    ]);
    const between = groupShortEvents(seq([['C', 4], ['G', 0.5], ['C', 3.5], ['F', 4]]), timing, beginner);
    expect(spans(between)).toEqual([
      ['C', 0, 8],
      ['F', 8, 12],
    ]);
    expect(between[0]).toMatchObject({ mergedFrom: ['G'], mergedBefore: 0 });
    // The chord before keeps playing even when the joining chord is longer than its parts.
    const joined = groupShortEvents(seq([['Am', 1.5], ['Am/G', 0.5], ['D', 1.5], ['E', 4]]), timing, beginner);
    expect(spans(joined)).toEqual([
      ['Am', 0, 3.5],
      ['E', 3.5, 7.5],
    ]);
    expect(joined[0]).toMatchObject({ mergedFrom: ['Am/G', 'D'], mergedBefore: 0 });
    // At the start of a stretch there is no chord before it: it stays.
    expect(spans(groupShortEvents(seq([['G', 1], ['C', 4]]), timing, beginner))).toEqual([
      ['G', 0, 1],
      ['C', 1, 5],
    ]);
  });

  it('groups a run of short chords at a bar start instead of absorbing it', () => {
    const out = groupShortEvents(seq([['G', 4], ['Am', 1], ['F', 1], ['C', 1], ['G', 1], ['D', 4]]), timing, beginner);
    expect(spans(out)).toEqual([
      ['G', 0, 4],
      ['Am', 4, 6],
      ['C', 6, 8],
      ['D', 8, 12],
    ]);
    expect(out.map((e) => e.mergedFrom)).toEqual([[], ['F'], ['G'], []]);
  });

  it('cuts a run longer than one bar into groups, a remainder joining the last group, in the original order', () => {
    const input = seq([
      ['C', 4],
      ['Am', 1.5],
      ['Em', 0.5],
      ['F', 1],
      ['G', 1],
      ['Dm', 1],
      ['Bb', 1],
      ['G', 1],
      ['E', 1],
      ['A', 1],
      ['D', 4],
    ]);
    const out = groupShortEvents(input, timing, beginner);
    expect(spans(out)).toEqual([
      ['C', 0, 4],
      ['Am', 4, 6],
      ['F', 6, 8],
      ['Dm', 8, 10],
      ['G', 10, 13],
      ['D', 13, 17],
    ]);
    expect(out[4].mergedFrom).toEqual(['E', 'A']);
    // The played chords are a subsequence of the input, and no change is shorter than two beats.
    let k = 0;
    for (const e of out) {
      while (k < input.length && input[k].chord !== e.chord) k++;
      expect(k).toBeLessThan(input.length);
      k++;
    }
    for (const e of out) expect(e.endSec - e.startSec).toBeGreaterThanOrEqual(2);
  });

  it('plays a group as its longest chord and says so when the merged chord came first', () => {
    const input = seq([['G', 4], ['Em', 0.5], ['C', 1.5], ['D', 4]]);
    const out = groupShortEvents(input, timing, beginner);
    expect(spans(out)).toEqual([
      ['G', 0, 4],
      ['C', 4, 6],
      ['D', 6, 10],
    ]);
    expect(out[1]).toMatchObject({ mergedFrom: ['Em'], mergedBefore: 1 });
    const a = arrangeEvents(input, timing, { level: 'beginner', capo: 0 });
    expect(a.events[1].change!.text).toContain('짧게 지나가는 코드(Em)를 이 코드에 합쳤어요');
  });

  it('never combines long chords, rests or chords across a coverage gap', () => {
    expect(spans(groupShortEvents(seq([['Am', 4], ['Am/G', 4], ['F', 4]]), timing, beginner))).toEqual([
      ['Am', 0, 4],
      ['Am/G', 4, 8],
      ['F', 8, 12],
    ]);
    const withRest = [...seq([['C', 4], ['N', 1]]), ...seq([['G', 1], ['Am', 4]], 5)];
    expect(spans(groupShortEvents(withRest, timing, beginner))).toEqual([
      ['C', 0, 4],
      ['N', 4, 5],
      ['G', 5, 6],
      ['Am', 6, 10],
    ]);
    const gap = [...seq([['C', 4], ['G', 1]]), ...seq([['F', 1], ['Am', 4]], 8)];
    expect(spans(groupShortEvents(gap, timing, beginner))).toEqual([
      ['C', 0, 5],
      ['F', 8, 9],
      ['Am', 9, 13],
    ]);
  });

  it('leaves the other levels on the previous-chord rule', () => {
    const input = seq([
      ['C', 2],
      ['G', 0.25],
      ['Am', 0.75],
      ['Am/G', 0.5],
      ['Fmaj7', 1],
      ['F6', 0.25],
      ['C', 2],
      ['D', 0.5],
      ['G', 4],
    ]);
    for (const level of ['novice', 'intermediate', 'advanced'] as const) {
      const cfg = LEVEL_CONFIGS[level];
      expect(cfg.shortChords).toBe('previous');
      const expected = mergeShortEvents(input, timing, cfg.minChordBeats);
      expect(levelEvents(input, timing, cfg)).toEqual(expected);
      const a = arrangeEvents(input, timing, { level, capo: 0 });
      expect(a.events.map((e) => [e.original, e.startSec, e.endSec, e.mergedFrom])).toEqual(expected.map((e) => [e.chord, e.startSec, e.endSec, e.mergedFrom]));
    }
    expect(mergeShortEvents(input, timing, LEVEL_CONFIGS.advanced.minChordBeats)).toHaveLength(input.length);
    expect(beginner.shortChords).toBe('group');
  });
});
