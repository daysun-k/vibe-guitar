# VGT-18 recognition candidates

Candidate review for `docs/recognition-improvement-protocol.md`. Order = evaluation order. Each
candidate lists its DEV evidence, expected effect, cost, and its settings (at most 5), fixed before
it is scored. Expected effects are planning guesses, not forecasts; gains are not additive and every
candidate can make things worse. Results and decisions are filled in as the loop runs.

## Evidence so far (DEV only, exploratory)
From the post-result diagnostics of the first held-out batch (13-14 Billboard DEV songs, share of
annotated time): exact 79.6%, fifth-related root 7.0%, other 4.8%, parallel major/minor 3.5%, relative
2.2%, semitone 0.7%, auto chart N 0.7%. Auto charts have fewer chord changes than the annotations in
most songs (e.g. 97 vs 172, 60 vs 114 events), i.e. under-segmentation. No tuning offset effect was
found (transposed overlaps low, semitone errors about 1%). Error types recorded in VGT-18: rap or
spoken sections recognised as no chord, riff-based songs with major/minor confusion (one song: root
right about 72% of the time but 38% parallel errors), and fifth-related root errors.
DEV baseline from the official charts (current evaluator, 23 songs): song-mean majmin 81.3%, root
83.5%, sevenths 69.9%; Billboard 18 songs 80.1%, Beatles 5 songs 85.7%.
Before the loop, the replayed DEV baseline adds: the error anatomy per song, BTC top-k oracle
bounds per beat unit, false-N vs reference-N time, and unit-grid oracle ceilings (beat vs half-beat
vs frame). Those analyses are recorded below under "Baseline analyses"; they never change the order
and only apply the gates written in the candidate entries.

## Baseline analyses
Replay reproduction on the new DEV recording (2026-11-14; 23/23 songs captured with the dump build at
9cd43e1, one capture each, no failures):
- R1 identity (main 1513b58 replay vs the live chart of the same capture): 23/23 identical (max
  confidence difference 0.000).
- R2 drift (replayed baseline vs `officialChartScore`, frozen maps): song-mean majmin 81.01 vs 81.28
  (-0.27, limit 1.0: met); one song above the 5-point per-song limit, `billboard-0879-run-d-m-c-walk-this-way`
  +6.29. Investigated: not alignment (the unchanged aligner picks an offset within 60 ms of the frozen map),
  not replay (R1 identical); the chart content differs between the official and the new capture (60 vs 53
  events, 87.6% time agreement, flips on ambiguous passages), i.e. capture-to-capture variability. The
  user chose to proceed with the new recording: "새 녹음으로 진행 (Recommended)". Maps stay frozen.

Baseline analysis (`npm run baseline-analysis`, main defaults, commit 68cdf50, 23 DEV songs, song means;
`baseline-analysis.json` in the briefing folder):
- Error anatomy (share of evaluated majmin time): exact 81.0%, fifth-related root 6.9%, other 4.4%,
  parallel 2.9%, relative 2.6%, semitone root 0.7%, auto chord where the reference is N 0.96%, false N
  (auto N where the reference has a chord) 0.51%.
- BTC top-k family oracle per beat unit (C1 family classes): reference family top-1 81.4%, within top-2
  91.5%, within top-3 94.7%.
- Unit-grid oracle ceilings (majority reference label per unit): beat units 97.90, half-beat units 98.12
  (+0.22 pp), frame units 99.06.
- btc_majmin vs the large model (per beat unit, 25 majmin families): the family argmax differs in 9.2%
  of units (8.8% of evaluated time); per-unit argmax majmin WCSR large 81.43, majmin model 80.91, oracle
  picking whichever matches 84.56 (+3.13 pp over the large model).
- Gates: U skipped (half-beat ceiling +0.22 pp < 1 pp); C7 skipped (false N 0.51% < 1%); C5 gate passed
  (oracle +3.13 pp >= 1 pp).

## Candidates

### C2 Weaker chord-change penalties
- Evidence: under-segmentation (fewer changes than annotated); the decoder pays 2/4/6 log-probability
  units per change at bar start/half bar/other beats, against one averaged log-probability per beat.
- Expected: 0 to +3 pp majmin; risk of flicker (guarded by boundary precision).
- Cost: none at runtime.
- Settings: `changePenalty` [1.5, 3, 4.5]; [1, 2, 3]; [0.5, 1, 1.5]; [0, 0, 0].

### C1 Family-first decoding
- Evidence: the simple vocabulary splits probability across qualities of the same root (C, C7, Cmaj7;
  Cm, Cm7), so a split family can lose to a single wrong class in the Viterbi.
- Method: decode over families (root x {major family: maj, 7, maj7; minor family: min, m7}; sus2,
  sus4, dim, aug, m7b5 and N stay separate classes) with summed probabilities, then choose the quality
  inside each decoded segment by the highest mean probability among that family's members. The
  evaluator's majmin reduction is not changed and non-major/minor qualities are not coerced.
- Expected: 0 to +2 pp. Cost: negligible.
- Settings: family decoding as above; the same with the incumbent's penalties scaled by 1.25
  (fewer classes change the effective competition).

