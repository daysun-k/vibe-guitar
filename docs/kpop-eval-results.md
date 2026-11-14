# VGT-21 K-pop evaluation set: results (2026-11-14)

Rules: `docs/kpop-eval-protocol.md` with Amendment 1 (chord-order comparison), merged as main 28a22365 before any
score. Nothing was changed after scoring. Raw results stay on the Mac outside the repository
(`~/vgt-kpop-eval/results/`, `summary.json`); no audio, sheets, references or lyrics are committed.

## Recommendation
**Not now** (the predeclared decision rule). On the chord-order measure the current recognizer does not do worse on the
user's recent Korean songs than on the held-out Billboard songs; it scores higher. There is no measured deficit for a
fine-tuning trial on recent songs to fix. This does not show that fine-tuning cannot help; it shows that this set gives
no reason to start one now.

| Decision input | Value | Rule |
| --- | --- | --- |
| G = Billboard TEST song-mean majmin F (78.3, 18 songs) - K-pop (83.5, 12 songs), both original recognizer | **-5.2 pp** | not now: G < 2.0 |
| 95% interval of G (both sets resampled independently, seeds 7007/7008) | [-14.2, +3.3] | not now: upper end < 5.0 |
| G with one artist left out | AKMU -4.4, IU -4.6, Jang Beom June -4.1, Sung Si Kyung -7.7 | trial would need >= 3.0 for each |
| K-pop wildcards (tied sheet disagreements, song mean of reference tokens) | 12.9% | inconclusive above 15% |

## What was measured
- 14 candidates: all had an official art-track upload and at least 2 chord-sheet lineages; the first 3 per artist (12)
  form the set, the 2 reserves were captured but not used. 14/14 captured; R1 replay identity 14/14.
- The planned time-aligned references failed their independent synced-lyric check for all 12 songs, and a lyric-anchored
  prototype also failed (Amendment 1 "Why"). The user cannot judge chords by ear, so references are the sheet consensus
  in chord order, and the primary metric compares chord order (edit-distance alignment of collapsed chord sequences).
- Arm A = original recognizer (the only arm the remaining Billboard charts have), arm B = shipped recognizer
  (`emission: meanLog`, `pitchShift: [-1, 1]`).

## Results (chord order; recall / precision / F in %)

| Set | majmin R / P / F (95% interval of F) | root F | sevenths F |
| --- | --- | --- | --- |
| K-pop, arm A (12 songs) | 78.7 / 89.2 / **83.5** [79.2, 87.5] | 86.9 | 71.2 (11 songs) |
| K-pop, arm B (12 songs) | 80.3 / 89.8 / **84.6** [80.4, 88.6] | 87.3 | 74.4 (11 songs) |
| Billboard TEST, arm A (18 songs) | 71.0 / 92.4 / **78.3** [70.2, 85.5] | 82.9 | 66.1 |

| Artist (song mean) | A majmin F | A root F | A sevenths F | B majmin F | B root F | B sevenths F |
| --- | --- | --- | --- | --- | --- | --- |
| AKMU | 85.9 | 90.6 | 67.7 | 88.5 | 91.3 | 74.3 |
| IU | 85.2 | 88.8 | 70.0 | 85.6 | 88.2 | 71.8 |
| Jang Beom June / Busker Busker | 86.7 | 89.3 | 84.3 | 86.4 | 89.1 | 87.2 |
| Sung Si Kyung | 76.1 | 78.8 | 62.3 | 77.9 | 80.8 | 63.4 |

| Song | A majmin R / P / F | A root F | A sevenths F | B majmin F | B - A | Reference / wildcard / chart tokens (A) |
| --- | --- | --- | --- | --- | --- | --- |
| jbj-cherry (벚꽃 엔딩) | 80.2 / 92.7 / 86.0 | 87.8 | 91.7 | 85.6 | -0.4 | 126 / 9 / 109 |
| jbj-shampoo (흔들리는 꽃들 속에서…) | 82.1 / 100 / 90.2 | 90.2 | 73.1 | 92.3 | +2.1 | 84 / 4 / 69 |
| jbj-karaoke (노래방에서) | 77.2 / 92.2 / 84.0 | 89.9 | 88.2 | 81.4 | -2.6 | 92 / 27 / 77 |
| ssk-moment (너의 모든 순간) | 63.2 / 72.3 / 67.4 | 74.6 | 55.5 | 71.2 | +3.8 | 95 / 10 / 83 |
| ssk-street (거리에서) | 79.5 / 94.2 / 86.2 | 86.1 | 69.8 | 87.2 | +1.0 | 122 / 24 / 103 |
| ssk-heejae (희재) | 71.3 / 78.6 / 74.8 | 75.8 | 61.5 | 75.4 | +0.6 | 108 / 4 / 98 |
| iu-night (밤편지) | 91.5 / 89.0 / 90.3 | 95.2 | 87.5 | 90.3 | 0.0 | 71 / 17 / 73 |
| iu-goodday (좋은 날) | 72.5 / 79.0 / 75.6 | 80.4 | 52.4 | 75.8 | +0.2 | 109 / 15 / 100 |
| iu-lovepoem (Love poem) | 84.8 / 95.1 / 89.7 | 90.8 | not computable | 90.8 | +1.1 | 92 / 17 / 82 |
| akmu-lastgoodbye (오랜 날 오랜 밤) | 94.9 / 94.9 / 94.9 | 97.7 | 85.7 | 95.4 | +0.5 | 98 / 16 / 98 |
| akmu-heartbreak (어떻게 이별까지…) | 76.8 / 87.8 / 81.9 | 90.8 | 73.3 | 89.2 | +7.3 | 112 / 15 / 98 |
| akmu-200 (200%) | 70.8 / 94.4 / 81.0 | 83.3 | 44.2 | 81.0 | 0.0 | 48 / 11 / 36 |

