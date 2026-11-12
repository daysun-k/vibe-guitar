import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Chart, Provenance } from '../src/chart/types';
import { accuracyExport, accuracyOverview, accuracyTotals, type AccuracyPair } from '../src/eval/overview';
import {
  MAX_CHANGES,
  REPORT_CONFIDENT_CHANGES,
  ReportInputError,
  barChartSvg,
  meaningNotes,
  mergeExports,
  parseAccuracyExport,
  renderAccuracyReport,
  syncAdvice,
} from '../src/eval/report';

/** A progression changing every 2 s; changes after the first are shifted by shiftSec. */
const prog = (chords: string[], shiftSec: number, createdBy: Provenance['createdBy'], id: string, title: string): Chart => ({
  schemaVersion: 1,
  recording: { source: 'youtube', id, title, artist: '합성 아티스트' },
  timing: { bpm: 120, beatsPerBar: 4, firstDownbeatSec: 0 },
  events: chords.map((chord, k) => ({
    startSec: k === 0 ? 0 : k * 2 + shiftSec,
    chord,
    confidence: 1,
    source: createdBy === 'recognizer' || (createdBy === 'edited' && k % 2) ? 'auto' : 'manual',
  })),
  coverage: [{ fromSec: 0, toSec: chords.length * 2 }],
  provenance: { createdBy, createdAt: '2026-11-12T00:00:00Z' },
});
const x4 = (c: string[]) => [...c, ...c, ...c, ...c];

const pair = (reference: Chart, auto: Chart): AccuracyPair => ({ source: 'youtube', id: reference.recording.id, referenceFrom: 'main', reference, auto });
const songA = pair(prog(x4(['C', 'G', 'Am', 'F']), 0, 'manual', 'a', '연습곡 A'), prog(x4(['C', 'G', 'A', 'F']), 0.12, 'recognizer', 'a', '연습곡 A'));
const songB = pair(prog(x4(['Em', 'C', 'G', 'D7']), 0, 'manual', 'b', '연습곡 B'), prog(x4(['Em', 'C', 'G', 'D']), 0.2, 'recognizer', 'b', '연습곡 B'));
const songC = pair(prog(x4(['G', 'D', 'Em', 'C']), 0, 'edited', 'c', '연습곡 C'), prog(x4(['G', 'D', 'E', 'C']), 0, 'recognizer', 'c', '연습곡 C'));
const songShort = pair(prog(['C', 'G', 'C', 'G'], 0, 'manual', 's', '짧은 곡'), prog(['C', 'G', 'C', 'G'], 0.1, 'recognizer', 's', '짧은 곡'));

/** What the panel downloads, as the CLI would read it back. */
const exported = (pairs: AccuracyPair[], at = '2026-11-12T10:00:00Z') =>
  JSON.parse(JSON.stringify(accuracyExport(accuracyOverview(pairs), new Date(at)))) as Record<string, unknown>;
const parsed = (pairs: AccuracyPair[], name = 'a.json', at?: string) => parseAccuracyExport(exported(pairs, at), name);

