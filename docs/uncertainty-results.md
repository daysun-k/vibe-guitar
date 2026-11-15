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

- **First choices unchanged (same DEV PCM):** the wired build (`EXTENSION_UNCERTAINTY` = the frozen criterion)
  reproduces every live chart and confidence (R1 23/23), and `paired-eval` against main's replay gives majmin
  82.9 -> 82.9, root 84.7 -> 84.7, sevenths 70.9 -> 70.9 (every delta +0.00 pp, 1708 -> 1708 chord changes).

## TEST (18 songs, once, 2026-11-14)
The 18 TEST songs were captured in the same sitting (18/18, coverage at least 90%) and replayed only after the
freeze commit bf3e79b was pushed. Two fixed runs of `uncertainty-analysis` on main a7b6959 (Amendment 1); R1
18/18 in both. Result files: `test-flag.json`, `test-replace.json` (same folder as DEV).

| TEST | Flag tier (S4 < 0.394164403405739) | Replace tier (S4 < -0.3143507889471948) |
| --- | --- | --- |
| Flagged share | 19.9 [15.3, 24.3] | 4.6 [3.1, 6.2] |
| Capture, all errors | 58.4 [49.6, 65.0] | 21.4 [15.2, 26.6] |
| Capture, different chord (171.1 s of errors) | 62.0 [49.8, 69.2] | 12.6 [5.3, 19.8] |
| Capture, missed change (264.8 s) | 70.9 [55.7, 81.6] | 35.9 [26.7, 43.3] |
| Capture, boundary (84.3 s) | 20.6 [13.0, 29.4] | 4.9 [1.9, 7.9] |
| Capture, N (46.9 s) | 43.1 [11.5, 86.8] | 1.1 [0.0, 6.8] |
| Precision | 47.5 [36.5, 57.6] | 75.7 [63.3, 83.6] |
| Second choice right on flagged time | 31.6 [22.4, 41.2] | 61.3 [46.1, 72.9] |
| Shown chord right on flagged time | 52.5 [42.4, 63.5] | 24.3 [16.4, 36.7] |
| Flagged error time the second choice fixes | 66.6 [55.6, 77.6] | 81.0 [68.9, 89.9] |
| Song-mean majmin change if every span took its second choice | -3.5 pp [-7.1, +0.4] | +1.9 pp [+0.3, +3.7] |
| Spans per minute; median (10th percentile) span length | 16.3; 0.56 s (0.46 s) | 4.6; 0.50 s (0.46 s) |
| Flagged share per song: min / median / max | 6.7 / 19.3 / 37.9 | 0.6 / 3.7 / 13.6 |

- **Reading (Amendment 1):** **similar** on the flag run (capture 58.4% >= DEV 51.5% - 10 pp; share 19.9% <=
  DEV 20.0% + 5 pp). T1 not raised (58.4% >= 50%), T2 not raised (missed change 70.9% vs 29.8%), T3 not raised
  (66.6% >= 33.3%). **T4, read on the replace run, not raised:** the second choice is right 61.3% of replace-tier
  time vs 24.3% for the shown chord. For information, T4 on the flag run: 31.6% vs 52.5% (as on DEV, the reason
  for the two tiers). The tool's generic T1 and "different" lines on the replace run do not apply (Amendment 1
  reads T1-T3 on the flag run only). No TEST alarm; neither threshold changed.
- **Existing rule** (event confidence < 0.5) on TEST: share 18.8%, capture 39.0%, missed change 31.7%.
- **Oracle diagnostic:** all 58.3%, different chord 46.7%, missed change 71.0%, boundary 67.5%, N 12.8%.
- TEST has more missed-change error time than different-chord error time (264.8 s vs 171.1 s), unlike DEV; the
  flags catch 70.9% of it.

## Measured vs shown
The panel draws no stretch on a no-chord (N) event (the lane shows no chord there), but the measurement counts
those spans. Share of span time (whole charts) whose shown chord is N: DEV 2.5% (27.1 of 1086.2 s) and TEST
2.1% (17.3 of 811.8 s) at the flag threshold; TEST 0.6% (1.0 of 174.2 s) at the replace threshold. The shown
marks are therefore slightly fewer than the measured flags (review vgt19-flags-ui-r4 F5, follow-up).

## K-pop (12 songs, chord order, reference only)
The 12 eval songs of VGT-21 were captured in the same sitting (12/12, coverage at least 90%) and replayed only
after the freeze, on main e2c89ce; R1 12/12. Charts with flags at each frozen threshold were compared with the
frozen VGT-21 chord-order references (`npm run uncertainty-sequence`, `--whole-chart`). Result files
`kpop-flag.json`/`.txt` and `kpop-replace.json`/`.txt` (same folder as DEV). Nothing was tuned on them.

| K-pop | Flag tier (S4 < 0.394164403405739) | Replace tier only (S4 < -0.3143507889471948) |
| --- | --- | --- |
| Chart tokens flagged (at least half their time) | 176 of 1040 | 13 of 1040 |
| Mismatch (substituted or inserted), flagged tokens | 26.1% (song mean 27.1%) | 15.4% (song mean 11.9%) |
| Mismatch, unflagged tokens | 7.5% (song mean 6.9%) | 10.6% (song mean 10.1%) |
| Song-mean recall if every span took its second choice | 80.2 -> 83.4 (+3.27 pp) | 80.2 -> 85.8 (+5.60 pp) |
| Song-mean precision | 89.8 -> 82.6 (-7.16 pp) | 89.8 -> 88.0 (-1.76 pp) |
| Song-mean F | 84.6 -> 82.9 (-1.65 pp) | 84.6 -> 86.9 (+2.29 pp) |
| Deletions / insertions (all songs) | 128 -> 64 / 11 -> 81 | 128 -> 62 / 11 -> 32 |

- Flagged tokens mismatch the sheets about 3.5 times as often as unflagged ones (26.1% vs 7.5%), so the marks
  point at doubtful chords in the user's songs too.
- Taking the second choice on the replace tier only roughly halves the deletions (missed chord changes in
  chord-order terms) and raises song-mean F by 2.3 pp; taking it on every flagged span also halves deletions but
  adds more insertions than it removes deletions, so F falls. This agrees with the two-tier design. Realignment
  can relabel operations, so these are net changes, not localized captures of missed changes.

## Resources (A5)
Measured on this Mac by replaying the 23 DEV captures with the shipped config, twice per arm in alternation,
before VGT-19 (fd4203d) and with the wired feature (475dddb / 743bb25, the same recognizer code as 8c7686e), while the K-pop capture was running in
the browser (so timings are noisy). Limits from `docs/recognition-improvement-protocol.md`.

| | Before VGT-19 | With VGT-19 | Limit | Result |
| --- | --- | --- | --- | --- |
| Peak resident memory of the replay | 2.137 / 2.186 GB | 2.199 / 2.178 GB | +20% | max +1.4%, within |
| 4-minute song (17t7SEsoKfE) total replay | 6.91 / 5.97 s | 5.93 / 6.68 s | +50% and at least +1 s | within noise |
| Its end-of-song analysis | 1.29 / 1.39 s | 1.12 / 1.68 s | same | at most +0.28 s, within |
| Packaged bytes (excl. maps) | 42,635,724 (VGT-18 baseline) | 42,675,193 | +10% | +0.09%, within |
| Live "인식 중" latency | unchanged path | the per-unit statistics run only in segment analysis, not in the live readout | +100 ms | unchanged |

A5 was not raised.
