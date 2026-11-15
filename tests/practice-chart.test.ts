import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { beatTimeAt, barPosition } from '../src/chart/timing';
import { validateChart } from '../src/chart/validate';
import { parseBeats, parseLab } from '../src/eval/annotations';
import { prepareChart } from '../src/play/prepare';
import { PracticeChartError, buildPracticeChart, gridCheck, practiceAgreement, practiceChord, practiceEvents, practiceGrid, type TimeMap } from '../src/eval/practice-chart';

const recording = { source: 'youtube' as const, id: 'abcdefghijk', title: 'Song', artist: 'Band' };

/** 4/4 at 120 bpm in annotation time: a one-beat pickup at 0.5 s, then downbeats every 2 s from 1.0 s. */
function beatFile(bars: number, pickup = true): string {
  const lines: string[] = [];
  if (pickup) lines.push('0.500 4');
  for (let b = 0; b < bars; b++) for (let k = 0; k < 4; k++) lines.push(`${(1 + 2 * b + 0.5 * k).toFixed(3)} ${k + 1}`);
  return lines.join('\n');
}

const LAB = ['0.000 1.000 N', '1.000 3.000 C', '3.000 5.000 A:min/b7', '5.000 6.000 F:maj7', '6.000 7.000 F:maj7', '7.000 9.000 X', '9.000 11.000 G:7', '11.000 12.000 N'].join('\n');

describe('practiceChord', () => {
  it('uses the evaluator symbol and flags labels whose symbol names other notes', () => {
    expect(practiceChord('A:min/b7')).toEqual({ chord: 'Am/G', kind: 'exact' });
    expect(practiceChord('A:min7(*5,b6)')).toEqual({ chord: 'Am7(#5)', kind: 'exact' });
    expect(practiceChord('A:min(*5)')).toEqual({ chord: 'Am', kind: 'simplified', notes: { added: ['E'], dropped: [] } });
    expect(practiceChord('N')).toEqual({ chord: 'N', kind: 'exact' });
    expect(practiceChord('X')).toEqual({ chord: 'N', kind: 'unknown-as-N' });
    expect(() => practiceChord('C:weird')).toThrow(PracticeChartError);
  });
});

describe('practiceEvents', () => {
  it('maps segment starts through offset and rate, merges repeats and keeps the whole annotated stretch', () => {
    const map: TimeMap = { offsetSec: 0.25, rate: 1.001 };
    const { events, coverage, labels } = practiceEvents(parseLab(LAB), map, 100);
    const m = (t: number) => Math.round((0.25 + 1.001 * t) * 1000) / 1000;
    expect(events.map((e) => [e.startSec, e.chord])).toEqual([
      [m(0), 'N'],
      [m(1), 'C'],
      [m(3), 'Am/G'],
      [m(5), 'Fmaj7'],
      [m(7), 'N'],
      [m(9), 'G7'],
      [m(11), 'N'],
    ]);
    expect(events.every((e) => e.source === 'manual' && e.confidence === 1)).toBe(true);
    expect(coverage).toEqual([{ fromSec: m(0), toSec: m(12) }]);
    expect(labels.find((l) => l.label === 'X')).toMatchObject({ chord: 'N', kind: 'unknown-as-N', sec: 2.002 });
    expect(labels.find((l) => l.label === 'F:maj7')?.sec).toBeCloseTo(2.002, 3);
  });

  it('starts segments mapped before 0 s at 0 s and cuts at the upload end', () => {
    const { events, coverage } = practiceEvents(parseLab(LAB), { offsetSec: -1.5, rate: 1 }, 8);
    expect(events.map((e) => [e.startSec, e.chord])).toEqual([
      [0, 'C'],
      [1.5, 'Am/G'],
      [3.5, 'Fmaj7'],
      [5.5, 'N'],
      [7.5, 'G7'],
    ]);
    expect(coverage).toEqual([{ fromSec: 0, toSec: 8 }]);
  });

  it('refuses a map that leaves no overlap with the upload', () => {
    expect(() => practiceEvents(parseLab(LAB), { offsetSec: 50, rate: 1 }, 20)).toThrow(PracticeChartError);
  });
});

