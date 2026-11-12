import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart, EventSource, Provenance, RecordingSource } from '../src/chart/types';
import { correctChordEvent } from '../src/editor/correct';
import { chordChangeOffset, compareCharts } from '../src/eval/metrics';
import { accuracyExport, accuracyOverview, accuracyRow, accuracyTotals } from '../src/eval/overview';
import { OVERVIEW_EMPTY, renderOverviewHtml, syncOffsetHint } from '../src/extension/sidepanel/overview';
import { findAccuracyPairs, loadAccuracyPairs } from '../src/extension/storage';

const chart = (
  events: [number, string, EventSource?][],
  coverage: [number, number][],
  createdBy: Provenance['createdBy'] = 'manual',
  extra: { source?: RecordingSource; id?: string; title?: string; example?: boolean } = {},
): Chart => ({
  schemaVersion: 1,
  recording: { source: extra.source ?? 'youtube', id: extra.id ?? 'vid1', title: extra.title ?? '', artist: '' },
  timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 },
  events: events.map(([startSec, chord, source]) => ({ startSec, chord, confidence: 1, source: source ?? (createdBy === 'recognizer' ? 'auto' : 'manual') })),
  coverage: coverage.map(([fromSec, toSec]) => ({ fromSec, toSec })),
  provenance: { createdBy, createdAt: '2026-11-12T00:00:00Z', ...(extra.example ? { example: true } : {}) },
});

/** A 32 s progression changing every 2 s. */
const song = (shiftSec = 0, createdBy: Provenance['createdBy'] = 'manual'): Chart => {
  const chords = ['C', 'G', 'Am', 'F'];
  const events: [number, string][] = [];
  for (let k = 0; k < 16; k++) events.push([k === 0 ? 0 : k * 2 + shiftSec, chords[k % 4]]);
  return chart(events, [[0, 32]], createdBy);
};

describe('reference selection (findAccuracyPairs)', () => {
  const auto = chart([[0, 'C'], [4, 'G']], [[0, 8]], 'recognizer');

  it('uses a manual or edited chart in use, never a recognizer chart', () => {
    const manual = chart([[0, 'C'], [4, 'G']], [[0, 8]], 'manual');
    const edited = chart([[0, 'C', 'manual'], [4, 'G', 'auto']], [[0, 8]], 'edited', { id: 'vid2' });
    const pairs = findAccuracyPairs({
      'chart:youtube:vid1': manual,
      'autochart:youtube:vid1': auto,
      'chart:youtube:vid2': edited,
      'autochart:youtube:vid2': { ...auto, recording: { ...auto.recording, id: 'vid2' } },
      'chart:youtube:vid3': { ...auto, recording: { ...auto.recording, id: 'vid3' } },
      'autochart:youtube:vid3': { ...auto, recording: { ...auto.recording, id: 'vid3' } },
      settings: { level: 'beginner' },
    });
    expect(pairs.map((p) => [p.id, p.referenceFrom, p.reference.provenance.createdBy])).toEqual([
      ['vid1', 'main', 'manual'],
      ['vid2', 'main', 'edited'],
    ]);
  });

  it('falls back to the kept hand-made chart after the auto chart was adopted', () => {
    const backup = chart([[0, 'C'], [4, 'Em']], [[0, 8]], 'manual');
    const pairs = findAccuracyPairs({ 'chart:youtube:vid1': auto, 'chartbackup:youtube:vid1': backup, 'autochart:youtube:vid1': auto });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].referenceFrom).toBe('backup');
    expect(pairs[0].reference).toBe(backup);
  });

  it('prefers the chart in use over a backup, and skips a recognizer backup', () => {
    const manual = chart([[0, 'C']], [[0, 8]], 'manual');
    const backup = chart([[0, 'D']], [[0, 8]], 'manual');
    expect(findAccuracyPairs({ 'chart:youtube:vid1': manual, 'chartbackup:youtube:vid1': backup, 'autochart:youtube:vid1': auto })[0].reference).toBe(manual);
    expect(findAccuracyPairs({ 'chart:youtube:vid1': auto, 'chartbackup:youtube:vid1': auto, 'autochart:youtube:vid1': auto })).toEqual([]);
  });

  it('needs an auto chart, skips examples and invalid charts, and matches keys exactly', () => {
    const manual = chart([[0, 'C']], [[0, 8]], 'manual');
    expect(findAccuracyPairs({ 'chart:youtube:vid1': manual })).toEqual([]);
    expect(findAccuracyPairs({ 'chart:youtube:vid1': chart([[0, 'C']], [[0, 8]], 'manual', { example: true }), 'autochart:youtube:vid1': auto })).toEqual([]);
    expect(findAccuracyPairs({ 'chart:youtube:vid1': manual, 'autochart:youtube:vid1': { schemaVersion: 1 } })).toEqual([]);
    expect(findAccuracyPairs({ 'chart:ytmusic:vid1': manual, 'autochart:youtube:vid1': auto })).toEqual([]);
  });

  it('reads storage once and never writes', async () => {
    const calls: string[] = [];
    const area = {
      get: async (keys: string[] | null) => {
        calls.push(`get:${JSON.stringify(keys)}`);
        return { 'chart:youtube:vid1': chart([[0, 'C']], [[0, 8]]), 'autochart:youtube:vid1': auto };
      },
      set: async () => {
        calls.push('set');
      },
    };
    expect(await loadAccuracyPairs(area)).toHaveLength(1);
    expect(calls).toEqual(['get:null']);
  });
});

