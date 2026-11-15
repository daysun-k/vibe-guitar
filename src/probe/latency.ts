/**
 * Capture-latency probe (dev only, Linear VGT-7): a click track with clicks at exact
 * sample positions, a click detector for the audio that listening mode placed on the
 * timeline, and the statistics that turn placed-vs-source click times into a suggested
 * CAPTURE_LATENCY_SEC. It measures placement error only (media element clock -> tab
 * capture -> anchor -> resample -> AudioPlacer), not speaker or Bluetooth delay.
 * Pure logic (no browser or Node APIs) so tests, the probe page, the offscreen hook and
 * the report script share it.
 */

export const PROBE_SAMPLE_RATE = 48000;
export const PROBE_DURATION_SEC = 72;

export type ProbeClickKind = 'main' | 'rate-check';

export interface ProbeClick {
  /** 0-based index over all clicks of the track. */
  index: number;
  kind: ProbeClickKind;
  /** Sample (at PROBE_SAMPLE_RATE) where the click starts. */
  sample: number;
  /** sample / PROBE_SAMPLE_RATE: the click's exact source time. */
  timeSec: number;
}

/** What the probe page does to the media element during one session (media times). */
export interface ProbeSessionPlan {
  /** Pause when the element reaches this time, for `pauseForSec`, then resume. */
  pauseAtSec: number;
  pauseForSec: number;
  /** Seek back from `seekFromSec` to `seekToSec` (replays the clicks in between). */
  seekFromSec: number;
  seekToSec: number;
  /** Play at `rate` from `rateFromSec` to `rateToSec`: nothing in there may be stored. */
  rateFromSec: number;
  rateToSec: number;
  rate: number;
}

export interface ProbePlan {
  sampleRate: number;
  durationSec: number;
  clicks: ProbeClick[];
  session: ProbeSessionPlan;
}

/** 20 main clicks at irregular spacing (1.5 s .. 55.2 s), then 3 clicks played at 1.5x. */
const MAIN_GAPS_SEC = [2.31, 3.07, 2.64, 3.42, 2.18, 2.93, 3.55, 2.47, 2.86, 3.21, 2.39, 3.38, 2.72, 2.25, 3.13, 2.58, 3.46, 2.81, 2.34];
const FIRST_CLICK_SEC = 1.5;
const RATE_CHECK_SEC = [61.0, 63.4, 65.9];

export function probePlan(): ProbePlan {
  const times: { t: number; kind: ProbeClickKind }[] = [];
  let t = FIRST_CLICK_SEC;
  times.push({ t, kind: 'main' });
  for (const g of MAIN_GAPS_SEC) {
    t += g;
    times.push({ t, kind: 'main' });
  }
  for (const r of RATE_CHECK_SEC) times.push({ t: r, kind: 'rate-check' });
  const clicks = times.map(({ t: sec, kind }, index) => {
    const sample = Math.round(sec * PROBE_SAMPLE_RATE);
    return { index, kind, sample, timeSec: sample / PROBE_SAMPLE_RATE };
  });
  return {
    sampleRate: PROBE_SAMPLE_RATE,
    durationSec: PROBE_DURATION_SEC,
    clicks,
    session: { pauseAtSec: 14, pauseForSec: 2, seekFromSec: 40, seekToSec: 33.5, rateFromSec: 59.5, rateToSec: 67.5, rate: 1.5 },
  };
}

const CLICK_FREQ_HZ = 2500;
const CLICK_LEN_SEC = 0.004;
const CLICK_DECAY_SEC = 0.001;
const CLICK_AMP = 0.7;
/** Quiet sustained tones so the capture path carries ordinary program audio, not silence. */
const BED_TONES_HZ = [110, 164.81, 220, 277.18];
const BED_AMP = 0.035;

/** Mono samples of the probe track (PROBE_SAMPLE_RATE). */
export function renderProbeTrack(plan: ProbePlan = probePlan()): Float32Array {
  const sr = plan.sampleRate;
  const n = Math.round(plan.durationSec * sr);
  const out = new Float32Array(n);
  const fade = Math.round(0.5 * sr);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const f of BED_TONES_HZ) s += Math.sin((2 * Math.PI * f * i) / sr);
    const g = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = BED_AMP * s * g;
  }
  const len = Math.round(CLICK_LEN_SEC * sr);
  for (const c of plan.clicks) {
    for (let i = 0; i < len && c.sample + i < n; i++) {
      out[c.sample + i] += CLICK_AMP * Math.sin((2 * Math.PI * CLICK_FREQ_HZ * i) / sr) * Math.exp(-i / (CLICK_DECAY_SEC * sr));
    }
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return bytes;
}

