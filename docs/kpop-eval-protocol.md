# VGT-21 K-pop evaluation set: protocol

Fixed **before any recognizer output of these songs is looked at or scored** (2026-11-14). This file and
`docs/kpop-eval-songs.json` are merged to `main` before the first score exists. After scores are seen: no
change of the song set, uploads, reference method, exclusion rules, metrics, thresholds or the decision rule.
If a rule seems to need a change after scores are seen, the user decides first. Wording fixed while the
references are built (before scoring) is recorded under "Recorded during implementation" with its reason.

## Purpose
All accuracy measured so far comes from 1958-1991 Billboard songs and Beatles songs (held-out Billboard TEST,
18 songs: song-mean majmin 83.3 with the shipped recognizer, `docs/recognition-candidates.md` "Final
confirmation"). The user, a beginner guitarist who plays along to the auto chart, mostly plays recent Korean
songs by Jang Beom June (Busker Busker), Sung Si Kyung, IU and AKMU. This set measures how the current
recognizer does on those songs and how it fails, to decide whether a small fine-tuning trial on recent songs
is worth trying. The set stays the yardstick for later fine-tuning trials. Measurement only: the recognizer is
not changed and nothing is trained. These songs are never used as training data (also not through HookTheory,
SheetSage or any other dataset that contains them: a later training set must drop them).

## Song set (frozen)
The user named 14 candidates (3-4 per artist). Rule: use the songs that have an official upload and reference
chords, at most 12, 3 per artist in the user's listed order; the 4th IU and AKMU songs are reserves that are
captured but only replace a song of the same artist that fails qualification **before any score**.

- **Upload:** the "Provided to YouTube" art track of the original studio recording (auto-generated, on the
  artist's Topic channel), found through YouTube Music song search on 2026-11-14. All 14 candidates have one.
- **Reference chords:** at least 2 public human-made chord sheets (Ultimate Guitar user versions, Korean chord
  blogs, chord sites with hand-written sheets). Auto-generated sources (Chordify, ChordU, ChordTool, Lamucal,
  analyzers) and paid image scores are not used. Sheets whose whole chord-family sequence agrees >= 0.97
  (difflib ratio after the best of 12 transpositions) form one **lineage** (one source copied from another);
  lineages, not sheets, vote. A song whose sheets form a single lineage is kept and flagged ("single lineage").
  All 12 listed songs qualified on 2026-11-14 (heejae is single lineage), so the reserves are not used.
- **Synced lyrics:** one LRCLIB synced-lyrics version per song, chosen by rule before alignment: duration within
  1 s of the art track, album title matching the art track's album, then the version whose line times agree best
  with the other matching versions. Used only for line timing (the gate below); lyric text is never stored.

| id | Artist | Title | YouTube | Length (s) | LRCLIB id |
| --- | --- | --- | --- | --- | --- |
| jbj-cherry | Busker Busker | 벚꽃 엔딩 | KvthiAoGTfo | 261 | 5230958 |
| jbj-shampoo | Jang Beom June | 흔들리는 꽃들 속에서 네 샴푸향이 느껴진거야 | _pcl_JPqMfw | 169 | 21970603 |
| jbj-karaoke | Jang Beom June | 노래방에서 | zeIOhIpQ-oI | 240 | 23805361 |
| ssk-moment | Sung Si Kyung | 너의 모든 순간 | OdFVPP_Rcos | 243 | 31330606 |
| ssk-street | Sung Si Kyung | 거리에서 | mLwfuskNDOo | 279 | 11405036 |
| ssk-heejae | Sung Si Kyung | 희재 | nD1p_H3qo_A | 281 | 18228386 |
| iu-night | IU | 밤편지 | NnRjwEhFU70 | 253 | 7750035 |
| iu-goodday | IU | 좋은 날 | OIHlzvEKncQ | 236 | 21366077 |
| iu-lovepoem | IU | Love poem | kcx0a2OAhN0 | 258 | 2207238 |
| akmu-lastgoodbye | AKMU | 오랜 날 오랜 밤 | G7TqsFwWTM0 | 284 | 5294633 |
| akmu-heartbreak | AKMU | 어떻게 이별까지 사랑하겠어, 널 사랑하는 거지 | KczYjTVrK_o | 290 | 4745375 |
| akmu-200 | AKMU | 200% | 5UrL0CM2uQA | 193 | 18453021 |
| (reserve) iu-autumn | IU | 가을 아침 | ZDoH5dQ58ps | 219 | 4544325 |
| (reserve) akmu-nakka | AKMU | 낙하 | uaejCvCMu5I | 213 | 38659178 |

## Data handling
Captured audio (`~/vgt-kpop-audio`), collected sheets, references and charts (`~/vgt-kpop-eval`) stay on this
Mac outside the repository and are never committed or uploaded. Sheets are stored as chords and line structure
only; lyric text is used in memory to pair sheet rows with synced-lyric lines and is never written. Audio is
deleted when the campaign ends. Only song metadata, rules, aggregate and per-song scores enter the repository.

## Capture and R1
The 14 uploads are captured once each with the audio-dump build of main 6d7ca60 in the user's Aside browser
(`docs/recognition-replay.md`), played from the start at 1x. The live chart is the shipped recognizer
(`EXTENSION_RECOGNIZER_OPTIONS = { emission: 'meanLog', pitchShift: [-1, 1] }`).
- **R1 (gate, before anything else):** `replay-audio` with config
  `{"recognizer":{"emission":"meanLog","pitchShift":[-1,1]}}` must reproduce every live chart exactly (the
  `replay-parity` comparison: coverage, chords, start times, beats and downbeats after 1 ms rounding). R1 runs
  mechanically; only pass/fail and counts are read, never chart content, until the references are frozen.
- A capture with no chart or covering less than 90% of the upload length is retried up to 2 more times.

## Reference construction (blind)
Nobody looks at the captured charts or any score until the references are frozen (sha256 manifest).
1. **Parse:** each sheet becomes rows of chord symbols with section labels, repeat marks and, where a lyric row
   pairs with a synced-lyric line (monotonic character-bigram matching), that line's index and time.
2. **Transposition:** each sheet is moved to the recording's key. The shift is proposed by a chord-template vs
   global-chroma fit over 12 shifts (librosa CQT chroma of the capture, not the recognizer's features) and must
   agree with the sheet's stated key/capo when one is stated; an unexplained conflict is an ambiguity for the user.
3. **Consensus:** one representative sheet per lineage; sequences are aligned to each other (global sequence
   alignment of chord tokens). Where lineages agree at the majmin level the chord is taken (the richer spelling,
   e.g. a seventh, only when every seventh-writing lineage agrees on it). Every majmin-level difference
   (different chord, extra or missing chord) goes to the user with the lineage majority pre-selected when one
   exists. Repeats are expanded only as a sheet itself marks them; a passage no sheet writes stays uncovered.
4. **User confirmation:** one page lists, per song, the differences, the passages whose timing is uncertain, and
   one randomly chosen agreed passage per song (two for a single-lineage song) as a spot check. Each item has the
   time, the candidates, a YouTube timestamp link and synthesized candidate chords. The user picks a candidate or
   "모르겠음" (can't tell). Spot-check answers are reported; they do not edit agreed chords unless the user marks a
   passage wrong and picks the correct chord.
5. **Timing:** the consensus sequence is aligned to the capture with a monotonic semi-Markov Viterbi alignment on
   beat-synchronous harmonic chroma (librosa beats, never the extension's Beat This! beats or charts); chords last
   at least one beat; a sheet chord missing from the recording may be skipped (reported); leading/trailing
   regions are N (silence) or X, never a forced chord. Boundaries sit on that beat grid (a limit stated in the
   results). Tool: `~/vgt-kpop-eval/tools/gt` (outside the repository; README there).
6. **Files:** per song two LAB files on the capture's own media time (so the map is offset 0, rate 1):
   `majmin` view and `sevenths` view (below), plus a manifest with sha256 of every file, frozen before scoring.

### Exclusion (X: counted neither right nor wrong) and no-chord (N)
- X: a passage no sheet covers and the user does not fill; a difference the user answers "모르겠음"; a capture gap.
- X in the **sevenths view only:** a chord whose seventh quality is not resolved (lineages disagree on the seventh,
  or no lineage that writes sevenths covers it, and the user did not resolve it). The majmin view keeps the
  agreed triad family there.
- N: silence before the first and after the last sound, and passages every covering sheet marks N.C.
- Nothing is excluded because the audio fit is weak (to avoid keeping only easy passages).
- Reported per song and artist: X seconds against the whole upload length (both views), and a bound on the majmin
  song mean with all X time counted wrong and counted right.

## Alignment gate (independent of the recognizer and of the chroma fit)
For each song, every synced-lyric line that a consensus chord row is paired with: Δ = aligned start of that
row's first chord - the line's LRCLIB time. **Pass:** at least 80% of paired lines have |Δ| within one bar (4 beats
at the song's median beat period), and the same statistic with each line compared against a displaced line
(1-3 lines away, both directions) is lower with a one-sided permutation p < 0.01. The chroma-template fit vs
circularly shifted copies is reported as a diagnostic only (the alignment optimised it). A song that fails is
reported separately with the reason and left out of the headline means. If 2 or more of the 12 songs fail, work
stops and the user decides.

## Scoring
Arms on the same captured PCM, replayed offline: **A** = original recognizer (replay config `{}`, the
`Recognizer` defaults at main 6d7ca60, unchanged since before VGT-18), **B** = shipped recognizer (config above).
The unchanged evaluator (`paired-eval`, `scoreSong`) with `docs/kpop-eval-songs.json`, maps written from the
captures (offset 0, rate 1, `mediaDurationSec` = the upload length measured during capture) before scoring, and
the frozen LAB files (majmin view for majmin and root, sevenths view for sevenths). `baseline-analysis` on the
same captures for arm A and arm B.
- **Per song, per artist (unweighted song mean within the artist) and overall (song mean):** majmin, root and
  sevenths WCSR; chord-change precision, recall and F within +-250 ms (majmin labels, one-to-one) and change counts;
  error anatomy (share of evaluated time: exact, fifth-related root, parallel, relative, semitone root, other,
  auto chord where the reference is N, auto N where the reference has a chord); top-k = share of beat units whose
  reference majmin family is the BTC model's top-1, within top-2 and within top-3 family (the family oracle of
  `docs/recognition-candidates.md` "Baseline analyses", not exact-chord top-k).
- **Billboard side by side:** majmin, root, sevenths and boundary precision of the TEST confirmation (18 songs,
  both arms, per-song values in its result file); error anatomy and top-k of the DEV baseline analysis (23 songs,
  arm A only, the only arm analysed there).
- **Uncertainty:** song-mean 95% percentile bootstrap (10 000 resamples, mulberry32 seed 7007); the gap G =
  Billboard TEST song mean (arm B) - K-pop song mean (arm B) with both song sets resampled independently;
  leave-one-song-out and leave-one-artist-out G.

## Decision rule (recommendation on a fine-tuning trial)
- **Worth a small trial:** G >= 5.0 pp, the 95% interval of G above 0, and G >= 3.0 pp with any one artist left out.
- **Not now:** G < 2.0 pp and the upper end of the 95% interval of G below 5.0 pp.
- **Inconclusive:** anything else; also when the song-mean X share of the majmin view exceeds 15% of the upload
  length, when 3 or more songs fail the alignment gate, or when the user marks more than 25% of spot checks wrong.
Error anatomy and top-k do not change the category; they shape what a trial would target. A reference built from
web sheets can be simpler than the curated Billboard annotations, so part of any gap can come from the reference
method; the results state this limit.

## Reporting
All 14 candidates through qualification, capture, R1, alignment gate and scoring, each with its reason; the
number of user questions and answers ("모르겠음" included); X shares; the decision with its numbers; limits (12
songs from 4 artists, web-sheet references, beat-grid boundaries, one capture per song, audio deleted so a later
trial compares baseline and candidate on a new capture with the same references).

## Recorded during implementation
(none yet)
