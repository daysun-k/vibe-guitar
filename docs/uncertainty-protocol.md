# VGT-19 uncertain-section flags: measurement protocol

Fixed **before any result** (2026-11-14). After results: no change of signals, flagged-share grid,
error classes, the criterion rule, song sets, maps or scoring. If a rule seems to need a change after
results are seen, the user decides first. Wording fixed while the tooling is built is recorded under
"Recorded during implementation" with its reason. A read-only advisor review of the draft (2026-11-14)
changed the threshold rule, the signal list, the alarms, the statistics and the K-pop check before this
version was fixed.

## Goal
The user plays along with the auto chart and cannot judge chords by ear. The chart's first choices stay
exactly as they are; the panel additionally marks the stretches where the recognizer is unsure and
offers its second choice there, replaceable in one action. This protocol decides, from real songs, which
signal marks those stretches and at which threshold, before the threshold is checked on songs that were
not used to choose it.

## Recognizer, songs and audio
- **Recognizer:** the shipped extension recognizer, `EXTENSION_RECOGNIZER_OPTIONS = { emission: 'meanLog',
  pitchShift: [-1, 1] }`; offline replay uses `--config` `{"recognizer":{"emission":"meanLog","pitchShift":[-1,1]}}`.
  The first-choice chart (events, confidences, beats, coverage) is never changed by this work.
- **DEV** (used to choose): the 23 songs and frozen maps of `docs/recognition-dev-maps.json`.
- **TEST** (checked once, after the freeze): the 18 TEST songs of VGT-18 with their frozen maps
  (`~/Documents/paseo-briefings/vibe-guitar-recognition-improvement/test/test-maps.json`, the official v2
  maps), annotations through `docs/annotation-eval-songs-heldout-v2.json`. These songs already served
  VGT-18's confirmation and VGT-21's reference check; here they are held out from **this threshold
  selection** only.
- **K-pop** (reference only, after the freeze): the 12 eval songs of `docs/kpop-eval-songs.json` with the
  frozen chord-order references of VGT-21 (manifest `~/vgt-kpop-eval/gt/sequence/manifest-vgt21-kpop-v1.json`,
  sha256 `fb685c699203b685ea272b92be757d5d7e2533d4be53cdd405265c7b629022c3`). Song list, references and
  scoring rules unchanged; reserves not used; nothing is tuned or trained on them.
- **Reserved:** pool ranks 93 and later stay untouched.
- **Audio:** every earlier capture was deleted, so all 53 songs are captured again in one sitting with
  the audio-dump build of main fd4203d (`docs/recognition-replay.md`), the official uploads, from the start
  at 1x. PCM stays on this Mac outside the repository (`~/vgt19-audio/`), is never committed or sent
  anywhere, and is deleted when the work ends. Charts and result JSON live in
  `~/Documents/paseo-briefings/vibe-guitar-uncertainty/`.
- **TEST and K-pop before the freeze:** only capture success (a chart was saved and covers at least 90% of
  the upload) and the mechanical R1 pass/fail are read. No chart content, flag, score or error of these
  songs is looked at until the criterion is frozen (below).

## R1 and capture failures
- **R1 (gate):** for every capture, the replay with the shipped config reproduces the live chart in the
  same capture (`npm run replay-parity`: coverage, chords, start times, beats and downbeats after 1 ms
  rounding) **and** every event confidence exactly as stored (S1 reads it). If R1 fails, the replay path is
  fixed first; tolerances are not widened.
- A capture with no chart or under 90% coverage is retried up to 2 more times. The DEV set stays 23 songs:
  if a DEV song still fails, the user decides before anything is measured. TEST or K-pop songs that still
  fail are reported and left out; a check with a missing song is reported as incomplete.
- The DEV majmin song mean of the new capture is reported for context (capture-to-capture drift of up to
  about 6 pp per song is known from VGT-18).

## Per-beat quantities
For each decode unit u (one beat, plus the stretch before the first beat) of each analysed segment, using
the reduced class probabilities the decoder used (pitch-shift averaged, `simple` vocabulary) over the
unit's frames (the frames `decodeUnits` assigns to the unit):
- **shown symbol** s(u): the decoded symbol, i.e. the chart's chord there;
- **family** of a symbol: the C1 family classes of `familyOf` (`src/recognize/candidate-decode.ts`): per
  root a major family {maj, 7, maj7} and a minor family {min, m7}; every other quality and N is its own
  family. A different quality of the same family is never offered as the second choice;
- **p_sym(u)**: linear mean probability of s(u) (the existing unit confidence);
- **p_fam(u)**: summed linear mean probability of the members of s(u)'s family;
- **alt family a(u)**: the family other than s(u)'s with the highest summed linear mean probability,
  **p_alt(u)**. Ties: the family listed first in the vocabulary's symbol order.