export interface DetectOptions {
  /** Absolute floor for the high-passed envelope (the bed stays far below it). */
  minLevel?: number;
  /** Clicks closer together than this are one click. */
  minSeparationSec?: number;
  /** Onsets this close to either end of the buffer are dropped (a cut click). */
  edgeGuardSec?: number;
}

/**
 * Click onsets (seconds from the first sample) in `samples`. A first difference removes
 * the low tonal bed; a click is where its magnitude first crosses half of the click's own
 * peak (linear interpolation between samples), found after the envelope crossed a
 * threshold. Reports the click start, like ProbeClick.timeSec.
 */
export function detectClicks(samples: Float32Array, sampleRate: number, opts: DetectOptions = {}): number[] {
  const minLevel = opts.minLevel ?? 0.08;
  const sep = Math.round((opts.minSeparationSec ?? 0.3) * sampleRate);
  const guard = (opts.edgeGuardSec ?? 0.002) * sampleRate;
  const n = samples.length;
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.abs(samples[i] - samples[i - 1]);
  const look = Math.max(2, Math.round(0.003 * sampleRate));
  const back = Math.max(2, Math.round(0.001 * sampleRate));
  const onsets: number[] = [];
  let i = 1;
  while (i < n) {
    if (env[i] < minLevel) {
      i++;
      continue;
    }
    let peak = 0;
    for (let j = i; j < Math.min(n, i + look); j++) peak = Math.max(peak, env[j]);
    const half = peak / 2;
    let k = Math.max(1, i - back);
    while (k < Math.min(n - 1, i + look) && env[k] < half) k++;
    // Interpolate the half-peak crossing between k - 1 and k.
    const a = env[k - 1];
    const b = env[k];
    const frac = b > a && a < half ? (half - a) / (b - a) : 1;
    const at = k - 1 + frac;
    if (at >= guard && at <= n - 1 - guard) onsets.push(at / sampleRate);
    i += sep;
  }
  return onsets;
}

/** One stored stretch of placed audio and the clicks found in it (placed times, s). */
export interface PlacedSegment {
  startSec: number;
  endSec: number;
  onsetsSec: number[];
  /**
   * The start the segment's first player report alone gave (the placement before VGT-22).
   * Absent in dumps made before VGT-22, whose startSec is that start.
   */
  firstStartSec?: number;
  /** Interquartile range of the per-block start estimates inside the segment (VGT-22 dumps). */
  startIqrSec?: number;
}

/** The parts of a stored ListeningSession segment that the probe dump reads. */
export interface StoredSegmentView {
  readonly startSec: number;
  readonly endSec: number;
  readonly durationSec: number;
  readonly firstStartSec: number;
  readonly startEstimates: readonly number[];
  readonly audio: { view(): Float32Array };
}

/** The dump entry for one stored segment (offscreen probe hook and the simulated capture share it). */
export function placedSegmentOf(seg: StoredSegmentView, sampleRate: number): PlacedSegment {
  return {
    startSec: seg.startSec,
    endSec: seg.endSec,
    onsetsSec: detectClicks(seg.audio.view(), sampleRate).map((t) => seg.startSec + t),
    firstStartSec: seg.firstStartSec,
    startIqrSec: seg.startEstimates.length ? percentile([...seg.startEstimates], 75) - percentile([...seg.startEstimates], 25) : 0,
  };
}

/**
 * The same segment as the first player report alone would have placed it: every onset moves by
 * firstStartSec - startSec. Used to report, from one real run, what the placement before VGT-22
 * gave. Null when the dump does not carry firstStartSec.
 */
function asFirstAnchorPlaced(seg: PlacedSegment): PlacedSegment | null {
  if (seg.firstStartSec === undefined) return null;
  const d = seg.firstStartSec - seg.startSec;
  return { startSec: seg.firstStartSec, endSec: seg.endSec + d, onsetsSec: seg.onsetsSec.map((t) => t + d) };
}

