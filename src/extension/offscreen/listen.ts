/**
 * Listening mode in the offscreen document: stores the captured tab audio on the
 * playback timeline (only while the song plays at 1x and no ad shows), extracts
 * features incrementally, shows the current chord ("인식 중"), and builds an auto
 * chart after a full listen (or on request). Models run locally via onnxruntime-web;
 * audio never leaves this document.
 */
import * as ort from 'onnxruntime-web';
import { CQT_FRAME_SEC, MODEL_SAMPLE_RATE } from '../../audio/features';
import { StreamingResampler } from '../../audio/resample';
import type { Recording } from '../../chart/types';
import { buildAutoChart } from '../../recognize/autochart';
import type { BtcMeta } from '../../recognize/chords';
import { Recognizer, type SegmentAnalysis } from '../../recognize/recognizer';
import { MODEL_FILES, ortRunner, type ModelRunner } from '../../recognize/runner';
import { ListeningSession, type Segment } from '../../recognize/session';
import type { ListenStateMessage, ModelState, PlayerStateMessage } from '../messages';

/** Rough delay from the media element's currentTime to the captured sample (uncalibrated). */
export const CAPTURE_LATENCY_SEC = 0.05;
/** Auto chart after this fraction of the song was heard and playback reached the end. */
export const AUTO_CHART_FRACTION = 0.9;
const TICK_MS = 250;
const LIVE_EVERY_MS = 500;
/** Off by default: the 24-clip browser bench gave lower beat/downbeat F on WebGPU than WASM (docs/phase0-benchmark.md). */
const USE_WEBGPU = false;
const TOOL = 'vibe-guitar listening mode: Beat This! small0 + BTC large-voca (onnxruntime-web)';

export function recordingKeyOf(r: Recording | null | undefined): string | null {
  return r ? `${r.source}:${r.id}` : null;
}

function positionNow(p: PlayerStateMessage, nowMs: number): number {
  return p.paused ? p.currentTime : p.currentTime + ((nowMs - p.sampledAt) / 1000) * p.playbackRate;
}

/** Why audio should not be stored right now (null = store it). */
export function idleReasonFor(p: PlayerStateMessage | null, nowMs: number): string | null {
  if (!p) return '플레이어 정보를 기다리는 중';
  if (!p.recording) return '곡 ID를 찾지 못함';
  if (nowMs - p.sampledAt > 3000) return '플레이어 정보가 끊김';
  if (p.isAd) return '광고 중';
  if (p.paused) return '일시정지';
  if (p.playbackRate !== 1) return `재생 속도 ${p.playbackRate}x (1x에서만 기록)`;
  return null;
}

interface Models {
  recognizer: Recognizer;
  beat: ModelRunner;
  backend: string;
}

