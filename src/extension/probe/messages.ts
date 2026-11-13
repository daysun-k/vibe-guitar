/**
 * Messages of the latency-probe build only (dev, VGT-7). Kept apart from ExtensionMessage
 * so the production side panel and service worker never see them as a known type.
 */
import type { PlayerStateMessage } from '../messages';
import type { PlacedSegment } from '../../probe/latency';

/**
 * Probe page adapter -> offscreen: the probe <audio> element's state, read and sent the
 * same way the YouTube adapter reports its <video> (currentTime, paused, playbackRate and
 * the Date.now() of the read). A separate type so the side panel ignores the probe tab.
 */
export interface ProbePlayerStateMessage extends Omit<PlayerStateMessage, 'type' | 'adapter' | 'recording'> {
  type: 'probe-player-state';
  /** Probe session id from the page (the recording id), or null before a session. */
  sessionId: string | null;
}

export type ProbeOp = 'status' | 'dump' | 'recapture';

export interface ProbeRequestMessage {
  type: 'probe-request';
  target: 'offscreen' | 'background';
  op: ProbeOp;
  sessionId?: string;
}

export interface ProbeStatus {
  capturing: boolean;
  captureTabId: number;
  captureSampleRate: number | null;
  /** Recording key of the listening session being stored, e.g. "probe:s1-…". */
  sessionKey: string | null;
  /** Why audio is not being stored right now (null = it is). */
  idleReason: string | null;
}

export interface ProbeDumpReply extends ProbeStatus {
  sessionId: string;
  latencyUsedSec: number;
  segments: PlacedSegment[];
}

export type ProbeReply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

/** window.postMessage envelope between the probe page and the probe content script. */
export const PAGE_CHANNEL = '__vgLatencyProbe';
export interface PageRequest {
  [PAGE_CHANNEL]: 'request';
  id: number;
  op: ProbeOp;
  sessionId?: string;
}
export interface PageResponse {
  [PAGE_CHANNEL]: 'response';
  id: number;
  reply: ProbeReply;
}