export interface ClickMatch {
  clickIndex: number;
  kind: ProbeClickKind;
  sourceSec: number;
  placedSec: number;
  /** placedSec - sourceSec: positive = audio placed too late. */
  residualSec: number;
  segment: number;
}

export interface MatchResult {
  matches: ClickMatch[];
  /** Placed onsets with no click within the tolerance. */
  extras: { placedSec: number; segment: number }[];
  /** Clicks never found in the placed audio. */
  missing: ProbeClick[];
}

/**
 * Pairs each placed onset with the nearest source click within `tolSec`. A click can be
 * placed more than once (it was replayed after a backward seek); each placement counts.
 */
export function matchClicks(clicks: ProbeClick[], segments: PlacedSegment[], tolSec = 0.25): MatchResult {
  const matches: ClickMatch[] = [];
  const extras: MatchResult['extras'] = [];
  const seen = new Set<number>();
  segments.forEach((seg, si) => {
    for (const p of seg.onsetsSec) {
      let best: ProbeClick | null = null;
      for (const c of clicks) if (!best || Math.abs(c.timeSec - p) < Math.abs(best.timeSec - p)) best = c;
      if (best && Math.abs(best.timeSec - p) <= tolSec) {
        matches.push({ clickIndex: best.index, kind: best.kind, sourceSec: best.timeSec, placedSec: p, residualSec: p - best.timeSec, segment: si });
        seen.add(best.index);
      } else extras.push({ placedSec: p, segment: si });
    }
  });
  return { matches, extras, missing: clicks.filter((c) => !seen.has(c.index)) };
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated percentile, p in [0, 100]. */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Least-squares slope of y over x (NaN with fewer than 2 distinct x). */
export function slope(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

/** What the offscreen probe hook returns for one recording (see probe-offscreen.ts). */
export interface ProbeSessionDump {
  sessionId: string;
  /** AudioContext rate of the capture (Hz). */
  captureSampleRate: number | null;
  /** CAPTURE_LATENCY_SEC that placed this audio. */
  latencyUsedSec: number;
  segments: PlacedSegment[];
  /** Source clicks of the track that was played. */
  clicks: ProbeClick[];
  /** The page's log of what it did (media time, wall time), for reading the report. */
  actions?: { action: string; mediaSec: number; atMs: number }[];
}

export interface ProbeDump {
  tool: 'vibe-guitar latency probe';
  version: 1;
  createdAt: string;
  sessions: ProbeSessionDump[];
}

export const PROBE_TARGETS = {
  /** |median residual| after the correction, on the validation clicks. */
  medianSec: 0.01,
  /** 95th percentile of |residual| after the correction, on the validation clicks. */
  p95Sec: 0.05,
  /** |drift| over one minute of continuous playback. */
  driftSecPerMin: 0.01,
} as const;

export interface SessionReport {
  sessionId: string;
  captureSampleRate: number | null;
  segments: {
    startSec: number;
    endSec: number;
    clicks: number;
    medianResidualSec: number;
    /** startSec - firstStartSec: how far the stored start moved from the first report's (VGT-22 dumps). */
    firstAnchorShiftSec?: number;
    startIqrSec?: number;
  }[];
  /** Max - min of the median residuals of the segments with clicks (the per-anchor offset, VGT-22). */
  segmentSpreadSec: number;
  mainPlaced: number;
  mainMissing: number[];
  replays: number;
  extras: number;
  rateCheckPlaced: number;
  medianResidualSec: number;
  driftSecPerMin: number;
}

export interface ProbeReport {
  latencyUsedSec: number;
  sessions: SessionReport[];
  fit: { n: number; medianResidualSec: number };
  validation: {
    n: number;
    medianSec: number;
    p95AbsSec: number;
    maxAbsSec: number;
    uncorrectedMedianSec: number;
    /** p95 of |corrected residual| without segments stored from the start of the track (see startClampSec). */
    p95AbsExcludingStartSec: number;
  };
  /**
   * Median residual of segments stored from the start of the track (start at most
   * START_SEGMENT_SEC) minus the overall correction. Before VGT-22, ListeningSession.append
   * clamped a segment start to 0 s, so audio stored right after playback started at 0 s
   * landed late by up to the latency constant; the start is no longer clamped, and this
   * checks that such segments land like the rest. NaN when no such segment had clicks.
   */
  startClampSec: number;
  /**
   * What the placement before VGT-22 (each segment placed by its first player report alone)
   * gives on the same run, from the dump's firstStartSec. Null for older dumps.
   */
  firstAnchor: {
    validationMedianSec: number;
    validationP95AbsSec: number;
    /** Per session, as SessionReport.segmentSpreadSec. */
    segmentSpreadSec: number[];
  } | null;
  driftSecPerMin: number;
  rateCheckPlaced: number;
  suggestedLatencySec: number;
  /** complete: every session placed all main clicks and recorded past the 1.5x stretch. */
  pass: { complete: boolean; median: boolean; p95: boolean; drift: boolean; rateNotStored: boolean };
  problems: string[];
}

/**
 * Fit on even-indexed main clicks, validate on odd-indexed ones (each placement counts),
 * pooled over sessions. The suggested constant is latencyUsed + median fit residual:
 * a positive residual means audio lands too late, so the latency must grow.
 */
export function analyzeProbeDump(dump: ProbeDump): ProbeReport {
  const r = analyzePlacement(dump);
  const shifted = dump.sessions.map((s) => s.segments.map(asFirstAnchorPlaced));
  if (shifted.every((segs) => segs.every((g) => g !== null))) {
    const old = analyzePlacement({ ...dump, sessions: dump.sessions.map((s, i) => ({ ...s, segments: shifted[i] as PlacedSegment[] })) });
    r.firstAnchor = {
      validationMedianSec: old.validation.medianSec,
      validationP95AbsSec: old.validation.p95AbsSec,
      segmentSpreadSec: old.sessions.map((s) => s.segmentSpreadSec),
    };
  }
  return r;
}

/** A segment starting at or before this (s) was stored from the start of the track. */
export const START_SEGMENT_SEC = 0.25;

function analyzePlacement(dump: ProbeDump): ProbeReport {
  const problems: string[] = [];
  if (!dump || !Array.isArray(dump.sessions) || !dump.sessions.length) throw new Error('세션이 없는 결과 파일입니다');
  const used = dump.sessions[0].latencyUsedSec;
  if (dump.sessions.some((s) => s.latencyUsedSec !== used)) problems.push('세션마다 CAPTURE_LATENCY_SEC가 다릅니다: 같은 빌드로 다시 측정하세요');
  const fit: number[] = [];
  const val: (ClickMatch & { atStart: boolean })[] = [];
  const startResiduals: number[] = [];
  const driftX: number[] = [];
  const driftY: number[] = [];
  let rateCheckPlaced = 0;
  let incomplete = 0;
  const sessions: SessionReport[] = dump.sessions.map((s) => {
    const r = matchClicks(s.clicks, s.segments);
    const main = r.matches.filter((m) => m.kind === 'main');
    const atStart = (m: ClickMatch) => s.segments[m.segment].startSec <= START_SEGMENT_SEC;
    for (const m of main) {
      if (m.clickIndex % 2 === 0) fit.push(m.residualSec);
      else val.push({ ...m, atStart: atStart(m) });
      if (atStart(m)) startResiduals.push(m.residualSec);
    }
    // Drift: residual against time within each continuous segment, so a seek or pause
    // (a new segment, re-anchored) does not look like drift. Both axes are centered per
    // segment, so segments of different lengths do not bias the pooled within-segment slope.
    const sx: number[] = [];
    const sy: number[] = [];
    s.segments.forEach((seg, si) => {
      const inSeg = main.filter((m) => m.segment === si);
      if (inSeg.length < 2) return;
      const mr = median(inSeg.map((m) => m.residualSec));
      const xs = inSeg.map((m) => m.placedSec - seg.startSec);
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      inSeg.forEach((m, i) => {
        sx.push(xs[i] - mx);
        sy.push(m.residualSec - mr);
      });
    });
    driftX.push(...sx);
    driftY.push(...sy);
    const placedCounts = new Map<number, number>();
    for (const m of main) placedCounts.set(m.clickIndex, (placedCounts.get(m.clickIndex) ?? 0) + 1);
    const ratePlaced = r.matches.filter((m) => m.kind === 'rate-check').length;
    rateCheckPlaced += ratePlaced;
    if (r.extras.length) problems.push(`${s.sessionId}: 원본에 없는 클릭 ${r.extras.length}개가 검출됐습니다`);
    // A run that stopped early (capture ended, tab reloaded) must not pass: every main click
    // has to be placed, and stored audio must reach past the 1.5x stretch, which proves the
    // page played through it and resumed 1x afterwards.
    const mainMissing = s.clicks.filter((c) => c.kind === 'main' && !placedCounts.has(c.index)).map((c) => c.index);
    const rateEndSec = Math.max(...s.clicks.filter((c) => c.kind === 'rate-check').map((c) => c.timeSec));
    const pastRateStretch = s.segments.some((seg) => seg.endSec >= rateEndSec + 0.5);
    if (mainMissing.length || !pastRateStretch) {
      incomplete++;
      problems.push(
        `${s.sessionId}: 측정이 끝까지 기록되지 않았습니다 (빠진 본 클릭 ${mainMissing.length}개${pastRateStretch ? '' : ', 1.5x 구간 뒤 기록 없음'}): 이 세션을 다시 측정하세요`,
      );
    }
    const segments: SessionReport['segments'] = s.segments.map((seg, si) => {
      const inSeg = main.filter((m) => m.segment === si);
      return {
        startSec: seg.startSec,
        endSec: seg.endSec,
        clicks: inSeg.length,
        medianResidualSec: median(inSeg.map((m) => m.residualSec)),
        ...(seg.firstStartSec !== undefined ? { firstAnchorShiftSec: seg.startSec - seg.firstStartSec } : {}),
        ...(seg.startIqrSec !== undefined ? { startIqrSec: seg.startIqrSec } : {}),
      };
    });
    const segMedians = segments.filter((g) => g.clicks > 0).map((g) => g.medianResidualSec);
    return {
      sessionId: s.sessionId,
      captureSampleRate: s.captureSampleRate,
      segments,
      segmentSpreadSec: segMedians.length ? Math.max(...segMedians) - Math.min(...segMedians) : NaN,
      mainPlaced: main.length,
      mainMissing,
      replays: [...placedCounts.values()].reduce((a, n) => a + Math.max(0, n - 1), 0),
      extras: r.extras.length,
      rateCheckPlaced: ratePlaced,
      medianResidualSec: median(main.map((m) => m.residualSec)),
      driftSecPerMin: slope(sx, sy) * 60,
    };
  });
  if (!fit.length || !val.length) problems.push('맞춰진 클릭이 부족합니다: 측정을 다시 하세요');
  const correction = median(fit);
  const corrected = val.map((m) => m.residualSec - correction);
  const abs = corrected.map(Math.abs);
  const drift = slope(driftX, driftY) * 60;
  const startClampSec = median(startResiduals) - correction;
  if (Math.abs(startClampSec) > PROBE_TARGETS.medianSec) {
    problems.push(
      `곡 처음(0 s)부터 기록한 구간이 나머지보다 ${(startClampSec * 1000).toFixed(1)} ms 다르게 배치됩니다: 상수와 별개인 배치 오류입니다 (VGT-22 이전 빌드라면 구간 시작을 0 s로 고정한 탓)`,
    );
  }
  const validation = {
    n: val.length,
    medianSec: median(corrected),
    p95AbsSec: percentile(abs, 95),
    maxAbsSec: abs.length ? Math.max(...abs) : NaN,
    uncorrectedMedianSec: median(val.map((m) => m.residualSec)),
    p95AbsExcludingStartSec: percentile(val.filter((m) => !m.atStart).map((m) => Math.abs(m.residualSec - correction)), 95),
  };
  return {
    latencyUsedSec: used,
    sessions,
    fit: { n: fit.length, medianResidualSec: correction },
    validation,
    startClampSec,
    firstAnchor: null,
    driftSecPerMin: drift,
    rateCheckPlaced,
    suggestedLatencySec: used + correction,
    pass: {
      complete: incomplete === 0,
      median: Math.abs(validation.medianSec) <= PROBE_TARGETS.medianSec,
      p95: validation.p95AbsSec <= PROBE_TARGETS.p95Sec,
      drift: Number.isFinite(drift) && Math.abs(drift) <= PROBE_TARGETS.driftSecPerMin,
      // Vacuous when the 1.5x stretch was never played, so it needs a complete run.
      rateNotStored: rateCheckPlaced === 0 && incomplete === 0,
    },
    problems,
  };
}

const ms = (s: number) => (Number.isFinite(s) ? `${(s * 1000).toFixed(1)} ms` : '-');
const ok = (b: boolean) => (b ? '통과' : '미달');

export function formatProbeReport(r: ProbeReport): string {
  const lines: string[] = [];
  lines.push('Vibe Guitar 캡처 지연 측정 (배치 오차만 측정; 스피커·블루투스 지연은 포함하지 않음)');
  lines.push(`측정에 쓴 CAPTURE_LATENCY_SEC: ${r.latencyUsedSec.toFixed(3)} s`);
  lines.push('');
  for (const s of r.sessions) {
    lines.push(`세션 ${s.sessionId} (캡처 ${s.captureSampleRate ?? '?'} Hz)`);
    lines.push(`  배치된 본 클릭 ${s.mainPlaced}개 (재생 반복 ${s.replays}), 빠진 클릭 ${s.mainMissing.length ? s.mainMissing.join(', ') : '없음'}, 잘못 검출 ${s.extras}`);
    lines.push(`  잔차 중앙값 ${ms(s.medianResidualSec)}, 드리프트 ${ms(s.driftSecPerMin)}/분, 1.5x 구간 클릭 저장 ${s.rateCheckPlaced}개`);
    s.segments.forEach((g, i) => {
      const anchor =
        g.firstAnchorShiftSec !== undefined ? `, 첫 보고 기준 시작과의 차이 ${ms(g.firstAnchorShiftSec)}, 블록별 시작 추정 IQR ${ms(g.startIqrSec ?? NaN)}` : '';
      lines.push(`  구간 ${i + 1}: ${g.startSec.toFixed(2)}–${g.endSec.toFixed(2)} s, 클릭 ${g.clicks}개, 잔차 중앙값 ${ms(g.medianResidualSec)}${anchor}`);
    });
    lines.push(`  구간 잔차 중앙값의 폭(최대-최소) ${ms(s.segmentSpreadSec)}`);
  }
  lines.push('');
  lines.push(`맞춤(짝수 클릭) ${r.fit.n}개: 잔차 중앙값 ${ms(r.fit.medianResidualSec)}`);
  lines.push(`검증(홀수 클릭) ${r.validation.n}개: 보정 전 중앙값 ${ms(r.validation.uncorrectedMedianSec)}`);
  lines.push(`  보정 후 중앙값 ${ms(r.validation.medianSec)} [목표 |값| <= ${ms(PROBE_TARGETS.medianSec)}: ${ok(r.pass.median)}]`);
  lines.push(`  보정 후 |잔차| p95 ${ms(r.validation.p95AbsSec)} [목표 <= ${ms(PROBE_TARGETS.p95Sec)}: ${ok(r.pass.p95)}], 최대 ${ms(r.validation.maxAbsSec)}`);
  lines.push(`  곡 처음부터 기록한 구간을 뺀 |잔차| p95 ${ms(r.validation.p95AbsExcludingStartSec)}; 곡 처음부터 기록한 구간의 추가 지연 ${ms(r.startClampSec)}`);
  if (r.firstAnchor) {
    lines.push(
      `  같은 측정을 첫 보고만으로 배치했다면(VGT-22 이전 방식): 보정 후 중앙값 ${ms(r.firstAnchor.validationMedianSec)}, |잔차| p95 ${ms(r.firstAnchor.validationP95AbsSec)}, 세션별 구간 폭 ${r.firstAnchor.segmentSpreadSec.map(ms).join(' / ')}`,
    );
  }
  lines.push(`드리프트(연속 구간 안) ${ms(r.driftSecPerMin)}/분 [목표 |값| <= ${ms(PROBE_TARGETS.driftSecPerMin)}/분: ${ok(r.pass.drift)}]`);
  lines.push(`1x가 아닌 재생 저장 안 함: 1.5x 구간 클릭 ${r.rateCheckPlaced}개 저장 [${ok(r.pass.rateNotStored)}]`);
  lines.push(`모든 세션이 끝까지 기록됨 [${ok(r.pass.complete)}]`);
  lines.push('');
  if (!r.pass.complete) lines.push('끝까지 기록되지 않은 세션이 있어 아래 제안값을 쓰면 안 됩니다.');
  lines.push(`제안 CAPTURE_LATENCY_SEC = ${r.latencyUsedSec.toFixed(3)} + ${r.fit.medianResidualSec.toFixed(4)} = ${r.suggestedLatencySec.toFixed(3)} s`);
  for (const p of r.problems) lines.push(`주의: ${p}`);
  return lines.join('\n');
}
