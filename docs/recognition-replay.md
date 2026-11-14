# Recognition replay: audio dump, offline replay, paired frozen-map comparison (dev only, VGT-18)

Candidate changes to the chord recognizer are tried on recorded real-song audio, offline, against the
unchanged evaluation method. Three tools:

| Step | What | Code |
| --- | --- | --- |
| Capture | A dev build of the extension POSTs, after each auto chart, the exact audio the analysis used plus the chart to a local receiver | `npm run build:audio-dump` (`scripts/build-config.mjs`, `src/extension/dump/`), `npm run audio-dump-receiver` |
| Replay | Feeds the stored audio through the same session/recognizer/chart code in Node and writes charts | `npm run replay-audio` (`src/replay/replay.ts`, `src/replay/node.ts`) |
| Parity | Checks that a default replay reproduces the live charts | `npm run replay-parity` (`src/replay/parity.ts`) |
| Compare | Scores a baseline and a candidate chart set with frozen time maps, paired per song | `npm run paired-eval` (`src/eval/paired.ts`) |

Audio stays on this Mac, outside the repository (the receiver refuses an output folder inside it), and is
deleted when the campaign ends. No audio, chart or result file is committed.

## How the dump build captures the analysed audio

`node scripts/build.mjs --audio-dump` writes a separate unpacked extension to `dist-dump/` (git-ignored),
named `… [audio dump, dev]`. It is the normal extension except that listen.ts's imports of
`recognize/session` and `recognize/autochart` are redirected (esbuild plugin, dump build only) to
`src/extension/dump/session-hook.ts` and `autochart-hook.ts`:

- `analyzeClosedSegments` is called with a cache wrapper that records each segment the function looks up.
  The function looks up every segment of its closed-segment snapshot once, in order, cached or not, so the
  recorded list is exactly the analysed snapshot (closed segments of at least 1 s). Closed segments never
  grow, so their audio is final.
