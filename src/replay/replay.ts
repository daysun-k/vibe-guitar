/**
 * Offline replay of a captured listening session (docs/recognition-replay.md): feeds the stored
 * segments through the same ListeningSession → analyzeClosedSegments → Recognizer
 * .analyzeSessionSegment → buildAutoChart path as the offscreen listening controller
 * (src/extension/offscreen/listen.ts), so a replay with default options reproduces the live chart.
 * Runtime-neutral: the caller supplies ModelRunners (onnxruntime-node in src/replay/node.ts).
 */
import type { Chart } from '../chart/types';
import type { KeyEstimate } from '../music/key';
import { buildAutoChart } from '../recognize/autochart';
import { hasCandidateOptions, plainRecognizerOptions, type CandidateDecodeOptions, type CandidateRecognizerOptions } from '../recognize/candidate-decode';
import { CandidateRecognizer, type MajminModel } from '../recognize/candidate-recognizer';
import type { BtcModelMeta, Vocabulary } from '../recognize/chords';
import { Recognizer, type SegmentAnalysis } from '../recognize/recognizer';
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
  /** btc_majmin.onnx, loaded only when the config asks for it (C5) or for the baseline analysis. */
  majmin?: MajminModel;
}

/** --config file: { "recognizer": CandidateRecognizerOptions } (only the fields below are accepted). */
export interface ReplayConfig {
  /** Free-text name of the arm, copied into the run manifest. */
  label?: string;
  recognizer: CandidateRecognizerOptions;
}

const VOCABULARIES: Vocabulary[] = ['full', 'simple', 'majmin'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function onlyFields(o: Record<string, unknown>, where: string, allowed: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`config: unknown field ${where}.${k}`);
}

function num(v: unknown, where: string, check: (n: number) => boolean = () => true, what = 'a finite number'): number {
  if (!isNum(v) || !check(v)) throw new Error(`config: ${where} must be ${what}`);
  return v;
}

/**
 * Validates a replay config. Unknown fields are errors (a typo must not silently run the baseline).
 * A new candidate option is added to CandidateRecognizerOptions in src/recognize/candidate-decode.ts
 * and checked here.
 */
