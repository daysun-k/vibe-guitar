/** Set by scripts/build.mjs: true only in the dev latency-probe build (--latency-probe). */
declare const __LATENCY_PROBE__: boolean;
/** Set by scripts/build.mjs: true only in the dev audio dump build (--audio-dump, docs/recognition-replay.md). */
declare const __AUDIO_DUMP__: boolean;
/** Set by scripts/build.mjs: build commit and packaged model sha256 values in the --audio-dump build, null otherwise. */
declare const __AUDIO_DUMP_INFO__: { commit: string; dirty: boolean; models: Record<string, string> } | null;
