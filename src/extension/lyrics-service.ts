/**
 * Lyrics lookup with a per-recording cache in chrome.storage.local (runs in the service
 * worker, which has the lrclib.net host permission). Each recording is looked up once:
 * found and not-found results are cached; network errors are not, so a later visit retries.
 */
import type { Recording, RecordingSource } from '../chart/types';
import { cleanTrackQuery, lookupLyrics, type FetchLike, type LyricsQuery } from '../lyrics/lrclib';
import type { Lyrics } from '../lyrics/types';
import type { StorageArea } from './storage';

export interface LyricsCacheEntry {
  v: 1;
  fetchedAt: string;
  query: LyricsQuery & { durationSec: number };
  result: 'found' | 'not-found';
  lyrics?: Lyrics;
  via?: 'get' | 'search';
  lrclibId?: number;
}

export function lyricsKey(source: RecordingSource, id: string): string {
  return `lyrics:${source}:${id}`;
}

/** YouTube and YouTube Music share video ids. */
function lookupKeys(source: RecordingSource, id: string): string[] {
  const keys = [lyricsKey(source, id)];
  if (source === 'youtube') keys.push(lyricsKey('ytmusic', id));
  if (source === 'ytmusic') keys.push(lyricsKey('youtube', id));
  return keys;
}

export interface LyricsRequest {
  recording: Recording;
  durationSec: number;
  /** False: answer from the cache only (the "가사 가져오기" setting is off). */
  allowFetch: boolean;
}

export type LyricsReply = { ok: true; entry: LyricsCacheEntry | null } | { ok: false; error: string };

export class LyricsService {
  private inflight = new Map<string, Promise<LyricsReply>>();

  constructor(
    private readonly area: StorageArea,
    private readonly fetchFn: FetchLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async cached(source: RecordingSource, id: string): Promise<LyricsCacheEntry | null> {
    const keys = lookupKeys(source, id);
    const r = await this.area.get(keys);
    for (const k of keys) {
      const v = r[k] as LyricsCacheEntry | undefined;
      if (v && v.v === 1) return v;
    }
    return null;
  }

  async get(req: LyricsRequest): Promise<LyricsReply> {
    const { source, id } = req.recording;
    const hit = await this.cached(source, id);
    if (hit || !req.allowFetch) return { ok: true, entry: hit };
    if (!(req.durationSec > 0)) return { ok: true, entry: null }; // wait for the player to report a duration
    const key = lyricsKey(source, id);
    let p = this.inflight.get(key);
    if (!p) {
      p = this.fetchAndStore(req).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private async fetchAndStore(req: LyricsRequest): Promise<LyricsReply> {
    const q = cleanTrackQuery(req.recording.title, req.recording.artist);
    try {
      const r = await lookupLyrics(q, req.durationSec, this.fetchFn);
      const entry: LyricsCacheEntry = {
        v: 1,
        fetchedAt: this.now().toISOString(),
        query: { ...q, durationSec: Math.round(req.durationSec) },
        result: r.status,
        ...(r.status === 'found' ? { lyrics: r.lyrics, via: r.via, lrclibId: r.record.id } : {}),
      };
      await this.area.set({ [lyricsKey(req.recording.source, req.recording.id)]: entry });
      return { ok: true, entry };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