### U Finer decoding units
- Evidence: chord changes that fall between beats are forced onto beat boundaries.
- Gate: pursue only if the baseline unit-grid oracle ceiling rises by at least 1 pp from beat units to
  half-beat units.
- Expected: 0 to +2 pp. Cost: about twice the decode units, negligible time.
- Settings: half-beat units with the off-beat half penalty = other-beat penalty + 2; + 4.

### E Duration-aware emissions
- Evidence: each unit contributes log(mean probability) once regardless of its length, so long and
  short beats weigh the same.
- Expected: 0 to +2 pp. Cost: none.
- Settings: emission weight proportional to unit length (normalised to the median beat); mean of
  frame log-probabilities instead of log of the mean.

### C5 BTC major/minor model
- Evidence: `btc_majmin.onnx` is trained for the primary metric's vocabulary; it already scores the
  same as the large model on synthetic audio (97.05%).
- Gate: measure on the baseline how often the two models disagree and an oracle that picks the right
  one per unit; skip if that oracle gains less than 1 pp.
- Expected: 0 to +2 pp. Cost: +6.4 MB packaged model (exceeds the size limit: the user is asked
  before promotion), about double BTC time (BTC is about 0.003 real-time factor).
- Settings: majmin model decides root and major/minor family, large model picks the quality; average
  of the two models' family probabilities.

### C7 No-chord handling
- Evidence: rap and spoken sections become N in the chart; DEV auto N is 0.7% of time on scored songs.
- Gate: pursue only if replayed DEV false-N time (auto N where the reference has a chord) is at least
  1% of annotated time.
- Expected: 0 to +1 pp. Cost: none.
- Settings: log-prior on N of -1; -2.

### C6 Pitch-shift averaging
- Evidence: fifth-related and parallel errors may be partly unstable predictions.
- Method: shift the log-CQT by +-2 bins (one semitone) with edge padding, never circular, run BTC,
  rotate chord roots back, keep N, average with the unshifted probabilities.
- Expected: 0 to +1.5 pp. Cost: 3x BTC time (still small).
- Settings: shifts {-1, +1} semitone; {-2, -1, +1, +2}.

### C4 Key-aware prior
- Evidence: parallel major/minor and "other" errors; most songs stay mostly in one key.
- Method: global key from `src/music/key.ts`; prior only where the posterior is ambiguous (top-2
  within a margin).
- Risk: modulations and blues (guarded by the group alarms).
- Settings: diatonic bonus 0.5 or 1.0 log units, applied only when top-2 probabilities are within 0.15.

### Later candidates (scored only if the list above converges; settings fixed when appended)
- C10 bass-aware root correction for fifth-related errors (bass is not always the root; gated by
  ambiguity).
- C3 median smoothing of frame probabilities (deprioritised: likely to worsen under-segmentation).
- C8 repetition-based smoothing (average probabilities over repeated sections).
- C9 harmonic-percussive separation before the CQT (feature cost).
- C11 another public chord model runnable in the browser: only with a checkpoint-specific training
  list that excludes every TEST song, and a recorded licence.
- C12 fine-tuning on this Mac: asked first (data, time, expected effect).
- A tuning-mismatch candidate only if the baseline analyses show detuning errors (earlier diagnostics
  found none).

## Results log
(one entry per scored setting: date, commit, setting, DEV deltas, eligibility, decision)

Pass 1, incumbent = main defaults (`{"recognizer":{}}`), charts replayed on the new DEV recording;
`npm run candidate-step` (deltas in pp: mean majmin delta [2.5th pct of the paired bootstrap],
Billboard-subset delta, smallest leave-one-out delta, boundary precision delta):
- 2026-11-14, da21561, c2-1.5-3-4.5: +1.02 [+0.04], Billboard +1.16, min LOO +0.50, precision -2.21; not eligible (P5 flicker); rejected.
- 2026-11-14, da21561, c2-1-2-3: +1.49 [+0.01], Billboard +1.71, min LOO +0.71, precision -4.23; not eligible (P5 flicker); rejected.
- 2026-11-14, da21561, c2-0.5-1-1.5: +1.48 [-0.39], Billboard +1.71, min LOO +0.62, precision -8.94; not eligible (P2, P5; group alarm complexity:moderate); rejected.
- 2026-11-14, da21561, c2-0-0-0: +0.25 [-1.91], Billboard +0.32, min LOO -0.57, precision -19.46; not eligible (P1, P2, P4, P5; group alarm complexity:moderate); rejected.
- 2026-11-14, da21561, c1-scale1: +0.41 [-0.04], Billboard +0.42, min LOO +0.25, precision -0.33; not eligible (P1, P2); rejected.
- 2026-11-14, da21561, c1-scale1.25: -0.37 [-1.01], Billboard -0.49, min LOO -0.51, precision +0.81; not eligible (P1-P5; group alarms billboard, simple, moderate); rejected.
- 2026-11-14, U: skipped by its gate (half-beat ceiling 98.12 vs beat 97.90, +0.22 pp < 1 pp); not scored.
- 2026-11-14, da21561, e-durationWeighted: -0.02 [-0.17], Billboard -0.04, min LOO -0.04, precision +0.03; not eligible (P1-P5; group alarm complexity:simple); rejected.
- 2026-11-14, da21561, e-meanLog: +0.91 [+0.25], Billboard +0.95, min LOO +0.65, precision -0.28; eligible, no alarm; promoted.
- 2026-11-14, C7: skipped by its gate (false N 0.51% < 1%); not scored.
- Pass 1 stopped after E (eligible setting); C5, C6, C4 not run in pass 1. Scored settings: 8 of 50.