describe('chord-change timing offset', () => {
  it('recovers a known +120 ms shift of the auto chart', () => {
    const t = chordChangeOffset(song(0), song(0.12, 'recognizer'));
    expect(t.medianMs).toBeCloseTo(120, 6);
    expect(t.matched).toBe(15);
    expect(t.unmatched).toBe(0);
  });

  it('gives a negative offset when the auto chart changes early', () => {
    expect(chordChangeOffset(song(0), song(-0.25, 'recognizer')).medianMs).toBeCloseTo(-250, 6);
  });

  it('counts reference changes with no auto change within the window', () => {
    const ref = chart([[0, 'C'], [2, 'G'], [4, 'Am'], [6, 'F']], [[0, 8]]);
    const auto = chart([[0, 'C'], [2.1, 'G'], [7.5, 'F']], [[0, 8]], 'recognizer');
    const t = chordChangeOffset(ref, auto, 1);
    // 2 → 2.1 matches; 4 (1.9 s from 2.1) and 6 (1.5 s from 7.5) have no auto change within 1 s.
    expect(t.matched).toBe(1);
    expect(t.unmatched).toBe(2);
    expect(t.medianMs).toBeCloseTo(100, 6);
  });

  it('ignores repeated chords and changes outside the overlap', () => {
    const ref = chart([[0, 'C'], [2, 'C'], [4, 'G'], [12, 'Am']], [[0, 16]]);
    const auto = chart([[0, 'C'], [4.05, 'G']], [[0, 8]], 'recognizer');
    const t = chordChangeOffset(ref, auto);
    expect(t.matched + t.unmatched).toBe(1);
    expect(t.medianMs).toBeCloseTo(50, 6);
  });
});

