import { describe, expect, it } from 'vitest';
import type { EvalResult, SongResult } from '../src/eval/annotations';
import { renderAnnotationReport } from '../src/eval/annotation-report';
import { bootstrapMeanCi, precisionCheck, quantile, songMeanAnalysis, studentTQuantile, tMeanCi } from '../src/eval/song-mean';

type W = { score: number; evaluatedSec: number };
/** A minimal song row: only what the analysis reads. */
const row = (id: string, over: Partial<SongResult> & { majmin?: W; root?: W; sevenths?: W } = {}): SongResult => {
  const { majmin, root, sevenths, ...rest } = over;
  const m = majmin ?? { score: 0.5, evaluatedSec: 100 };
  return {
    id,
    role: 'eval',
    artist: `Artist ${id}`,
    title: id,
    dataset: 'billboard-2.0.1-lab',
    btcTraining: 'not-known',
    complexity: 'moderate',
    status: 'scored',
    score: { comparison: { majmin: m, root: root ?? m, sevenths: sevenths ?? m }, excludedSec: { majmin: 0, root: 0, sevenths: 0 }, notCoveredSec: 0, changes: [], changeMedianMs: NaN } as unknown as SongResult['score'],
    ...rest,
  };
};
const scored = (id: string, score: number, evaluatedSec = 100) => row(id, { majmin: { score, evaluatedSec } });

