# VGT-19 uncertain-section flags: results

Rules: `docs/uncertainty-protocol.md` (fixed before any result, merged in PR #44; Amendment 1 added after the
DEV result by the user's decision, before any TEST or K-pop replay). Shares are pooled over songs' evaluated
majmin time; brackets are song-level percentile bootstrap 95% intervals (10 000 resamples of (numerator,
denominator) pairs, seed 7007); "song mean" values are in `dev-sweep.json`.

## DEV (23 songs, 2026-11-14)
- **Capture and R1:** 23/23 songs captured again with the audio-dump build of main fd4203d (one capture each, no
  retries, every capture covers at least 90% of the upload). Replay with the shipped recognizer on main a7b6959
  reproduced every live chart (`replay-parity` 23/23 identical, largest confidence difference 0.000) and every
  event confidence exactly (the R1 gate of `uncertainty-analysis`). Majmin song mean of this capture: 82.9%.
- **Result files** (outside the repository, no audio): `~/Documents/paseo-briefings/vibe-guitar-uncertainty/
  dev-sweep.json` and `dev-sweep.txt`.

All-error capture at a 20% flagged share, by signal (the selection step):

| Signal | Capture | Missed change | Eligible (>= 50%) |
| --- | --- | --- | --- |
| S1 event confidence | 47.7 | 41.8 | no |
| S2 symbol probability | 49.8 | 71.3 | no |
| S3 family probability | 52.1 | 73.3 | yes |
| S4 family margin | 51.5 | 73.3 | yes |
| S5 log margin | 51.1 | 72.8 | yes |

S3 and S4 are within 1.0 pp; S4 has the higher missed-change capture (unrounded), so **S4** was chosen. At 10%
and 15% S4 captures 31.5% and 42.7%, so the operating point is **f = 20%, θ = 0.394164403405739**.

S4 at the frozen thresholds:

| | Flag tier (S4 < 0.394164403405739) | Replace tier (S4 < -0.3143507889471948) |
| --- | --- | --- |
| Flagged share of evaluated time | 20.0 [17.0, 23.1] | 5.0 [3.6, 6.6] |
| Capture, all errors | 51.5 [44.4, 60.0] | 19.2 [12.7, 28.0] |
| Capture, different chord (402.8 s of errors) | 46.1 [38.8, 58.6] | 9.0 [5.3, 15.6] |
| Capture, missed change (223.0 s) | 73.3 [60.4, 82.9] | 46.5 [34.5, 56.5] |
| Capture, boundary (107.9 s) | 27.3 [17.8, 35.8] | 6.1 [1.5, 11.1] |
| Capture, N (60.8 s) | 49.9 [35.5, 63.4] | 9.5 [2.9, 17.6] |
| Precision (flagged time that is wrong) | 43.1 [36.2, 50.4] | 64.4 [53.5, 75.3] |
| Second choice right on flagged time | 27.9 [22.5, 33.5] | 53.5 [41.5, 65.2] |
| Shown chord right on flagged time | 56.9 [49.6, 63.8] | 35.6 [24.7, 46.5] |
| Flagged error time the second choice fixes | 64.6 [52.0, 76.8] | 83.2 [71.3, 91.1] |
| Song-mean majmin change if every span took its second choice | -5.7 pp [-7.8, -3.5] | +1.0 pp [-0.1, +2.2] |
| Spans per minute; median (10th percentile) span length | 14.9; 0.66 s (0.38 s) | 4.1; 0.68 s (0.38 s) |
| Flagged share per song: min / median / max | 9.4 / 19.7 / 41.3 | 0.4 / 3.7 / 16.6 |

- **Alarms:** A1 not raised (3 eligible signals); A2 not raised (missed-change capture 73.3% vs 1.5 x 20.0% =
  30.0%); A3 not raised (the second choice fixes 64.6% of flagged error time, needs 33.3%); **A4 raised** (second
  choice 27.9% vs shown chord 56.9% on flagged time). A5 (resources) is measured separately.
- **Existing rule** (event confidence < 0.5): flags 14.9% of the time and captures 39.3% of error time (missed
  change 31.7%).
- **Oracle diagnostic** (every error piece marked, the same second choice): fixes 60.5% of all error time,
  different chord 51.9%, missed change 74.9%, boundary 73.0%, N 42.7%. The second choice is the limit for
  "different chord" errors; for missed changes both the flags and the second choice do well.
- **Omitted reference segments** (no correct chart time inside): 382; 317 contain flagged time at the flag tier.
- **Decision:** the user chose the two-tier design of Amendment 1 ("두 단계 (Recommended)", 2026-11-14).
- **Frozen:** `src/recognize/uncertainty-criterion.ts` (S4, threshold 0.394164403405739, replaceBelow
  -0.3143507889471948), committed and pushed before any TEST or K-pop replay.

## TEST (18 songs, once)
(pending)

## K-pop (12 songs, chord order, reference only)
(pending)

## Resources (A5)
(pending)
