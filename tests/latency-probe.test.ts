import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MODEL_SAMPLE_RATE } from '../src/audio/features';
import { resample } from '../src/audio/resample';
import { AudioPlacer, type PlayerAnchor } from '../src/recognize/placement';
import { ListeningSession } from '../src/recognize/session';
import {
  analyzeProbeDump,
  detectClicks,
  encodeWav,
  formatProbeReport,
  matchClicks,
  median,
  percentile,
  placedSegmentOf,
  probePlan,
  renderProbeTrack,
  slope,
  type ProbeDump,
  type ProbeSessionDump,
} from '../src/probe/latency';
import { latencyProbeManifest, PROBE_MATCH } from '../src/probe/manifest';
import { toPlayerState } from '../src/extension/probe/probe-offscreen';

const plan = probePlan();
const track = renderProbeTrack(plan);

describe('probe click track', () => {
  it('has 20 irregular main clicks and 3 rate-check clicks at exact samples', () => {
    const main = plan.clicks.filter((c) => c.kind === 'main');
    expect(main).toHaveLength(20);
    expect(plan.clicks.filter((c) => c.kind === 'rate-check')).toHaveLength(3);
    for (const c of plan.clicks) {
      expect(Number.isInteger(c.sample)).toBe(true);
      expect(c.timeSec).toBe(c.sample / plan.sampleRate);
    }
    const gaps = main.slice(1).map((c, i) => c.timeSec - main[i].timeSec);
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(10);
  });

  it('keeps every click away from the pause, seek and rate-change points', () => {
    const s = plan.session;
    for (const t of [s.pauseAtSec, s.seekFromSec, s.seekToSec, s.rateFromSec, s.rateToSec]) {
      for (const c of plan.clicks) expect(Math.abs(c.timeSec - t)).toBeGreaterThan(0.5);
    }
    for (const c of plan.clicks) {
      const inRate = c.timeSec > s.rateFromSec && c.timeSec < s.rateToSec;
      expect(inRate).toBe(c.kind === 'rate-check');
    }
  });

  it('encodes a 16-bit mono WAV', () => {
    const wav = encodeWav(track.subarray(0, 1000), plan.sampleRate);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(wav.length).toBe(44 + 2000);
  });
});

describe('detectClicks', () => {
  it('finds every click at the source rate within 0.1 ms', () => {
    const found = detectClicks(track, plan.sampleRate);
    expect(found).toHaveLength(plan.clicks.length);
    found.forEach((t, i) => expect(Math.abs(t - plan.clicks[i].timeSec)).toBeLessThan(0.0001));
  });

  it('finds every click after resampling to the model rate within 0.3 ms (detector bias)', () => {
    const r = resample(track, plan.sampleRate, MODEL_SAMPLE_RATE);
    const found = detectClicks(r, MODEL_SAMPLE_RATE);
    expect(found).toHaveLength(plan.clicks.length);
    const err = found.map((t, i) => t - plan.clicks[i].timeSec);
    expect(Math.max(...err.map(Math.abs))).toBeLessThan(0.0003);
  });

  it('ignores the tonal bed and a click cut at the buffer edge', () => {
    const bedOnly = track.subarray(plan.clicks[0].sample + 4000, plan.clicks[1].sample - 100);
    expect(detectClicks(bedOnly, plan.sampleRate)).toEqual([]);
    const cut = track.subarray(plan.clicks[0].sample + 5, plan.clicks[1].sample + 5000);
    const found = detectClicks(cut, plan.sampleRate);
    expect(found).toHaveLength(1);
    expect(found[0]).toBeCloseTo((plan.clicks[1].sample - plan.clicks[0].sample - 5) / plan.sampleRate, 4);
  });
});

