/** Messages exchanged between content scripts, service worker, offscreen document and side panel. */
import type { Chart, CoverageRange, Recording, RecordingSource, UncertainSpan } from '../chart/types';
import type { RecordingIdSource } from './content/recording-id';
import type { EventRef } from '../editor/correct';

export type AdapterVia = 'video-element' | 'musickit' | 'media-element' | 'unreachable';

export interface PlayerStateMessage {
  type: 'player-state';
  adapter: RecordingSource;
  /** How the position was read (Apple Music adapter is experimental). */
  via: AdapterVia;
  recording: Recording | null;
  /**
   * YouTube adapters: where recording.id came from. 'player' = what the page's player is
   * playing; 'url' / 'player-bar' = fallback (could differ from the audio on YouTube Music).
   */
  idSource?: RecordingIdSource;
  /** URL `v=` when it names a different recording than the one playing. */
  urlIdMismatch?: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  isAd: boolean;
  /** Date.now() when currentTime was read. */
  sampledAt: number;
  url: string;
  note?: string;
}

export interface PlayerControlMessage {
  type: 'player-control';
  /** 'rate': set the playback speed to `rate` (one of PRACTICE_RATES). */
  action: 'play' | 'pause' | 'seek' | 'rate';
  time?: number;
  rate?: number;
}

/** Reply of a content script to a PlayerControlMessage. */
export interface PlayerControlResult {
  ok: boolean;
  /** Present when ok is false, e.g. "unsupported on this player". */
  reason?: string;
}

export interface CaptureStartMessage {
  type: 'capture-start';
  target: 'offscreen';
  streamId: string;
  tabId: number;
  url?: string;
}

export interface CaptureStopMessage {
  type: 'capture-stop';
  target: 'offscreen';
}

export type CaptureState = 'starting' | 'running' | 'stopped' | 'error';

export interface CaptureStatusMessage {
  type: 'capture-status';
  state: CaptureState;
  tabId?: number;
  url?: string;
  error?: string;
}

export interface CaptureStatsMessage {
  type: 'capture-stats';
  tabId: number;
  url?: string;
  /** Some non-silent audio arrived in the last 2 s. */
  audioReceived: boolean;
  everReceived: boolean;
  rms: number;
  sampleRate: number;
  chroma: number[];
  trackState: string;
  trackMuted: boolean;
  elapsedSec: number;
}

export type ModelState = 'idle' | 'loading' | 'ready' | 'error';

/** Offscreen → panel: listening-mode status for the captured tab (about 2 Hz). */
export interface ListenStateMessage {
  type: 'listen-state';
  tabId: number;
  /** "source:id" of the recording being listened to, or null. */
  recordingKey: string | null;
  modelState: ModelState;
  /** e.g. "wasm" or "webgpu". */
  backend: string;
  modelError?: string;
  /** Audio is being stored for the auto chart right now. */
  recordingAudio: boolean;
  /** Why audio is not being stored (paused, ad, playback rate, …). */
  idleReason?: string;
  /** Current chord while listening ("인식 중"); not for play-along. */
  live: { chord: string; confidence: number; atSec: number } | null;
  coverage: CoverageRange[];
  durationSec: number;
  coveredFraction: number;
  analyzing: boolean;
  lastAnalysis?: { at: string; events: number; ms: number; recordingKey: string; error?: string };
}

/** Panel → offscreen: build the auto chart from what was heard so far. */
export interface ListenAnalyzeMessage {
  type: 'listen-analyze';
  target: 'offscreen';
}

/** Offscreen → service worker: a finished auto chart to store. */
export interface AutoChartMessage {
  type: 'auto-chart';
  chart: Chart;
}

/** Service worker → panel: where the auto chart was stored. */
export interface AutoChartSavedMessage {
  type: 'auto-chart-saved';
  recordingKey: string;
  /** 'main': in use by the play view. 'pending': a manual chart exists; waiting for the user's confirm. */
  savedAs: 'main' | 'pending';
  error?: string;
}

/**
 * Side panel → service worker: a chart write. All chart writes run in the service worker
 * one at a time (ChartStore), so they cannot interleave with auto chart saves.
 */
export type ChartWriteMessage =
  | { type: 'chart-write'; op: 'save'; chart: Chart }
  | { type: 'chart-write'; op: 'adopt-auto'; source: RecordingSource; id: string }
  /** Play view: fix one event's chord (identified by its start and current chord). */
  | { type: 'chart-write'; op: 'correct-event'; source: RecordingSource; id: string; event: EventRef; chord: string; at: string }
  /** Play view (VGT-19): play an uncertain stretch of an auto event as its second choice. */
  | { type: 'chart-write'; op: 'accept-alt'; source: RecordingSource; id: string; event: EventRef; span: UncertainSpan; at: string }
  /** Play view: a manual event plays its first recognized chord again (처음 코드로 되돌리기). */
  | { type: 'chart-write'; op: 'restore-auto'; source: RecordingSource; id: string; event: EventRef; at: string }
  | { type: 'chart-write'; op: 'undo-correct'; source: RecordingSource; id: string; before: Chart; after: Chart };

/** Service worker → side panel: reply to a ChartWriteMessage (`before`: the chart a correction replaced). */
export type ChartWriteResult = { ok: true; chart?: Chart | null; before?: Chart } | { ok: false; error: string };

/**
 * Side panel → service worker: lyrics for a recording (cache first; LRCLIB only when
 * allowFetch is true). Reply: LyricsReply from lyrics-service.ts.
 */
export interface LyricsGetMessage {
  type: 'lyrics-get';
  recording: Recording;
  durationSec: number;
  allowFetch: boolean;
}

export interface CommandMessage {
  type: 'command';
  command: 'stamp-chord' | 'tap-tempo';
}

export type ExtensionMessage =
  | PlayerStateMessage
  | PlayerControlMessage
  | CaptureStartMessage
  | CaptureStopMessage
  | CaptureStatusMessage
  | CaptureStatsMessage
  | CommandMessage
  | ListenStateMessage
  | ListenAnalyzeMessage
  | AutoChartMessage
  | AutoChartSavedMessage
  | ChartWriteMessage
  | LyricsGetMessage;

/** sendMessage that ignores "no receiver" errors (side panel closed). */
export function sendQuietly(msg: ExtensionMessage): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // extension context invalidated (extension reloaded): caller should stop
    throw new Error('extension-context-invalidated');
  }
}