describe('overview rows and totals', () => {
  it('per-song numbers equal compareCharts', () => {
    const ref = song(0);
    const auto = chart([[0, 'C'], [2.1, 'G'], [4, 'Am7'], [6.3, 'Fmaj7'], [8, 'C']], [[0, 10]], 'recognizer');
    const row = accuracyRow({ source: 'youtube', id: 'vid1', referenceFrom: 'main', reference: ref, auto });
    expect(row.comparison).toEqual(compareCharts(ref, auto));
  });

  it('per-song numbers equal `npm run bench -- --compare` for the same two files', () => {
    const ref = song(0);
    const auto = chart([[0, 'C'], [2.1, 'G'], [4, 'Am7'], [6.3, 'Fmaj7'], [8, 'C']], [[1, 10]], 'recognizer');
    const dir = mkdtempSync(path.join(tmpdir(), 'vgt-overview-'));
    try {
      writeFileSync(path.join(dir, 'ref.json'), JSON.stringify(ref));
      writeFileSync(path.join(dir, 'auto.json'), JSON.stringify(auto));
      const r = spawnSync(process.execPath, ['scripts/bench.mjs', '--compare', path.join(dir, 'ref.json'), path.join(dir, 'auto.json')], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const row = accuracyRow({ source: 'youtube', id: 'vid1', referenceFrom: 'main', reference: ref, auto });
      expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(row.comparison)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('weights totals by evaluated duration, not by song', () => {
    // Song A: 32 s, all agree. Song B: 8 s, half agrees.
    const a = accuracyRow({ source: 'youtube', id: 'a', referenceFrom: 'main', reference: song(0), auto: song(0, 'recognizer') });
    const refB = chart([[0, 'C'], [4, 'G']], [[0, 8]]);
    const autoB = chart([[0, 'C'], [4, 'Am']], [[0, 8]], 'recognizer');
    const b = accuracyRow({ source: 'youtube', id: 'b', referenceFrom: 'main', reference: refB, auto: autoB });
    expect(b.comparison.majmin.score).toBeCloseTo(0.5, 9);
    const t = accuracyTotals([a, b]);
    expect(t.overlapSec).toBe(40);
    expect(t.majmin.evaluatedSec).toBe(40);
    expect(t.majmin.score).toBeCloseTo((32 + 4) / 40, 9);
    expect(t.songs).toBe(2);
  });

  it('pools timing offsets over songs and keeps edited references separate', () => {
    const o = accuracyOverview([
      { source: 'youtube', id: 'a', referenceFrom: 'main', reference: song(0), auto: song(0.1, 'recognizer') },
      { source: 'youtube', id: 'b', referenceFrom: 'backup', reference: song(0), auto: song(0.2, 'recognizer') },
      { source: 'youtube', id: 'c', referenceFrom: 'main', reference: song(0, 'edited'), auto: song(0, 'recognizer') },
    ]);
    expect(o.totals.manual.songs).toBe(2);
    expect(o.totals.edited.songs).toBe(1);
    expect(o.totals.all.songs).toBe(3);
    expect(o.totals.manual.timing?.matched).toBe(30);
    expect(o.totals.manual.timing?.medianMs).toBeCloseTo(150, 6);
    expect(o.totals.edited.overlapSec).toBe(32);
    expect(syncOffsetHint(o.totals.manual)).toBe(150);
  });

  it('measures no timing for an edited reference (review s2-r1 F1)', () => {
    // A chord-only fix keeps the auto chart's times, so its changes would match at 0 ms.
    const auto = chart([[0, 'C'], [2.1, 'G'], [4.2, 'Am'], [6.3, 'F']], [[0, 8]], 'recognizer');
    const edited = correctChordEvent(auto, { startSec: 4.2, chord: 'Am' }, 'Em', new Date('2026-11-12T00:00:00Z'));
    expect(edited.provenance.createdBy).toBe('edited');
    const o = accuracyOverview([
      { source: 'youtube', id: 'a', referenceFrom: 'main', reference: song(0), auto: song(0.12, 'recognizer') },
      { source: 'youtube', id: 'b', referenceFrom: 'main', reference: edited, auto },
    ]);
    const row = o.rows.find((r) => r.id === 'b')!;
    expect(row.timing).toBeNull();
    expect(row.offsetsMs).toEqual([]);
    expect(row.comparison.majmin.score).toBeCloseTo(1 - 2.1 / 8, 9); // WCSR is kept: Em vs Am over 4.2..6.3
    expect(o.totals.edited.timing).toBeNull();
    expect(o.totals.edited.majmin.evaluatedSec).toBe(8);
    // The combined total pools hand-made timing only: still +120 ms over 15 changes, not pulled toward 0.
    expect(o.totals.all.timing).toEqual(o.totals.manual.timing);
    expect(o.totals.all.timing?.medianMs).toBeCloseTo(120, 6);
    expect(o.totals.all.timing?.matched).toBe(15);
    const out = JSON.parse(JSON.stringify(accuracyExport(o, new Date('2026-11-12T00:00:00Z'))));
    expect(out.rows.find((r: { id: string }) => r.id === 'b').timing).toBeNull();
    expect(out.rows.find((r: { id: string }) => r.id === 'b').majmin.evaluatedSec).toBe(8);
    expect(out.totals.edited.timing).toBeNull();
    expect(out.totals.all.timing).toEqual(out.totals.manual.timing);
    expect(out.totals.all.timing.medianOffsetMs).toBeCloseTo(120, 6);
  });

  it('exports numbers only (no chord events), with NaN as null', () => {
    const o = accuracyOverview([{ source: 'youtube', id: 'a', referenceFrom: 'main', reference: song(0), auto: chart([[40, 'C']], [[40, 50]], 'recognizer') }]);
    const json = JSON.stringify(accuracyExport(o, new Date('2026-11-12T00:00:00Z')));
    const back = JSON.parse(json);
    expect(back.rows[0].overlapSec).toBe(0);
    expect(back.rows[0].majmin.score).toBeNull();
    expect(back.rows[0].timing.medianOffsetMs).toBeNull();
    expect(back.totals.manual.songs).toBe(1);
    expect(json).not.toContain('"events":[');
    expect(json).not.toContain('offsetsMs');
    expect(json).not.toContain('"chord"');
  });
});

describe('overview HTML', () => {
  it('explains how results appear when there is nothing yet', () => {
    expect(renderOverviewHtml(accuracyOverview([]))).toContain(OVERVIEW_EMPTY);
  });

  it('labels edited references and escapes titles', () => {
    const ref = chart(
      song(0).events.map((e, i) => [e.startSec, e.chord, i === 0 ? 'manual' : 'auto'] as [number, string, EventSource]),
      [[0, 32]],
      'edited',
      { title: '<b>노래</b>' },
    );
    const html = renderOverviewHtml(accuracyOverview([{ source: 'youtube', id: 'a', referenceFrom: 'main', reference: ref, auto: song(0, 'recognizer') }]));
    expect(html).toContain('고친 코드표(일부만 직접 확인)');
    expect(html).toContain('직접 고친 코드 1/16개');
    expect(html).toContain('&lt;b&gt;노래&lt;/b&gt;');
    expect(html).not.toContain('싱크 오프셋을');
  });

  it('suggests a sync offset only with enough matched changes', () => {
    const few = accuracyOverview([{ source: 'youtube', id: 'a', referenceFrom: 'main', reference: chart([[0, 'C'], [2, 'G']], [[0, 4]]), auto: chart([[0, 'C'], [2.1, 'G']], [[0, 4]], 'recognizer') }]);
    expect(syncOffsetHint(few.totals.manual)).toBeNull();
    const many = accuracyOverview([{ source: 'youtube', id: 'a', referenceFrom: 'main', reference: song(0), auto: song(0.12, 'recognizer') }]);
    expect(renderOverviewHtml(many)).toContain('싱크 오프셋을 +120 ms 근처로');
  });
});
