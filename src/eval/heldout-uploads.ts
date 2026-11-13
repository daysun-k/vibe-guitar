/**
 * The frozen upload search of the VGT-7 held-out list (PR #31): the two queries, which search
 * result qualifies and which qualifying result is chosen. Pure; the search itself is done in the
 * Aside test browser and recorded as a log.
 */
import { normalize } from './heldout-draw';

/** Only the first video results of each query are read. */
export const RESULTS_PER_QUERY = 15;
export const MAX_LENGTH_DIFF_SEC = 2;
export const TOPIC_SUFFIX = ' - Topic';
export const EXCLUDED_WORDS = ['live', 'remix', 're-recorded', 'rerecorded', 'karaoke', 'instrumental', 'cover', 'acoustic', 'demo', 'mono', 'edit'];

export type QueryLabel = 'Q1' | 'Q2';

export function searchQueries(artist: string, title: string): Record<QueryLabel, string> {
  return { Q1: `${artist} ${title} "Provided to YouTube"`, Q2: `${artist} - Topic ${title}` };
}

export interface SearchResult {
  /** 1-based position among the video results of the query. */
  rank: number;
  videoId: string;
  title: string;
  channel: string;
  lengthText: string;
}

/** "m:ss" or "h:mm:ss" to seconds; null for anything else (live streams, missing lengths). */
export function parseLength(text: string): number | null {
  const t = text.trim();
  let m = /^(\d+):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+):([0-5]\d):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return null;
}

/** Upload title without parenthesized parts and without the part after its last " - ". */
export function cleanUploadTitle(title: string): string {
  const noParens = title.replace(/\([^)]*\)/g, '');
  const i = noParens.lastIndexOf(' - ');
  return i >= 0 ? noParens.slice(0, i) : noParens;
}

/** The first excluded word that appears as a whole word (letters and digits as word characters). */
export function excludedWord(title: string): string | null {
  const t = title.toLowerCase();
  for (const w of EXCLUDED_WORDS) {
    const re = new RegExp(`(^|[^a-z0-9])${w.replace(/-/g, '\\-')}($|[^a-z0-9])`);
    if (re.test(t)) return w;
  }
  return null;
}

export interface SongForSearch {
  artist: string;
  title: string;
  annotationDurationSec: number;
}

export interface ResultCheck {
  qualifies: boolean;
  /** Failed conditions, in the order of the protocol. */
  failed: string[];
  topic: boolean;
  lengthSec: number | null;
  diffSec: number | null;
}

export function checkResult(r: SearchResult, song: SongForSearch): ResultCheck {
  const failed: string[] = [];
  const topic = r.channel.endsWith(TOPIC_SUFFIX);
  if (!topic) failed.push('channel is not a Topic channel');
  else {
    const a = normalize(r.channel.slice(0, -TOPIC_SUFFIX.length));
    const b = normalize(song.artist);
    if (!a || !(a.includes(b) || b.includes(a))) failed.push('Topic artist does not match');
  }
  if (normalize(cleanUploadTitle(r.title)) !== normalize(song.title)) failed.push('title does not match');
  const word = excludedWord(r.title);
  if (word) failed.push(`title has the word "${word}"`);
  const lengthSec = parseLength(r.lengthText);
  const diffSec = lengthSec === null ? null : Math.abs(lengthSec - song.annotationDurationSec);
  if (diffSec === null) failed.push('no length');
  else if (!(diffSec <= MAX_LENGTH_DIFF_SEC)) failed.push(`length differs by ${diffSec.toFixed(2)} s`);
  return { qualifies: failed.length === 0, failed, topic, lengthSec, diffSec };
}

export interface Candidate {
  query: QueryLabel;
  rank: number;
  videoId: string;
  title: string;
  channel: string;
  lengthText: string;
  lengthSec: number | null;
  diffSec: number | null;
}

export interface UploadDecision {
  status: 'chosen' | 'skipped';
  chosen: Candidate | null;
  qualifying: number;
  /** Skipped songs: why. */
  reason: string | null;
  /** Up to three Topic-channel results nearest to the annotation length (any artist or title). */
  nearestTopic: Candidate[];
}

const QUERY_ORDER: Record<QueryLabel, number> = { Q1: 0, Q2: 1 };

/**
 * Choice among qualifying results of both queries (first RESULTS_PER_QUERY each): smallest length
 * difference, then Q1 before Q2, then result rank.
 */
export function chooseUpload(song: SongForSearch, results: Record<QueryLabel, SearchResult[]>): UploadDecision {
  const qualifying: Candidate[] = [];
  const topics: Candidate[] = [];
  for (const query of ['Q1', 'Q2'] as QueryLabel[]) {
    for (const r of results[query].filter((x) => x.rank >= 1 && x.rank <= RESULTS_PER_QUERY)) {
      const c = checkResult(r, song);
      const cand: Candidate = { query, rank: r.rank, videoId: r.videoId, title: r.title, channel: r.channel, lengthText: r.lengthText, lengthSec: c.lengthSec, diffSec: c.diffSec };
      if (c.qualifies) qualifying.push(cand);
      if (c.topic && c.diffSec !== null) topics.push(cand);
    }
  }
  const byChoice = (a: Candidate, b: Candidate) => a.diffSec! - b.diffSec! || QUERY_ORDER[a.query] - QUERY_ORDER[b.query] || a.rank - b.rank;
  qualifying.sort(byChoice);
  const seen = new Set<string>();
  const nearestTopic = topics.sort(byChoice).filter((c) => (seen.has(c.videoId) ? false : (seen.add(c.videoId), true))).slice(0, 3);
  if (qualifying.length) return { status: 'chosen', chosen: qualifying[0], qualifying: qualifying.length, reason: null, nearestTopic };
  return { status: 'skipped', chosen: null, qualifying: 0, reason: 'no qualifying upload in the first 15 results of Q1 and Q2', nearestTopic };
}