## Candidate signals (lower = less certain), in simplicity order
- **S1 event confidence:** the chart event's stored confidence (duration-weighted mean of p_sym over the
  event, rounded to 3 decimals by `buildAutoChart`); every unit of an event gets the event's value. The
  existing `UNCERTAIN_BELOW = 0.5` is one threshold of S1.
- **S2 symbol probability:** p_sym(u).
- **S3 family probability:** p_fam(u).
- **S4 family margin:** p_fam(u) − p_alt(u).
- **S5 log margin (decoder-aligned):** mean over the unit's frames of log(p_shown + 1e-9) minus the largest
  such mean over the symbols outside the shown family (the same per-unit evidence the meanLog decoder uses;
  it can expose a chord the change penalty held on).

## Thresholds
For a signal and a nominal share f, **θ_f** is the threshold that flags the largest share of DEV's pooled
majmin-evaluated time **at or below f**, flagging units whose value is below θ_f and keeping equal values
together (all or none). The achieved share is reported. The frozen θ is stored at full precision; only
its display is rounded.

## Flagged spans and the second choice
A unit is flagged when its signal is below θ. A **span** is a maximal run of consecutive flagged units,
clipped to the chart's owned ranges exactly as `buildAutoChart` clips units (duration weights are taken
after clipping), that lies inside one chart event and has one alt family. Its **second choice** is the
member of that alt family with the highest duration-weighted mean probability over the span's units (ties:
vocabulary order). Span times are rounded to 1 ms like event times. Spans carry their start, end, the shown
chord and the second choice. No minimum length and no smoothing; fragmentation is reported, not corrected.

## Error classes (DEV and TEST, time-mapped references under the frozen maps)
The evaluated region is exactly the majmin-evaluated region of `scoreSong` (the pieces of the VGT-18 error
anatomy). Reference labels are reduced to majmin and consecutive equal reduced labels form reference
segments; unevaluated labels (X, unmapped) form their own segments and act as barriers. Chart events are
reduced the same way into chart runs, split at coverage gaps. Overlaps count only with positive duration.
Each error piece (chart label differs from the reference label) inside reference segment R is:
- **N:** the reference or the chart label is N;
- **hold-over:** the chart label equals the label of the reference segment immediately before or after R and
  the chart run containing the piece also overlaps that neighbour. Then:
  - **missed change** (코드 변화 놓침) when the chart shows R's label nowhere inside R,
  - **boundary** (변화 시점 어긋남) otherwise (the chart changes, but late or early);
- **different chord** (다른 코드): every other error piece.
Hold-over is a useful subset of missed changes, not all of them, so the report also counts **omitted
reference segments** (no correct chart time inside R, whatever the class) and how many of them contain any
flagged time.

## Measured quantities
Per signal and per nominal share f in {5, 10, 15, 20, 25, 30, 40}%, at θ_f:
- **capture:** share of error time inside flagged spans, for all errors and per class (different chord,
  missed change, boundary, N), with the error seconds behind each share;
- **precision:** share of flagged time that is an error;
- **second choice:** on the flagged time, the share where the second choice equals the reference (majmin)
  and the share where the shown chord does; the share of flagged error time the second choice fixes, per
  class;
- **blind replacement (diagnostic):** song-mean majmin change if every flagged span took its second choice;
- **spread:** flagged share per song (min, median, max), spans per minute, median and 10th-percentile span
  duration, second-choice changes per minute;
