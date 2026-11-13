import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLab, parseSongList, parseUploads, type DatasetInfo } from '../src/eval/annotations';
import {
  annotationStats,
  billboardIdsOfList,
  buildPool,
  normalize,
  parseBillboardIndex,
  parseCsv,
  rankKey,
  round2,
  usPopTitlesFromTree,
  type RankedSong,
} from '../src/eval/heldout-draw';
import { checkResult, chooseUpload, cleanUploadTitle, excludedWord, parseLength, searchQueries, type SearchResult } from '../src/eval/heldout-uploads';
import { betaBinomialAtLeast, betaBinomialPmf, buildHeldoutV2List, heldoutV2Size, logGamma, V2_START_RANK, type V2SizeRule } from '../src/eval/heldout-v2';
import { amendLog, buildHeldoutList, heldoutSongId, NOT_NEEDED_REASON, SEARCH_LOG_SCHEMA, selectionDiff, TARGET_SONGS, type SearchLog, type SearchLogEntry } from '../src/eval/heldout-list';

/** A lab with n chord changes (alternating C and G, 2 s each) and trailing silence. */
const labWith = (changes: number, labels = ['C:maj', 'G:maj']) => {
  const lines = ['0.0 1.0 N'];
  for (let i = 0; i < changes; i++) lines.push(`${1 + 2 * i} ${3 + 2 * i} ${labels[i % labels.length]}`);
  lines.push(`${1 + 2 * changes} ${2 + 2 * changes} N`);
  return lines.join('\n');
};

describe('held-out pool: normalization and parsing (VGT-7, PR #31)', () => {
  it('normalizes as frozen: lower case, & -> and, no parentheses, no leading "the ", only [a-z0-9]', () => {
    expect(normalize('The Beatles')).toBe('beatles');
    expect(normalize('Simon & Garfunkel')).toBe('simonandgarfunkel');
    expect(normalize('Sweet Caroline (Good Times Never Seemed So Good)')).toBe('sweetcaroline');
    expect(normalize("(Sittin' On) The Dock Of The Bay")).toBe('dockofthebay');
    expect(normalize('Theme From Shaft')).toBe('themefromshaft');
    expect(normalize('Wake Me Up Before You Go-Go')).toBe('wakemeupbeforeyougogo');
  });

  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,b\n1,"x, y"\n2,"say ""hi"""\n')).toEqual([
      ['a', 'b'],
      ['1', 'x, y'],
      ['2', 'say "hi"'],
    ]);
    const rows = parseBillboardIndex('id,chart_date,target_rank,actual_rank,title,artist,peak_rank,weeks_on_chart\n1,1987-07-11,82,,,,,\n4,1971-08-07,32,31,You\'ve Got A Friend,"Roberta Flack,Donny Hathaway",29,12\n');
    expect(rows).toEqual([
      { id: 1, chartDate: '1987-07-11', title: '', artist: '' },
      { id: 4, chartDate: '1971-08-07', title: "You've Got A Friend", artist: 'Roberta Flack,Donny Hathaway' },
    ]);
  });

  it('takes UsPop2002 titles from uspopLabels file names only, without track numbers and invisible characters', () => {
    const t = usPopTitlesFromTree({
      tree: [
        { path: 'uspopLabels/Goo_Goo_Dolls/A_Boy_Named_Goo/06-Name.lab', type: 'blob' },
        { path: 'uspopLabels/enya/A_Day_Without_Rain/‭08-Silver_Inches.lab', type: 'blob' },
        { path: 'uspopLabels/Goo_Goo_Dolls', type: 'tree' },
        { path: 'RWC_Pop_Chords/N001-M01-T01.lab', type: 'blob' },
      ],
    });
    expect(t.map((x) => [x.artist, x.title])).toEqual([
      ['Goo Goo Dolls', 'Name'],
      ['enya', 'Silver Inches'],
    ]);
  });

  it('computes length and complexity like the earlier list (make_list.py stats)', () => {
    expect(round2(245.7349)).toBe(245.73);
    expect(round2(0.125)).toBe(0.12); // Python rounds an exact tie to even
    expect(round2(0.375)).toBe(0.38);
    expect(round2(1.005)).toBe(1); // 1.005 is just below 1.005 as a float
    const simple = annotationStats(parseLab(labWith(12)));
    expect(simple).toEqual({ durationSec: 26, complexity: 'simple', changes: 12 });
    const sevenths = annotationStats(parseLab(labWith(12, ['C:7', 'G:maj'])));
    expect(sevenths.complexity).toBe('complex'); // half of the chord time is not a plain triad
    expect(annotationStats(parseLab('0 5 N\n5 9 X')).complexity).toBeNull();
  });

  it('excludes exactly the 12 Billboard songs of the earlier list as already seen (pool file)', () => {
    const pool = JSON.parse(readFileSync('docs/annotation-heldout-v1-pool.json', 'utf8'));
    const seen = billboardIdsOfList(parseSongList(JSON.parse(readFileSync('docs/annotation-eval-songs.json', 'utf8'))));
    expect(seen).toHaveLength(12);
    expect(pool.sources.alreadySeen.ids).toEqual(seen.map((i) => String(i).padStart(4, '0')));
    expect(pool.excluded['already-seen'].map((s: { id: string }) => s.id).sort()).toEqual([...pool.sources.alreadySeen.ids].sort());
  });
});