describe('matching and statistics', () => {
  const clicks = plan.clicks;
  it('pairs replays, reports missing clicks and extras', () => {
    const r = matchClicks(clicks, [
      { startSec: 0, endSec: 10, onsetsSec: [clicks[0].timeSec + 0.02, clicks[1].timeSec + 0.03, 5.2] },
      { startSec: 1, endSec: 8, onsetsSec: [clicks[1].timeSec + 0.025] },
    ]);
    expect(r.matches.map((m) => [m.clickIndex, m.segment])).toEqual([[0, 0], [1, 0], [1, 1]]);
    expect(r.matches[0].residualSec).toBeCloseTo(0.02, 9);
    expect(r.extras).toEqual([{ placedSec: 5.2, segment: 0 }]);
    expect(r.missing.map((c) => c.index)).not.toContain(1);
    expect(r.missing).toHaveLength(clicks.length - 2);
  });

  it('median, percentile and slope', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(percentile([0, 10], 95)).toBeCloseTo(9.5);
    expect(percentile([5], 95)).toBe(5);
    expect(slope([0, 1, 2], [1, 3, 5])).toBeCloseTo(2);
    expect(Number.isNaN(median([]))).toBe(true);
  });

  it('suggests latencyUsed + median fit residual (positive residual = placed too late)', () => {
    const session = (id: string, offset: number): ProbeSessionDump => ({
      sessionId: id,
      captureSampleRate: 48000,
      latencyUsedSec: 0.05,
      clicks,
      segments: [{ startSec: 0, endSec: 72, onsetsSec: clicks.filter((c) => c.kind === 'main').map((c) => c.timeSec + offset + (c.index % 3) * 0.001) }],
    });
    const dump: ProbeDump = { tool: 'vibe-guitar latency probe', version: 1, createdAt: 'x', sessions: [session('a', 0.03), session('b', 0.031), session('c', 0.029)] };
    const r = analyzeProbeDump(dump);
    expect(r.fit.n).toBe(30);
    expect(r.validation.n).toBe(30);
    expect(r.suggestedLatencySec).toBeCloseTo(0.081, 3);
    expect(Math.abs(r.validation.medianSec)).toBeLessThan(0.002);
    expect(r.pass).toEqual({ complete: true, median: true, p95: true, drift: true, rateNotStored: true });
    expect(formatProbeReport(r)).toContain('제안 CAPTURE_LATENCY_SEC = 0.050 + ');
  });

  it('flags stored non-1x audio and drift', () => {
    const drifting = clicks.map((c) => c.timeSec + 0.02 + c.timeSec * (0.03 / 60));
    const dump: ProbeDump = {
      tool: 'vibe-guitar latency probe',
      version: 1,
      createdAt: 'x',
      sessions: [{ sessionId: 'd', captureSampleRate: 48000, latencyUsedSec: 0.05, clicks, segments: [{ startSec: 0, endSec: 72, onsetsSec: drifting }] }],
    };
    const r = analyzeProbeDump(dump);
    expect(r.rateCheckPlaced).toBe(3);
    expect(r.pass.rateNotStored).toBe(false);
    expect(r.driftSecPerMin).toBeCloseTo(0.03, 3);
    expect(r.pass.drift).toBe(false);
  });

  it('pools drift across segments of different lengths without bias (seek back included)', () => {
    // Review s13-r1 counterexample: an 11 ms/min within-segment drift was reported as
    // 9.7 ms/min and passed the 10 ms/min target when only the residuals were centered.
    const ranges: [number, number][] = [[0, 14], [14, 40], [33.5, 59.5]];
    const segments = ranges.map(([startSec, endSec]) => ({
      startSec,
      endSec,
      onsetsSec: clicks
        .filter((c) => c.kind === 'main' && c.timeSec >= startSec && c.timeSec < endSec)
        .map((c) => c.timeSec + 0.03 + (c.timeSec - startSec) * (0.011 / 60)),
    }));
    const dump: ProbeDump = {
      tool: 'vibe-guitar latency probe',
      version: 1,
      createdAt: 'x',
      sessions: [{ sessionId: 'm', captureSampleRate: 48000, latencyUsedSec: 0.05, clicks, segments }],
    };
    const r = analyzeProbeDump(dump);
    expect(r.driftSecPerMin).toBeCloseTo(0.011, 4);
    expect(r.sessions[0].driftSecPerMin).toBeCloseTo(0.011, 4);
    expect(r.pass.drift).toBe(false);
  });

  it('rejects a run that stopped early instead of passing it (connector review on PR #24)', () => {
    // Capture ended after the first two clicks: only clicks 0 and 1, constant residual.
    const early: ProbeDump = {
      tool: 'vibe-guitar latency probe',
      version: 1,
      createdAt: 'x',
      sessions: [{ sessionId: 'e', captureSampleRate: 48000, latencyUsedSec: 0.05, clicks, segments: [{ startSec: 0, endSec: 5, onsetsSec: clicks.slice(0, 2).map((c) => c.timeSec + 0.03) }] }],
    };
    const r = analyzeProbeDump(early);
    expect(r.pass.complete).toBe(false);
    expect(r.pass.rateNotStored).toBe(false);
    expect(r.sessions[0].mainMissing).toHaveLength(18);
    expect(r.problems.some((p) => p.includes('끝까지 기록되지 않았습니다'))).toBe(true);
    expect(formatProbeReport(r)).toContain('아래 제안값을 쓰면 안 됩니다');

    // All main clicks but nothing stored after the 1.5x stretch: the rate check never ran.
    const noRate: ProbeDump = {
      ...early,
      sessions: [{ ...early.sessions[0], segments: [{ startSec: 0, endSec: 59.5, onsetsSec: clicks.filter((c) => c.kind === 'main').map((c) => c.timeSec + 0.03) }] }],
    };
    const r2 = analyzeProbeDump(noRate);
    expect(r2.sessions[0].mainMissing).toEqual([]);
    expect(r2.pass.complete).toBe(false);
    expect(r2.pass.rateNotStored).toBe(false);
  });
});

