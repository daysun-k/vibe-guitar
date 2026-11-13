/**
 * Offline replay of a captured listening session (docs/recognition-replay.md): feeds the stored
 * segments through the same ListeningSession → analyzeClosedSegments → Recognizer
 * .analyzeSessionSegment → buildAutoChart path as the offscreen listening controller
 * (src/extension/offscreen/listen.ts), so a replay with default options reproduces the live chart.
 * Runtime-neutral: the caller supplies ModelRunners (onnxruntime-node in src/replay/node.ts).
 */
import type { Chart } from '../chart/types';
import { buildAutoChart } from '../recognize/autochart';
import type { BtcModelMeta, DecodeOptions, Vocabulary } from '../recognize/chords';
import { Recognizer, type RecognizerOptions, type SegmentAnalysis } from '../recognize/recognizer';
import type { ModelRunner } from '../recognize/runner';
import { analyzeClosedSegments, ListeningSession, type Segment } from '../recognize/session';
import { CAPTURE_SAMPLE_RATE, type CaptureMeta, type CaptureSegment } from './capture';

/** One 4096-frame capture-worklet block at 48 kHz after resampling to 22.05 kHz (capture-worklet.ts). */
export const REPLAY_BLOCK_SAMPLES = Math.round((4096 * CAPTURE_SAMPLE_RATE) / 48000);
/** The live tick runs every 250 ms (listen.ts TICK_MS): about this many blocks arrive per tick. */
export const REPLAY_BLOCKS_PER_TICK = 3;
/** listen.ts tick: extractReady(48) per tick. */
const TICK_CQT_FRAMES = 48;

export interface ReplayModels {
  beat: ModelRunner;
  chords: ModelRunner;
  chordMeta: BtcModelMeta;
}

/** --config file: { "recognizer": RecognizerOptions } (only the fields below are accepted). */
export interface ReplayConfig {
  /** Free-text name of the arm, copied into the run manifest. */
  label?: string;
  recognizer: RecognizerOptions;
}

const VOCABULARIES: Vocabulary[] = ['full', 'simple', 'majmin'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a replay config. Unknown fields are errors (a typo must not silently run the baseline).
 * A new candidate option is added to RecognizerOptions in src/recognize and checked here.
 */
export function parseReplayConfig(v: unknown): ReplayConfig {
  if (v === undefined || v === null) return { recognizer: {} };
  if (!isObj(v)) throw new Error('config: expected an object { "label"?, "recognizer": { … } }');
  for (const k of Object.keys(v)) if (k !== 'label' && k !== 'recognizer' && !k.startsWith('$')) throw new Error(`config: unknown field ${k}`);
  if (v.label !== undefined && typeof v.label !== 'string') throw new Error('config: label must be a string');
  const r = v.recognizer ?? {};
  if (!isObj(r)) throw new Error('config: recognizer must be an object');
  const out: RecognizerOptions = {};
  for (const [k, x] of Object.entries(r)) {
    if (k === 'vocabulary') {
      if (!VOCABULARIES.includes(x as Vocabulary)) throw new Error(`config: recognizer.vocabulary must be one of ${VOCABULARIES.join(', ')}`);
      out.vocabulary = x as Vocabulary;
    } else if (k === 'decode') {
      if (!isObj(x)) throw new Error('config: recognizer.decode must be an object');
      for (const dk of Object.keys(x)) if (dk !== 'changePenalty') throw new Error(`config: unknown field recognizer.decode.${dk}`);
      const p = x.changePenalty;
      if (!Array.isArray(p) || p.length !== 3 || !p.every((n) => typeof n === 'number' && Number.isFinite(n)))
        throw new Error('config: recognizer.decode.changePenalty must be three finite numbers [bar start, half bar, other beats]');
      out.decode = { changePenalty: [p[0], p[1], p[2]] } satisfies DecodeOptions;
    } else throw new Error(`config: unknown field recognizer.${k}`);
  }
  return { ...(typeof v.label === 'string' ? { label: v.label } : {}), recognizer: out };
}

export interface ReplayResult {
  chart: Chart;
  /** Segments analysed (closed and at least 1 s, as live). */
  analysedSegments: number;
  ms: { feed: number; analyze: number };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Refills a ListeningSession the way the placer does live: per segment, 4096-frame-sized blocks
 * whose end positions continue the segment, extractReady(48) and one precomputeBeatChunks per
 * 250 ms tick, breakSegment between segments. (The live tick runs the live chord readout instead
 * of precomputeBeatChunks every other tick; neither changes the analysis: features are
 * deterministic per frame and cached beat chunks equal recomputed ones, see segmentBeatLogits.)
 */
export async function feedSession(session: ListeningSession, segments: CaptureSegment[], beat: ModelRunner | null): Promise<Segment[]> {
  const fed: Segment[] = [];
  for (const { startSec, samples } of segments) {
    session.breakSegment();
    let pushed = 0;
    let blocks = 0;
    while (pushed < samples.length) {
      const block = samples.subarray(pushed, Math.min(samples.length, pushed + REPLAY_BLOCK_SAMPLES));
      pushed += block.length;
      session.append(block, startSec + pushed / CAPTURE_SAMPLE_RATE);
      if (pushed === block.length) {
        const seg = session.currentSegment!;
        // max(0, end − duration) can differ from the stored start in the last bit; the live
        // segment started exactly at startSec, so the replayed one does too.
        (seg as { startSec: number }).startSec = startSec;
        fed.push(seg);
      }
      if (++blocks % REPLAY_BLOCKS_PER_TICK === 0) {
        session.extractReady(TICK_CQT_FRAMES);
        if (beat) await session.precomputeBeatChunks(beat, 1);
      }
    }
    if (session.currentSegment !== fed[fed.length - 1]) throw new Error(`replay: segment at ${startSec} s split while feeding (continuity)`);
  }
  return fed;
}

/** Replays one capture: the chart the extension would build from the same audio with `options`. */
export async function replayCapture(meta: Pick<CaptureMeta, 'recordingKey' | 'recording' | 'durationSec'>, segments: CaptureSegment[], models: ReplayModels, options: RecognizerOptions, tool: string): Promise<ReplayResult> {
  const recognizer = new Recognizer(models.beat, models.chords, models.chordMeta, options);
  const session = new ListeningSession(meta.recordingKey, meta.durationSec);
  const t0 = now();
  await feedSession(session, segments, models.beat);
  const t1 = now();
  const analyses: SegmentAnalysis[] = await analyzeClosedSegments(session, new WeakMap<Segment, SegmentAnalysis>(), (seg) => recognizer.analyzeSessionSegment(seg));
  if (!analyses.length) throw new Error('replay: no segment of at least 1 s');
  const chart = buildAutoChart({ recording: { ...meta.recording }, segments: analyses, tool, durationSec: session.durationSec });
  return { chart, analysedSegments: analyses.length, ms: { feed: Math.round(t1 - t0), analyze: Math.round(now() - t1) } };
}

export interface ModelHashMismatch {
  file: string;
  /** Hash the capture recorded (null: the capture names no hash for this file). */
  recorded: string | null;
  loaded: string;
}

/**
 * Model files replay loaded whose bytes differ from what the capture's build packaged (or that the
 * capture does not name). Empty means the replay runs the same model files as the live analysis.
 */
export function modelHashMismatches(recorded: Record<string, string>, loaded: Record<string, string>): ModelHashMismatch[] {
  return Object.entries(loaded)
    .filter(([file, hash]) => recorded[file] !== hash)
    .map(([file, hash]) => ({ file, recorded: recorded[file] ?? null, loaded: hash }));
}