describe('held-out pool: canonical entries, exclusions and order', () => {
  const index = [
    { id: 30, chartDate: '1980-01-05', title: 'Song A', artist: 'Band One' },
    { id: 7, chartDate: '1979-01-05', title: 'Song A (Single)', artist: 'The Band One' },
    { id: 8, chartDate: '1979-01-05', title: 'Kryptonite', artist: 'Band Two' },
    { id: 9, chartDate: '1979-01-05', title: 'Kryptonite', artist: 'Queen' },
    { id: 10, chartDate: '1979-01-05', title: 'Help!', artist: 'The Beatles' },
    { id: 11, chartDate: '1979-01-05', title: 'Seen Song', artist: 'Band Three' },
    { id: 12, chartDate: '1979-01-05', title: 'Short', artist: 'Band Four' },
    { id: 13, chartDate: '1979-01-05', title: 'No Lab', artist: 'Band Five' },
    { id: 14, chartDate: '1979-01-05', title: '', artist: '' },
    { id: 15, chartDate: '1979-01-05', title: 'Eligible', artist: 'Band Six' },
    { id: 16, chartDate: '1979-01-05', title: 'Seen Song', artist: 'Band Three' },
  ];
  const labs: Record<number, string> = { 30: labWith(20), 7: labWith(20), 8: labWith(20), 9: labWith(20), 10: labWith(20), 11: labWith(20), 12: labWith(11), 15: labWith(12), 16: labWith(20) };
  const pool = buildPool({
    index,
    readLab: (id) => labs[id] ?? null,
    usPopTitles: [{ path: 'uspopLabels/3_doors_down/The_Better_Life/01-Kryptonite.lab', artist: '3 doors down', title: 'Kryptonite' }],
    alreadySeenIds: [16],
  });

  it('counts rows, entries with a lab and unique songs', () => {
    expect(pool.counts).toMatchObject({ indexRows: 11, rowsWithTitle: 10, entriesWithLab: 9, uniqueSongs: 7, eligible: 2 });
  });

  it('merges a song by normalized artist and title and keeps the lowest id as canonical', () => {
    const a = pool.order.find((s) => s.ids.includes(30))!;
    expect(a.id).toBe(7);
    expect(a.ids).toEqual([7, 30]);
    expect(a.title).toBe('Song A (Single)');
  });

  it('applies the exclusions in order and records only the first matching reason', () => {
    const ids = (r: keyof typeof pool.excluded) => pool.excluded[r].map((s) => s.id);
    expect(ids('btc-uspop-title')).toEqual([8, 9]); // Queen's Kryptonite is a title match first
    expect(ids('btc-isophonics-or-rw-artist')).toEqual([10]);
    expect(ids('already-seen')).toEqual([11]); // any entry of the song (16) was seen
    expect(ids('too-few-changes')).toEqual([12]);
    expect(pool.excluded['too-few-changes'][0].detail).toBe('11 changes');
    expect(pool.counts.excluded).toEqual({ 'btc-uspop-title': 2, 'btc-isophonics-or-rw-artist': 1, 'already-seen': 1, 'too-few-changes': 1 });
  });

  it('orders eligible songs by sha256 of the seed and 4-digit id, ranks from 1', () => {
    expect(rankKey(7)).toMatch(/^[0-9a-f]{64}$/);
    const keys = pool.order.map((s) => s.key);
    expect(keys).toEqual([...keys].sort());
    expect(pool.order.map((s) => s.rank)).toEqual([1, 2]);
    expect(pool.order.every((s) => s.key === rankKey(s.id))).toBe(true);
  });

  it('commits an ordered pool whose order follows the frozen key (docs/annotation-heldout-v1-pool.json)', () => {
    const p = JSON.parse(readFileSync('docs/annotation-heldout-v1-pool.json', 'utf8'));
    expect(p.seed).toBe('vgt7-billboard-heldout-v1');
    expect(p.order).toHaveLength(p.counts.eligible);
    const total = p.counts.eligible + Object.values(p.counts.excluded as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(p.counts.uniqueSongs);
    p.order.forEach((s: { rank: number; id: string; key: string; changes: number }, i: number) => {
      expect(s.rank).toBe(i + 1);
      expect(s.key).toBe(rankKey(Number(s.id)));
      expect(s.changes).toBeGreaterThanOrEqual(12);
      if (i) expect(p.order[i - 1].key < s.key || (p.order[i - 1].key === s.key && Number(p.order[i - 1].id) < Number(s.id))).toBe(true);
    });
    const titles = JSON.parse(readFileSync('docs/btc-uspop2002-titles.json', 'utf8'));
    expect(titles.entries).toHaveLength(195);
    expect(titles.source.treeSha).toBe('4b022ff5a95ff1d9ba1057ea4c982e45484d764f');
  });
});

describe('held-out uploads: frozen search rules', () => {
  const song = { artist: 'Robert Palmer', title: 'Addicted To Love', annotationDurationSec: 264.93 };
  const r = (rank: number, over: Partial<SearchResult> = {}): SearchResult => ({ rank, videoId: `vid${String(rank).padStart(8, '0')}`, title: 'Addicted To Love', channel: 'Robert Palmer - Topic', lengthText: '4:25', ...over });

  it('builds the two frozen queries', () => {
    expect(searchQueries('Robert Palmer', 'Addicted To Love')).toEqual({ Q1: 'Robert Palmer Addicted To Love "Provided to YouTube"', Q2: 'Robert Palmer - Topic Addicted To Love' });
  });

  it('parses m:ss and h:mm:ss lengths only', () => {
    expect(parseLength('4:25')).toBe(265);
    expect(parseLength('1:02:03')).toBe(3723);
    expect(parseLength('LIVE')).toBeNull();
    expect(parseLength('4:7')).toBeNull();
    expect(parseLength('')).toBeNull();
  });

  it('cleans titles: drops parentheses and the part after the last " - "', () => {
    expect(cleanUploadTitle('Addicted To Love (2003 Remaster)')).toBe('Addicted To Love ');
    expect(cleanUploadTitle('Addicted To Love - Remastered 2003')).toBe('Addicted To Love');
    expect(cleanUploadTitle('Cold Sweat - Part 1 - Single Version')).toBe('Cold Sweat - Part 1');
  });

  it('finds excluded words as whole words only', () => {
    expect(excludedWord('Addicted To Love (Live)')).toBe('live');
    expect(excludedWord('Song - Radio Edit')).toBe('edit');
    expect(excludedWord('Song (Re-Recorded)')).toBe('re-recorded');
    expect(excludedWord('Song (Deluxe Edition)')).toBeNull();
    expect(excludedWord('Monologue')).toBeNull();
    expect(excludedWord('Olive Tree')).toBeNull();
  });

  it('qualifies only Topic uploads of the same artist and title within 2 s', () => {
    expect(checkResult(r(1), song).qualifies).toBe(true);
    expect(checkResult(r(1, { channel: 'Robert Palmer' }), song).failed).toEqual(['channel is not a Topic channel']);
    expect(checkResult(r(1, { channel: 'Palmer - Topic' }), song).qualifies).toBe(true); // contained in the Billboard artist
    expect(checkResult(r(1, { channel: 'Robert Palmer & The Band - Topic' }), song).qualifies).toBe(true); // contains it
    expect(checkResult(r(1, { channel: 'Someone Else - Topic' }), song).failed).toEqual(['Topic artist does not match']);
    expect(checkResult(r(1, { channel: '() - Topic' }), song).failed).toEqual(['Topic artist does not match']);
    expect(checkResult(r(1, { title: 'Addicted To Love (Remastered 2003)' }), song).qualifies).toBe(true);
    expect(checkResult(r(1, { title: 'Addicted To Love - Live At Wembley' }), song).failed).toEqual(['title has the word "live"']);
    expect(checkResult(r(1, { title: 'Simply Irresistible' }), song).failed).toEqual(['title does not match']);
    expect(checkResult(r(1, { lengthText: '4:27' }), song).failed).toEqual(['length differs by 2.07 s']);
    expect(checkResult(r(1, { lengthText: 'LIVE' }), song).failed).toEqual(['no length']);
    expect(checkResult(r(1, { lengthText: '4:23' }), { ...song, annotationDurationSec: 265 }).qualifies).toBe(true); // exactly 2 s
  });

  it('chooses by smallest length difference, then Q1 before Q2, then rank, within the first 15 results', () => {
    const d = chooseUpload(song, { Q1: [r(3, { lengthText: '4:26' }), r(4)], Q2: [r(1)] });
    expect(d.status).toBe('chosen');
    expect(d.chosen).toMatchObject({ query: 'Q1', rank: 4 });
    expect(d.qualifying).toBe(3);
    const tie = chooseUpload(song, { Q1: [r(5), r(2)], Q2: [r(1)] });
    expect(tie.chosen).toMatchObject({ query: 'Q1', rank: 2 });
    const late = chooseUpload(song, { Q1: [r(16)], Q2: [] });
    expect(late.status).toBe('skipped');
  });

  it('records the nearest Topic lengths for a skipped song', () => {
    const d = chooseUpload(song, { Q1: [r(1, { lengthText: '4:30' }), r(2, { channel: 'Other - Topic', lengthText: '4:26' }), r(3, { channel: 'Not Topic', lengthText: '4:25' })], Q2: [r(1, { lengthText: '4:30' })] });
    expect(d.status).toBe('skipped');
    expect(d.reason).toMatch(/no qualifying upload/);
    expect(d.nearestTopic.map((c) => [c.query, c.rank, c.lengthText])).toEqual([
      ['Q1', 2, '4:26'],
      ['Q1', 1, '4:30'],
    ]);
  });
});

describe('held-out uploads: amended-v1 channel rule (PR #31 amendment)', () => {
  const song = { artist: 'Robert Palmer', title: 'Addicted To Love', annotationDurationSec: 264.93 };
  const official = (over: Partial<SearchResult> = {}, extra: SearchResult['extra'] = { channelId: 'UCx', ownerBadges: ['BADGE_STYLE_TYPE_VERIFIED_ARTIST'], snippet: 'Provided to YouTube by Universal Music Group Addicted To Love' }): SearchResult => ({
    rank: 1,
    videoId: 'abcdefghijk',
    title: 'Addicted To Love',
    channel: 'Robert Palmer',
    lengthText: '4:25',
    ...over,
    extra,
  });

  it('accepts a verified official artist channel with a Provided to YouTube upload (branch 2)', () => {
    const c = checkResult(official(), song, 'amended-v1');
    expect(c).toMatchObject({ qualifies: true, branch: 'official-artist', topic: false });
    expect(checkResult(official(), song, 'topic-only-v1').qualifies).toBe(false);
    const d = chooseUpload(song, { Q1: [official()], Q2: [] }, 'amended-v1');
    expect(d.chosen).toMatchObject({ videoId: 'abcdefghijk', branch: 'official-artist' });
    expect(chooseUpload(song, { Q1: [official()], Q2: [] }).chosen).toBeNull();
  });

  it('fails branch 2 without the snippet, without the badge, with another badge or with a different prefix case', () => {
    expect(checkResult(official({}, { ownerBadges: ['BADGE_STYLE_TYPE_VERIFIED_ARTIST'] }), song, 'amended-v1').qualifies).toBe(false);
    const { extra: _none, ...noExtra } = official();
    expect(checkResult(noExtra, song, 'amended-v1').failed).toEqual(['not a Topic channel and the upload is not a Provided to YouTube track']);
    expect(checkResult(official({}, {}), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({}, { snippet: 'Provided to YouTube by X' }), song, 'amended-v1').failed).toEqual(['not a Topic channel and the channel is not a verified artist channel']);
    expect(checkResult(official({}, { snippet: 'Provided to YouTube by X', ownerBadges: ['BADGE_STYLE_TYPE_VERIFIED'] }), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({}, { snippet: 'provided to YouTube by X', ownerBadges: ['BADGE_STYLE_TYPE_VERIFIED_ARTIST'] }), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({}, { snippet: ' Provided to YouTube by X', ownerBadges: ['BADGE_STYLE_TYPE_VERIFIED_ARTIST'] }), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({ channel: 'Someone Else' }), song, 'amended-v1').failed).toEqual(['artist channel does not match']);
  });

  it('never judges a " - Topic" channel by branch 2', () => {
    const c = checkResult(official({ channel: 'Party Tyme - Topic' }), song, 'amended-v1');
    expect(c.failed).toEqual(['Topic artist does not match']);
    expect(c.branch).toBeNull();
    expect(checkResult(official({ channel: 'Robert Palmer - Topic' }, {}), song, 'amended-v1').branch).toBe('topic');
  });

  it('needs nonempty normalized names in both branches', () => {
    expect(checkResult(official({ channel: '() - Topic' }), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({ channel: '(!!)' }), song, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official({ channel: 'Robert Palmer - Topic' }), { ...song, artist: '(x)' }, 'amended-v1').qualifies).toBe(false);
    expect(checkResult(official(), { ...song, artist: '(x)' }, 'amended-v1').qualifies).toBe(false);
  });
});

describe('held-out list builder', () => {
  const dataset: DatasetInfo = { name: 'BB', page: 'p', downloads: [], folder: 'billboard-2.0.1-lab', licence: 'CC0', licenceQuote: 'q', attribution: 'a', btcTraining: 'not listed' };
  const order: RankedSong[] = Array.from({ length: 40 }, (_, i) => ({
    rank: i + 1,
    id: 100 + i,
    ids: [100 + i],
    artist: `Artist ${i}`,
    title: `Title ${i}`,
    chartDate: '1980-01-01',
    annotationDurationSec: 200.4,
    complexity: 'moderate',
    changes: 30,
    key: String(i).padStart(64, '0'),
  }));
  const entry = (s: RankedSong, ok: boolean): SearchLogEntry => {
    const q = searchQueries(s.artist, s.title);
    const hit: SearchResult = { rank: 1, videoId: `v${String(s.id).padStart(10, '0')}`, title: s.title, channel: `${s.artist} - Topic`, lengthText: ok ? '3:20' : '3:40' };
    return { rank: s.rank, id: s.id, queries: [{ label: 'Q1', query: q.Q1, results: [hit] }, { label: 'Q2', query: q.Q2, results: [] }] };
  };
  const skipRanks = new Set([2, 5, 6]);
  const log = (n: number): SearchLog => ({ schema: SEARCH_LOG_SCHEMA, entries: order.slice(0, n).map((s) => entry(s, !skipRanks.has(s.rank))) });

  it('walks the order, skips songs without an upload and stops at exactly 25', () => {
    const r = buildHeldoutList({ order, log: log(28), dataset, declaredAt: '2026-11-13' });
    expect(TARGET_SONGS).toBe(25);
    expect(r.list.songs).toHaveLength(25);
    expect(r.skipped.map((s) => s.rank)).toEqual([2, 5, 6]);
    expect(r.chosen.at(-1)!.rank).toBe(28);
    expect(Object.keys(r.uploads)).toEqual(r.list.songs.map((s) => s.id));
    expect(r.uploads[r.list.songs[0].id]).toEqual({ youtubeId: 'v0000000100', durationSec: 200, channel: 'Artist 0 - Topic', uploadTitle: 'Title 0' });
    const s = r.list.songs[0];
    expect(s).toMatchObject({ role: 'eval', btcTraining: 'not-known', dataset: 'billboard-2.0.1-lab', chords: 'McGill-Billboard/0100/full.lab', beats: null, complexity: 'moderate', annotationDurationSec: 200.4 });
    expect(s.search).toEqual(['Artist 0 Title 0 "Provided to YouTube"', 'Artist 0 - Topic Title 0']);
    expect(s.release).not.toMatch(/album/i);
    expect(s.uploadHint).toContain('v0000000100');
    expect(s.uploadHint).toContain('annotation 3:20,');
    const late = buildHeldoutList({ order: order.map((o) => ({ ...o, annotationDurationSec: 179.98 })), log: { schema: SEARCH_LOG_SCHEMA, entries: order.slice(0, 25).map((o) => { const e = entry(o, true); e.queries[0].results[0].lengthText = '3:00'; return e; }) }, dataset, declaredAt: 'x' });
    expect(late.list.songs[0].uploadHint).toContain('annotation 3:00,');
    expect(s.id).toBe(heldoutSongId(order[0]));
    expect(parseSongList(r.list).songs).toHaveLength(25);
    expect(parseUploads(r.uploads)).toEqual(r.uploads);
    expect(r.list.datasets['billboard-2.0.1-lab']).toBe(dataset);
    expect(r.list.purpose).toContain('PR #31');
  });

  it('is deterministic for the same pool and log', () => {
    expect(JSON.stringify(buildHeldoutList({ order, log: log(28), dataset, declaredAt: 'x' }))).toBe(JSON.stringify(buildHeldoutList({ order, log: log(28), dataset, declaredAt: 'x' })));
  });

  it('rejects a log that ends early, searched past the stop, skips a rank or changes a query or decision', () => {
    expect(() => buildHeldoutList({ order, log: log(27), dataset, declaredAt: 'x' })).toThrow(/only 24 of 25/);
    expect(() => buildHeldoutList({ order, log: log(29), dataset, declaredAt: 'x' })).toThrow(/searched after 25/);
    const gap = log(28);
    gap.entries.splice(3, 1);
    expect(() => buildHeldoutList({ order, log: gap, dataset, declaredAt: 'x' })).toThrow(/pool order has rank 4/);
    const q = log(28);
    q.entries[0].queries[0].query = 'something else';
    expect(() => buildHeldoutList({ order, log: q, dataset, declaredAt: 'x' })).toThrow(/frozen query/);
    const dec = log(28);
    dec.entries[1].decision = { ...chooseUpload(order[0], { Q1: [], Q2: [] }) };
    dec.entries[1].decision.status = 'chosen';
    expect(() => buildHeldoutList({ order, log: dec, dataset, declaredAt: 'x' })).toThrow(/logged topic-only-v1 decision differs/);
  });
});

describe('heldout-songs script', () => {
  it('builds the list and uploads from a pool file and a log', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vgt-heldout-'));
    try {
      const order = Array.from({ length: 26 }, (_, i) => ({ rank: i + 1, id: String(200 + i).padStart(4, '0'), ids: [String(200 + i).padStart(4, '0')], artist: `A${i}`, title: `T${i}`, chartDate: '1980-01-01', annotationDurationSec: 180, complexity: 'simple', changes: 20, key: 'k' }));
      writeFileSync(path.join(dir, 'pool.json'), JSON.stringify({ schema: 'vibe-guitar-annotation-heldout-pool/1', order }));
      const entries = order.slice(0, 26).map((s, i) => {
        const q = searchQueries(s.artist, s.title);
        const results = i === 0 ? [] : [{ rank: 1, videoId: `x${String(i).padStart(10, '0')}`, title: s.title, channel: `${s.artist} - Topic`, lengthText: '3:00' }];
        return { rank: s.rank, id: Number(s.id), queries: [{ label: 'Q1', query: q.Q1, results }, { label: 'Q2', query: q.Q2, results: [] }] };
      });
      writeFileSync(path.join(dir, 'log.json'), JSON.stringify({ schema: SEARCH_LOG_SCHEMA, entries }));
      const run = spawnSync(
        process.execPath,
        ['scripts/heldout-songs.mjs', 'list', '--pool', path.join(dir, 'pool.json'), '--log', path.join(dir, 'log.json'), '--declared-at', '2026-11-13', '--out', path.join(dir, 'list.json'), '--uploads-out', path.join(dir, 'uploads.json')],
        { encoding: 'utf8' },
      );
      expect(run.status, run.stderr).toBe(0);
      const list = parseSongList(JSON.parse(readFileSync(path.join(dir, 'list.json'), 'utf8')));
      expect(list.songs).toHaveLength(25);
      expect(list.datasets['billboard-2.0.1-lab'].folder).toBe('billboard-2.0.1-lab');
      expect(Object.keys(parseUploads(JSON.parse(readFileSync(path.join(dir, 'uploads.json'), 'utf8'))))).toHaveLength(25);
      const bad = spawnSync(process.execPath, ['scripts/heldout-songs.mjs', 'pool'], { encoding: 'utf8' });
      expect(bad.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('committed held-out list (VGT-7, PR #31 and its amendment)', () => {
  const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
  const pool = read('docs/annotation-heldout-v1-pool.json');
  const log = read('docs/annotation-heldout-v1-search-log.json');
  const existing = parseSongList(read('docs/annotation-eval-songs.json'));
  const dataset = existing.datasets['billboard-2.0.1-lab'];
  const order: RankedSong[] = pool.order.map((s: RankedSong & { id: string; ids: string[] }) => ({ ...s, id: Number(s.id), ids: s.ids.map(Number) }));
  const list = parseSongList(read('docs/annotation-eval-songs-heldout-v1.json'));
  const AMENDED_RANKS = [4, 5, 6, 8, 9, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32];
  const TOPIC_ONLY_RANKS = [5, 18, 19, 25, 27, 31, 32, 35, 36, 37, 41, 57, 62, 63, 67, 69, 72, 81, 84, 104, 118, 128, 129, 130, 136];

  it('replays the original topic-only-v1 walk from the log: 25 songs, stop at rank 136', () => {
    const r = buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'topic-only-v1' });
    expect(r.stopRank).toBe(136);
    expect(r.chosen.map((c) => c.rank)).toEqual(TOPIC_ONLY_RANKS);
    expect(log.stoppedAtRank).toBe(136);
    expect(log.chosen).toBe(25);
  });

  it('replays the amended-v1 walk from the same log: 25 songs, stop at rank 32, later songs not needed', () => {
    const r = buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'amended-v1' });
    expect(r.stopRank).toBe(32);
    expect(r.chosen.map((c) => c.rank)).toEqual(AMENDED_RANKS);
    expect(log.amended).toEqual({ rule: 'amended-v1', stoppedAtRank: 32, chosen: 25, skipped: 7, notNeeded: 104 });
    for (const e of log.entries) {
      expect(e.decision.status).toMatch(/^(chosen|skipped)$/);
      if (e.rank > 32) expect(e.decisionAmended).toEqual({ status: 'not-needed', reason: NOT_NEEDED_REASON });
    }
    expect(amendLog(order, log)).toEqual(log);
  });

  it('keeps the nearest-Topic diagnostic of every amended skip equal to the original one (Topic channels only)', () => {
    const skipped = log.entries.filter((e: SearchLogEntry) => e.decisionAmended?.status === 'skipped');
    expect(skipped.map((e: SearchLogEntry) => e.rank)).toEqual([1, 2, 3, 7, 10, 17, 30]);
    for (const e of skipped) {
      const amended = e.decisionAmended as { nearestTopic: { channel: string }[] };
      expect(amended.nearestTopic).toEqual(e.decision!.nearestTopic);
      expect(amended.nearestTopic.every((c) => c.channel.endsWith(' - Topic'))).toBe(true);
    }
  });

  it('fails when a logged amended decision differs from the recomputation', () => {
    const bad = JSON.parse(JSON.stringify(log));
    bad.entries[0].decisionAmended.status = 'chosen';
    expect(() => buildHeldoutList({ order, log: bad, dataset, declaredAt: 'x', rule: 'amended-v1' })).toThrow(/logged amended-v1 decision differs/);
    const early = JSON.parse(JSON.stringify(log));
    early.entries[40].decisionAmended = early.entries[3].decisionAmended;
    expect(() => buildHeldoutList({ order, log: early, dataset, declaredAt: 'x', rule: 'amended-v1' })).toThrow(/not marked not-needed/);
  });

  it('ships the list and uploads of the amended walk', () => {
    const r = buildHeldoutList({ order, log, dataset, declaredAt: list.declaredAt, rule: 'amended-v1' });
    expect(list).toEqual(r.list);
    expect(list.purpose).toContain('amended-v1');
    expect(list.purpose).toContain('PR #31 amendment');
    const { $comment, ...uploads } = read('docs/annotation-heldout-v1-uploads.json');
    expect($comment).toMatch(/amended-v1/);
    expect(parseUploads(uploads)).toEqual(r.uploads);
  });

  it('records both selections in the selection diff', () => {
    const a = buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'topic-only-v1' });
    const b = buildHeldoutList({ order, log, dataset, declaredAt: 'x', rule: 'amended-v1' });
    const d = read('docs/annotation-heldout-v1-selection-diff.json');
    const { purpose, sources, ...rest } = d;
    expect(purpose).toMatch(/not captured/);
    expect(sources.searchLog).toBe('docs/annotation-heldout-v1-search-log.json');
    expect(rest).toEqual(JSON.parse(JSON.stringify(selectionDiff(order, a, b))));
    expect(d.overlap.length + d.only['amended-v1'].length).toBe(25);
    expect(d.overlap.length + d.only['topic-only-v1'].length).toBe(25);
    expect(d.selections['amended-v1'].passRate).toBeCloseTo(25 / 32, 12);
    expect(d.selections['topic-only-v1'].passRate).toBeCloseTo(25 / 136, 12);
    expect(d.selections['amended-v1'].members.every((m: { branch?: string }) => m.branch === 'topic' || m.branch === 'official-artist')).toBe(true);
  });

  it('has 25 held-out eval songs with no overlap with the earlier list', () => {
    expect(list.songs).toHaveLength(25);
    for (const s of list.songs) {
      expect(s.role).toBe('eval');
      expect(s.btcTraining).toBe('not-known');
      expect(s.annotationDurationSec).toBeGreaterThan(60);
      expect(s.chords).toMatch(/^McGill-Billboard\/\d{4}\/full\.lab$/);
    }
    const seen = new Set(existing.songs.map((s) => s.chords));
    expect(list.songs.filter((s) => seen.has(s.chords))).toEqual([]);
    expect(new Set(list.songs.map((s) => s.id)).size).toBe(25);
  });
});