- `buildAutoChart` returns the chart unchanged; when its input is the array that analysis returned, it
  schedules (after the current task, so after listen.ts has sent the `auto-chart` message) one POST to
  `http://127.0.0.1:8791/capture`: each segment's raw 22.05 kHz little-endian Float32 samples with its
  unrounded `startSec`, plus the recording key and metadata, session duration and coverage, the chart
  exactly as sent, the build commit (and whether the tree had local changes), the sha256 of the model
  files actually packaged into `dist-dump/models/` (hashed after the build copied them, not the
  manifest's expected values) and a capture time. A failed POST is caught and logged (`audio dump: POST failed`); the chart
  path never waits for it.

The default build defines `__AUDIO_DUMP__` false and does not bundle these modules at all, so `dist/` is
byte-identical to a build without the flag (compare `shasum -a 256` listings).

## Capture session

1. Build both: `npm run build` (keep `dist/`), then `npm run build:audio-dump`.
2. Back up the loaded extension folder, swap in the dump build, reload:
   `cp -R dist /tmp/vg-dist-backup && rm -rf dist && cp -R dist-dump dist`, then reload the extension
   (chrome://extensions → reload; in Aside the same unpacked folder). Loading `dist-dump/` directly as a
   second unpacked extension also works if the original is disabled.
3. Start the receiver (outside the repository):
   `npm run audio-dump-receiver -- --out ~/vg-captures/<campaign>`. It listens on 127.0.0.1 only, accepts
   chrome-extension origins (and local tools without an Origin), refuses web origins, and prints one line
   per saved capture: `saved <dir>: youtube:<id> "<title>", <n> segments, <s> s audio, <e> events, build …`.
4. Play the songs to the end in listening mode (or request a chart). Each auto chart produces
   `<out>/<youtubeId>/<captureId>/seg-<i>.f32` + `meta.json`. An existing capture folder is never
   overwritten; a new analysis of the same song is a new `captureId` (UTC time + random suffix).
5. Restore the normal build afterwards: `rm -rf dist && mv /tmp/vg-dist-backup dist`, reload. Check the
   extension name no longer ends in `[audio dump, dev]`.

## Replay

```
npm run replay-audio -- --audio ~/vg-captures/<campaign> --out /tmp/vg-replay/baseline
npm run replay-audio -- --audio ~/vg-captures/<campaign> --out /tmp/vg-replay/cand-a --config cand-a.json [--ids id1,id2]
```

For each song the latest capture is used (older ones are listed as skipped in the manifest). Replay
rebuilds a `ListeningSession` the way the placer fills it live: per stored segment, blocks the size of one
4096-frame capture block after resampling (1882 samples), positions continuing the segment, and per
250 ms tick `extractReady(48)` and one `precomputeBeatChunks`; `breakSegment` between segments. Then
`analyzeClosedSegments` with `Recognizer.analyzeSessionSegment` and `buildAutoChart`, as listen.ts does.
Features are deterministic per frame and cached beat chunks equal recomputed ones, so the tick pattern
cannot change the result; `tests/replay.test.ts` checks that a replayed session has the same segment
starts, audio, mel/CQT features and beat logits as a session filled with irregular live-like blocks.

Runtime: onnxruntime-node (CPU) with `models/` by default; `--runtime web` uses onnxruntime-web WASM in
Node (1 thread), closer to the browser. Output: `<out>/<youtubeId>.json` (the chart, the shape
`eval-annotations` and `paired-eval` read) and `<out>/replay-manifest.json` (config, git commit and
dirty flag, runtime, model sha256 values, per-song capture id, segments, audio seconds, timings). Replay
hashes the model files it loads and compares them with the hashes the capture recorded; every file whose
bytes differ, or that the capture does not name, is printed as a `WARNING` and listed in the manifest
(`modelMismatch`), because such a replay does not run the live model bytes.

`--config` is `{ "label"?: string, "recognizer": CandidateRecognizerOptions }`. Accepted:
`recognizer.vocabulary` (`full` | `simple` | `majmin`) and `recognizer.decode.changePenalty`
(three numbers: bar start, half bar, other beats; default `[2, 4, 6]`), which run the extension's own
`Recognizer`; and the VGT-18 candidate options of `docs/recognition-candidates.md`, which run
`CandidateRecognizer` (`src/recognize/candidate-recognizer.ts`, not bundled into the extension):
`decode.familyFirst: { penaltyScale }` (C1), `units: { halfBeat: true, offbeatExtraPenalty }` (U),
`emission: "durationWeighted" | "meanLog"` (E), `majmin: "familyDecide" | "average"` (C5; loads
`btc_majmin.onnx`, whose sha256 goes to the manifest's `candidateModels`), `nLogPrior` (C7),
`pitchShift: [semitones…]` (C6) and `keyPrior: { bonus, margin }` (C4: a second decode pass with the
key that `estimateKey` gives for the pass-1 chart; the manifest records it per song), `bassRoot: { margin }`
(C10) and `repetition: { k, weight }` (C8). Options combine;
unknown fields are errors. A new candidate option is added to `CandidateRecognizerOptions` in
`src/recognize/candidate-decode.ts` and to `parseReplayConfig` in `src/replay/replay.ts`.
`npm run bench -- --config <json>` runs the synthetic benchmark with the same options.

Baseline analyses (error anatomy, top-k family oracle, unit-grid ceilings, majmin-model
disagreement) of replayed captures under the frozen maps:

```
npm run baseline-analysis -- --audio ~/vg-captures/<campaign> --maps docs/recognition-dev-maps.json --annotations <dir> --out <result.json> [--config <json>] [--ids songId,…]
```

## Parity

```
npm run replay-parity -- --audio ~/vg-captures/<campaign> --charts /tmp/vg-replay/baseline
```

Compares each replayed chart with the live chart in `meta.json`: coverage identical; events identical
(chord and `startSec` after rounding to 1 ms); beat times, first downbeat (after 1 ms rounding), beats per
bar and bpm identical. The largest confidence difference is printed apart and never fails. Provenance is
ignored. Exit 1 on any mismatch, with the first differences per song. Run it on the default replay before
trusting any candidate comparison.

## Paired frozen-map comparison

```
npm run paired-eval -- --maps maps.json --annotations <annotations dir> \
  --baseline /tmp/vg-replay/baseline --candidate /tmp/vg-replay/cand-a \
  --subset-field btcTraining=not-known [--groups groups.json] [--songs <list.json>]… --out result.json
```

`maps.json` (written before any candidate is scored):

```
{ "schema": "vibe-guitar-paired-maps/1",
  "songs": [ { "id", "dataset", "youtubeId", "offsetSec", "rate", "mediaDurationSec", "btcTraining", "groups": [], "songList"? } ] }
```

The frozen recognition maps (`docs/recognition-dev-maps.json`, schema
`vibe-guitar-recognition-dev-maps/1`, and later `vibe-guitar-recognition-*-maps/1` sets) are accepted
as they are; extra fields are ignored.

Only map songs are read. Each song's annotation is found through a song list: the entry's `songList`
(repository-relative path) and only that list; for an entry without one, the `--songs` lists, or else the
two DEV lists `docs/annotation-eval-songs.json` and `docs/annotation-eval-songs-heldout-v1.json`. A
held-out TEST list such as `docs/annotation-eval-songs-heldout-v2.json` is read only when a maps entry or
`--songs` names it. The id must mean the same files in every list used and the dataset must match the
map. Annotations are parsed with the evaluator's `parseLab`/`parseBeats`. Both arms are scored with the
unchanged `scoreSong(segs, annotationBeats, chart, offsetSec, mediaDurationSec, 1, rate)`; a chart's own
beats are never used for the map. Baseline and candidate must have identical coverage and the same
evaluated seconds per metric (within 1e-6 s): otherwise the run stops with an error.

Per song: majmin, root and sevenths for both arms and the delta (candidate − baseline), and chord-change
diagnostics inside the region both the mapped annotation and the chart cover: changes of the
majmin-reduced label (a chord outside majmin keeps its own symbol), matched one-to-one within ±250 ms;
predicted and annotated change counts, precision, recall, F, and their deltas. Aggregates (all songs,
and the subset):
song means of each metric for both arms, mean deltas, a paired percentile bootstrap 95% interval of the
mean majmin delta (10 000 resamples over songs, mulberry32 seed 7007, `bootstrapMeanCi` from
`src/eval/song-mean.ts`), leave-one-song-out mean majmin deltas (min and max, with the song left out),
the worst single-song majmin delta, song-mean boundary precision, recall and F of both arms with their
paired deltas (over the songs where the rate is defined in both arms; the precision delta is the
protocol's flicker guard: not lower by more than 2.0 pp), and mean deltas per group (map `groups` plus `--groups`
`{ "<group>": [songId…] }`, whose ids must be in the maps). The result JSON (`--out`; non-finite numbers
written as null) and a short text summary in percentage points.

`--mask-unknown-boundaries` (opt-in; off by default, and without it the output is unchanged) leaves out of
the chord-change diagnostics the reference regions labelled `X` or with an unmapped label (the seconds
WCSR already leaves out), mapped to media time and widened by ±250 ms, so changes into or out of them and
chart changes inside them are not counted; the result records it as `inputs.maskUnknownBoundaries: true`
and the summary says so.

## Cleanup

After the campaign: delete the capture folder (`rm -rf ~/vg-captures/<campaign>`) and the replay charts,
restore `dist/` (above), and remove `dist-dump/` if you like (`rm -rf dist-dump`).