/**
 * The production placement path on a simulated tab: the media element runs the probe
 * session plan; the captured sample at AudioContext time t carries the media audio at
 * t - trueLatency. AudioPlacer places it with the 0.05 s constant; the probe must report
 * a residual of trueLatency - 0.05 (plus the resampler's sub-millisecond edge).
 */
interface SimOptions {
  /**
   * Startup model (VGT-22): for each start (0 = first play, 1 = resume after the pause, 2 = after
   * the seek) the element already reports "playing" (its play / seeked event and the 250 ms ticks)
   * while its clock and its audio stay at the start position for this long.
   */
  startupSec?: readonly number[];
  /**
   * Negative control: every report from this start on is off by this much (an offset per start
   * that all anchors of the segment share), with no startup delay.
   */
  reportOffsetSec?: readonly number[];
}

function simulateSession(trueLatency: number, latencyUsed: number, opts: SimOptions = {}): ProbeSessionDump {
  const sr = 48000;
  const s = plan.session;
  /** playing: clock and audio advance; reported: the element says it is not paused; event: a media event reports here. */
  type Piece = { ctx: number; media: number; rate: number; playing: boolean; reported: boolean; event: boolean; off: number };
  const pieces: Piece[] = [];
  let ctx = 0.5;
  let media = 0;
  let off = 0;
  pieces.push({ ctx: 0, media: 0, rate: 1, playing: false, reported: false, event: true, off });
  const playTo = (to: number, rate: number, start?: number) => {
    if (start !== undefined) off = opts.reportOffsetSec?.[start] ?? 0;
    const d = start !== undefined ? (opts.startupSec?.[start] ?? 0) : 0;
    if (d > 0) {
      pieces.push({ ctx, media, rate, playing: false, reported: true, event: true, off });
      ctx += d;
    }
    pieces.push({ ctx, media, rate, playing: true, reported: true, event: d === 0, off });
    ctx += (to - media) / rate;
    media = to;
  };
  playTo(s.pauseAtSec, 1, 0);
  pieces.push({ ctx, media, rate: 1, playing: false, reported: false, event: true, off });
  ctx += s.pauseForSec;
  playTo(s.seekFromSec, 1, 1);
  media = s.seekToSec;
  playTo(s.rateFromSec, 1, 2);
  playTo(s.rateToSec, s.rate);
  playTo(plan.durationSec, 1);
  pieces.push({ ctx, media, rate: 1, playing: false, reported: false, event: true, off });
  const endCtx = ctx + 1;
  const pieceAt = (t: number) => {
    let p = pieces[0];
    for (const q of pieces) if (q.ctx <= t) p = q;
    return p;
  };
  const posAt = (t: number) => {
    const p = pieceAt(t);
    return p.playing ? p.media + (t - p.ctx) * p.rate : p.media;
  };

  const placer = new AudioPlacer(latencyUsed);
  const key = 'probe:sim';
  const session = new ListeningSession(key, 0);
  const addAnchor = (t: number) => {
    const p = pieceAt(t);
    const a: PlayerAnchor = { ctxTime: t, key, position: posAt(t) + (p.reported ? p.off : 0), paused: !p.reported, rate: p.rate, isAd: false };
    placer.addAnchor(a);
  };
  for (let t = 0; t < endCtx; t += 0.25) addAnchor(t);
  for (const p of pieces) if (p.event) addAnchor(p.ctx);

  const BLOCK = 4096;
  const total = Math.floor(endCtx * sr);
  for (let f0 = 0; f0 + BLOCK <= total; f0 += BLOCK) {
    const block = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const tt = (f0 + i) / sr - trueLatency;
      const p = pieceAt(tt);
      if (!p.playing || tt < 0) continue;
      const idx = Math.round(posAt(tt) * sr);
      block[i] = idx >= 0 && idx < track.length ? track[idx] : 0;
    }
    placer.pushBlock(block, sr, f0 + BLOCK);
    placer.drain((f0 + BLOCK) / sr + 1, (k) => (k === key ? session : null));
  }
  const segments = session.segments.filter((g) => g.durationSec > 0).map((g) => placedSegmentOf(g, MODEL_SAMPLE_RATE));
  return { sessionId: `sim-${trueLatency}`, captureSampleRate: sr, latencyUsedSec: latencyUsed, segments, clicks: plan.clicks };
}