describe('held-out v2 size rule (VGT-7, PR #33)', () => {
  it('reproduces the predeclared N: k = 12 -> 51, 13 -> 46, 14 -> 42, 15 -> 38', () => {
    const got = [12, 13, 14, 15].map((k) => heldoutV2Size(k));
    expect(got.map((s) => s.n)).toEqual([51, 46, 42, 38]);
    for (const s of got) {
      expect(s.a).toBe(1 + s.k);
      expect(s.b).toBe(1 + 25 - s.k);
      expect(s.probability).toBeGreaterThanOrEqual(0.95);
      expect(betaBinomialAtLeast(15, s.n - 1, s.a, s.b)).toBeLessThan(0.95);
    }
    // Exact rational values (Python fractions) of P(X >= 15) at N for k = 12 and 13.
    expect(got[0].probability).toBeCloseTo(0.9553610832853788, 11);
    expect(got[1].probability).toBeCloseTo(0.9555488162303252, 11);
  });

  it('computes log-gamma and a beta-binomial that sums to 1', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(11)).toBeCloseTo(Math.log(3628800), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    let total = 0;
    for (let x = 0; x <= 40; x++) total += betaBinomialPmf(x, 40, 14, 13);
    expect(total).toBeCloseTo(1, 12);
    // a = b = 1 is uniform on 0..n.
    expect(betaBinomialPmf(3, 9, 1, 1)).toBeCloseTo(0.1, 12);
    expect(betaBinomialAtLeast(15, 14, 2, 2)).toBe(0);
  });

  it('rejects k outside 0..25 or not a whole number', () => {
    for (const k of [-1, 26, 12.5, Number.NaN]) expect(() => heldoutV2Size(k)).toThrow(/k must be an integer/);
  });
});

