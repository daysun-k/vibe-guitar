/**
 * YouTube / YouTube Music page (MAIN) world part.
 * - Practice speed (both sites): applies a rate request from the isolated content script
 *   through the page's own player (movie_player.setPlaybackRate), see ./yt-rate.ts.
 * - YouTube Music only: reports what the page's own player is playing
 *   (movie_player.getVideoData()) to the isolated content script, because the URL `v=`
 *   can name a different recording than the one playing.
 */
import { handleRateRequest, type PagePlayer } from './yt-rate';

interface VideoData {
  video_id?: string;
  title?: string;
  author?: string;
}
interface YtPlayer extends PagePlayer {
  getVideoData?: () => VideoData | undefined;
}

function players(): (YtPlayer | null)[] {
  return [document.getElementById('movie_player'), document.querySelector('.html5-video-player')] as unknown as (YtPlayer | null)[];
}

function readPlayer(): VideoData | null {
  for (const p of players()) {
    if (p && typeof p.getVideoData === 'function') {
      try {
        const d = p.getVideoData();
        if (d && d.video_id) return d;
      } catch {
        // player not ready
      }
    }
  }
  return null;
}

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const reply = handleRateRequest(e.data, () => players().find((p) => p && typeof p.setPlaybackRate === 'function') ?? null);
  if (reply) window.postMessage(reply, location.origin);
});

if (location.hostname === 'music.youtube.com') {
  setInterval(() => {
    const d = readPlayer();
    window.postMessage(
      {
        __vibeGuitar: 'yt-video-data',
        payload: d ? { videoId: String(d.video_id), title: String(d.title ?? ''), author: String(d.author ?? ''), sampledAt: Date.now() } : null,
      },
      location.origin,
    );
  }, 250);
}
