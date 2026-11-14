/**
 * Listening mode in the offscreen document: stores the captured tab audio on the
 * playback timeline (only while the song plays at 1x and no ad shows), extracts
 * features incrementally, shows the current chord ("인식 중"), and builds an auto
 * chart after a full listen (or on request). Models run locally via onnxruntime-web in a
 * dedicated worker (model-worker.ts), so inference never blocks the side panel; audio never
 * leaves the browser.
 */
import { CQT_FRAME_SEC } from '../../audio/features';
import type { Recording } from '../../chart/types';
import { buildAutoChart } from '../../recognize/autochart';
import type { BtcMeta } from '../../recognize/chords';
import { EXTENSION_RECOGNIZER_OPTIONS } from '../../recognize/extension-options';
import { Recognizer, type SegmentAnalysis } from '../../recognize/recognizer';
import { ModelWorkerClient } from '../../recognize/model-worker-client';
import { MODEL_FILES, type ModelRunner } from '../../recognize/runner';
import { anchorFromPlayerState, AudioPlacer } from '../../recognize/placement';
import { analyzeClosedSegments, ListeningSession, type Segment } from '../../recognize/session';
import type { ListenStateMessage, ModelState, PlayerStateMessage } from '../messages';

/**
 * Delay from the media element's currentTime to the captured sample. Measured 2026-11-13 in Aside
 * with the latency probe (3 sessions, 66 clicks): 0.050 + median fit residual 0.0778 = 0.128 s;
 * see docs/latency-probe.md "Measurements". Placement only: speaker and Bluetooth delay are not in it.
 */
export const CAPTURE_LATENCY_SEC = 0.128;
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

/** AudioContext time and wall clock read together (null = no capture running). */
export type AudioClock = () => { ctxTime: number; epochMs: number } | null;


export interface ListenModels {
  recognizer: Recognizer;
  beat: ModelRunner;
  backend: string;
  /** Called once if the model worker dies; the models are unusable afterwards. */
  onFailure(listener: (e: Error) => void): void;
  dispose(): void;
}

async function createModels(): Promise<ListenModels> {
  const client = new ModelWorkerClient(new Worker(chrome.runtime.getURL('model-worker.js')));
  try {
    const opts = { wasmPaths: chrome.runtime.getURL('ort/'), numThreads: self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1 };
    const url = (f: string) => chrome.runtime.getURL(`models/${f}`);
    const meta = (await (await fetch(url(MODEL_FILES.btcMeta))).json()) as BtcMeta;
    await client.load('beat', url(MODEL_FILES.beat), 'wasm', opts);
    await client.load('chords', url(MODEL_FILES.chords), 'wasm', opts);
    const beatWasm = client.runner('beat');
    const chords = client.runner('chords');
    let beat: ModelRunner = beatWasm;
    let backend = 'wasm (worker)';
    // WebGPU for the beat model when available, after a numeric check against WASM.
    if (USE_WEBGPU && 'gpu' in navigator) {
      try {
        await client.load('beat-gpu', url(MODEL_FILES.beat), 'webgpu', opts);
        const gpu = client.runner('beat-gpu');
        const probe = new Float32Array(300 * 128).map((_, i) => 2 + Math.sin(i * 0.37));
        const [a, b] = await Promise.all([gpu.run('spect', probe, [1, 300, 128]), beatWasm.run('spect', probe, [1, 300, 128])]);
        let maxDiff = 0;
        for (let i = 0; i < a.beat.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.beat[i] - b.beat[i]));
        if (maxDiff < 1e-2) {
          beat = gpu;
          backend = 'beat: webgpu, chords: wasm (worker)';
        } else backend = `wasm (worker; webgpu mismatch ${maxDiff.toExponential(1)})`;
      } catch (e) {
        backend = `wasm (worker; webgpu unavailable: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
    return {
      recognizer: new Recognizer(beat, chords, meta.models.large, EXTENSION_RECOGNIZER_OPTIONS),
      beat,
      backend,
      onFailure: (l) => client.onFailure(l),
      dispose: () => client.terminate(),
    };
  } catch (e) {
    client.terminate();
    throw e;
  }
}

export class ListeningController {
  private tabId = -1;
  private player: PlayerStateMessage | null = null;
  private session: ListeningSession | null = null;
  private recording: Recording | null = null;
  private readonly placer = new AudioPlacer(CAPTURE_LATENCY_SEC);
  private models: ListenModels | null = null;
  private modelState: ModelState = 'idle';
  private modelError: string | undefined;
  private backend = '';
  private live: ListenStateMessage['live'] = null;
  private liveFrames = 0;
  private lastLiveAt = 0;
  private analyzing = false;
  private lastAnalysis: ListenStateMessage['lastAnalysis'];
  private readonly autoDone = new Set<string>();
  private readonly analysisCache = new WeakMap<Segment, SegmentAnalysis>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly send: (msg: unknown) => void,
    private readonly clock: AudioClock,
    private readonly makeModels: () => Promise<ListenModels> = createModels,
  ) {}

  private get idleReason(): string | null {
    return this.placer.idleReason;
  }

  /** Read-only views for the dev latency probe (src/extension/probe/probe-offscreen.ts). */
  get currentSession(): ListeningSession | null {
    return this.session;
  }

  get currentIdleReason(): string | null {
    return this.idleReason;
  }

  private readonly sessionFor = (key: string): ListeningSession | null => (this.session?.key === key ? this.session : null);

  private drain(): void {
    const c = this.clock();
    if (c) this.placer.drain(c.ctxTime, this.sessionFor);
  }

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
    this.placer.reset();
    this.live = null;
  }

  private async loadModels(): Promise<void> {
    this.modelState = 'loading';
    this.modelError = undefined;
    try {
      const models = await this.makeModels();
      this.models = models;
      this.backend = models.backend;
      this.modelState = 'ready';
      // Subscribe last: a worker that already died reports at once and must win over 'ready'.
      // A crashed worker answers nothing more: drop it so the next start() loads a new one.
      models.onFailure((e) => {
        if (this.models !== models) return;
        this.models = null;
        this.modelState = 'error';
        this.modelError = e.message;
        models.dispose();
        this.pushState();
      });
    } catch (e) {
      this.modelState = 'error';
      this.modelError = e instanceof Error ? e.message : String(e);
    }
  }

  onPlayerState(msg: PlayerStateMessage, senderTabId: number | undefined): void {
    if (senderTabId !== this.tabId) return;
    this.player = msg;
    const c = this.clock();
    if (c) {
      this.placer.addAnchor(anchorFromPlayerState(msg, recordingKeyOf(msg.recording), c));
      // Audio captured before this report goes to the session it belongs to, before any switch.
      this.placer.drain(c.ctxTime, this.sessionFor);
    }
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
      this.live = null;
      this.liveFrames = 0;
    }
    if (msg.duration > 0) this.session.durationSec = msg.duration;
    this.recording = msg.recording;
  }

  /**
   * A captured block; `endFrame` is the AudioContext frame just after its last sample.
   * Placement uses that sample time, not the arrival time of this message.
   */
  onAudio(samples: Float32Array, rate: number, endFrame: number): void {
    this.placer.pushBlock(samples, rate, endFrame);
    this.drain();
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
      // Closes the open segment (new audio opens a new one) and analyses only the
      // segments closed at this point; audio arriving during the awaits is left for later.
      const analyses = await analyzeClosedSegments(session, this.analysisCache, (seg) => models.recognizer.analyzeSessionSegment(seg));
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
      this.drain();
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
