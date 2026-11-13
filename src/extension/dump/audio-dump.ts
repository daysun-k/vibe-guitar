/**
 * Dev-only audio dump (docs/recognition-replay.md). Compiled only into the --audio-dump build:
 * scripts/build-config.mjs redirects listen.ts's imports of recognize/session and
 * recognize/autochart to session-hook.ts and autochart-hook.ts, which wrap the two functions
 * below. The default build bundles neither this file nor the hooks, so dist/ is unchanged.
 *
 * analyzeClosedSegments is called with a cache that records every segment the function looks
 * up. It looks up each segment of its closed-segment snapshot exactly once, in order, so the
 * recorded list is exactly the analysed snapshot, without repeating the snapshot rule here.
 * buildAutoChart then posts that audio with the chart it returned (the chart listen.ts sends in
 * the `auto-chart` message), after the current task, fire-and-forget: a failed POST is logged
 * and never touches the chart path.
 */
import type { AutoChartInput } from '../../recognize/autochart';
import type { ListeningSession, Segment } from '../../recognize/session';
import type { Chart, CoverageRange } from '../../chart/types';
import { AUDIO_DUMP_PORT, CAPTURE_SAMPLE_RATE, CAPTURE_SCHEMA, encodeCaptureBody, type CaptureMeta, type CaptureSegment } from '../../replay/capture';

export interface DumpBuildInfo {
  commit: string;
  dirty: boolean;
  models: Record<string, string>;
}

/** Looks up a real cache and records each looked-up segment in call order. */
export class RecordingCache<T> extends WeakMap<Segment, T> {
  readonly seen: Segment[] = [];
  constructor(private readonly inner: WeakMap<Segment, T>) {
    super();
  }
  override get(seg: Segment): T | undefined {
    this.seen.push(seg);
    return this.inner.get(seg);
  }
  override set(seg: Segment, v: T): this {
    this.inner.set(seg, v);
    return this;
  }
  override has(seg: Segment): boolean {
    return this.inner.has(seg);
  }
  override delete(seg: Segment): boolean {
    return this.inner.delete(seg);
  }
}

interface PendingDump {
  session: ListeningSession;
  sessionCoverage: CoverageRange[];
  /** The array analyzeClosedSegments returned (identity-checked against buildAutoChart's input). */
  analyses: unknown[];
  segments: CaptureSegment[];
}

export type AnalyzeClosedSegments = <T>(session: ListeningSession, cache: WeakMap<Segment, T>, analyze: (seg: Segment) => Promise<T>, minSec?: number) => Promise<T[]>;
export type BuildAutoChart = (input: AutoChartInput) => Chart;
export type PostDump = (meta: CaptureMeta, segments: CaptureSegment[]) => Promise<void>;

/** The pair of wrappers with shared state (one per offscreen document). */
export function createAudioDumpHooks(original: { analyzeClosedSegments: AnalyzeClosedSegments; buildAutoChart: BuildAutoChart }, info: DumpBuildInfo, post: PostDump, defer: (f: () => void) => void = (f) => setTimeout(f, 0)) {
  let pending: PendingDump | null = null;

  const analyzeClosedSegments: AnalyzeClosedSegments = async (session, cache, analyze, minSec) => {
    const rec = new RecordingCache(cache);
    pending = null;
    const sessionCoverage = session.coverage();
    const analyses = await original.analyzeClosedSegments(session, rec, analyze, minSec);
    if (rec.seen.length === analyses.length) {
      // Closed segments never grow, so these views stay valid; the POST copies them into a Blob.
      pending = { session, sessionCoverage, analyses, segments: rec.seen.map((seg) => ({ startSec: seg.startSec, samples: seg.audio.view() })) };
    } else console.warn(`audio dump: ${rec.seen.length} segments looked up for ${analyses.length} analyses; not dumped`);
    return analyses;
  };

  const buildAutoChart: BuildAutoChart = (input) => {
    const chart = original.buildAutoChart(input);
    const p = pending;
    pending = null;
    if (p && p.analyses === (input.segments as unknown[])) {
      const meta: CaptureMeta = {
        schema: CAPTURE_SCHEMA,
        recordingKey: p.session.key,
        recording: { ...input.recording },
        durationSec: input.durationSec ?? p.session.durationSec,
        sessionCoverage: p.sessionCoverage,
        chart,
        build: { commit: info.commit, dirty: info.dirty },
        models: info.models,
        capturedAt: '',
        sampleRate: CAPTURE_SAMPLE_RATE,
      };
      defer(() => {
        try {
          meta.capturedAt = new Date().toISOString();
          post(meta, p.segments).catch((e: unknown) => console.warn('audio dump: POST failed', e));
        } catch (e) {
          console.warn('audio dump: POST failed', e);
        }
      });
    }
    return chart;
  };

  return { analyzeClosedSegments, buildAutoChart };
}

/** POSTs one capture to the local receiver (scripts/audio-dump-receiver.mjs). */
export async function postToReceiver(meta: CaptureMeta, segments: CaptureSegment[], port = AUDIO_DUMP_PORT): Promise<void> {
  const body = new Blob(encodeCaptureBody(meta, segments) as BlobPart[], { type: 'application/octet-stream' });
  const res = await fetch(`http://127.0.0.1:${port}/capture`, { method: 'POST', body });
  if (!res.ok) throw new Error(`receiver answered ${res.status}: ${await res.text()}`);
  console.info(`audio dump: ${meta.recordingKey} sent (${segments.length} segments): ${await res.text()}`);
}
