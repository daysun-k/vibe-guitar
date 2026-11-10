import type { Lyrics } from '../../lyrics/types';
import type { LyricsReply } from '../lyrics-service';

/**
 * When the side panel asks the service worker for lyrics: once per visit of a recording for
 * each (fetch on/off, duration known) state. A failed attempt (error, 429, cancelled) stays
 * recorded, so player updates never turn into a retry loop; a new visit asks again, and so
 * does an explicit OFF→ON change of the setting by the user (once).
 */
export class LyricsAsker {
  private recording = '';
  private asked = new Set<string>();
  private ticket = 0;

  shouldAsk(recordingKey: string, allowFetch: boolean, durationKnown: boolean): boolean {
    if (!recordingKey) return false;
    if (recordingKey !== this.recording) this.reset(recordingKey);
    const k = `${allowFetch ? 'fetch' : 'cache'}|${durationKnown ? 'd' : '-'}`;
    if (this.asked.has(k)) return false;
    this.asked.add(k);
    return true;
  }

  /**
   * The user turned "가사 가져오기" back on: forget this visit's fetch attempts so one fresh
   * lookup may go (an earlier one may have been cancelled by turning it off). Player updates
   * still never retry on their own; the service worker still honours an active 429 backoff.
   */
  fetchTurnedOn(recordingKey: string): void {
    if (!recordingKey || recordingKey !== this.recording) return;
    for (const k of [...this.asked]) if (k.startsWith('fetch|')) this.asked.delete(k);
  }

  /** A new visit (recording change, tab switch): ask again once. */
  reset(recordingKey = ''): void {
    this.recording = recordingKey;
    this.asked.clear();
  }

  /** Numbers each request; a reply whose number is no longer the latest is stale. */
  begin(): number {
    return ++this.ticket;
  }

  isLatest(ticket: number): boolean {
    return ticket === this.ticket;
  }
}

/**
 * What a lyrics reply means for the panel: the lyrics to show (undefined = keep the current
 * ones) and the status line.
 */
export function lyricsOutcome(reply: LyricsReply | undefined, fetchOn: boolean): { lyrics?: Lyrics | null; note: string } {
  if (!reply || !reply.ok) {
    // The attempt stays recorded for this visit: no retry on every player update (429 included);
    // the next visit, a recording change or turning the setting back on asks again, and the
    // service worker honours its backoff.
    if (reply && !reply.ok && reply.reason === 'rate-limited') return { note: 'LRCLIB 요청이 많아 잠시 쉬어요. 나중에 이 곡을 다시 열면 가져와요.' };
    if (reply && !reply.ok && reply.reason === 'cancelled') return { note: '가사 가져오기를 껐어요.' };
    return { note: `가사를 가져오지 못했어요${reply && !reply.ok ? ` (${reply.error})` : ''}. 다음에 이 곡을 열 때 다시 시도해요.` };
  }
  const e = reply.entry;
  if (e?.result === 'found' && e.lyrics) {
    return { lyrics: e.lyrics, note: `가사: LRCLIB ${e.lyrics.kind === 'words' ? '단어 단위' : '줄 단위'} (${e.query.artist} – ${e.query.track})` };
  }
  if (e?.result === 'not-found') return { lyrics: null, note: `가사: LRCLIB에서 찾지 못했어요 (${e.query.artist} – ${e.query.track})` };
  return { note: fetchOn ? '' : '가사 가져오기가 꺼져 있어요.' };
}

/**
 * Whether the player state can be used for a lyrics lookup right now. During an ad the
 * video element reports the ad's duration under the song's recording id, and a lookup with
 * that duration would cache "not found" for the song. Skipping here marks nothing, so the
 * lookup simply happens once the song itself plays. Short songs are real songs: only the
 * ad flag is used, never a duration threshold.
 */
export function lyricsLookupReady(p: { isAd?: boolean; duration?: number } | null | undefined): boolean {
  return !!p && !p.isAd;
}