export function parseReplayConfig(v: unknown): ReplayConfig {
  if (v === undefined || v === null) return { recognizer: {} };
  if (!isObj(v)) throw new Error('config: expected an object { "label"?, "recognizer": { … } }');
  for (const k of Object.keys(v)) if (k !== 'label' && k !== 'recognizer' && !k.startsWith('$')) throw new Error(`config: unknown field ${k}`);
  if (v.label !== undefined && typeof v.label !== 'string') throw new Error('config: label must be a string');
  const r = v.recognizer ?? {};
  if (!isObj(r)) throw new Error('config: recognizer must be an object');
  const out: CandidateRecognizerOptions = {};
  for (const [k, x] of Object.entries(r)) {
    if (k === 'vocabulary') {
      if (!VOCABULARIES.includes(x as Vocabulary)) throw new Error(`config: recognizer.vocabulary must be one of ${VOCABULARIES.join(', ')}`);
      out.vocabulary = x as Vocabulary;
    } else if (k === 'decode') {
      if (!isObj(x)) throw new Error('config: recognizer.decode must be an object');
      onlyFields(x, 'recognizer.decode', ['changePenalty', 'familyFirst']);
      const d: CandidateDecodeOptions = {};
      if (x.changePenalty !== undefined) {
        const p = x.changePenalty;
        if (!Array.isArray(p) || p.length !== 3 || !p.every(isNum))
          throw new Error('config: recognizer.decode.changePenalty must be three finite numbers [bar start, half bar, other beats]');
        d.changePenalty = [p[0], p[1], p[2]];
      }
      if (x.familyFirst !== undefined) {
        const ff = x.familyFirst;
        if (!isObj(ff)) throw new Error('config: recognizer.decode.familyFirst must be an object { "penaltyScale": number }');
        onlyFields(ff, 'recognizer.decode.familyFirst', ['penaltyScale']);
        d.familyFirst = { penaltyScale: num(ff.penaltyScale, 'recognizer.decode.familyFirst.penaltyScale', (n) => n > 0, 'a number > 0') };
      }
      if (!Object.keys(d).length) throw new Error('config: recognizer.decode must set changePenalty or familyFirst');
      out.decode = d;
    } else if (k === 'units') {
      if (!isObj(x)) throw new Error('config: recognizer.units must be an object { "halfBeat": true, "offbeatExtraPenalty": number }');
      onlyFields(x, 'recognizer.units', ['halfBeat', 'offbeatExtraPenalty']);
      if (x.halfBeat !== true) throw new Error('config: recognizer.units.halfBeat must be true');
      out.units = { halfBeat: true, offbeatExtraPenalty: num(x.offbeatExtraPenalty, 'recognizer.units.offbeatExtraPenalty', (n) => n >= 0, 'a number >= 0') };
    } else if (k === 'emission') {
      if (x !== 'durationWeighted' && x !== 'meanLog') throw new Error('config: recognizer.emission must be durationWeighted or meanLog');
      out.emission = x;
    } else if (k === 'majmin') {
      if (x !== 'familyDecide' && x !== 'average') throw new Error('config: recognizer.majmin must be familyDecide or average');
      out.majmin = x;
    } else if (k === 'nLogPrior') {
      out.nLogPrior = num(x, 'recognizer.nLogPrior');
    } else if (k === 'pitchShift') {
      if (!Array.isArray(x) || !x.length || !x.every((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 6) || new Set(x).size !== x.length)
        throw new Error('config: recognizer.pitchShift must be distinct non-zero integer semitones within ±6');
      out.pitchShift = [...x];
    } else if (k === 'keyPrior') {
      if (!isObj(x)) throw new Error('config: recognizer.keyPrior must be an object { "bonus": number, "margin": number }');
      onlyFields(x, 'recognizer.keyPrior', ['bonus', 'margin']);
      out.keyPrior = { bonus: num(x.bonus, 'recognizer.keyPrior.bonus'), margin: num(x.margin, 'recognizer.keyPrior.margin', (n) => n >= 0 && n <= 1, 'a number in [0, 1]') };
    } else if (k === 'bassRoot') {
      if (!isObj(x)) throw new Error('config: recognizer.bassRoot must be an object { "margin": number }');
      onlyFields(x, 'recognizer.bassRoot', ['margin']);
      out.bassRoot = { margin: num(x.margin, 'recognizer.bassRoot.margin', (n) => n >= 0 && n <= 1, 'a number in [0, 1]') };
    } else if (k === 'repetition') {
      if (!isObj(x)) throw new Error('config: recognizer.repetition must be an object { "k": integer, "weight": number }');
      onlyFields(x, 'recognizer.repetition', ['k', 'weight']);
      out.repetition = {
        k: num(x.k, 'recognizer.repetition.k', (n) => Number.isInteger(n) && n >= 1 && n <= 16, 'an integer in [1, 16]'),
        weight: num(x.weight, 'recognizer.repetition.weight', (n) => n > 0 && n <= 1, 'a number in (0, 1]'),
      };
    } else throw new Error(`config: unknown field recognizer.${k}`);
  }
  return { ...(typeof v.label === 'string' ? { label: v.label } : {}), recognizer: out };
}

export interface ReplayResult {
  chart: Chart;
  /** Segments analysed (closed and at least 1 s, as live). */
  analysedSegments: number;
  ms: { feed: number; analyze: number };
  /** Global key the key prior used (C4 only; null when no key could be estimated). */
  key?: KeyEstimate | null;
  /** With `keep`: the final analyses and the recognizer that holds their decode inputs. */
  kept?: { analyses: SegmentAnalysis[]; recognizer: CandidateRecognizer };
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

/**
 * Replays one capture: the chart the extension would build from the same audio with `options`.
 * Without candidate options this is the live path (Recognizer); with them, CandidateRecognizer
 * (and, for the key prior, a second decode pass with the key of the pass-1 chart). `keep` forces
 * the candidate path (equal to the live one for default options) and returns the analyses.
 */
export async function replayCapture(
  meta: Pick<CaptureMeta, 'recordingKey' | 'recording' | 'durationSec'>,
  segments: CaptureSegment[],
  models: ReplayModels,
  options: CandidateRecognizerOptions,
  tool: string,
  keep = false,
): Promise<ReplayResult> {
  const session = new ListeningSession(meta.recordingKey, meta.durationSec);
  const t0 = now();
  await feedSession(session, segments, models.beat);
  const t1 = now();
  const build = (analyses: SegmentAnalysis[]) => buildAutoChart({ recording: { ...meta.recording }, segments: analyses, tool, durationSec: session.durationSec });
  const ms = () => ({ feed: Math.round(t1 - t0), analyze: Math.round(now() - t1) });
  if (!keep && !hasCandidateOptions(options)) {
    const recognizer = new Recognizer(models.beat, models.chords, models.chordMeta, plainRecognizerOptions(options));
    const analyses: SegmentAnalysis[] = await analyzeClosedSegments(session, new WeakMap<Segment, SegmentAnalysis>(), (seg) => recognizer.analyzeSessionSegment(seg));
    if (!analyses.length) throw new Error('replay: no segment of at least 1 s');
    return { chart: build(analyses), analysedSegments: analyses.length, ms: ms() };
  }
  const recognizer = new CandidateRecognizer(models.beat, models.chords, models.chordMeta, options, models.majmin);
  const pass1: SegmentAnalysis[] = await analyzeClosedSegments(session, new WeakMap<Segment, SegmentAnalysis>(), (seg) => recognizer.analyzeSessionSegment(seg));
  if (!pass1.length) throw new Error('replay: no segment of at least 1 s');
  let chart = build(pass1);
  let analyses = pass1;
  let key: KeyEstimate | null | undefined;
  if (options.keyPrior) {
    ({ analyses, key } = recognizer.applyKeyPrior(pass1, chart));
    chart = build(analyses);
  }
  return { chart, analysedSegments: analyses.length, ms: ms(), ...(options.keyPrior ? { key } : {}), ...(keep ? { kept: { analyses, recognizer } } : {}) };
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
