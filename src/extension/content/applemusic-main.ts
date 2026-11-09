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
  play?: () => Promise<unknown> | unknown;
  pause?: () => Promise<unknown> | unknown;
  seekToTime?: (t: number) => Promise<unknown> | unknown;
  currentPlaybackTime?: number;
  currentPlaybackDuration?: number;
  isPlaying?: boolean;
  playbackRate?: number;
  nowPlayingItem?: MusicKitItem | null;
}

const w = window as unknown as { MusicKit?: { getInstance?: () => MusicKitInstance | undefined } };

// Count-in controls relayed from the isolated content script (public MusicKit API only).
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data as { __vibeGuitar?: string; seq?: number; action?: string; time?: number };
  if (d?.__vibeGuitar !== 'am-control') return;
  const reply = (ok: boolean, reason?: string): void =>
    window.postMessage({ __vibeGuitar: 'am-control-result', seq: d.seq, ok, reason }, location.origin);
  const mk = w.MusicKit?.getInstance?.();
  const fn = d.action === 'play' ? mk?.play : d.action === 'pause' ? mk?.pause : d.action === 'seek' ? mk?.seekToTime : undefined;
  if (!mk || !fn) return reply(false, 'unsupported on this player: MusicKit control not available');
  Promise.resolve(d.action === 'seek' ? fn.call(mk, Number(d.time ?? 0)) : (fn as () => unknown).call(mk))
    .then(() => reply(true))
    .catch((err: unknown) => reply(false, String(err)));
});

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
