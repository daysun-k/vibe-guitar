/**
 * Lyrics lookup with a per-recording cache in chrome.storage.local (runs in the service
 * worker, which has the lrclib.net host permission). Each recording is looked up once:
 * found and not-found results are cached; network errors are not, so a later visit retries.
 */
import type { Recording, RecordingSource } from '../chart/types';
import { LookupCancelled, RateLimited, cleanTrackQuery, lookupLyrics, type FetchLike, type LyricsQuery } from '../lyrics/lrclib';
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

export type LyricsReply =
  | { ok: true; entry: LyricsCacheEntry | null }
  | { ok: false; error: string; reason?: 'cancelled' | 'rate-limited' | 'error'; retryAt?: number };

/** Storage key of the 429 backoff (survives service-worker restarts). */
export const LYRICS_BLOCKED_KEY = 'lyrics-blocked-until';

/** Default wait after a 429 without Retry-After. */
export const RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

export class LyricsService {
  private inflight = new Map<string, { promise: Promise<LyricsReply>; abort: AbortController }>();
  /** No request to LRCLIB before this time (Date.now() ms) after a 429. */
  private blockedUntil = 0;

  /**
   * @param allowed reads the current "가사 가져오기" setting from storage; checked after the
   *   cache read and again right before every request, so a request never starts while it is off.
   */
  constructor(
    private readonly area: StorageArea,
    private readonly fetchFn: FetchLike,
    private readonly now: () => Date = () => new Date(),
    private readonly allowed: () => boolean | Promise<boolean> = () => true,
  ) {}

  /** The setting turned off: abort every lookup in flight (nothing is cached for them). */
  abortAll(): void {
    for (const { abort } of this.inflight.values()) abort.abort();
  }

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
    if (!(await this.allowed())) return { ok: true, entry: null }; // turned off while the cache was read
    const nowMs = this.now().getTime();
    if (!this.blockedUntil) {
      const b = Number((await this.area.get([LYRICS_BLOCKED_KEY]))[LYRICS_BLOCKED_KEY]);
      this.blockedUntil = Number.isFinite(b) && b > 0 ? b : 0;
    }
    if (nowMs < this.blockedUntil) return { ok: false, error: 'lrclib rate limited', reason: 'rate-limited', retryAt: this.blockedUntil };
    const key = lyricsKey(source, id);
    let cur = this.inflight.get(key);
    // A lookup aborted by turning the setting off is not joined: OFF→ON starts a fresh one.
    if (!cur || cur.abort.signal.aborted) {
      const abort = new AbortController();
      const promise: Promise<LyricsReply> = this.fetchAndStore(req, abort.signal).finally(() => {
        if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
      });
      cur = { promise, abort };
      this.inflight.set(key, cur);
    }
    return cur.promise;
  }

  private async fetchAndStore(req: LyricsRequest, signal: AbortSignal): Promise<LyricsReply> {
    const q = cleanTrackQuery(req.recording.title, req.recording.artist);
    try {
      const r = await lookupLyrics(q, req.durationSec, this.fetchFn, { signal, allowed: this.allowed });
      if (signal.aborted || !(await this.allowed())) throw new LookupCancelled();
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
      if (e instanceof LookupCancelled) return { ok: false, error: e.message, reason: 'cancelled' };
      if (e instanceof RateLimited) {
        this.blockedUntil = this.now().getTime() + (e.retryAfterSec ? e.retryAfterSec * 1000 : RATE_LIMIT_BACKOFF_MS);
        await this.area.set({ [LYRICS_BLOCKED_KEY]: this.blockedUntil }).catch(() => undefined);
        return { ok: false, error: e.message, reason: 'rate-limited', retryAt: this.blockedUntil };
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e), reason: 'error' };
    }
  }
}