- Shipped vs original on K-pop: majmin F +1.1 pp on average (8 songs up, 2 down, 2 unchanged; range -2.6 to +7.3),
  in the same direction as the VGT-18 Billboard TEST result (+1.0 pp time-weighted).
- Sevenths: iu-lovepoem has no evaluable sevenths tokens (neither lineage writes sevenths), so sevenths means use 11 songs.

**Error anatomy (share of reference tokens, majmin, song mean, %)**

| | fifth-related root | parallel | relative | semitone root | other substitution | missed (deletion) | extra (insertion, share of chart tokens) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K-pop A | 1.4 | 1.0 | 0.5 | 0.4 | 5.3 | 12.6 | 1.1 |
| K-pop B | 1.1 | 1.0 | 0.7 | 0.3 | 5.0 | 11.5 | 1.1 |
| Billboard A | 1.2 | 0.5 | 0.2 | 0.1 | 3.3 | 23.7 | 0.9 |

The largest error type in both sets is a missed chord (the chart holds one chord where the reference changes). Billboard
misses about twice as often; one possible reason is that curated annotations write changes more densely than web chord
sheets (this was not measured separately).

## Reference only: timing validation failed
These numbers use references timed by the lyric-anchored prototype aligner, whose validation failed; they never entered
the decision. K-pop time-weighted majmin 68.9 (A) -> 69.7 (B), root 71.6 -> 71.5, sevenths 56.7 -> 58.3 (11 songs),
chord-change F (+-250 ms) 53.8 -> 54.4, top-1/2/3 family oracle 69.1/81.7/86.6 -> 69.8/82.3/86.9. The gap to the
Billboard time-weighted results (83.3 majmin) is confounded with reference timing error of unknown size, so it is not
evidence of a domain gap.

## How far to trust this
- 12 songs from 4 artists, one capture each: the interval of G is wide (about 17 pp). The data rule out a large K-pop
  deficit on this measure; they cannot resolve differences of a few points.
- The two sets use different references: curated, time-aligned Billboard annotations against a consensus of public web
  sheets in chord order. Web sheets may write fewer changes, which would lower the recognizer's misses on K-pop. A
  follow-up check (below) measured this effect on the Billboard songs as small: -0.9 pp [-4.3, +2.7]. The original evaluation did not run a
  same-method comparison (web sheets for the Billboard songs; scope, advisor round 1); the follow-up below adds it.
- Chord order ignores timing and duration: a chord shown at the wrong moment still counts as right. Timing accuracy and
  top-k could not be measured reliably on these songs.
- Reference quality: lineage-majority consensus of 2-6 sheet lineages per song; tied disagreements (12.9% of tokens) are
  uncounted; keys for jbj-cherry and akmu-200 came from the synced-lyric tie-break; ssk-heejae's two lineages agree on
  99% of positions (probably related copies). No human listening check was possible.
- The captured audio is deleted at the end of this campaign as planned, so a later fine-tuning trial must capture these
  12 uploads again and compare its baseline and candidate on that new capture with the same frozen references.

## Follow-up: reference-method check (2026-11-14, after scoring, exploratory; user-requested)
Not part of the predeclared protocol; it does not change the recommendation. On the same 18 Billboard TEST songs and the
same official v2 charts (original recognizer), references were rebuilt from public web chord sheets with the K-pop
rules (lineages, majority/tie wildcards, duplicated-half rule) and compared with the curated McGill references.
Raw results stay outside the repository (`~/vgt-kpop-eval/billboard-websheets/summary.json`).

| Measure | Value |
| --- | --- |
| Billboard majmin F, web-sheet vs curated references | 77.4 vs 78.3: effect -0.9 pp [-4.3, +2.7] (paired bootstrap, seed 7007; 10 songs up, 8 down) |
| Same, root F | -2.9 pp [-4.9, -1.0] |
| Majmin F effect, songs with >= 2 sheet lineages (12) | +1.6 pp [-2.3, +5.7] |
| Same-method gap: Billboard (web) - K-pop (web), majmin F | -6.1 pp [-16.4, +3.1]; any one artist left out -5.0 to -8.5 |
| Same-method gap, Billboard songs with >= 2 lineages | -4.3 pp [-18.1, +6.8] |
| Reference tokens, web / curated | song-mean ratio 0.87 (totals 1674 vs 1958, ratio 0.85); web wildcards 10.7% (K-pop 12.9%) |

Reading: swapping the reference method moves the Billboard score by about one point, and the K-pop advantage remains
with web-sheet references on both sides, so the reference method does not explain it. Limits: keys were decided by the
sheets' stated keys only when they matched the transposition that best fits the curated annotation (a literal
stated-key majority mis-keys 3 songs and would give an effect of -12.4 pp), so the Billboard side partly used its
known key; 6 songs had a single sheet lineage and many web sheets are copies of each other (Ultimate Guitar,
guitartabs.cc, guitaretab.com); per-song differences range from -14.9 to +16.6 pp, so single songs can move a lot.
