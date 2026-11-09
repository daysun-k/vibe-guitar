import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import schema from '../src/chart/chart.schema.json';
import { EXAMPLE_CHARTS, beatIndexAt, beatTimeAt, barPosition, previousDownbeat, quantizeTime, validateChart } from '../src/chart';
import type { Chart, Timing } from '../src/chart/types';
import { chromaFromDbSpectrum, frequencyToPitchClass, rms } from '../src/audio/chroma';
import {
  addTap,
  attachChartToRecording,
  buildChart,
  fitTapTempo,
  nextToStamp,
  parseChordSequence,
  quantizeStamps,
  stamp,
  undoStamp,
} from '../src/editor/core';
import { arrangeChart } from '../src/arrange';
import { computePlayView, estimatePosition } from '../src/extension/playview';

const ajv = new Ajv({ allErrors: true });
const schemaValidate = ajv.compile(schema);

describe('chart schema and validator', () => {
  it('example charts pass both the JSON Schema and the runtime validator, and are marked as examples', () => {
    expect(EXAMPLE_CHARTS).toHaveLength(2);
    for (const c of EXAMPLE_CHARTS) {
      expect(schemaValidate(c), JSON.stringify(schemaValidate.errors)).toBe(true);
      const r = validateChart(c);
      expect(r.errors).toEqual([]);
      expect(c.provenance.example).toBe(true);
      expect(c.recording.title).toMatch(/EXAMPLE/);
    }
  });

  it('rejects structural and semantic errors', () => {
    const base = structuredClone(EXAMPLE_CHARTS[0]) as Chart;
    const bad = structuredClone(base) as unknown as Record<string, unknown> & Chart;
    bad.events[2].startSec = 0.5; // out of order
    bad.events[3].chord = 'Hm7'; // unparseable
    (bad as unknown as { extra: number }).extra = 1;
    const r = validateChart(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/greater than the previous/);
    expect(r.errors.join('\n')).toMatch(/Hm7/);
    expect(r.errors.join('\n')).toMatch(/extra is not allowed/);
    expect(schemaValidate(bad)).toBe(false); // schema catches the extra key

    const noRec = structuredClone(base) as unknown as Record<string, unknown>;
    delete noRec.recording;
    expect(validateChart(noRec).ok).toBe(false);
    expect(schemaValidate(noRec)).toBe(false);
    expect(validateChart(null).ok).toBe(false);
  });

  it('accepts no-chord events', () => {
    const c = structuredClone(EXAMPLE_CHARTS[0]) as Chart;
    c.events[0].chord = 'N';
    expect(validateChart(c).ok).toBe(true);
  });
});

describe('beat grid', () => {
  const t: Timing = { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 1 };
  it('maps time ↔ beat index and bar position', () => {
    expect(beatTimeAt(t, 4)).toBe(3);
    expect(beatIndexAt(t, 3.25)).toBeCloseTo(4.5);
    expect(barPosition(t, 3.25)).toMatchObject({ bar: 1, beatInBar: 0 });
    expect(barPosition(t, 0.5).bar).toBe(-1);
    expect(quantizeTime(t, 1.27)).toBe(1.5);
    expect(previousDownbeat(t, 4.9)).toBe(3);
  });
  it('uses explicit beat times when given', () => {
    const tb: Timing = { ...t, beatTimes: [1, 1.5, 2.1, 2.6] };
    expect(beatIndexAt(tb, 2.1)).toBeCloseTo(2);
    expect(beatTimeAt(tb, 2.5)).toBeCloseTo(2.35);
    expect(beatTimeAt(tb, 4)).toBeCloseTo(3.1); // extrapolated with bpm
    expect(beatIndexAt(tb, beatTimeAt(tb, 1.7))).toBeCloseTo(1.7);
  });
});

