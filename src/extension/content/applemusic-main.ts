/**
 * EXPERIMENTAL Apple Music adapter, page (MAIN) world part.
 * Reads MusicKit JS state if the page exposes it and posts it to the isolated-world
 * content script. Uses an unofficial path; it may break at any time.
 */

interface MusicKitItem {
  id?: string;
  title?: string;
  artistName?: string;
  attributes?: { name?: string; artistName?: string };
}
interface MusicKitInstance {
  currentPlaybackTime?: number;
  currentPlaybackDuration?: number;
  isPlaying?: boolean;
  playbackRate?: number;
  nowPlayingItem?: MusicKitItem | null;
}

const w = window as unknown as { MusicKit?: { getInstance?: () => MusicKitInstance | undefined } };

setInterval(() => {
  let payload: Record<string, unknown> | null = null;
  try {
    const mk = w.MusicKit?.getInstance?.();
    if (mk) {
      const item = mk.nowPlayingItem ?? null;
      payload = {
        via: 'musickit',
        currentTime: Number(mk.currentPlaybackTime ?? 0),
        duration: Number(mk.currentPlaybackDuration ?? 0),
        paused: !mk.isPlaying,
        playbackRate: Number(mk.playbackRate ?? 1) || 1,
        id: item?.id ?? null,
        title: item?.title ?? item?.attributes?.name ?? '',
        artist: item?.artistName ?? item?.attributes?.artistName ?? '',
      };
    }
  } catch (e) {
    payload = { via: 'musickit-error', error: String(e) };
  }
  window.postMessage({ __vibeGuitar: 'am-state', payload, sampledAt: Date.now() }, location.origin);
}, 250);
