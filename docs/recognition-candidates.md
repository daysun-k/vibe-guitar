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
vs frame). Those analyses are recorded below under "Baseline analyses" and may only reorder or gate
candidates that are not yet scored.

## Baseline analyses
(to be filled before the first candidate is scored)

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
