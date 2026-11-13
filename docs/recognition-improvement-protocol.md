# VGT-18 recognition improvement: experiment protocol

Fixed **before any candidate is scored** (2026-11-14). This file, `docs/recognition-dev-maps.json`
and the first version of `docs/recognition-candidates.md` are merged to `main` before the first
experiment result exists. After results: no change of metrics, thresholds, song sets, maps or the
test procedure. If a rule seems to need a change after results are seen, the user decides first.
Wording fixed while the tooling is built is recorded under "Recorded during implementation" with
its reason.

## Goal
Raise the real-song accuracy of the auto chord chart as far as this search can, by trying
candidates one at a time on DEV songs (hill climbing), then confirm the final candidate once on
TEST songs. Ship it to the extension only when that confirmation passes. Also record what helped,
what did not, and what limits remain.

## Song roles and data handling
- **DEV** (results already seen): the 23 songs in `docs/recognition-dev-maps.json` = the songs that
  `npm run eval-annotations` on main 1714f4f scores (status `scored`) from the official stored
  charts of `docs/annotation-eval-songs.json` (10) and `docs/annotation-eval-songs-heldout-v1.json`
  (13). 5 of them are Isophonics Beatles songs that BTC was probably trained on
  (`btcTraining: likely`); 18 are Billboard (`not-known`).
- **TEST**: the 18 songs with status `scored` in the official v2 result
  `~/Documents/paseo-briefings/2026-11-14-vibe-guitar-accuracy-heldout-v2.json`
  (sha256 `e76ce61f040c7ef8bea313db5ca50f8d5ab59e8dace2c2e31d24d8ceb6322e52`; list
  `docs/annotation-eval-songs-heldout-v2.json`, uploads `docs/annotation-heldout-v2-uploads.json`).
  TEST is never used for development: no per-song scores, errors, charts or alignment diagnostics
  are looked at, nothing is tuned or trained on it, and it is **recorded only after the loop ends**
  (see "Final confirmation").
- **Reserved**: pool ranks 93 and later (same order as v1/v2) stay untouched. Using them for anything,
  including training, is the user's decision.
- **Audio**: PCM captured from the browser tab is stored only on this Mac, outside the repository
  (`~/vgt18-audio/dev`, later `~/vgt18-audio/test`), never committed, never sent off the machine, and
  deleted when the campaign ends. Charts and result JSON live in
  `~/Documents/paseo-briefings/vibe-guitar-recognition-improvement/`.

## Frozen inputs
For every song and every comparison the following are fixed and identical in both arms:
1. the stored PCM and its segment boundaries (one capture per song; the capture used is recorded);
2. the time map (`offsetSec`, `rate`) and `mediaDurationSec`: DEV from
   `docs/recognition-dev-maps.json`, TEST from the official v2 result file above. Maps are never
   re-fitted on new recordings or candidate charts, and never chosen by candidate scores;
3. the annotation files (the evaluator's own loading; annotation beats, never chart beats, go to
   `scoreSong`);
4. the scored song set (DEV = the 23 songs of the maps file; TEST = the 18);
5. coverage and evaluated seconds: the scorer fails if the two arms differ in coverage or in
   evaluated seconds for majmin, root or sevenths.

Scoring is the unchanged `scoreSong` of `src/eval/annotations.ts` with the frozen map. Nothing in
alignment or WCSR scoring changes.

## Replay path and reproduction (before any candidate)
Tooling: `docs/recognition-replay.md` (dump build, local receiver, `replay-audio`, `replay-parity`,
`paired-eval`).
- **R1 identity (gate).** For every DEV capture, the offline replay of the stored segments with the
  current recognizer must reproduce the live chart saved in the same capture: identical coverage,
  identical event chords, event start times identical after rounding to 1 ms, beats and downbeats
  identical after rounding to 1 ms. Confidence differences are reported separately. If R1 fails, the
  replay path is fixed first; if the cause is a backend numeric difference (Node CPU vs the browser's
  WebGPU/WASM), acceptance runs move to a browser-backend replay that passes R1. Tolerances are not
  widened.
