/** Messages exchanged between content scripts, service worker, offscreen document and side panel. */
import type { Recording, RecordingSource } from '../chart/types';

export type AdapterVia = 'video-element' | 'musickit' | 'media-element' | 'unreachable';

export interface PlayerStateMessage {
  type: 'player-state';
  adapter: RecordingSource;
  /** How the position was read (Apple Music adapter is experimental). */
  via: AdapterVia;
  recording: Recording | null;
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
  action: 'play' | 'pause' | 'seek';
  time?: number;
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
  | CommandMessage;

/** sendMessage that ignores "no receiver" errors (side panel closed). */
export function sendQuietly(msg: ExtensionMessage): void {
  try {
    chrome.runtime.sendMessage(msg).catch(() => undefined);
  } catch {
    // extension context invalidated (extension reloaded): caller should stop
    throw new Error('extension-context-invalidated');
  }
}
