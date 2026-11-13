/**
 * Builds the VGT-7 held-out song list (PR #31) from the committed ordered pool and the raw search
 * log: walks the order, skips songs without a qualifying upload and stops at exactly TARGET_SONGS.
 * Decisions are recomputed from the raw results with the chosen upload rule; a logged decision
 * that disagrees, a log out of order, a log that ends early or one that searched past the stop is
 * an error. The log keeps the topic-only-v1 decision as `decision` and the amended-v1 decision as
 * `decisionAmended` (songs past the amended stop: status 'not-needed').
 */
import { DRAW_SEED, id4, labPath, type RankedSong } from './heldout-draw';
import { chooseUpload, searchQueries, type QueryLabel, type SearchResult, type UploadDecision, type UploadRule } from './heldout-uploads';
import { SONG_LIST_SCHEMA, type DatasetInfo, type SongEntry, type SongList, type UploadEntry } from './annotations';

export const TARGET_SONGS = 25;
export const SEARCH_LOG_SCHEMA = 'vibe-guitar-annotation-heldout-search-log/1';
export const BILLBOARD_DATASET = 'billboard-2.0.1-lab';
export const NOT_NEEDED_REASON = 'not needed: beyond the amended stop';

export interface NotNeededDecision {
  status: 'not-needed';
  reason: string;
}

export interface SearchLogEntry {
  /** Pool rank and canonical id of the song searched. */
  rank: number;
  id: number;
  queries: { label: QueryLabel; query: string; results: SearchResult[] }[];
  /** topic-only-v1 decision (the original walk). */
  decision?: UploadDecision;
  /** amended-v1 decision. */
  decisionAmended?: UploadDecision | NotNeededDecision;
}

export interface SearchLog {
  schema: string;
  entries: SearchLogEntry[];
}

