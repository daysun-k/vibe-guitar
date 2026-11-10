/** Time-synced lyrics in recording time (seconds). */

export interface LyricWord {
  text: string;
  startSec: number;
}

export interface LyricLine {
  startSec: number;
  endSec: number;
  text: string;
  words: LyricWord[];
  /** False when word times are interpolated from a line-level time. */
  wordTimed: boolean;
}

export interface Lyrics {
  /** 'words' = per-word times (LRCLIB lyricsfile); 'lines' = per-line times (LRC syncedLyrics). */
  kind: 'words' | 'lines';
  lines: LyricLine[];
}
