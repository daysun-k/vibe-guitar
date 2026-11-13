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

/**
 * topic-only-v1: the rule frozen in PR #31 (a ' - Topic' channel only). amended-v1: the PR #31
 * amendment recorded before any capture: a ' - Topic' channel, or a verified official artist
 * channel whose upload is an auto-generated 'Provided to YouTube by' track.
 */
export type UploadRule = 'topic-only-v1' | 'amended-v1';
export const UPLOAD_RULES: UploadRule[] = ['topic-only-v1', 'amended-v1'];
export const PROVIDED_PREFIX = 'Provided to YouTube by';
export const VERIFIED_ARTIST_BADGE = 'BADGE_STYLE_TYPE_VERIFIED_ARTIST';

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
  /** Recorded for the record (channel id, owner badge styles, first description snippet); read only by amended-v1. */
  extra?: { channelId?: string | null; ownerBadges?: string[]; snippet?: string };
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

export type ChannelBranch = 'topic' | 'official-artist';

export interface ResultCheck {
  qualifies: boolean;
  /** Failed conditions, in the order of the protocol. */
  failed: string[];
  topic: boolean;
  /** Which branch met the channel condition (null when none did). */
  branch: ChannelBranch | null;
  lengthSec: number | null;
  diffSec: number | null;
}

const namesMatch = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));

export function checkResult(r: SearchResult, song: SongForSearch, rule: UploadRule = 'topic-only-v1'): ResultCheck {
  const failed: string[] = [];
  const topic = r.channel.endsWith(TOPIC_SUFFIX);
  let branch: ChannelBranch | null = null;
  if (rule === 'topic-only-v1') {
    if (!topic) failed.push('channel is not a Topic channel');
    else {
      const a = normalize(r.channel.slice(0, -TOPIC_SUFFIX.length));
      const b = normalize(song.artist);
      if (!a || !(a.includes(b) || b.includes(a))) failed.push('Topic artist does not match');
      else branch = 'topic';
    }
  } else if (topic) {
    // A ' - Topic' channel is judged by branch 1 only, never by branch 2.
    if (!namesMatch(normalize(r.channel.slice(0, -TOPIC_SUFFIX.length)), normalize(song.artist))) failed.push('Topic artist does not match');
    else branch = 'topic';
  } else {
    const snippet = r.extra?.snippet;
    const badges = r.extra?.ownerBadges;
    if (typeof snippet !== 'string' || !snippet.startsWith(PROVIDED_PREFIX)) failed.push('not a Topic channel and the upload is not a Provided to YouTube track');
    else if (!Array.isArray(badges) || !badges.includes(VERIFIED_ARTIST_BADGE)) failed.push('not a Topic channel and the channel is not a verified artist channel');
    else if (!namesMatch(normalize(r.channel), normalize(song.artist))) failed.push('artist channel does not match');
    else branch = 'official-artist';
  }
  if (normalize(cleanUploadTitle(r.title)) !== normalize(song.title)) failed.push('title does not match');
  const word = excludedWord(r.title);
  if (word) failed.push(`title has the word "${word}"`);
  const lengthSec = parseLength(r.lengthText);
  const diffSec = lengthSec === null ? null : Math.abs(lengthSec - song.annotationDurationSec);
  if (diffSec === null) failed.push('no length');
  else if (!(diffSec <= MAX_LENGTH_DIFF_SEC)) failed.push(`length differs by ${diffSec.toFixed(2)} s`);
  return { qualifies: failed.length === 0, failed, topic, branch, lengthSec, diffSec };
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
  /** amended-v1 only: the branch that met the channel condition. */
  branch?: ChannelBranch;
}

export interface UploadDecision {
  status: 'chosen' | 'skipped';
  chosen: Candidate | null;
  qualifying: number;
  /** Skipped songs: why. */
  reason: string | null;
  /** Up to three ' - Topic'-channel results nearest to the annotation length (any artist or title), under every rule. */
  nearestTopic: Candidate[];
}

const QUERY_ORDER: Record<QueryLabel, number> = { Q1: 0, Q2: 1 };

/**
 * Choice among qualifying results of both queries (first RESULTS_PER_QUERY each): smallest length
 * difference, then Q1 before Q2, then result rank.
 */
export function chooseUpload(song: SongForSearch, results: Record<QueryLabel, SearchResult[]>, rule: UploadRule = 'topic-only-v1'): UploadDecision {
  const qualifying: Candidate[] = [];
  const topics: Candidate[] = [];
  for (const query of ['Q1', 'Q2'] as QueryLabel[]) {
    for (const r of results[query].filter((x) => x.rank >= 1 && x.rank <= RESULTS_PER_QUERY)) {
      const c = checkResult(r, song, rule);
      const cand: Candidate = { query, rank: r.rank, videoId: r.videoId, title: r.title, channel: r.channel, lengthText: r.lengthText, lengthSec: c.lengthSec, diffSec: c.diffSec };
      if (c.qualifies) qualifying.push(rule === 'amended-v1' && c.branch ? { ...cand, branch: c.branch } : cand);
      // The nearest-Topic diagnostic is rule-independent: ' - Topic' channels only, any artist or title.
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