describe('end to end through AudioPlacer (simulated capture)', () => {
  it('recovers a known capture latency across pause, seek and a 1.5x stretch', () => {
    const sessions = [0.08, 0.08, 0.08].map((l) => simulateSession(l, 0.05));
    const r = analyzeProbeDump({ tool: 'vibe-guitar latency probe', version: 1, createdAt: 'x', sessions });
    for (const s of r.sessions) {
      // pause/resume and the backward seek give three stored stretches (the 1.5x part is dropped)
      expect(s.segments.length).toBeGreaterThanOrEqual(3);
      expect(s.mainMissing).toEqual([]);
      expect(s.replays).toBe(2); // the two clicks between 33.5 s and 40 s play twice
      expect(s.extras).toBe(0);
      expect(s.rateCheckPlaced).toBe(0);
    }
    expect(r.suggestedLatencySec).toBeGreaterThan(0.079);
    expect(r.suggestedLatencySec).toBeLessThan(0.0815);
    expect(r.pass).toEqual({ complete: true, median: true, p95: true, drift: true, rateNotStored: true });
    // Playback from 0 s (VGT-22 criterion 3): the first segment's start is no longer clamped to
    // 0 s, so it lands like the rest (+37.5 ms with the clamp); everything is within 2 ms.
    expect(r.sessions[0].segments[0].startSec).toBeLessThan(0);
    expect(Math.abs(r.startClampSec)).toBeLessThanOrEqual(0.002);
    expect(r.validation.p95AbsSec).toBeLessThan(0.002);
    expect(r.problems.join('\n')).not.toContain('곡 처음(0 s)부터');
    if (process.env.VG_PRINT_PROBE) console.log(formatProbeReport(r));
  });

  it('reports a negative residual when the constant is too large', () => {
    const r = analyzeProbeDump({ tool: 'vibe-guitar latency probe', version: 1, createdAt: 'x', sessions: [simulateSession(0.02, 0.05)] });
    expect(r.fit.medianResidualSec).toBeLessThan(-0.028);
    expect(r.fit.medianResidualSec).toBeGreaterThan(-0.0315);
  });
});