describe('practiceGrid', () => {
  it('starts the grid at the first downbeat, maps it and keeps every downbeat on a bar start', () => {
    const map: TimeMap = { offsetSec: 0.1, rate: 1 };
    const g = practiceGrid(parseBeats(beatFile(6)), map);
    expect(g.droppedLeadBeats).toBe(1);
    expect(g.timing).toMatchObject({ bpm: 120, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 1.1 });
    expect(g.timing.beatTimes).toHaveLength(24);
    for (let b = 0; b < 6; b++) {
      const sec = 1.1 + 2 * b;
      expect(barPosition(g.timing, sec + 1e-6)).toMatchObject({ bar: b, beatInBar: 0 });
    }
    // The pickup before the first downbeat is extrapolated at the grid tempo.
    expect(beatTimeAt(g.timing, -1)).toBeCloseTo(0.6, 6);
  });

  it('spreads a short bar evenly so later downbeats stay on their annotated times', () => {
    // Bars of 4, 2 (at 3.0 s, ends at 4.0 s) and 4 beats, then a final bar of one beat.
    const text = ['1.0 1', '1.5 2', '2.0 3', '2.5 4', '3.0 1', '3.5 2', '4.0 1', '4.5 2', '5.0 3', '5.5 4', '6.0 1'].join('\n');
    const g = practiceGrid(parseBeats(text), { offsetSec: 0, rate: 1 });
    expect(g.irregularBars).toEqual([{ atSec: 3, beats: 2 }]);
    expect(g.timing.beatTimes).toEqual([1, 1.5, 2, 2.5, 3, 3.25, 3.5, 3.75, 4, 4.5, 5, 5.5, 6]);
    expect(barPosition(g.timing, 4.0001)).toMatchObject({ bar: 2, beatInBar: 0 });
    expect(barPosition(g.timing, 6.0001)).toMatchObject({ bar: 3, beatInBar: 0 });
  });

  it('skips bars whose downbeat maps before 0 s and refuses beats without positions', () => {
    const g = practiceGrid(parseBeats(beatFile(4, false)), { offsetSec: -1.5, rate: 1 });
    expect(g.timing.beatTimes?.[0]).toBe(1.5);
    expect(g.droppedLeadBeats).toBe(4);
    expect(() => practiceGrid(parseBeats('1.0\n1.5\n2.0'), { offsetSec: 0, rate: 1 })).toThrow(PracticeChartError);
  });
});

describe('buildPracticeChart', () => {
  it('passes the chart validator, keeps its bar phase in the play view and agrees with the annotation', () => {
    const map: TimeMap = { offsetSec: 0.1, rate: 1 };
    const segs = parseLab(LAB);
    const grid = practiceGrid(parseBeats(beatFile(6)), map);
    const { chart } = buildPracticeChart({ segs, map, mediaDurationSec: 30, recording, timing: grid.timing, createdAt: '2026-11-15T00:00:00.000Z', tool: 'test', note: 'synthetic' });
    const v = validateChart(JSON.parse(JSON.stringify(chart)));
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(chart.provenance).toEqual({ createdBy: 'manual', createdAt: '2026-11-15T00:00:00.000Z', tool: 'test', note: 'synthetic' });
    expect(prepareChart(chart).phaseShifted).toBe(false);
    const a = practiceAgreement(chart, segs, map);
    expect(a.exact).toBe(1);
    expect(a.evaluatedSec).toBeCloseTo(12, 2);
    expect(a.unknownAsNoChordSec).toBeCloseTo(2, 2);
    expect(a.mismatches).toEqual([]);
  });

  it('reports a chart that disagrees with the annotation', () => {
    const map: TimeMap = { offsetSec: 0, rate: 1 };
    const segs = parseLab(LAB);
    const { chart } = buildPracticeChart({ segs, map, mediaDurationSec: 30, recording, timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 1 }, createdAt: 'x', tool: 't', note: 'n' });
    chart.events[1] = { ...chart.events[1], chord: 'D' };
    const a = practiceAgreement(chart, segs, map);
    expect(a.exact).toBeCloseTo(10 / 12, 3);
    expect(a.mismatches).toEqual([{ fromSec: 1, toSec: 3, chart: 'D', annotation: 'C' }]);
  });
});