- **R2 drift check.** The replayed baseline charts are scored with the frozen DEV maps and compared
  with `officialChartScore` (the official charts, same evaluator). Expected: song-mean majmin within
  1.0 point and every song within 5 points. This compares two different captures, so it is a
  capture-drift diagnostic, not an identity test. A song is never re-captured to make scores match.
  If R2 is not met after the cause is investigated and recorded, stop and ask the user.
- **Capture failures.** A song whose capture saved no chart or covers less than 90% of the upload
  length is retried up to 2 more times before any candidate is scored. The DEV set stays the 23
  songs: if any song still fails after the retries, or fails R1, the campaign stops and the user
  decides before any candidate is scored. No song is dropped by rule. The counts (listed, captured,
  R1-passed, scored) are reported.
- Unchanged-aligner diagnostic: the evaluator's own alignment on each replayed baseline chart is
  reported next to the frozen map (offset difference, exclusion code). It never changes the map or
  the song set.

## Metrics
Percentage points (pp) on a 0-100 scale; song mean = unweighted mean over songs.
- **Primary:** song-mean majmin WCSR over DEV (TEST at the end).
- **Secondary (must not get worse):** song-mean root WCSR and song-mean sevenths WCSR on DEV; the
  synthetic benchmark (`npm run bench`, Node) WCSR majmin, root and sevenths. "Not worse" = not
  lower when both values are rounded to one decimal place.
- **Flicker guard:** song-mean boundary precision (one-to-one matching of chord-change times within
  +-250 ms against the time-mapped annotation, majmin labels) not lower by more than 2.0 pp.
- **Diagnostics (reported, not gates):** boundary recall and F, predicted vs annotated change counts,
  per-song deltas, the error anatomy (exact, fifth-related root, parallel, relative, semitone, N).

## Candidates and settings
`docs/recognition-candidates.md` lists the candidates in a fixed priority order with the DEV
evidence, expected effect, cost and **at most 5 settings** each. A candidate's settings and code are
committed before that candidate is scored (the commit sha is recorded with the result). Analyses of
the baseline alone (error anatomy, oracle bounds on cached probabilities) are allowed before or
during the loop and are recorded; they are not candidate scores. They never change the order; they
only apply the gate written in a candidate's entry (a gated candidate whose gate fails is skipped in
that pass, recorded, and does not count as a scored setting).

## Promotion rule (DEV, per candidate)
Compare each setting with the current incumbent on DEV, paired per song. A setting is **eligible**
when all hold:
- P1 mean majmin delta >= +0.50 pp;
- P2 the paired percentile bootstrap 95% interval of the mean delta (10 000 resamples over songs,
  mulberry32 seed 7007) has its 2.5th percentile > 0;
- P3 mean delta on the Billboard subset (`btcTraining: not-known`) > 0;
- P4 leave-one-song-out: the mean delta stays > 0 whichever single song is removed;
- P5 the secondary and flicker guards hold, and coverage/evaluated seconds are identical;
- P6 resource limits hold (below), or the user approved the increase.
Among eligible settings of one candidate the one with the largest mean delta is promoted and becomes
the incumbent. These promotions are **provisional engineering choices**: P2 describes noise across
these 23 songs but is not adjusted for the repeated, adaptive search, so the evidence that the final
result is not chance comes from the one-shot TEST confirmation.

## Stop-and-ask alarms
Applied to a setting that would otherwise be promoted (it is not promoted until the user decides):
- any predeclared group has a negative mean majmin delta (below -0.05 pp, i.e. lower at one decimal)
  either against the current incumbent or against the original baseline (main 1714f4f defaults),
  so losses cannot accumulate across promotions unseen; groups are `dataset:isophonics-btc-overlap`
  (5), `dataset:billboard` (18), `complexity:simple` (6), `complexity:moderate` (8),
  `complexity:complex` (9) (the `complexity` field of the song lists, fixed before this campaign);
- any single DEV song loses >= 10 pp against the incumbent or the original baseline (losses of
  5-10 pp are recorded with a diagnosis);
