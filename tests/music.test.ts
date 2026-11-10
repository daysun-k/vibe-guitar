import { describe, expect, it } from 'vitest';
import type { Chart, Timing } from '../src/chart/types';
import { estimateKey, prettyChord, respellChartForKey, respellChord, spellPitchInKey } from '../src/music/key';
import { alignBarPhase, bigBeatInfo, bigBeatSeconds, bigBeatsUntil, estimateBarPhase, shiftBarPhase } from '../src/music/meter';
import { beatIndexAt } from '../src/chart/timing';

/** A Perfect-like progression as the recognizer names it (sharps), one chord per 2 s. */
function sharpChart(): Chart {
  const prog = ['G#', 'Fm', 'C#', 'D#', 'G#', 'Fm', 'C#', 'D#', 'Fm', 'C#', 'G#', 'D#', 'G#'];
  return {
    schemaVersion: 1,
    recording: { source: 'youtube', id: 'x', title: 't', artist: 'a' },
    timing: { bpm: 90, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 },
    events: prog.map((chord, i) => ({ startSec: i * 2, chord, confidence: 0.9, source: 'auto' as const })),
    coverage: [{ fromSec: 0, toSec: prog.length * 2 }],
    provenance: { createdBy: 'recognizer', createdAt: '2026-11-10T00:00:00Z' },
  };
}

describe('key estimation and spelling', () => {
  it('finds A-flat major for a sharp-spelled I–vi–IV–V and spells A♭ Fm D♭ E♭', () => {
    const { chart, key } = respellChartForKey(sharpChart());
    expect(key?.tonicName).toBe('Ab');
    expect(key?.mode).toBe('major');
    expect([...new Set(chart.events.map((e) => e.chord))]).toEqual(['Ab', 'Fm', 'Db', 'Eb']);
    expect(chart.events.map((e) => prettyChord(e.chord)).slice(0, 4)).toEqual(['A♭', 'Fm', 'D♭', 'E♭']);
  });

  it('keeps sharps in sharp keys and separates relative minor by the tonic', () => {
    const e = (chord: string, d = 2) => ({ chord, durationSec: d });
    const g = estimateKey([e('G'), e('D'), e('Em'), e('C'), e('G'), e('D'), e('G')]);
    expect(g?.tonicName).toBe('G');
    expect(respellChord('Gb', g)).toBe('F#');
    expect(respellChord('D/Gb', g)).toBe('D/F#');
    const am = estimateKey([e('Am', 4), e('Dm'), e('E'), e('Am', 4), e('G'), e('F'), e('E'), e('Am', 4)]);
    expect(am?.tonicName).toBe('A');
    expect(am?.mode).toBe('minor');
  });

  it('spells out-of-scale roots with the key signature flavour', () => {
    const eb = estimateKey(['Eb', 'Ab', 'Bb', 'Cm', 'Eb'].map((chord) => ({ chord, durationSec: 2 })));
    expect(eb?.tonicName).toBe('Eb');
    expect(spellPitchInKey(6, eb)).toBe('Gb'); // non-diatonic, flat key
    expect(respellChord('G#maj7/D#', eb)).toBe('Abmaj7/Eb');
    expect(respellChord('N', eb)).toBe('N');
    expect(estimateKey([{ chord: 'N', durationSec: 3 }])).toBeNull();
  });
});

describe('big beats (compound meter)', () => {
  it('treats a fast 6-beat bar (tracker eighths) and 6/8 / 12/8 as compound', () => {
    expect(bigBeatInfo({ bpm: 187.5, beatsPerBar: 6, beatUnit: 4, firstDownbeatSec: 0 })).toMatchObject({ beatsPerBig: 3, bigPerBar: 2, compound: true, label: '6/8' });
    expect(bigBeatInfo({ bpm: 90, beatsPerBar: 6, beatUnit: 8, firstDownbeatSec: 0 })).toMatchObject({ beatsPerBig: 3, bigPerBar: 2 });
    expect(bigBeatInfo({ bpm: 150, beatsPerBar: 12, beatUnit: 8, firstDownbeatSec: 0 })).toMatchObject({ bigPerBar: 4, label: '12/8' });
    expect(bigBeatInfo({ bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 })).toMatchObject({ beatsPerBig: 1, bigPerBar: 4, compound: false });
    expect(bigBeatInfo({ bpm: 80, beatsPerBar: 6, beatUnit: 4, firstDownbeatSec: 0 }).compound).toBe(false); // slow 6/4
  });

  it('counts the countdown in dotted quarters', () => {
    const t: Timing = { bpm: 180, beatsPerBar: 6, beatUnit: 4, firstDownbeatSec: 0 };
    const big = bigBeatInfo(t);
    expect(bigBeatSeconds(t, big)).toBeCloseTo(1, 6);
    expect(bigBeatsUntil(t, big, 0, 2)).toBe(2); // one bar ahead = 2 big beats
    expect(bigBeatsUntil(t, big, 1.2, 2)).toBe(1);
    expect(bigBeatsUntil(t, big, 2, 2)).toBe(0);
  });
});

describe('bar phase', () => {
  const beatTimes = Array.from({ length: 61 }, (_, i) => Math.round((0.5 + i * 0.32) * 1000) / 1000);
  const t: Timing = { bpm: 187.5, beatsPerBar: 6, beatUnit: 4, firstDownbeatSec: 0.5, beatTimes };

  it('moves the downbeat to the beat where chord changes land', () => {
    const changes = [3, 9, 15, 21, 27, 33, 39, 45].map((i) => beatTimes[i] + 0.02);
    const est = estimateBarPhase(t, changes);
    expect(est.phase).toBe(3);
    expect(est.hits).toBe(8);
    expect(est.currentHits).toBe(0);
    const a = alignBarPhase(t, changes);
    expect(a.shifted).toBe(true);
    for (const c of changes) expect(beatIndexAt(a.timing, c) % 6).toBeLessThan(0.1);
    // every original beat time is still in the grid
    expect(a.timing.beatTimes!.slice(-beatTimes.length)).toEqual(beatTimes);
  });

  it('keeps the grid when the evidence is weak or already right', () => {
    const weak = [3, 9, 4, 10].map((i) => beatTimes[i]);
    expect(alignBarPhase(t, weak).shifted).toBe(false);
    const right = [0, 6, 12, 18, 24].map((i) => beatTimes[i]);
    expect(alignBarPhase(t, right).shifted).toBe(false);
  });

  it('shifts a bpm grid without explicit beats', () => {
    const g: Timing = { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 1 };
    expect(shiftBarPhase(g, 2).firstDownbeatSec).toBeCloseTo(2, 6);
  });
});
