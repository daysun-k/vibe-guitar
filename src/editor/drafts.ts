/**
 * Editor drafts bound to a recording. A draft made while song A played must never be
 * saved under song B's id; switching songs stores the old draft and restores (or
 * creates) the draft of the new song. Saving under another id requires an explicit
 * reattach by the user.
 */
import type { Recording, Timing } from '../chart/types';

export interface EditorDraft {
  /** "<source>:<id>" of the recording this draft belongs to; '' when none. */
  recordingKey: string;
  recording: Recording | null;
  seqText: string;
  chords: string[];
  stamps: number[];
  timing: Timing;
}

export const DEFAULT_EDITOR_TIMING: Timing = { bpm: 100, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 };

export function recordingKeyOf(r: Recording | null): string {
  return r ? `${r.source}:${r.id}` : '';
}

export function emptyDraft(recording: Recording | null): EditorDraft {
  return {
    recordingKey: recordingKeyOf(recording),
    recording: recording ? { ...recording } : null,
    seqText: '',
    chords: [],
    stamps: [],
    timing: { ...DEFAULT_EDITOR_TIMING },
  };
}

export function isDraftEmpty(d: EditorDraft): boolean {
  return d.chords.length === 0 && d.stamps.length === 0 && d.seqText.trim() === '';
}

export class DraftBook {
  private readonly drafts = new Map<string, EditorDraft>();

  /** Keep `current` under its own recording and return the draft for `next`. */
  switchTo(current: EditorDraft, next: Recording | null): EditorDraft {
    if (current.recordingKey && !isDraftEmpty(current)) this.drafts.set(current.recordingKey, current);
    const key = recordingKeyOf(next);
    if (key === current.recordingKey) return current;
    const stored = key ? this.drafts.get(key) : undefined;
    return stored ?? emptyDraft(next);
  }

  delete(key: string): void {
    this.drafts.delete(key);
  }

  get(key: string): EditorDraft | undefined {
    return this.drafts.get(key);
  }
}

export type SaveCheck =
  | { ok: true; recording: Recording }
  | { ok: false; reason: 'no-recording' | 'recording-mismatch' };

/** A draft may only be saved under the recording it was made for. */
export function checkSaveTarget(draft: EditorDraft, playing: Recording | null): SaveCheck {
  if (!draft.recording || !draft.recordingKey) return { ok: false, reason: 'no-recording' };
  if (!playing || recordingKeyOf(playing) !== draft.recordingKey) return { ok: false, reason: 'recording-mismatch' };
  return { ok: true, recording: draft.recording };
}

/** Explicit user action: move the draft (chords, stamps, timing) to another recording. */
export function reattachDraft(draft: EditorDraft, recording: Recording): EditorDraft {
  return { ...draft, recordingKey: recordingKeyOf(recording), recording: { ...recording } };
}
