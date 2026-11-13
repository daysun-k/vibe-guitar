/**
 * Builds the VGT-7 held-out song list (PR #31) from the committed ordered pool and the raw search
 * log: walks the order, skips songs without a qualifying upload and stops at exactly TARGET_SONGS.
 * Decisions are recomputed from the raw results with the frozen rules; a logged decision that
 * disagrees, a log out of order, a log that ends early or one that searched past the stop is an
 * error.
 */
import { DRAW_SEED, id4, labPath, type RankedSong } from './heldout-draw';
import { chooseUpload, searchQueries, type QueryLabel, type SearchResult, type UploadDecision } from './heldout-uploads';
import { SONG_LIST_SCHEMA, type DatasetInfo, type SongEntry, type SongList, type UploadEntry } from './annotations';

export const TARGET_SONGS = 25;
export const SEARCH_LOG_SCHEMA = 'vibe-guitar-annotation-heldout-search-log/1';
export const BILLBOARD_DATASET = 'billboard-2.0.1-lab';

export interface SearchLogEntry {
  /** Pool rank and canonical id of the song searched. */
  rank: number;
  id: number;
  queries: { label: QueryLabel; query: string; results: SearchResult[] }[];
  decision?: UploadDecision;
}

export interface SearchLog {
  schema: string;
  entries: SearchLogEntry[];
}

export interface HeldoutListResult {
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

export const HELDOUT_PURPOSE =
  'Predeclared before any result (VGT-7, PR #31): 25 held-out evaluation songs drawn by a fixed seed from McGill Billboard 2.0.1 songs with no known BTC training-song overlap, for scoring Vibe Guitar auto charts against public, time-aligned chord annotations. ' +
  `Pool: one song per normalized (artist, title), canonical entry = lowest id; excluded in order: a title in BTC's UsPop2002 annotation list, an Isophonics or Robbie Williams artist, a song already on docs/annotation-eval-songs.json, fewer than 12 chord changes. Order: sha256("${DRAW_SEED}:" + 4-digit id) ascending, ties by id; the ordered pool is docs/annotation-heldout-v1-pool.json. ` +
  'Upload search: two frozen YouTube queries per song read to 15 results; a result qualifies on a matching "<artist> - Topic" channel, a matching cleaned title, none of the excluded words and a length within 2 s of annotationDurationSec; smallest difference, then Q1, then rank; songs without one are skipped and the walk stops at 25 (docs/annotation-heldout-v1-search-log.json). ' +
  'Complexity rule (from the annotation, N and X ignored): complex when >= 20 distinct labels or >= 40% of chord time is not a plain major/minor triad; simple when <= 10 labels and < 20%; otherwise moderate. ' +
  'Primary analysis: unweighted mean of per-song majmin WCSR with a percentile bootstrap 95% interval over songs. Results never change the list: no redraw, no replacement.';

function songEntry(s: RankedSong, d: UploadDecision): SongEntry {
  const c = d.chosen!;
  const q = searchQueries(s.artist, s.title);
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
    uploadHint: `Chosen by the frozen PR #31 search (${c.query}, result ${c.rank}): '${c.channel}' upload '${c.title}' (${c.videoId}), length ${c.lengthText}; annotation ${mmss(s.annotationDurationSec)}, difference ${c.diffSec!.toFixed(2)} s. Pool rank ${s.rank}.`,
  };
}

/** Recomputes a logged entry's decision and checks it against the logged one, when present. */
export function decideEntry(song: RankedSong, entry: SearchLogEntry): UploadDecision {
  const q = searchQueries(song.artist, song.title);
  const results = { Q1: [] as SearchResult[], Q2: [] as SearchResult[] };
  for (const label of ['Q1', 'Q2'] as QueryLabel[]) {
    const logged = entry.queries.filter((x) => x.label === label);
    if (logged.length !== 1) throw new Error(`search log: rank ${song.rank} needs exactly one ${label}`);
    if (logged[0].query !== q[label]) throw new Error(`search log: rank ${song.rank} ${label} was "${logged[0].query}", the frozen query is "${q[label]}"`);
    results[label] = logged[0].results;
  }
  const decision = chooseUpload(song, results);
  if (entry.decision && JSON.stringify(entry.decision) !== JSON.stringify(decision)) throw new Error(`search log: rank ${song.rank} logged decision differs from the frozen rules`);
  return decision;
}

export function buildHeldoutList(input: { order: RankedSong[]; log: SearchLog; dataset: DatasetInfo; declaredAt: string; target?: number }): HeldoutListResult {
  const target = input.target ?? TARGET_SONGS;
  if (input.log.schema !== SEARCH_LOG_SCHEMA) throw new Error(`search log: expected schema ${SEARCH_LOG_SCHEMA}`);
  const chosen: HeldoutListResult['chosen'] = [];
  const skipped: HeldoutListResult['skipped'] = [];
  const songs: SongEntry[] = [];
  const uploads: Record<string, UploadEntry> = {};
  const entries = input.log.entries;
  for (let i = 0; i < entries.length; i++) {
    if (chosen.length >= target) throw new Error(`search log: rank ${entries[i].rank} was searched after ${target} songs had an upload`);
    const song = input.order[i];
    if (!song) throw new Error(`search log: entry ${i + 1} is past the end of the pool`);
    if (entries[i].rank !== song.rank || entries[i].id !== song.id) throw new Error(`search log: entry ${i + 1} is rank ${entries[i].rank} id ${entries[i].id}, the pool order has rank ${song.rank} id ${song.id}`);
    const decision = decideEntry(song, entries[i]);
    if (decision.status === 'chosen') {
      const e = songEntry(song, decision);
      songs.push(e);
      const c = decision.chosen!;
      uploads[e.id] = { youtubeId: c.videoId, durationSec: c.lengthSec!, channel: c.channel, uploadTitle: c.title };
      chosen.push({ rank: song.rank, id: song.id, songId: e.id, decision });
    } else skipped.push({ rank: song.rank, id: song.id, artist: song.artist, title: song.title, decision });
  }
  if (chosen.length < target) throw new Error(`search log: only ${chosen.length} of ${target} songs have an upload after ${entries.length} searched songs; the search is not finished`);
  return {
    list: { schema: SONG_LIST_SCHEMA, declaredAt: input.declaredAt, purpose: HELDOUT_PURPOSE, datasets: { [BILLBOARD_DATASET]: input.dataset }, songs },
    uploads,
    chosen,
    skipped,
  };
}