/** Startup delays per start (first play, resume, after seek) for the three simulated sessions. */
const STARTUPS: readonly (readonly number[])[] = [
  [0.015, 0.075, 0.08],
  [0.06, 0.02, 0.035],
  [0.04, 0.07, 0.015],
];

const dumpOf = (sessions: ProbeSessionDump[]): ProbeDump => ({ tool: 'vibe-guitar latency probe', version: 1, createdAt: 'x', sessions });

/**
 * The placement before VGT-22 on the same simulated capture: each segment placed by its first
 * player report alone (firstStartSec) and its start clamped to 0 s.
 */
function beforeFix(s: ProbeSessionDump): ProbeSessionDump {
  return {
    ...s,
    segments: s.segments.map((g) => {
      const start = Math.max(0, g.firstStartSec!);
      const d = start - g.startSec;
      return { startSec: start, endSec: g.endSec + d, onsetsSec: g.onsetsSec.map((t) => t + d) };
    }),
  };
}

describe('VGT-22: per-anchor offset (simulated startup)', () => {
  const startup = () => STARTUPS.map((d) => simulateSession(0.08, 0.05, { startupSec: d }));

  // Reproduction with the placement before the fix (the 2026-11-13 real-run pattern: segment
  // medians 17.0, 80.5 and 82.5 ms in one session, flat inside each segment, p95 53 ms).
  it('reproduces a per-segment offset of tens of ms, flat inside each segment, from a startup delay', () => {
    const r = analyzeProbeDump(dumpOf(startup().map(beforeFix)));
    for (const s of r.sessions) expect(s.segmentSpreadSec).toBeGreaterThan(0.04);
    expect(Math.abs(r.driftSecPerMin)).toBeLessThan(0.001);
    expect(r.validation.p95AbsSec).toBeGreaterThan(0.05);
    expect(r.firstAnchor).toBeNull(); // a dump from before VGT-22 has no firstStartSec
    expect(r.startClampSec).toBeGreaterThan(0.02);
    expect(r.problems.join('\n')).toContain('구간 시작을 0 s로 고정');
  });

  // Criterion 1: the same harness after the fix (median of the per-block start estimates).
  it('places every segment by the median of its per-block estimates: spread <= 5 ms, p95 <= 10 ms', () => {
    const r = analyzeProbeDump(dumpOf(startup()));
    for (const s of r.sessions) expect(s.segmentSpreadSec).toBeLessThanOrEqual(0.005);
    expect(r.validation.p95AbsSec).toBeLessThanOrEqual(0.01);
    expect(Math.abs(r.validation.medianSec)).toBeLessThanOrEqual(0.002);
    expect(Math.abs(r.driftSecPerMin)).toBeLessThan(0.001);
    expect(r.pass).toEqual({ complete: true, median: true, p95: true, drift: true, rateNotStored: true });
    // Criterion 3 with a startup delay at the first play too.
    expect(Math.abs(r.startClampSec)).toBeLessThanOrEqual(0.002);
    // Criterion 4: the dump carries the first report's start, and the report gives the old
    // placement's numbers from the same run (no clamp there: firstStartSec is not clamped).
    expect(r.firstAnchor).not.toBeNull();
    expect(Math.max(...r.firstAnchor!.segmentSpreadSec)).toBeGreaterThan(0.04);
    expect(r.firstAnchor!.validationP95AbsSec).toBeGreaterThan(0.03);
    // The first report runs ahead by up to the startup delay, so the stored start moves earlier.
    const shifts = r.sessions.flatMap((s) => s.segments.map((g) => g.firstAnchorShiftSec!));
    expect(Math.min(...shifts)).toBeLessThan(-0.05);
    for (const x of shifts) expect(x).toBeLessThanOrEqual(1e-4);
    // After the startup the reports agree: the estimates inside a segment are tight.
    for (const s of r.sessions) for (const g of s.segments) expect(g.startIqrSec!).toBeLessThan(0.001);
    const text = formatProbeReport(r);
    expect(text).toContain('첫 보고만으로 배치했다면');
    expect(text).toContain('구간 잔차 중앙값의 폭');
  });

  // The post-seek segment of the first session shows no startup bias even before the fix: the
  // block containing the seek is dropped, and a 250 ms report from after the startup arrives
  // just before the first stored block ends, so that block was placed with a correct report.
  it('explains the post-seek segment without bias: the first stored block already had a report from after the startup', () => {
    const r = analyzeProbeDump(dumpOf(startup().map(beforeFix)));
    const [first, resumed, seekSeg] = r.sessions[0].segments; // startups 15, 75 and 80 ms
    expect(seekSeg.startSec).toBeGreaterThan(33);
    // 80 ms true latency - 50 ms constant = 30 ms (+0.5 ms detector edge), no startup bias.
    expect(seekSeg.medianResidualSec).toBeCloseTo(0.0305, 3);
    expect(resumed.medianResidualSec - seekSeg.medianResidualSec).toBeCloseTo(0.075, 3);
    expect(first.medianResidualSec).toBeGreaterThan(seekSeg.medianResidualSec);
  });

  // Criterion 2, negative control: an offset that every report of a start shares is not an
  // anchor-pairing error, and the fix does not (and should not) remove it.
  it('negative control: a per-start offset shared by all reports keeps its spread', () => {
    const r = analyzeProbeDump(dumpOf(STARTUPS.map((d) => simulateSession(0.08, 0.05, { reportOffsetSec: d }))));
    for (const s of r.sessions) expect(s.segmentSpreadSec).toBeGreaterThan(0.035);
    // What tells the two causes apart in a real dump: the first report agrees with the rest.
    for (const s of r.sessions) for (const g of s.segments) expect(Math.abs(g.firstAnchorShiftSec!)).toBeLessThan(0.001);
    r.firstAnchor!.segmentSpreadSec.forEach((x, i) => expect(x).toBeCloseTo(r.sessions[i].segmentSpreadSec, 6));
  });
});


