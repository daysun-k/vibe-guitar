/**
 * Chord chart format v1: the shared interface between hand-made charts,
 * a future recognizer and user edits (proposal section 4.5).
 */

export type RecordingSource = 'youtube' | 'ytmusic' | 'applemusic';

export interface Recording {
  source: RecordingSource;
  /** Exact recording id: YouTube videoId, Apple Music catalog id, … */
  id: string;
  title: string;
  artist: string;
}

export interface Timing {
  /** Beats per minute, counted in `beatUnit` notes (6/8 counts eighths). */
  bpm: number;
  beatsPerBar: number;
  /** Note value of one beat: 4 for x/4 meters, 8 for x/8 meters. Default 4. */
  beatUnit?: 4 | 8;
  /** Playback time (seconds) of the downbeat of bar 1. */
  firstDownbeatSec: number;
  /** Optional explicit beat times (seconds, ascending); overrides bpm grid inside its range. */
  beatTimes?: number[];
  /** Rhythmic feel, used for strumming suggestions. Default straight. */
  feel?: 'straight' | 'shuffle';
}

export type EventSource = 'manual' | 'auto';

export interface ChordEvent {
  startSec: number;
  /** Chord symbol such as "Am7", "C/B", or "N" for no chord. */
  chord: string;
  /** 0..1. Manual events are usually 1. */
  confidence: number;
  source: EventSource;
}

export interface CoverageRange {
  fromSec: number;
  toSec: number;
}

export interface Provenance {
  createdBy: 'manual' | 'recognizer' | 'edited';
  /** ISO 8601 timestamp. */
  createdAt: string;
  updatedAt?: string;
  tool?: string;
  note?: string;
  /** True for bundled examples whose timings are fake. */
  example?: boolean;
}

/**
 * A stretch of an auto event where the recognizer was unsure, with its second choice (VGT-19,
 * docs/uncertainty-protocol.md). Chords are stored at sounding pitch like events. A span applies
 * only while the event under it is still an auto event showing `chord`.
 */
export interface UncertainSpan {
  fromSec: number;
  toSec: number;
  /** The event's chord when the span was computed. */
  chord: string;
  /** The recognizer's second choice there, from another chord family than `chord`. */
  alt: string;
}

export interface Chart {
  schemaVersion: 1;
  recording: Recording;
  timing: Timing;
  events: ChordEvent[];
  coverage: CoverageRange[];
  provenance: Provenance;
  /** Uncertain stretches of auto events (absent on charts made before VGT-19 and on hand-made charts). */
  uncertain?: UncertainSpan[];
}

export const NO_CHORD = 'N';

export function chartStorageKey(source: RecordingSource, id: string): string {
  return `chart:${source}:${id}`;
}