describe('song-mean analysis (VGT-7, PR #31)', () => {
  it('t quantiles match the table', () => {
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(12.7062, 3);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 5);
    expect(studentTQuantile(0.975, 24)).toBeCloseTo(2.063899, 5);
  });

  it('is reproducible for a fixed input (mulberry32 seed 7007, 10 000 resamples)', () => {
    const xs = [0.42, 0.55, 0.61, 0.38, 0.7, 0.66, 0.51, 0.47, 0.59, 0.73];
    const a = bootstrapMeanCi(xs);
    expect(bootstrapMeanCi(xs)).toEqual(a);
    expect(a.lower).toBeLessThan(0.562);
    expect(a.upper).toBeGreaterThan(0.562);
    expect(bootstrapMeanCi(xs, 10_000, 1)).not.toEqual(a);
    const rows = xs.map((x, i) => scored(`s${i}`, x));
    expect(songMeanAnalysis(rows)).toEqual(songMeanAnalysis(rows));
    expect(songMeanAnalysis(rows).bootstrap).toMatchObject({ method: 'percentile', resamples: 10_000, prng: 'mulberry32', seed: 7007, level: 0.95, lower: a.lower, upper: a.upper });
  });

  it('handles an empty population', () => {
    const a = songMeanAnalysis([]);
    expect(a.counts.primary).toBe(0);
    expect(a.mean).toBeNaN();
    expect(a.bootstrap.lower).toBeNaN();
    expect(a.tInterval).toBeNull();
    expect(a.sufficiency.met).toBe(false);
  });

  it('handles a single song and constant samples', () => {
    const one = songMeanAnalysis([scored('a', 0.6)]);
    expect(one.mean).toBe(0.6);
    expect(one.bootstrap.lower).toBe(0.6);
    expect(one.bootstrap.upper).toBe(0.6);
    expect(one.tInterval).toBeNull();
    const constant = songMeanAnalysis(Array.from({ length: 16 }, (_, i) => scored(`c${i}`, 0.7)));
    expect(constant.bootstrap.lower).toBeCloseTo(0.7, 12);
    expect(constant.bootstrap.upper).toBeCloseTo(0.7, 12);
    expect(constant.tInterval!.lower).toBeCloseTo(0.7, 12);
    expect(constant.sufficiency.met).toBe(true);
  });

  it('keeps only scored songs with a finite majmin score and positive evaluated seconds in the primary population', () => {
    const rows = [
      scored('a', 0.8),
      scored('b', 0.4),
      scored('nan', NaN),
      scored('zero', 0.9, 0),
      row('ex', { status: 'excluded', score: undefined, alignment: { excluded: { code: 'drift', reason: 'x' }, barConflict: false } as unknown as SongResult['alignment'] }),
      row('amb', { status: 'excluded', score: undefined, alignment: { excluded: { code: 'ambiguous', reason: 'x' }, barConflict: true } as unknown as SongResult['alignment'] }),
      row('miss', { status: 'missing', score: undefined }),
      row('err', { status: 'error', score: undefined }),
    ];
    const a = songMeanAnalysis(rows);
    expect(a.counts).toEqual({ selected: 8, scored: 4, primary: 2, scoredNotPrimary: 2, excluded: 2, excludedByCode: { drift: 1, ambiguous: 1 }, missing: 1, error: 1, barConflict: 1 });
    expect(a.mean).toBeCloseTo(0.6, 12);
    expect(a.median).toBeCloseTo(0.6, 12);
    expect(a.min).toBe(0.4);
    expect(a.max).toBe(0.8);
    // Bounds over all 8 selected songs: the 6 outside the primary at 0 or 1.
    expect(a.bounds.songs).toBe(8);
    expect(a.bounds.lower).toBeCloseTo(1.2 / 8, 12);
    expect(a.bounds.upper).toBeCloseTo(7.2 / 8, 12);
  });

  it('reports composition by complexity, annotation length and repeated artists over the primary songs', () => {
    const a = songMeanAnalysis([
      row('a', { complexity: 'simple', artist: 'X', annotationDurationSec: 200 }),
      row('b', { complexity: 'complex', artist: 'X', annotationDurationSec: 180 }),
      row('c', { complexity: 'complex', artist: 'Y', annotationDurationSec: 240 }),
      row('m', { status: 'missing', score: undefined, artist: 'Y', annotationDurationSec: 999 }),
    ]);
    expect(a.composition).toEqual({ complexity: { simple: 1, complex: 2 }, lengthSec: { min: 180, median: 200, max: 240 }, repeatedArtists: [{ artist: 'X', songs: 2 }] });
  });

  it('weighs every song the same, whatever its evaluated duration', () => {
    const a = songMeanAnalysis([scored('long', 0.9, 1000), scored('short', 0.3, 10)]);
    expect(a.mean).toBeCloseTo(0.6, 12);
    expect(a.tInterval!.df).toBe(1);
  });

  it('reports root and sevenths song means over the primary songs', () => {
    const a = songMeanAnalysis([
      row('a', { majmin: { score: 0.5, evaluatedSec: 10 }, root: { score: 0.7, evaluatedSec: 10 }, sevenths: { score: 0.2, evaluatedSec: 10 } }),
      row('b', { majmin: { score: 0.7, evaluatedSec: 10 }, root: { score: 0.9, evaluatedSec: 10 }, sevenths: { score: NaN, evaluatedSec: 0 } }),
      row('c', { majmin: { score: NaN, evaluatedSec: 0 }, root: { score: 0.1, evaluatedSec: 10 } }),
    ]);
    expect(a.songMean.root).toBeCloseTo(0.8, 12);
    expect(a.songMean.sevenths).toBeCloseTo(0.2, 12);
  });

  it('counts exactly a 0.10 half-width as precise enough, and needs 15 songs', () => {
    expect(precisionCheck(15, 0.5, 0.7)).toMatchObject({ n: 15, met: true });
    expect(precisionCheck(15, 0.55, 0.75).met).toBe(true); // 0.1 after float rounding
    expect(precisionCheck(15, 0.5, 0.7000001).met).toBe(false);
    expect(precisionCheck(14, 0.5, 0.6).met).toBe(false);
    expect(precisionCheck(20, NaN, NaN).met).toBe(false);
    const c = precisionCheck(15, 0.5, 0.7);
    expect(c.halfWidth).toBeCloseTo(0.1, 12);
    expect(c.minSongs).toBe(15);
    expect(c.maxHalfWidth).toBe(0.1);
  });

  it('t interval: mean +- t(0.975, n-1) * s / sqrt(n)', () => {
    const t = tMeanCi([0.2, 0.4, 0.6])!;
    expect(t.sd).toBeCloseTo(0.2, 12);
    expect(t.tCrit).toBeCloseTo(4.302653, 5);
    expect(t.lower).toBeCloseTo(0.4 - (4.302653 * 0.2) / Math.sqrt(3), 5);
  });

  it('uses the evaluator quantile (linear interpolation)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('report: analysis section and list-dependent text', () => {
  const base = (songs: SongResult[]): EvalResult => {
    const t = { songs: 0, majmin: { score: NaN, evaluatedSec: 0 }, root: { score: NaN, evaluatedSec: 0 }, sevenths: { score: NaN, evaluatedSec: 0 }, songMean: { majmin: NaN, root: NaN, sevenths: NaN }, changes: { matched: 0, unmatched: 0, medianMs: NaN, p10Ms: NaN, p90Ms: NaN, within100Ms: NaN } };
    return { schema: 's', generatedAt: '2026-11-13T00:00:00Z', songList: { declaredAt: '2026-11-13', sha256: null, songs: songs.length }, datasets: {}, songs, totals: { all: t, heldOut: t, trainingOverlap: t }, analysis: { heldOut: songMeanAnalysis(songs) } };
  };
  const strip = (r: SongResult): SongResult => ({ ...r, status: 'missing', score: undefined });

  it('shows the predeclared analysis in Korean and counts the list it evaluates', () => {
    const songs = Array.from({ length: 25 }, (_, i) => (i < 3 ? strip(scored(`s${i}`, 0.5)) : scored(`s${i}`, 0.5 + (i % 5) * 0.05)));
    const html = renderAnnotationReport(base(songs));
    expect(html).toContain('미리 정한 주 분석');
    expect(html).toContain('95% 신뢰구간');
    expect(html).toContain('VGT-7 마무리 기준');
    expect(html).toContain('평가 25곡');
    expect(html).not.toContain('시범 2곡');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('NaN');
  });

  it('says a bar-phase conflict excludes the song instead of only warning', () => {
    const html = renderAnnotationReport(base([scored('a', 0.5)]));
    expect(html).not.toContain('경고만 남겨요');
    expect(html).toContain('제외해요');
  });

  it('still renders a result written before the analysis existed', () => {
    const r = base([scored('a', 0.5), { ...scored('p', 0.5), role: 'pilot' }]);
    delete r.analysis;
    const html = renderAnnotationReport(r);
    expect(html).not.toContain('미리 정한 주 분석');
    expect(html).toContain('시범 1곡, 평가 1곡');
  });
});