describe('held-out v2 list builder (PR #33)', () => {
  const dataset: DatasetInfo = { name: 'BB', page: 'p', downloads: [], folder: 'billboard-2.0.1-lab', licence: 'CC0', licenceQuote: 'q', attribution: 'a', btcTraining: 'not listed' };
  const order: RankedSong[] = Array.from({ length: 30 }, (_, i) => ({
    rank: i + 1,
    id: 300 + i,
    ids: [300 + i],
    artist: `Artist ${i}`,
    title: `Title ${i}`,
    chartDate: '1985-01-01',
    annotationDurationSec: 200.4,
    complexity: 'moderate',
    changes: 30,
    key: String(i).padStart(64, '0'),
  }));
  const skipRanks = new Set([3, 12, 13, 17]);
  const entry = (s: RankedSong): SearchLogEntry => {
    const q = searchQueries(s.artist, s.title);
    const hit: SearchResult = { rank: 1, videoId: `w${String(s.id).padStart(10, '0')}`, title: s.title, channel: `${s.artist} - Topic`, lengthText: skipRanks.has(s.rank) ? '3:40' : '3:20' };
    return { rank: s.rank, id: s.id, queries: [{ label: 'Q1', query: q.Q1, results: [hit] }, { label: 'Q2', query: q.Q2, results: [] }] };
  };
  const log = (n = order.length): SearchLog => ({ schema: SEARCH_LOG_SCHEMA, entries: order.slice(0, n).map(entry) });
  const size = (n: number): V2SizeRule => ({ ...heldoutV2Size(13), n });

  it('starts at the start rank and stops at the first N songs with an upload', () => {
    expect(V2_START_RANK).toBe(33);
    const r = buildHeldoutV2List({ order, log: log(), dataset, declaredAt: '2026-11-13', size: size(6), startRank: 10 });
    expect(r.chosen.map((c) => c.rank)).toEqual([10, 11, 14, 15, 16, 18]);
    expect(r.skipped.map((s) => s.rank)).toEqual([12, 13, 17]);
    expect(r.stopRank).toBe(18);
    expect(r.list.songs).toHaveLength(6);
    expect(Object.keys(r.uploads)).toEqual(r.list.songs.map((s) => s.id));
    expect(r.list.v2).toMatchObject({ protocol: 'PR #33', uploadRule: 'amended-v1', startRank: 10, stopRank: 18, searchedFromStart: 9 });
    expect(r.list.v2.skipped.map((s) => s.id)).toEqual(['0311', '0312', '0316']);
    expect(r.list.v2.sizeRule.n).toBe(6);
    expect(r.list.songs[0]).toMatchObject({ role: 'eval', btcTraining: 'not-known', dataset: 'billboard-2.0.1-lab', chords: 'McGill-Billboard/0309/full.lab' });
    expect(r.list.songs[0].uploadHint).toContain('walked for the v2 batch (PR #33), rule amended-v1');
    expect(r.list.purpose).toContain('PR #33');
    expect(r.list.purpose).toContain('from rank 10');
    expect(parseSongList(r.list).songs).toHaveLength(6);
    expect(parseUploads(r.uploads)).toEqual(r.uploads);
  });

  it('decides from the raw results only: logged decisions and not-needed marks are ignored', () => {
    const plain = buildHeldoutV2List({ order, log: log(), dataset, declaredAt: 'x', size: size(6), startRank: 10 });
    const marked = log();
    const wrong = chooseUpload(order[0], { Q1: [], Q2: [] });
    for (const e of marked.entries) {
      e.decision = wrong;
      e.decisionAmended = e.rank >= 10 ? { status: 'not-needed', reason: NOT_NEEDED_REASON } : wrong;
    }
    expect(buildHeldoutV2List({ order, log: marked, dataset, declaredAt: 'x', size: size(6), startRank: 10 })).toEqual(plain);
  });

  it('never decides entries before the start rank or after the stop', () => {
    const l = log();
    l.entries[1].queries[0].query = 'changed before the start';
    l.entries[25].queries[0].query = 'changed after the stop';
    expect(buildHeldoutV2List({ order, log: l, dataset, declaredAt: 'x', size: size(6), startRank: 10 }).stopRank).toBe(18);
    l.entries[13].queries[0].query = 'changed inside the walk';
    expect(() => buildHeldoutV2List({ order, log: l, dataset, declaredAt: 'x', size: size(6), startRank: 10 })).toThrow(/frozen query/);
  });

  it('fails when the log ends before N songs qualify, or does not follow the pool order', () => {
    expect(() => buildHeldoutV2List({ order, log: log(20), dataset, declaredAt: 'x', size: size(9), startRank: 10 })).toThrow(/only 8 of 9 songs .*\(rank 20\); stop and ask the user/);
    expect(() => buildHeldoutV2List({ order, log: log(9), dataset, declaredAt: 'x', size: size(1), startRank: 10 })).toThrow(/no entry at or after rank 10/);
    const gap = log();
    gap.entries.splice(4, 1);
    expect(() => buildHeldoutV2List({ order, log: gap, dataset, declaredAt: 'x', size: size(6), startRank: 10 })).toThrow(/pool order has rank 5/);
  });

  it('leaves the v1 builder output as it was', () => {
    const v1 = buildHeldoutList({ order, log: log(29), dataset, declaredAt: 'x', rule: 'amended-v1' });
    expect(v1.list.songs[0].uploadHint).toMatch(/^Chosen by the PR #31 search, rule amended-v1 \(/);
    expect(v1.list.purpose).not.toContain('PR #33');
    expect('v2' in v1.list).toBe(false);
  });

  it('walks the committed v1 pool and log from rank 33 (capacity check of PR #33)', () => {
    const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
    const pool = read('docs/annotation-heldout-v1-pool.json');
    const committed: RankedSong[] = pool.order.map((s: RankedSong & { id: string; ids: string[] }) => ({ ...s, id: Number(s.id), ids: s.ids.map(Number) }));
    const committedLog = read('docs/annotation-heldout-v1-search-log.json');
    const bb = parseSongList(read('docs/annotation-eval-songs.json')).datasets['billboard-2.0.1-lab'];
    const r = buildHeldoutV2List({ order: committed, log: committedLog, dataset: bb, declaredAt: 'x', size: heldoutV2Size(13) });
    expect(r.list.songs).toHaveLength(46);
    expect(r.stopRank).toBe(92);
    expect(Math.min(...r.chosen.map((c) => c.rank))).toBeGreaterThanOrEqual(33);
    const v1 = new Set(parseSongList(read('docs/annotation-eval-songs-heldout-v1.json')).songs.map((s) => s.chords));
    expect(r.list.songs.filter((s) => v1.has(s.chords))).toEqual([]);
    expect(() => buildHeldoutV2List({ order: committed, log: committedLog, dataset: bb, declaredAt: 'x', size: { ...heldoutV2Size(13), n: 73 } })).toThrow(/only 72 of 73/);
  });
});

describe('heldout-songs script list-v2', () => {
  it('writes the v2 list and uploads with the size rule, and needs --eligible-k', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vgt-heldout-v2-'));
    try {
      const order = Array.from({ length: 80 }, (_, i) => ({ rank: i + 1, id: String(400 + i).padStart(4, '0'), ids: [String(400 + i).padStart(4, '0')], artist: `B${i}`, title: `U${i}`, chartDate: '1980-01-01', annotationDurationSec: 180.2, complexity: 'simple', changes: 20, key: 'k' }));
      writeFileSync(path.join(dir, 'pool.json'), JSON.stringify({ schema: 'vibe-guitar-annotation-heldout-pool/1', order }));
      const entries = order.map((s, i) => {
        const q = searchQueries(s.artist, s.title);
        const results = i === 40 ? [] : [{ rank: 1, videoId: `y${String(i).padStart(10, '0')}`, title: s.title, channel: `${s.artist} - Topic`, lengthText: '3:00' }];
        return { rank: s.rank, id: Number(s.id), queries: [{ label: 'Q1', query: q.Q1, results }, { label: 'Q2', query: q.Q2, results: [] }], decisionAmended: { status: 'not-needed', reason: NOT_NEEDED_REASON } };
      });
      writeFileSync(path.join(dir, 'log.json'), JSON.stringify({ schema: SEARCH_LOG_SCHEMA, entries }));
      const args = ['--pool', path.join(dir, 'pool.json'), '--log', path.join(dir, 'log.json'), '--declared-at', '2026-11-13', '--out', path.join(dir, 'list.json'), '--uploads-out', path.join(dir, 'uploads.json')];
      const run = spawnSync(process.execPath, ['scripts/heldout-songs.mjs', 'list-v2', '--start-rank', '33', '--eligible-k', '15', ...args], { encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('N 38');
      expect(run.stdout).toContain('stop rank 71');
      const list = JSON.parse(readFileSync(path.join(dir, 'list.json'), 'utf8'));
      expect(parseSongList(list).songs).toHaveLength(38);
      expect(list.v2).toMatchObject({ startRank: 33, stopRank: 71, sizeRule: { k: 15, n: 38, a: 16, b: 11 } });
      expect(list.declaredAt).toBe('2026-11-13');
      const uploads = JSON.parse(readFileSync(path.join(dir, 'uploads.json'), 'utf8'));
      expect(uploads.$comment).toMatch(/PR #33/);
      expect(Object.keys(parseUploads(uploads))).toHaveLength(38);
      const noK = spawnSync(process.execPath, ['scripts/heldout-songs.mjs', 'list-v2', ...args], { encoding: 'utf8' });
      expect(noK.status).toBe(1);
      expect(noK.stderr).toContain('needs --eligible-k');
      const badK = spawnSync(process.execPath, ['scripts/heldout-songs.mjs', 'list-v2', '--eligible-k', '13.5', ...args], { encoding: 'utf8' });
      expect(badK.status).toBe(1);
      const short = spawnSync(process.execPath, ['scripts/heldout-songs.mjs', 'list-v2', '--eligible-k', '10', ...args], { encoding: 'utf8' });
      expect(short.status).toBe(1);
      expect(short.stderr).toContain('stop and ask the user');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