describe('gridCheck', () => {
  it('measures the distance of grid beats to the nearest tracked beat inside the tracked range', () => {
    const tracker = Array.from({ length: 20 }, (_, i) => 1 + 0.5 * i);
    const grid = [0.2, ...tracker.map((t, i) => t + (i % 2 ? -0.1 : 0.02))];
    const c = gridCheck(grid, tracker)!;
    expect(c.compared).toBe(20);
    expect(c.within70ms).toBe(0.5);
    expect(gridCheck(grid, tracker.slice(0, 5))).toBeNull();
  });
});

describe('scripts/practice-charts.mjs', () => {
  it('writes a valid chart and a provenance sidecar, and refuses a weak time map', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'practice-charts-'));
    try {
      mkdirSync(path.join(dir, 'ann/ds'), { recursive: true });
      writeFileSync(path.join(dir, 'ann/ds/song.lab'), LAB);
      writeFileSync(path.join(dir, 'ann/ds/song.txt'), beatFile(6));
      const dataset = { name: 'Synthetic', folder: 'ds', page: 'p', attribution: 'a', licence: 'l' };
      const song = (id: string) => ({ id, title: 'Song', artist: 'Band', release: 'r', dataset: 'ds', chords: 'song.lab', beats: 'song.txt' });
      writeFileSync(path.join(dir, 'songs.json'), JSON.stringify({ datasets: { ds: dataset }, songs: [song('s1'), song('s2')] }));
      const entry = { songList: path.join(dir, 'songs.json'), offsetSec: 0.1, rate: 1, mediaDurationSec: 30, alignMethod: 'beats', alignStrength: 'strong' };
      writeFileSync(
        path.join(dir, 'maps.json'),
        JSON.stringify({ songs: [{ ...entry, id: 's1', youtubeId: 'abcdefghijk' }, { ...entry, id: 's2', youtubeId: 'bcdefghijkl', alignMethod: 'chord-boundaries', alignStrength: 'weak' }] }),
      );
      const run = (...ids: string[]) =>
        spawnSync(process.execPath, ['scripts/practice-charts.mjs', '--out', path.join(dir, 'out'), '--annotations', path.join(dir, 'ann'), '--captures', path.join(dir, 'none'), '--maps', path.join(dir, 'maps.json'), ...ids], { encoding: 'utf8' });
      const ok = run('abcdefghijk');
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('주석 일치 100.00%');
      const chart = JSON.parse(readFileSync(path.join(dir, 'out/abcdefghijk.json'), 'utf8'));
      expect(validateChart(chart).errors).toEqual([]);
      expect(chart.recording).toEqual(recording);
      expect(chart.timing.beatTimes[0]).toBe(1.1);
      expect(chart.provenance.note).toContain('media = 0.1000 + 1.000000 x annotation time');
      const side = JSON.parse(readFileSync(path.join(dir, 'out/abcdefghijk.provenance.json'), 'utf8'));
      expect(side.grid).toMatchObject({ kind: 'annotation-beats', beatsPerBar: 4, bpm: 120, droppedLeadBeats: 1 });
      expect(side.agreement.exact).toBe(1);
      expect(side.timingCheck).toBeNull();
      const weak = run('s2');
      expect(weak.status).toBe(1);
      expect(weak.stderr).toContain("'weak'(chord-boundaries)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