**Promotion 1: e-meanLog** (`{"recognizer":{"emission":"meanLog"}}`, commit da21561). DEV song means
before -> after: majmin 81.0 -> 81.9, root 83.1 -> 83.9, sevenths 69.1 -> 70.1, boundary F 74.1 -> 76.0
(precision 86.9 -> 86.6, recall 66.9 -> 69.5). Mean majmin delta +0.91 pp, 95% paired bootstrap
[+0.25, +1.71]; Billboard-subset delta +0.95; smallest leave-one-out delta +0.65 (without
pilot-talking-heads-and-she-was). All five groups not lower; no song loss >= 5 pp; resources within limits.

Pass 2, incumbent = inc1-meanLog (`{"recognizer":{"emission":"meanLog"}}`), charts of e-meanLog; alarms
against the incumbent and the original baseline:
- 2026-11-14, da21561, c2-1.5-3-4.5: +0.52 [-0.24], Billboard +0.58, min LOO +0.12, precision -2.08; not eligible (P2, P5); group alarm moderate; rejected.
- 2026-11-14, da21561, c2-1-2-3: +0.83 [-0.33], Billboard +0.93, min LOO +0.28, precision -4.49; not eligible (P2, P5); group alarm moderate; rejected.
- 2026-11-14, da21561, c2-0.5-1-1.5: +0.66 [-0.72], Billboard +0.88, min LOO +0.09, precision -9.46; not eligible (P2, P5); group alarm isophonics-btc-overlap, moderate; rejected.
- 2026-11-14, da21561, c2-0-0-0: -0.58 [-2.29], Billboard -0.56, min LOO -1.14, precision -19.32; not eligible (P1, P2, P3, P4, P5); group alarm billboard, complex, isophonics-btc-overlap, moderate; 4 songs lose 5-10 pp; rejected.
- 2026-11-14, da21561, c1-scale1: +0.29 [-0.15], Billboard +0.26, min LOO +0.10, precision -0.25; not eligible (P1, P2, P5); rejected.
- 2026-11-14, da21561, c1-scale1.25: -0.74 [-1.73], Billboard -0.83, min LOO -0.93, precision +0.60; not eligible (P1, P2, P3, P4, P5); group alarm billboard, complex, isophonics-btc-overlap, moderate, simple; 1 song loses 5-10 pp; rejected.
- 2026-11-14, U: skipped by its gate (same record as pass 1); not scored.
- 2026-11-14, da21561, c5-familyDecide: +0.27 [-1.49], Billboard -0.24, min LOO -0.11, precision -0.58; not eligible (P1, P2, P3, P4, P6); group alarm billboard, complex, moderate; song loss >= 10 pp billboard-0879-run-d-m-c-walk-this-way; rejected.
- 2026-11-14, da21561, c5-average: +0.74 [-0.43], Billboard +0.27, min LOO +0.38, precision +0.95; not eligible (P2, P6); group alarm complex; rejected.
- 2026-11-14, C7: skipped by its gate (same record as pass 1); not scored.
- 2026-11-14, da21561, c6-shift-1: +1.50 [+0.58], Billboard +1.54, min LOO +1.28, precision +1.55; eligible, no alarm; promoted.
- 2026-11-14, da21561, c6-shift-2: +1.25 [+0.08], Billboard +1.02, min LOO +0.96, precision +1.83; eligible, no alarm; not promoted (smaller mean delta than c6-shift-1).
- Pass 2 stopped after C6 (eligible settings); C4 not run in pass 2. Scored settings: 18 of 50.

**Promotion 2: c6-shift-1** (`{"recognizer":{"emission":"meanLog","pitchShift":[-1,1]}}`, commit da21561;
largest mean delta among C6's eligible settings). DEV song means before -> after: majmin 81.9 -> 83.4,
root 83.9 -> 85.5, sevenths 70.1 -> 71.3, boundary F 76.0 -> 76.7 (precision 86.6 -> 88.1, recall
69.5 -> 69.8). Mean majmin delta +1.50 pp, 95% paired bootstrap [+0.58, +2.38]; Billboard-subset delta
+1.54; smallest leave-one-out delta +1.28 (without billboard-0891-the-who-happy-jack). No group lower
against the incumbent or the original baseline; worst song -4.56 pp (iron butterfly); resources within
limits. Cumulative against the original baseline (main defaults): +2.41 pp mean majmin (81.0 -> 83.4).