export interface HeldoutListResult {
  rule: UploadRule;
  /** Rank of the song that completed the list. */
  stopRank: number;
  list: SongList;
  uploads: Record<string, UploadEntry>;
  chosen: { rank: number; id: number; songId: string; decision: UploadDecision }[];
  skipped: { rank: number; id: number; artist: string; title: string; decision: UploadDecision }[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const heldoutSongId = (s: { id: number; artist: string; title: string }) => `billboard-${id4(s.id)}-${slug(s.artist)}-${slug(s.title)}`;

const mmss = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const CHANNEL_RULE: Record<UploadRule, string> = {
  'topic-only-v1': 'a matching "<artist> - Topic" channel',
  'amended-v1':
    'a matching "<artist> - Topic" channel, or (PR #31 amendment, decided before any capture from the same search log) a verified official artist channel (owner badge BADGE_STYLE_TYPE_VERIFIED_ARTIST) of a matching artist whose upload description starts with "Provided to YouTube by"',
};

export function heldoutPurpose(rule: UploadRule): string {
  return (
    'Predeclared before any result (VGT-7, PR #31): 25 held-out evaluation songs drawn by a fixed seed from McGill Billboard 2.0.1 songs with no known BTC training-song overlap, for scoring Vibe Guitar auto charts against public, time-aligned chord annotations. ' +
    `Pool: one song per normalized (artist, title), canonical entry = lowest id; excluded in order: a title in BTC's UsPop2002 annotation list, an Isophonics or Robbie Williams artist, a song already on docs/annotation-eval-songs.json, fewer than 12 chord changes. Order: sha256("${DRAW_SEED}:" + 4-digit id) ascending, ties by id; the ordered pool is docs/annotation-heldout-v1-pool.json. ` +
    `Upload search: two frozen YouTube queries per song read to 15 results; a result qualifies on ${CHANNEL_RULE[rule]}, a matching cleaned title, none of the excluded words and a length within 2 s of annotationDurationSec; smallest difference, then Q1, then rank; songs without one are skipped and the walk stops at 25 (docs/annotation-heldout-v1-search-log.json, upload rule ${rule}${rule === 'amended-v1' ? '; the topic-only selection is kept in docs/annotation-heldout-v1-selection-diff.json' : ''}). ` +
    'Complexity rule (from the annotation, N and X ignored): complex when >= 20 distinct labels or >= 40% of chord time is not a plain major/minor triad; simple when <= 10 labels and < 20%; otherwise moderate. ' +
    'Primary analysis: unweighted mean of per-song majmin WCSR with a percentile bootstrap 95% interval over songs. Results never change the list: no redraw, no replacement.'
  );
}

const BRANCH_TEXT = { topic: 'Topic channel', 'official-artist': 'official artist channel, Provided to YouTube' } as const;

/** One song-list entry for a chosen upload; `search` names the walk that chose it in the upload hint. */
export function songEntry(s: RankedSong, d: UploadDecision, rule: UploadRule, search = 'the PR #31 search'): SongEntry {
  const c = d.chosen!;
  const q = searchQueries(s.artist, s.title);
  const branch = c.branch ? `, ${BRANCH_TEXT[c.branch]}` : '';
  return {
    id: heldoutSongId(s),
    role: 'eval',
    artist: s.artist,
    title: s.title,
    release: `Billboard Hot 100 entry ${s.chartDate} (McGill Billboard id ${id4(s.id)}); the dataset does not record the CD used.`,
    dataset: BILLBOARD_DATASET,
    chords: labPath(s.id),
    beats: null,
    annotationDurationSec: s.annotationDurationSec,
    btcTraining: 'not-known',
    complexity: s.complexity!,
    search: [q.Q1, q.Q2],
    uploadHint: `Chosen by ${search}, rule ${rule} (${c.query}, result ${c.rank}${branch}): '${c.channel}' upload '${c.title}' (${c.videoId}), length ${c.lengthText}; annotation ${mmss(s.annotationDurationSec)}, difference ${c.diffSec!.toFixed(2)} s. Pool rank ${s.rank}.`,
  };
}

const logged = (entry: SearchLogEntry, rule: UploadRule) => (rule === 'topic-only-v1' ? entry.decision : entry.decisionAmended);

/** Recomputes a logged entry's decision under the rule and checks it against the logged one, when present. */
export function decideEntry(song: RankedSong, entry: SearchLogEntry, rule: UploadRule = 'topic-only-v1'): UploadDecision {
  const q = searchQueries(song.artist, song.title);
  const results = { Q1: [] as SearchResult[], Q2: [] as SearchResult[] };
  for (const label of ['Q1', 'Q2'] as QueryLabel[]) {
    const lq = entry.queries.filter((x) => x.label === label);
    if (lq.length !== 1) throw new Error(`search log: rank ${song.rank} needs exactly one ${label}`);
    if (lq[0].query !== q[label]) throw new Error(`search log: rank ${song.rank} ${label} was "${lq[0].query}", the frozen query is "${q[label]}"`);
    results[label] = lq[0].results;
  }
  const decision = chooseUpload(song, results, rule);
  const prior = logged(entry, rule);
  if (prior && JSON.stringify(prior) !== JSON.stringify(decision)) throw new Error(`search log: rank ${song.rank} logged ${rule} decision differs from the rules`);
  return decision;
}

export function buildHeldoutList(input: { order: RankedSong[]; log: SearchLog; dataset: DatasetInfo; declaredAt: string; target?: number; rule?: UploadRule }): HeldoutListResult {
  const target = input.target ?? TARGET_SONGS;
  const rule = input.rule ?? 'topic-only-v1';
  if (input.log.schema !== SEARCH_LOG_SCHEMA) throw new Error(`search log: expected schema ${SEARCH_LOG_SCHEMA}`);
  const chosen: HeldoutListResult['chosen'] = [];
  const skipped: HeldoutListResult['skipped'] = [];
  const songs: SongEntry[] = [];
  const uploads: Record<string, UploadEntry> = {};
  const entries = input.log.entries;
  let stopRank = 0;
  for (let i = 0; i < entries.length; i++) {
    const song = input.order[i];
    if (!song) throw new Error(`search log: entry ${i + 1} is past the end of the pool`);
    if (entries[i].rank !== song.rank || entries[i].id !== song.id) throw new Error(`search log: entry ${i + 1} is rank ${entries[i].rank} id ${entries[i].id}, the pool order has rank ${song.rank} id ${song.id}`);
    if (chosen.length >= target) {
      // Past the stop: the original walk never searched here; under the amendment the log marks these songs as not needed.
      const prior = logged(entries[i], rule);
      if (rule === 'amended-v1' && prior?.status === 'not-needed') continue;
      throw new Error(`search log: rank ${entries[i].rank} was searched after ${target} songs had an upload under ${rule}${rule === 'amended-v1' ? ' and is not marked not-needed' : ''}`);
    }
    const decision = decideEntry(song, entries[i], rule);
    if (decision.status === 'chosen') {
      const e = songEntry(song, decision, rule);
      songs.push(e);
      const c = decision.chosen!;
      uploads[e.id] = { youtubeId: c.videoId, durationSec: c.lengthSec!, channel: c.channel, uploadTitle: c.title };
      chosen.push({ rank: song.rank, id: song.id, songId: e.id, decision });
      if (chosen.length === target) stopRank = song.rank;
    } else skipped.push({ rank: song.rank, id: song.id, artist: song.artist, title: song.title, decision });
  }
  if (chosen.length < target) throw new Error(`search log: only ${chosen.length} of ${target} songs have an upload after ${entries.length} searched songs; the search is not finished`);
  return {
    rule,
    stopRank,
    list: { schema: SONG_LIST_SCHEMA, declaredAt: input.declaredAt, purpose: heldoutPurpose(rule), datasets: { [BILLBOARD_DATASET]: input.dataset }, songs },
    uploads,
    chosen,
    skipped,
  };
}

/** Adds decisionAmended to every log entry: recomputed up to the amended stop, not-needed after it. Original decisions are left as they are. */
export function amendLog<T extends SearchLog>(order: RankedSong[], log: T, target = TARGET_SONGS): T {
  let chosen = 0;
  const entries = log.entries.map((e, i) => {
    const song = order[i];
    if (!song || song.rank !== e.rank || song.id !== e.id) throw new Error(`search log: entry ${i + 1} does not follow the pool order`);
    if (chosen >= target) return { ...e, decisionAmended: { status: 'not-needed' as const, reason: NOT_NEEDED_REASON } };
    const { decisionAmended: _drop, ...rest } = e;
    const d = decideEntry(song, rest, 'amended-v1');
    if (d.status === 'chosen') chosen++;
    return { ...e, decisionAmended: d };
  });
  if (chosen < target) throw new Error(`amended rule: only ${chosen} of ${target} songs in the logged search`);
  return { ...log, entries };
}

export const SELECTION_DIFF_SCHEMA = 'vibe-guitar-annotation-heldout-selection-diff/1';

/** Annotation length bands for the composition (seconds, lower bound inclusive). */
export const LENGTH_BANDS: [string, number, number][] = [
  ['< 2:30', 0, 150],
  ['2:30-3:30', 150, 210],
  ['3:30-4:30', 210, 270],
  ['>= 4:30', 270, Infinity],
];

const decade = (date: string) => (/^\d{4}/.test(date) ? `${date.slice(0, 3)}0s` : 'unknown');
const band = (sec: number) => LENGTH_BANDS.find(([, lo, hi]) => sec >= lo && sec < hi)![0];

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...keys].sort()) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Selection-sensitivity record: the same pool and log walked under both upload rules. */
export function selectionDiff(order: RankedSong[], a: HeldoutListResult, b: HeldoutListResult) {
  const byRank = new Map(order.map((s) => [s.rank, s]));
  const side = (r: HeldoutListResult) => {
    const members = r.chosen.map((c) => {
      const s = byRank.get(c.rank)!;
      const u = c.decision.chosen!;
      return {
        rank: c.rank,
        id: id4(c.id),
        artist: s.artist,
        title: s.title,
        chartDate: s.chartDate,
        complexity: s.complexity,
        annotationDurationSec: s.annotationDurationSec,
        videoId: u.videoId,
        channel: u.channel,
        lengthText: u.lengthText,
        diffSec: u.diffSec,
        ...(u.branch ? { branch: u.branch } : {}),
      };
    });
    return {
      rule: r.rule,
      stopRank: r.stopRank,
      searchedToStop: r.stopRank,
      chosen: r.chosen.length,
      skipped: r.skipped.length,
      passRate: r.chosen.length / r.stopRank,
      composition: {
        decade: tally(members.map((m) => decade(m.chartDate))),
        complexity: tally(members.map((m) => m.complexity ?? 'unknown')),
        lengthBand: tally(members.map((m) => band(m.annotationDurationSec))),
        ...(r.rule === 'amended-v1' ? { branch: tally(members.map((m) => m.branch ?? 'none')) } : {}),
      },
      members,
    };
  };
  const sa = side(a);
  const sb = side(b);
  const ida = new Set(sa.members.map((m) => m.id));
  const idb = new Set(sb.members.map((m) => m.id));
  const brief = (m: (typeof sa.members)[number]) => ({ rank: m.rank, id: m.id, artist: m.artist, title: m.title });
  return {
    schema: SELECTION_DIFF_SCHEMA,
    lengthBands: LENGTH_BANDS.map(([name, lo, hi]) => ({ name, fromSec: lo, toSec: Number.isFinite(hi) ? hi : null })),
    selections: { [a.rule]: sa, [b.rule]: sb },
    overlap: sa.members.filter((m) => idb.has(m.id)).map(brief),
    only: { [a.rule]: sa.members.filter((m) => !idb.has(m.id)).map(brief), [b.rule]: sb.members.filter((m) => !ida.has(m.id)).map(brief) },
  };
}