async function createModels(): Promise<Models> {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const url = (f: string) => chrome.runtime.getURL(`models/${f}`);
  const meta = (await (await fetch(url(MODEL_FILES.btcMeta))).json()) as BtcMeta;
  const wasm = (f: string) => ort.InferenceSession.create(url(f), { executionProviders: ['wasm'] });
  const beatWasm = ortRunner(await wasm(MODEL_FILES.beat), ort.Tensor);
  const chords = ortRunner(await wasm(MODEL_FILES.chords), ort.Tensor);
  let beat = beatWasm;
  let backend = 'wasm';
  // WebGPU for the beat model when available, after a numeric check against WASM.
  if (USE_WEBGPU && 'gpu' in navigator) {
    try {
      const gpu = ortRunner(await ort.InferenceSession.create(url(MODEL_FILES.beat), { executionProviders: ['webgpu'] }), ort.Tensor);
      const probe = new Float32Array(300 * 128).map((_, i) => 2 + Math.sin(i * 0.37));
      const [a, b] = await Promise.all([gpu.run('spect', probe, [1, 300, 128]), beatWasm.run('spect', probe, [1, 300, 128])]);
      let maxDiff = 0;
      for (let i = 0; i < a.beat.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.beat[i] - b.beat[i]));
      if (maxDiff < 1e-2) {
        beat = gpu;
        backend = 'beat: webgpu, chords: wasm';
      } else backend = `wasm (webgpu mismatch ${maxDiff.toExponential(1)})`;
    } catch (e) {
      backend = `wasm (webgpu unavailable: ${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return { recognizer: new Recognizer(beat, chords, meta.models.large), beat, backend };
}

export class ListeningController {
  private tabId = -1;
  private player: PlayerStateMessage | null = null;
  private session: ListeningSession | null = null;
  private recording: Recording | null = null;
  private resampler: StreamingResampler | null = null;
  private models: Models | null = null;
  private modelState: ModelState = 'idle';
  private modelError: string | undefined;
  private backend = '';
  private live: ListenStateMessage['live'] = null;
  private liveFrames = 0;
  private lastLiveAt = 0;
  private idleReason: string | null = null;
  private analyzing = false;
  private lastAnalysis: ListenStateMessage['lastAnalysis'];
  private readonly autoDone = new Set<string>();
  private readonly analysisCache = new WeakMap<Segment, SegmentAnalysis>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(private readonly send: (msg: unknown) => void) {}

  start(tabId: number): void {
    this.tabId = tabId;
    if (!this.timer) this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (this.modelState === 'idle' || this.modelState === 'error') void this.loadModels();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tabId = -1;
    this.session = null;
    this.resampler = null;
    this.live = null;
  }

  private async loadModels(): Promise<void> {
    this.modelState = 'loading';
    this.modelError = undefined;
    try {
      this.models = await createModels();
      this.backend = this.models.backend;
      this.modelState = 'ready';
    } catch (e) {
      this.modelState = 'error';
      this.modelError = e instanceof Error ? e.message : String(e);
    }
  }

  onPlayerState(msg: PlayerStateMessage, senderTabId: number | undefined): void {
    if (senderTabId !== this.tabId) return;
    this.player = msg;
    const key = recordingKeyOf(msg.recording);
    if (!key || msg.isAd) return;
    if (this.session && this.session.key !== key) {
      const old = this.session;
      const oldRec = this.recording;
      if (!this.autoDone.has(old.key) && old.coveredFraction() >= AUTO_CHART_FRACTION && oldRec) void this.analyze(old, oldRec, true);
      this.session = null;
    }
    if (!this.session) {
      this.session = new ListeningSession(key, msg.duration);
      this.resampler = null;
      this.live = null;
      this.liveFrames = 0;
    }
    if (msg.duration > 0) this.session.durationSec = msg.duration;
    this.recording = msg.recording;
  }

  onAudio(samples: Float32Array, rate: number): void {
    const s = this.session;
    const p = this.player;
    const now = Date.now();
    this.idleReason = idleReasonFor(p, now);
    if (!s || !p || this.idleReason || recordingKeyOf(p.recording) !== s.key) {
      s?.breakSegment();
      this.resampler = null;
      return;
    }
    if (!this.resampler || this.resampler.fromRate !== rate) {
      s.breakSegment();
      this.resampler = new StreamingResampler(rate, MODEL_SAMPLE_RATE);
    }
    const out = this.resampler.push(samples);
    s.append(out, positionNow(p, now) - CAPTURE_LATENCY_SEC);
    if (s.full) this.idleReason = '저장 한도(20분)에 도달';
  }

  /** Builds the auto chart from what was heard (manual request). */
  requestAnalysis(): void {
    if (this.session && this.recording) void this.analyze(this.session, this.recording, false);
  }

  private async analyze(session: ListeningSession, recording: Recording, auto: boolean): Promise<void> {
    if (this.analyzing) return;
    const models = this.models;
    if (!models) {
      this.lastAnalysis = { at: new Date().toISOString(), events: 0, ms: 0, recordingKey: session.key, error: '모델이 아직 준비되지 않았습니다' };
      return;
    }
    this.analyzing = true;
    this.pushState();
    const t0 = performance.now();
    try {
      // Close the open segment so its last frames can be padded; new audio opens a new one.
      session.breakSegment();
      this.resampler = null;
      session.extractReady(Number.MAX_SAFE_INTEGER, true);
      const analyses: SegmentAnalysis[] = [];
      for (const seg of session.segments) {
        if (seg.durationSec < 1) continue;
        let a = this.analysisCache.get(seg);
        if (!a) {
          a = await models.recognizer.analyzeSessionSegment(seg);
          this.analysisCache.set(seg, a);
        }
        analyses.push(a);
      }
      if (!analyses.length) throw new Error('들은 구간이 없습니다');
      const chart = buildAutoChart({ recording: { ...recording }, segments: analyses, tool: TOOL, durationSec: session.durationSec });
      this.send({ type: 'auto-chart', chart });
      if (auto) this.autoDone.add(session.key);
      this.lastAnalysis = { at: new Date().toISOString(), events: chart.events.length, ms: Math.round(performance.now() - t0), recordingKey: session.key };
    } catch (e) {
      this.lastAnalysis = { at: new Date().toISOString(), events: 0, ms: Math.round(performance.now() - t0), recordingKey: session.key, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.analyzing = false;
      this.pushState();
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = this.session;
      if (s) {
        s.extractReady(48);
        const models = this.models;
        const seg = s.currentSegment;
        if (models && seg && !this.analyzing) {
          const now = performance.now();
          if (now - this.lastLiveAt >= LIVE_EVERY_MS && seg.cqtFrames >= 4 && seg.cqtFrames !== this.liveFrames) {
            this.lastLiveAt = now;
            this.liveFrames = seg.cqtFrames;
            const r = await models.recognizer.live(seg.cqt.view(), seg.cqtFrames);
            this.live = r ? { chord: r.symbol, confidence: r.confidence, atSec: seg.startSec + (seg.cqtFrames - 2) * CQT_FRAME_SEC } : null;
          } else {
            await s.precomputeBeatChunks(models.beat, 1);
          }
        }
        if (!seg && this.live && this.idleReason) this.live = null;
        const p = this.player;
        if (p && models && !this.analyzing && !this.autoDone.has(s.key) && s.durationSec > 0 && s.coveredFraction() >= AUTO_CHART_FRACTION && this.recording) {
          const pos = positionNow(p, Date.now());
          if (pos >= s.durationSec - 3) void this.analyze(s, this.recording, true);
        }
      }
      this.pushState();
    } catch (e) {
      this.modelError = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = false;
    }
  }

  private pushState(): void {
    if (this.tabId < 0) return;
    const s = this.session;
    const msg: ListenStateMessage = {
      type: 'listen-state',
      tabId: this.tabId,
      recordingKey: s?.key ?? null,
      modelState: this.modelState,
      backend: this.backend,
      modelError: this.modelError,
      recordingAudio: !!s?.currentSegment && !this.idleReason,
      idleReason: this.idleReason ?? undefined,
      live: this.live,
      coverage: s?.coverage() ?? [],
      durationSec: s?.durationSec ?? 0,
      coveredFraction: s?.coveredFraction() ?? 0,
      analyzing: this.analyzing,
      lastAnalysis: this.lastAnalysis,
    };
    this.send(msg);
  }
}
