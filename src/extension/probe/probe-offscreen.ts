/**
 * Latency-probe build only: hooks the offscreen document's listening controller.
 * - Feeds the probe page's player reports to the production placement path
 *   (ListeningController.onPlayerState -> anchor -> AudioPlacer), as recording "probe:<session>".
 * - Answers 'status' and 'dump': dump finds the clicks in the audio that AudioPlacer
 *   stored for that session (22 050 Hz, after resampling) and returns their placed times.
 * Nothing here runs in the production build (offscreen.ts installs it behind
 * __LATENCY_PROBE__, which scripts/build.mjs sets only with --latency-probe).
 */
import { MODEL_SAMPLE_RATE } from '../../audio/features';
import type { Recording, RecordingSource } from '../../chart/types';
import { detectClicks } from '../../probe/latency';
import type { PlayerStateMessage } from '../messages';
import { CAPTURE_LATENCY_SEC, type ListeningController } from '../offscreen/listen';
import type { ProbeDumpReply, ProbePlayerStateMessage, ProbeReply, ProbeRequestMessage, ProbeStatus } from './messages';

/** Recording source of the probe; never stored (the adapter reports duration 0). */
const PROBE_SOURCE = 'probe' as RecordingSource;

export function probeRecording(sessionId: string | null): Recording | null {
  return sessionId ? { source: PROBE_SOURCE, id: sessionId, title: 'latency probe', artist: '' } : null;
}

/** The probe report as the PlayerStateMessage the production path consumes. */
export function toPlayerState(m: ProbePlayerStateMessage): PlayerStateMessage {
  const { type: _type, sessionId, ...rest } = m;
  return { ...rest, type: 'player-state', adapter: PROBE_SOURCE, recording: probeRecording(sessionId) };
}

export function installLatencyProbe(listener: ListeningController, capture: () => { ctx: AudioContext | null; tabId: number }): void {
  const status = (): ProbeStatus => {
    const { ctx, tabId } = capture();
    return {
      capturing: !!ctx,
      captureTabId: tabId,
      captureSampleRate: ctx?.sampleRate ?? null,
      sessionKey: listener.currentSession?.key ?? null,
      idleReason: listener.currentIdleReason,
    };
  };

  chrome.runtime.onMessage.addListener((msg: ProbePlayerStateMessage | ProbeRequestMessage, sender, sendResponse) => {
    if (msg?.type === 'probe-player-state') {
      listener.onPlayerState(toPlayerState(msg), sender.tab?.id);
      return;
    }
    if (msg?.type !== 'probe-request' || msg.target !== 'offscreen') return;
    if (msg.op === 'status') {
      sendResponse({ ok: true, data: status() } satisfies ProbeReply<ProbeStatus>);
      return;
    }
    if (msg.op === 'dump') {
      const session = listener.currentSession;
      const want = msg.sessionId ? `probe:${msg.sessionId}` : null;
      if (!want || !session || session.key !== want) {
        sendResponse({ ok: false, error: `no stored audio for ${want ?? '(no session id)'} (current: ${session?.key ?? 'none'})` } satisfies ProbeReply);
        return;
      }
      const segments = session.segments
        .filter((s) => s.durationSec > 0)
        .map((s) => ({
          startSec: s.startSec,
          endSec: s.endSec,
          onsetsSec: detectClicks(s.audio.view(), MODEL_SAMPLE_RATE).map((t) => s.startSec + t),
        }));
      const data: ProbeDumpReply = { ...status(), sessionId: msg.sessionId!, latencyUsedSec: CAPTURE_LATENCY_SEC, segments };
      sendResponse({ ok: true, data } satisfies ProbeReply<ProbeDumpReply>);
    }
  });
}