- a resource limit is exceeded. Baselines are measured on this Mac before the first candidate:
  packaged bytes of `dist/`, end-of-song analysis time of a replayed 4-minute song, peak resident
  memory of the replay process, and (for candidates that touch the live path) the live "인식 중"
  latency. Limits: packaged bytes +10%, analysis time +50% and at least +1 s, peak memory +20%,
  live latency +100 ms. Adding `btc_majmin.onnx` (about 6.4 MB) exceeds the size limit by itself.
- direct training or fine-tuning (always asked first, with data, time and expected effect).

## Loop order and stopping
1. Evaluate the candidates in the documented order against the incumbent.
2. After a promotion, start again from the top of the list of not-yet-promoted candidates (rejected
   ones included, since the incumbent changed).
3. Stop when one complete pass over the remaining candidates promotes nothing (**converged**), or after
   **50 scored settings** in total (**budget stop** = search incomplete, reported as such). Every
   scored setting counts, including rejected and failed ones; the counter never resets. After a
   budget stop the user decides whether to continue or to go to the final confirmation; TEST is not
   touched before that decision. If the loop converges with no promotion at all, there is no
   finalist: TEST is not recorded and the extension stays as it is.
4. New candidates may be appended only between passes, with written DEV evidence, before they are
   scored; they count toward the budget.
5. Each promotion is recorded in `docs/recognition-candidates.md` with before/after DEV song-mean
   majmin, root and sevenths, boundary F, the mean delta with its interval, the Billboard-subset delta
   and the smallest leave-one-out delta.

## Final confirmation on TEST (once)
1. Freeze the finalist: commit sha, config and model sha256 values. Build it into the extension on a
   branch and check on a few DEV songs in Aside that the live charts equal the offline finalist
   charts (R1 rule) before TEST is touched.
2. Capture the 18 TEST songs (official uploads, list order) with the dump build. Technical failures
   follow the capture-failure rule above. A missing song is never replaced; if any song is missing,
   the confirmation is **incomplete**: it is computed on the rest, reported, and shipping waits for
   the user.
3. Replay every TEST capture with the baseline (main 1714f4f defaults) and with the finalist; score
   both with the official v2 maps. Per-song majmin delta = finalist - baseline.
4. **Pass** iff the 2.5th percentile of the paired percentile bootstrap of the mean delta (18 songs,
   10 000 resamples, mulberry32 seed 7007) is > 0 and coverage/evaluated seconds are identical.
   **Ship** only if it passes AND the DEV secondary safeguards also hold on TEST: song-mean root and
   song-mean sevenths not lower (one decimal) and song-mean boundary precision not lower by more
   than 2.0 pp. Reported alongside: mean delta, song means of both arms, boundary recall and F, a
   Student t interval as sensitivity, and the unchanged-aligner diagnostic.
5. No second test, no switching to another finalist, no tuning after the result. A failure means
   insufficient evidence, not proof of no benefit. If the confirmation fails, or passes with a
   safeguard violated, the extension's default stays as it is, the attempt and limits are recorded,
   and the work stops for the user's decision.

Power note: with a paired song-delta SD of about 5 pp, 18 songs give about 80% power only for a true
mean gain of roughly 3 pp; smaller real gains will often fail this confirmation.

## Shipping (only after a pass)
The finalist becomes the default in a PR with `npm run bench`, `npm run typecheck`, `npm test` and
independent review; after merge `/Users/ds/GitHub/vibe-guitar/dist` is rebuilt, and live charts
captured in Aside on DEV songs must reproduce the offline finalist charts (R1 rule).

## Training and public weights
- Training or fine-tuning data never include DEV or TEST songs (or other recordings of the same
  compositions), nor reserved ranks 93+ unless the user decides so.
- Public weights are used only with a checkpoint-specific training list that excludes every TEST song
  (Billboard ids and other recordings of the same compositions). "Not known to overlap" is not
  enough. Licences are recorded.

## Recorded during implementation
- 2026-11-14, before any candidate result (follow-up F8 of the PR #34 review): every "not lower at
  one decimal" or "lower at one decimal" comparison in this protocol (secondary metrics, group
  alarms, TEST safeguards) compares the two values in percentage points after rounding each to one
  decimal place with `Math.round(10 * x) / 10`; equal rounded values are not lower. The group alarm's
  "below -0.05 pp" wording means this same comparison of the two rounded group means.