describe('probe build wiring', () => {
  it('the probe manifest only adds the 127.0.0.1 content script and a name suffix', () => {
    const base = {
      name: 'Vibe Guitar',
      permissions: ['tabCapture'],
      host_permissions: ['https://www.youtube.com/*'],
      content_scripts: [{ matches: ['https://www.youtube.com/*'], js: ['content-youtube.js'] }],
    };
    const m = latencyProbeManifest(base);
    expect(m.permissions).toBe(base.permissions);
    expect(m.host_permissions).toBe(base.host_permissions);
    expect(m.content_scripts).toEqual([...base.content_scripts, { matches: [PROBE_MATCH], js: ['probe-content.js'], run_at: 'document_idle' }]);
    expect(base.content_scripts).toHaveLength(1);
  });

  it('turns a probe report into a player-state for recording probe:<session>', () => {
    const msg = toPlayerState({ type: 'probe-player-state', sessionId: 's1', via: 'media-element', currentTime: 3.2, duration: 0, paused: false, playbackRate: 1, isAd: false, sampledAt: 123, url: 'http://127.0.0.1/' });
    expect(msg).toMatchObject({ type: 'player-state', currentTime: 3.2, paused: false, playbackRate: 1, sampledAt: 123, duration: 0, recording: { source: 'probe', id: 's1' } });
    expect(toPlayerState({ type: 'probe-player-state', sessionId: null, via: 'unreachable', currentTime: 0, duration: 0, paused: true, playbackRate: 1, isAd: false, sampledAt: 1, url: '' }).recording).toBeNull();
  });

  it('latency-report prints the suggested constant from a result file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vg-latency-'));
    const file = path.join(dir, 'r.json');
    writeFileSync(file, JSON.stringify({ tool: 'vibe-guitar latency probe', version: 1, createdAt: 'x', sessions: [simulateSession(0.07, 0.05)] }));
    const r = spawnSync(process.execPath, ['scripts/latency-report.mjs', file], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/제안 CAPTURE_LATENCY_SEC = 0\.050 \+ 0\.02\d+ = 0\.07\d s/);
    const bad = spawnSync(process.execPath, ['scripts/latency-report.mjs', path.join(dir, 'missing.json')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
  }, 30000);
});
