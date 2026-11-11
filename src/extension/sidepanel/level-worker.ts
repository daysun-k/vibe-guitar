/**
 * Dedicated worker that estimates every non-current level's shape suitability (play/level-fit.ts),
 * so arranging three more levels never blocks the side panel's playback display.
 * Everything stays inside the browser: no network.
 */
import { computeLevelFits, type LevelFitWorkerRequest, type LevelFitWorkerResponse } from '../../play/level-fit';

function reply(r: LevelFitWorkerResponse): void {
  (self as unknown as Worker).postMessage(r);
}

self.addEventListener('message', (e: MessageEvent<LevelFitWorkerRequest>) => {
  const { id, levels, ...input } = e.data;
  const t0 = performance.now();
  try {
    const results = computeLevelFits(input, levels);
    reply({ id, ok: true, results, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
