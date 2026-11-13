/**
 * Manifest of the latency-probe build (scripts/build.mjs --latency-probe, output dist-probe/).
 * Adds only a content script for the local probe page on http://127.0.0.1 (any port);
 * permissions and host permissions stay as in the production manifest.
 */
export const PROBE_MATCH = 'http://127.0.0.1/*';
export const PROBE_CONTENT_SCRIPT = 'probe-content.js';

interface ManifestLike {
  name: string;
  content_scripts?: { matches?: string[]; js?: string[]; run_at?: string; world?: string }[];
  [k: string]: unknown;
}

export function latencyProbeManifest<M extends ManifestLike>(m: M): M {
  return {
    ...m,
    name: `${m.name} [latency probe, dev]`,
    content_scripts: [...(m.content_scripts ?? []), { matches: [PROBE_MATCH], js: [PROBE_CONTENT_SCRIPT], run_at: 'document_idle' }],
  };
}
