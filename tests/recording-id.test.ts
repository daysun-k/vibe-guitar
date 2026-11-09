import { describe, expect, it } from 'vitest';
import { chooseRecordingId, PLAYER_DATA_MAX_AGE_MS, type RecordingIdChoice } from '../src/extension/content/recording-id';

const NOW = 1_000_000;
const player = (videoId: string, ageMs = 100) => ({ videoId, title: 'Perfect Duet', author: 'Ed Sheeran', sampledAt: NOW - ageMs });
const base = { urlId: null, playerBarId: null, player: null, isAd: false, previous: null, now: NOW };

describe('chooseRecordingId (YouTube Music plays a different recording than the URL)', () => {
  it('prefers the id the player is actually playing and flags the URL mismatch', () => {
    const c = chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('817P8W8-mGE') });
    expect(c).toEqual({ id: '817P8W8-mGE', source: 'player', urlIdMismatch: 'iKzRIweSBLA', title: 'Perfect Duet', artist: 'Ed Sheeran' });
  });

  it('reports no mismatch when player and URL agree', () => {
    const c = chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('iKzRIweSBLA') });
    expect(c?.source).toBe('player');
    expect(c?.urlIdMismatch).toBeUndefined();
  });

  it('falls back to the URL id (flagged as url) when player data is stale', () => {
    const c = chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('817P8W8-mGE', PLAYER_DATA_MAX_AGE_MS + 1) });
    expect(c).toEqual({ id: 'iKzRIweSBLA', source: 'url' });
  });

  it('falls back to the URL id when the player id is malformed or missing', () => {
    expect(chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('not an id') })).toEqual({ id: 'iKzRIweSBLA', source: 'url' });
    expect(chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA' })).toEqual({ id: 'iKzRIweSBLA', source: 'url' });
  });

  it('uses the player bar link when there is neither player data nor a URL id', () => {
    expect(chooseRecordingId({ ...base, playerBarId: 'abcdefghijk' })).toEqual({ id: 'abcdefghijk', source: 'player-bar' });
    expect(chooseRecordingId(base)).toBeNull();
  });

  it('keeps the previous song during an ad instead of the ad video id', () => {
    const previous: RecordingIdChoice = { id: '817P8W8-mGE', source: 'player' };
    const c = chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('ADVIDEO0001'), isAd: true, previous });
    expect(c).toBe(previous);
  });

  it('does not trust player data during an ad when nothing was chosen before', () => {
    const c = chooseRecordingId({ ...base, urlId: 'iKzRIweSBLA', player: player('ADVIDEO0001'), isAd: true });
    expect(c).toEqual({ id: 'iKzRIweSBLA', source: 'url' });
  });
});