- **oracle diagnostic (explains, never selects):** marking every error piece of a class (with the per-unit
  alt family's best member) shows how much of that class the second choice could fix with perfect flags;
  low oracle repair means the limit is the second choice, high oracle repair with low capture means the
  limit is the signal.
Statistics: pooled time shares are primary (they match "how much listening time is flagged or caught");
song means are reported next to them. 95% intervals: song-level percentile bootstrap (10 000 resamples,
mulberry32 seed 7007) that resamples each song's (numerator, denominator) pair and computes
sum(numerator) / sum(denominator); draws with a zero denominator are dropped and the valid-draw count is
reported. Intervals after selection are descriptive. A share with no support (zero denominator) is "not
assessable", never a pass. The existing rule (S1 below 0.5) is reported with its flagged share and capture.

## Fixing the criterion (DEV only)
1. **Eligible signals:** those whose all-error capture reaches at least 50% at θ_20 (achieved share at
   most 20%). If none: alarm A1.
2. **Signal:** among eligible signals, those within 1.0 pp of the highest all-error capture at θ_20; among
   them the highest missed-change capture at θ_20; remaining ties by simplicity order S1 … S5.
3. **Operating point:** the smallest f in {10, 15, 20}% at which the chosen signal's capture at θ_f reaches
   50%. θ = that θ_f (full precision).
4. **Alarms at the operating point (stop and ask the user; nothing is frozen until the user decides):**
   - A1: no eligible signal (above);
   - A2: missed-change capture below 1.5 × the achieved flagged share, or not assessable;
   - A3: the second choice fixes less than one third of the flagged error time;
   - A4: on the flagged time the second choice is right no more often than the shown chord (replacing would
     not help on average);
   - A5: a resource limit of `docs/recognition-improvement-protocol.md` is exceeded (packaged bytes +10%,
     analysis time +50% and at least +1 s, peak memory +20%, live latency +100 ms).
5. **Freeze:** signal, θ and the DEV numbers go into `docs/uncertainty-results.md` and into the code constant,
   are committed and pushed before any TEST or K-pop capture is replayed for flags; the commit is recorded.

## TEST check (once)
The same tool with the frozen signal and θ on the TEST songs. Reported: the same quantities with
intervals. Predeclared reading: **similar** when TEST all-error capture is at least DEV capture − 10 pp and
the TEST achieved flagged share is at most DEV's + 5 pp; otherwise **different**. TEST alarms, read with the
frozen θ and TEST's achieved share: T1 all-error capture below 50%; T2 missed-change capture below 1.5 × the
TEST flagged share or not assessable; T3 the second choice fixes less than one third of flagged error time;
T4 the second choice is right no more often than the shown chord on flagged time. Any T alarm or
"different" is reported to the user; θ is not changed on TEST results.

## K-pop reference check (chord order, reference only)
The frozen criterion on the 12 K-pop songs with the conventions of VGT-21 amendment 1 (majmin tokens, N
dropped, consecutive equal tokens collapsed, X wildcards, `--whole-chart`). A collapsed chart token's
duration is the sum of its chord intervals (dropped N and coverage gaps excluded); it is **flagged** when at
least half of that duration lies in flagged spans. Reported:
- **mismatch detection:** the share of chart tokens substituted or inserted in the alignment, for flagged vs
  unflagged tokens (pooled and song means); tokens aligned to a wildcard are left out of both;
- **net sequence recovery:** when every flagged span takes its second choice, the change in song-mean
  recall, precision and F and in the counts of deletions and insertions. Realignment can relabel
  operations and a sequence-only reference cannot say where a missing chord was, so this is reported as a
  net change, not as localized capture of missed changes.
Nothing is tuned on it.

## First choices unchanged
On the same DEV PCM, the build that stores flags reproduces main's replay charts (`replay-parity` plus equal
confidences: identical events, beats and coverage) and `paired-eval` shows a 0.00 majmin, root and sevenths
delta for every song. In the browser, the final dump build's live chart equals main's chart for the same
capture and its live flags equal the offline flags of that capture.

## Recorded during implementation
Readings fixed while the tooling was built (2026-11-14), before any result; no rule above changed.
- **θ_f among equal shares:** several thresholds can give the same largest share at or below f (units
  without evaluated time do not move it). θ_f is the largest of them: the smallest value, among units with
  evaluated time, that stays unflagged (∞ if all could be flagged). Reason: one deterministic value.
- **Units that cannot be flagged:** a unit whose run `buildAutoChart` skipped (its rounded start is not
  after the previous event, so another chord is shown there), or with no other family in the vocabulary,
  is never flagged; its evaluated time stays in the share's denominator. Reason: a span must name the
  chord the final event shows, and needs a second choice.
- **Span adjacency:** consecutive flagged units join only when they touch (no coverage gap between them).
- **Reference segments and neighbours:** only touching reference intervals merge, and the segment
  "immediately before or after R" must touch R; a reference coverage gap acts like a barrier.
- **Chart runs:** a chord outside majmin (e.g. sus4) keys its run by its own symbol, so different such
  chords are different runs; a stretch with no chart event (none in recognizer charts) is a different chord.
- **Omitted reference segments:** R counts when it has evaluated time and no correct chart time inside;
  "contains flagged time" means flagged evaluated time inside R.
- **Spread:** spans per minute and chord changes per minute use the charts' coverage minutes (pooled).
  "Second-choice changes per minute" is reported as chord changes per minute of the chart with every span
  replaced, next to the shown chart's rate and their difference. Span durations are pooled over all spans
  (median and 10th percentile, linear interpolation as `quantile`).
- **Oracle diagnostic:** uses each flaggable unit's best alt-family member (single unit, no span weighting);
  error time over units that cannot be flagged counts as not fixed.
- **Not assessable in alarms:** A2/T2 as stated; A3/T3 and A4/T4 are also raised when their share has no
  support (never a pass). The TEST reading is "not assessable" when the TEST capture or share is.
- **R1 and model hashes:** R1 is the chart check (parity plus exact confidences); model files that differ
  from the capture's build are recorded and warned about, as `replay-audio` does, without failing R1.
- **Bootstrap:** every share's interval uses its own mulberry32 stream seeded 7007; the blind replacement is
  the song mean of per-song majmin deltas, bootstrapped as (delta, 1) pairs.
- **K-pop tokens:** only the whole-chart mode exists; chart tokens absorbed by a wildcard are left out of
  both the flagged and unflagged counts.