describe('accuracy report: input validation', () => {
  it('accepts an overview export and rejects anything else with a clear message', () => {
    expect(parsed([songA, songC]).rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(() => parseAccuracyExport({ schemaVersion: 1, events: [] }, 'chart.json')).toThrow(ReportInputError);
    expect(() => parseAccuracyExport({ schemaVersion: 1, events: [] }, 'chart.json')).toThrow(/chart\.json: 정확도 모아 보기의 "결과 내보내기" 파일이 아니에요/);
    expect(() => parseAccuracyExport([], 'x.json')).toThrow(/JSON 객체가 아니에요/);
    expect(() => parseAccuracyExport({ ...exported([songA]), version: 2 }, 'x.json')).toThrow(/version 2/);
    const bad = exported([songA]);
    (bad.rows as Record<string, unknown>[])[0].majmin = { score: 'high' };
    expect(() => parseAccuracyExport(bad, 'x.json')).toThrow(/1번째 곡의 majmin/);
  });

  it('rejects out-of-range scores and counts with the same clear message, never a RangeError', () => {
    const withRow = (patch: Record<string, unknown>, at = 0) => {
      const v = exported([songA, songC]);
      Object.assign((v.rows as Record<string, unknown>[])[at], patch);
      return () => parseAccuracyExport(v, 'x.json');
    };
    const clear = /x\.json: 정확도 모아 보기의 "결과 내보내기" 파일이 아니에요/;
    for (const bad of [
      withRow({ majmin: { score: 1.2, evaluatedSec: 10 } }),
      withRow({ root: { score: -0.1, evaluatedSec: 10 } }),
      withRow({ sevenths: { score: 0.5, evaluatedSec: -1 } }),
      withRow({ timing: { medianOffsetMs: 100, matched: -3, unmatched: 0 } }),
      withRow({ timing: { medianOffsetMs: 100, matched: 2, unmatched: -1 } }),
      withRow({ timing: { medianOffsetMs: 100, matched: 1.5, unmatched: 0 } }),
      withRow({ timing: { medianOffsetMs: 100, matched: 1e12, unmatched: 0 } }),
      withRow({ timing: { medianOffsetMs: 100, matched: MAX_CHANGES, unmatched: 1 } }),
      // An edited row's timing is checked too, even though the report then ignores it.
      withRow({ timing: { medianOffsetMs: 0, matched: -1, unmatched: 0 } }, 1),
      withRow({ manualEvents: 30, events: 16 }),
    ]) {
      expect(bad).toThrow(ReportInputError);
      expect(bad).toThrow(clear);
    }
    const totals = exported([songA]);
    ((totals.totals as Record<string, Record<string, unknown>>).manual).timing = { medianOffsetMs: 1, matched: -1, unmatched: 0 };
    expect(() => parseAccuracyExport(totals, 'x.json')).toThrow(/totals\.manual timing/);
    // Edge values stay valid.
    expect(withRow({ majmin: { score: 0, evaluatedSec: 0 }, root: { score: 1, evaluatedSec: 32 }, sevenths: { score: null, evaluatedSec: 0 } })).not.toThrow();
  });

  it('copies only known numbers and names, so nothing extra (such as lyrics) reaches the report', () => {
    const v = exported([songA]);
    (v.rows as Record<string, unknown>[])[0].lyrics = '비밀 가사 한 줄';
    const html = renderAccuracyReport(mergeExports([parseAccuracyExport(v, 'a.json')]), { generatedAt: new Date('2026-11-12T00:00:00Z') });
    expect(html).not.toContain('비밀 가사');
  });
});

describe('accuracy report: merging and totals', () => {
  it('totals of a single export equal overview.ts totals exactly, timing included', () => {
    const o = accuracyOverview([songA, songB, songC]);
    const m = mergeExports([parsed([songA, songB, songC])]);
    for (const k of ['manual', 'edited', 'all'] as const) {
      const got = m.overview.totals[k];
      const want = o.totals[k];
      expect(got.songs).toBe(want.songs);
      expect(got.overlapSec).toBeCloseTo(want.overlapSec, 9);
      for (const w of ['majmin', 'root', 'sevenths'] as const) {
        expect(got[w].evaluatedSec).toBeCloseTo(want[w].evaluatedSec, 9);
        if (Number.isNaN(want[w].score)) expect(got[w].score).toBeNaN();
        else expect(got[w].score).toBeCloseTo(want[w].score, 9);
      }
      expect(got.timing).toEqual(want.timing);
    }
    expect(m.timingExact).toBe(true);
    expect(m.duplicates).toBe(0);
  });

  it('merges files by recording id, the latest export wins, and totals are recomputed', () => {
    const songAFixed = pair(songA.reference, prog(x4(['C', 'G', 'Am', 'F']), 0.12, 'recognizer', 'a', '연습곡 A'));
    const older = parsed([songA, songC], 'old.json', '2026-11-01T00:00:00Z');
    const newer = parsed([songAFixed, songB], 'new.json', '2026-11-10T00:00:00Z');
    // Argument order does not matter: the export time decides.
    const m = mergeExports([newer, older]);
    expect(m.overview.rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(m.duplicates).toBe(1);
    const fixedScore = accuracyOverview([songAFixed]).rows[0].comparison.majmin.score;
    expect(fixedScore).toBeGreaterThan(accuracyOverview([songA]).rows[0].comparison.majmin.score);
    expect(m.overview.rows.find((r) => r.id === 'a')?.comparison.majmin.score).toBeCloseTo(fixedScore, 9);
    const want = accuracyOverview([songAFixed, songB, songC]).totals;
    expect(m.overview.totals.all.majmin.score).toBeCloseTo(want.all.majmin.score, 9);
    expect(m.overview.totals.manual.root.evaluatedSec).toBeCloseTo(want.manual.root.evaluatedSec, 9);
    expect(m.overview.totals.edited.songs).toBe(1);
    // Two timed songs from two files: the pooled median is the matched-weighted median of song medians.
    expect(m.timingExact).toBe(false);
    expect(m.overview.totals.manual.timing?.matched).toBe(want.manual.timing?.matched);
    expect(accuracyTotals(m.overview.rows.filter((r) => r.referenceKind === 'manual')).timing?.medianMs).toBe(m.overview.totals.manual.timing?.medianMs);
  });

  it('a tie in export time keeps the later file in argument order', () => {
    const first = parsed([songA], 'first.json');
    const second = parseAccuracyExport({ ...exported([songA]), rows: [{ ...(exported([songA]).rows as object[])[0], title: '두 번째' }] }, 'second.json');
    expect(mergeExports([first, second]).overview.rows[0].title).toBe('두 번째');
  });
});

describe('accuracy report: sync offset recommendation', () => {
  it('uses hand-made references only, the panel rounding, and flags fewer than 20 matched changes', () => {
    const both = syncAdvice(mergeExports([parsed([songA, songB, songC])]).overview.totals.manual);
    expect(both.matched).toBe(30);
    expect(both.matched).toBeGreaterThanOrEqual(REPORT_CONFIDENT_CHANGES);
    expect(both.level).toBe('ok');
    expect(both.offsetMs).toBe(160); // median of 15 × 120 ms and 15 × 200 ms = 160 ms (auto is late → positive)
    const one = syncAdvice(mergeExports([parsed([songA])]).overview.totals.manual);
    expect(one).toMatchObject({ level: 'rough', offsetMs: 120, matched: 15 });
    const few = syncAdvice(mergeExports([parsed([songShort])]).overview.totals.manual);
    expect(few).toMatchObject({ level: 'none', offsetMs: null, matched: 3 });
    // An edited reference alone gives no timing at all.
    expect(syncAdvice(mergeExports([parsed([songC])]).overview.totals.manual)).toMatchObject({ level: 'none', matched: 0 });
  });
});

describe('accuracy report: HTML', () => {
  const html = renderAccuracyReport(mergeExports([parsed([songA, songB, songC])]), { generatedAt: new Date('2026-11-12T00:00:00Z') });

  it('is self-contained: no script, no external references, inline CSS and SVG', () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/\b(src|href)=/i);
    expect(html).not.toMatch(/@import|url\(/i);
    expect(html).toContain('<style>');
    expect(html).toContain('<svg class="chart"');
  });

  it('has the Korean labels, the setting name and the per-song rows', () => {
    for (const label of ['정확도 보고서', '한눈에 보기', '장·단 코드 이름', '근음', '7th 포함', '비교한 시간', '추천 싱크 오프셋', '싱크 보정', '오프셋', '곡별 결과', '이 숫자가 뜻하는 것', '+160 ms'])
      expect(html).toContain(label);
    expect(html).toContain('data-label="장·단"');
    expect(html).toContain('연습곡 B');
    expect(html).toContain('재지 않음 (고친 코드표)');
  });

  it('explains a root score above the major/minor score and low 7th accuracy', () => {
    const t = accuracyOverview([songA, songB]).totals.manual;
    const notes = meaningNotes(t, 0).join('\n');
    expect(notes).toContain('메이저인지 마이너인지');
    expect(notes).toContain('7th 포함 정확도');
  });

  it('an edited-only report says its headline is the edited charts and does not claim they were left out', () => {
    const only = renderAccuracyReport(mergeExports([parsed([songC])]), { generatedAt: new Date('2026-11-12T00:00:00Z') });
    const headline = only.slice(only.indexOf('한눈에 보기'), only.indexOf('추천 싱크 오프셋'));
    expect(headline).toContain('고친 코드표 1곡 기준');
    expect(headline).toContain('실제보다 높게 나와요');
    expect(headline).toContain('75%'); // the edited chart's 장·단 score is the headline
    expect(only).not.toContain('큰 숫자에는 넣지 않고');
    expect(only).toContain('위의 큰 숫자는 고친 코드표 1곡으로만 계산했어요');
    // With a hand-made chart present, the edited one is left out of the headline and the text says so.
    expect(html).toContain('큰 숫자에는 넣지 않고');
    const mixed = mergeExports([parsed([songA, songC])]).overview;
    expect(meaningNotes(mixed.totals.manual, 1).join('')).toContain('큰 숫자에는 넣지 않고');
    expect(meaningNotes(mixed.totals.edited, 1, true).join('')).not.toContain('큰 숫자에는 넣지 않고');
  });

  it('escapes song names', () => {
    const evil = pair(prog(x4(['C', 'G']), 0, 'manual', 'e', '<b>곡</b>'), prog(x4(['C', 'G']), 0.1, 'recognizer', 'e', ''));
    const svg = barChartSvg(mergeExports([parsed([evil])]).overview.rows);
    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;');
  });
});

describe('npm run accuracy-report (CLI)', () => {
  const script = path.resolve('scripts/accuracy-report.mjs');
  const fixture = path.resolve('tests/fixtures/accuracy-export-sample.json');

  it('writes one HTML file next to the input and prints its path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vg-report-'));
    try {
      const input = path.join(dir, 'vibe-guitar-accuracy-2026-11-12.json');
      writeFileSync(input, readFileSync(fixture));
      const r = spawnSync(process.execPath, [script, input], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      const out = path.join(dir, 'vibe-guitar-accuracy-2026-11-12-report.html');
      expect(r.stdout.trim()).toBe(out);
      expect(statSync(out).size).toBeGreaterThan(1000);
      expect(readFileSync(out, 'utf8')).not.toMatch(/<script|https?:/i);

      const custom = path.join(dir, 'custom.html');
      const r2 = spawnSync(process.execPath, [script, input, fixture, '--out', custom], { encoding: 'utf8' });
      expect(r2.status, r2.stderr).toBe(0);
      expect(existsSync(custom)).toBe(true);

      const wrong = path.join(dir, 'chart.json');
      writeFileSync(wrong, JSON.stringify({ schemaVersion: 1, events: [] }));
      const r3 = spawnSync(process.execPath, [script, wrong], { encoding: 'utf8' });
      expect(r3.status).toBe(1);
      expect(r3.stderr).toContain('결과 내보내기');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