describe('editor core', () => {
  it('parses a pasted chord sequence', () => {
    const r = parseChordSequence('| C  G/B | Am7 F |\nN.C. Dsus4 :| Xq');
    expect(r.chords).toEqual(['C', 'G/B', 'Am7', 'F', 'N', 'Dsus4']);
    expect(r.errors).toHaveLength(1);
  });

  it('stamps chord changes in order and supports undo', () => {
    let s = { chords: ['C', 'G', 'Am'], stamps: [] as number[] };
    expect(nextToStamp(s)).toBe('C');
    s = stamp(s, 1.2341);
    s = stamp(s, 1.0); // not after previous → ignored
    s = stamp(s, 3.5);
    expect(s.stamps).toEqual([1.234, 3.5]);
    expect(nextToStamp(s)).toBe('Am');
    s = undoStamp(s);
    expect(s.stamps).toEqual([1.234]);
  });

  it('fits tap tempo and first downbeat', () => {
    let taps: number[] = [];
    for (const t of [10.02, 10.51, 10.99, 11.5, 12.01, 12.49]) taps = addTap(taps, t);
    const fit = fitTapTempo(taps)!;
    expect(fit.bpm).toBeGreaterThan(118);
    expect(fit.bpm).toBeLessThan(122);
    expect(fit.firstDownbeatSec).toBeCloseTo(10.01, 1);
    expect(fitTapTempo([1, 2, 3])).toBeNull();
    expect(addTap([1, 1.5], 9)).toEqual([9]); // long gap restarts
  });

  it('quantizes stamps and builds a valid chart', () => {
    const timing: Timing = { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0.5 };
    const q = quantizeStamps([0.52, 2.46, 4.55], timing);
    expect(q).toEqual([0.5, 2.5, 4.5]);
    const chart = buildChart({
      recording: { source: 'youtube', id: 'abc', title: 't', artist: 'a' },
      timing,
      chords: ['C', 'G', 'Am', 'F'],
      stamps: q,
      durationSec: 30,
      now: new Date('2026-11-09T00:00:00Z'),
    });
    expect(chart.events).toHaveLength(3);
    expect(chart.coverage).toEqual([{ fromSec: 0.5, toSec: 30 }]);
    expect(validateChart(chart).ok).toBe(true);
    expect(schemaValidate(chart)).toBe(true);
  });

  it('attaches an example to the current recording', () => {
    const c = attachChartToRecording(EXAMPLE_CHARTS[0], { source: 'ytmusic', id: 'xyz', title: 'Song', artist: 'Me' });
    expect(c.recording.id).toBe('xyz');
    expect(validateChart(c).ok).toBe(true);
  });
});

describe('audio helpers', () => {
  it('computes RMS', () => {
    expect(rms([1, -1, 1, -1])).toBe(1);
    expect(rms([])).toBe(0);
  });

  it('folds a spectrum onto 12 pitch classes', () => {
    expect(frequencyToPitchClass(440)).toBe(9);
    expect(frequencyToPitchClass(261.63)).toBe(0);
    const sampleRate = 48000;
    const fftSize = 8192;
    const spec = new Float32Array(fftSize / 2).fill(-120);
    const binOf = (hz: number) => Math.round(hz / (sampleRate / fftSize));
    // A minor triad: A3, C4, E4
    spec[binOf(220)] = -10;
    spec[binOf(261.63)] = -12;
    spec[binOf(329.63)] = -14;
    const chroma = chromaFromDbSpectrum(spec, sampleRate, fftSize);
    expect(chroma).toHaveLength(12);
    expect(chroma[9]).toBe(1);
    const top3 = chroma.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]).sort((a, b) => a - b);
    expect(top3).toEqual([0, 4, 9]);
  });
});

describe('play view', () => {
  const chart = EXAMPLE_CHARTS[0]; // 96 bpm, 4/4, first downbeat 2.0 s, one chord per bar (2.5 s)
  const a = arrangeChart(chart, { level: 'beginner', capo: 1 });

  it('extrapolates the playback clock', () => {
    expect(estimatePosition({ currentTime: 10, paused: false, playbackRate: 1, sampledAt: 1000 }, 1500)).toBeCloseTo(10.5);
    expect(estimatePosition({ currentTime: 10, paused: true, playbackRate: 1, sampledAt: 1000 }, 1500)).toBe(10);
    expect(estimatePosition({ currentTime: 10, paused: false, playbackRate: 0.5, sampledAt: 1000 }, 2000, 100)).toBeCloseTo(10.6);
  });

  it('shows current and next chord with a beat countdown inside the look-ahead window', () => {
    const v = computePlayView(a, chart.timing, 2.0 + 2.5 * 0.5, 1);
    expect(v.current?.sounding).toBe('Ab');
    expect(v.next?.sounding).toBe('Eb');
    expect(v.beatsUntilNext).toBeCloseTo(2);
    expect(v.countdown).toBe(2);
    expect(v.inLookAhead).toBe(true);
    const far = computePlayView(a, chart.timing, 2.01, 0.25);
    expect(far.inLookAhead).toBe(false);
    expect(far.countdown).toBeNull();
  });

  it('counts in before the first chord', () => {
    const beat = 60 / 96;
    const v = computePlayView(a, chart.timing, 2.0 - 3.5 * beat, 1);
    expect(v.current).toBeNull();
    expect(v.countIn).toBe(1);
    expect(computePlayView(a, chart.timing, 2.0 - 0.5 * beat, 1).countIn).toBe(4);
  });
});
