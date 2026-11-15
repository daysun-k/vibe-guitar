# Capture-latency probe (dev only, VGT-7)

Listening mode places each captured tab-audio block on the song timeline with `AudioPlacer`
(`src/recognize/placement.ts`): the player position at the block's AudioContext time minus
`CAPTURE_LATENCY_SEC` (`src/extension/offscreen/listen.ts`; 69 ms since the 2026-11-15 measurement
below, after VGT-22; 128 ms from the 2026-11-13 measurement before that, a 50 ms guess before). This probe measures the
error of that placement with a click track, through the production path, and suggests the constant.

**What it measures:** the time between the media element's `currentTime` clock and the captured audio,
as listening mode places it: tab capture → AudioContext → anchor mapping → resampling to 22 050 Hz →
`AudioPlacer` / `ListeningSession`. **What it does not measure:** speaker, headphone or Bluetooth output
delay (the probe never listens through a microphone), or how late the side panel draws.

## Pieces

| Piece | Where |
| --- | --- |
| Click track: 20 short clicks (2.5 kHz, 4 ms) at exact sample positions with irregular spacing over 1.5–55.2 s, 3 more at 61–66 s for the non-1x check, quiet tones underneath, 72 s, 48 kHz WAV | `src/probe/latency.ts` (`probePlan`, `renderProbeTrack`) |
| Probe page on `http://127.0.0.1:<port>/` with a real `<audio>` element, start buttons and `window.vgProbe` | `scripts/latency-probe.mjs`, `src/probe/page.ts` |
| Adapter for that page: reports the element's own `currentTime` / `paused` / `playbackRate` with `Date.now()` of the read, every 250 ms and on media events, like the YouTube adapter | `src/extension/probe/probe-content.ts` |
| Offscreen hook: feeds those reports to `ListeningController.onPlayerState` (recording `probe:<session>`), and on `dump` finds the clicks in the audio `AudioPlacer` stored for that session (high-pass + half-peak onset on the 22 050 Hz segments) and returns placed times | `src/extension/probe/probe-offscreen.ts` |
| Service-worker hook: `recapture` stops and restarts tab capture on the probe tab (fresh AudioContext and placer) | `src/extension/probe/probe-background.ts` |
| Statistics | `scripts/latency-report.mjs` → `analyzeProbeDump` in `src/probe/latency.ts` |

## Build

`npm run build:latency-probe` (= `node scripts/build.mjs --latency-probe`) writes a separate unpacked
extension to `dist-probe/` (git-ignored). It is the normal extension plus:

- one content script, `probe-content.js`, on `http://127.0.0.1/*` (any port). It does nothing unless the
  page has `<meta name="vibe-guitar-latency-probe">`. No permission or host permission is added;
- the probe hooks, compiled in because `__LATENCY_PROBE__` is `true`;
- the name suffix `[latency probe, dev]`.

`npm run build` (default) sets `__LATENCY_PROBE__` to `false`: the hooks are not bundled, `dist/` and its
manifest (permissions, host permissions, content-script matches) are unchanged.

The probe adapter reports duration 0, so listening mode never builds or saves an auto chart of the probe,
and it uses its own message type, so the side panel ignores the probe tab.

## Session plan (one measurement session)

On the capture that is running: seek to 0, set a new session id, play; at 14 s pause for 2 s and resume;
at 40 s seek back to 33.5 s (the clicks at 35.9 s and 38.6 s play twice); at 59.5 s set 1.5x until 67.5 s
(the 3 rate-check clicks play only at 1.5x and must not be stored); play to the end; wait 1.5 s; `dump`.
No click is within 0.5 s of a pause, seek or rate change. One session takes about 80 s.

`vgProbe.runAll(3)` runs three sessions; before the second and third it sends `recapture`, so each session
is a fresh tab capture. Then `vgProbe.download()` (button 결과 JSON 받기) saves the result file.

## Statistics (`npm run latency-report -- <file.json>`)

- Each placed click is matched to the nearest source click within ±0.25 s; residual = placed − source
  (positive = audio placed too late). A replayed click counts once per placement.
- Fit on the even-indexed main clicks of all sessions (10 per session), validate on the odd ones (the other
  30). Correction = median fit residual. **Suggested `CAPTURE_LATENCY_SEC` = used constant + correction.**
- Validation, after the correction: median, p95 and max of |residual|. Drift: slope of residual over time
  inside each continuous segment (a pause or seek starts a new, re-anchored segment), in ms per minute.
- Proposed targets: |median| ≤ 10 ms, p95 ≤ 50 ms, |drift| ≤ 10 ms/min, and 0 rate-check clicks stored.
- Also reported per session: the stored segments with their median residual, missing clicks, replays, extra
  detections, and the capture sample rate.

**Known separate effect (found while building this):** `ListeningSession.append` clamps a new segment's
start to 0 s. When playback starts at 0 s, the first stored block's start computes to a negative time and
is clamped, so the whole first segment (until the first pause or seek) lands later than the rest, by up to
the latency constant. In the simulated test (true latency 80 ms, constant 50 ms) it is +37.5 ms. The report
prints it as "0 s 시작 구간의 추가 지연" and the p95 without those segments. It is a placement bug at the
start of a song, separate from the constant, and it grows when the constant grows. Fixed in VGT-22 (see
below): the start is no longer clamped, and the report now calls it "곡 처음부터 기록한 구간의 추가 지연"
(segments that start at or before 0.25 s), which should stay within 10 ms.

## Measurement steps (Aside or another Chromium)

1. In the worktree: `npm run build:latency-probe`, then `npm run latency-probe` (prints
   `http://127.0.0.1:8790/`; `-- --port <n>` for another port). Leave it running.
2. Load `dist-probe/` as an unpacked extension (chrome://extensions → Developer mode → Load unpacked).
   Turn the normal Vibe Guitar extension off for the measurement so only one extension captures.
3. Open `http://127.0.0.1:8790/`. The status line must say `probe build: detected` (otherwise reload the
   page once after loading the extension).
4. **The one manual step:** click the Vibe Guitar (probe) toolbar button on this tab. This starts tab capture
   (the side panel opens too; leave it).
5. From page JavaScript: `await vgProbe.status()` → `capturing: true`. Then start `vgProbe.runAll(3)` (or
   press 3회 측정). It takes about 4.5 minutes; poll `vgProbe.running`, `vgProbe.lastError` and
   `vgProbe.results.length`. Do not navigate or reload the tab during the run (that ends the activeTab grant
   `recapture` relies on).
   - If `audio.play()` is refused (autoplay policy: `NotAllowedError` in the log), click 3회 측정 on the page
     once instead of calling it from script.
   - If `recapture` fails (`lastError` mentions tabCapture / activeTab), run the sessions one by one: click the
     toolbar button, `await vgProbe.runSession()`, and repeat; each toolbar click starts a fresh capture.
6. Save the result: `JSON.stringify(vgProbe.dump())` from page JavaScript into a file, or `vgProbe.download()`.
7. `npm run latency-report -- <file.json>` prints the statistics and the suggested constant
   (`--json` for machine-readable output).
8. Changing the constant is a separate change in `src/extension/offscreen/listen.ts`; re-run the probe with
   the new build to confirm |median| ≤ 10 ms.

## Measurements

### 2026-11-13, Aside on the Mac mini (main 5e5b7b1, constant 0.050 s)

Three sessions of the full plan (pause, seek back, 1.5x stretch), one toolbar click; later sessions
restarted capture without a click.

| | Result | Target |
| --- | --- | --- |
| Complete runs | 3 of 3, no missing click, 0 clicks stored from the 1.5x stretch | all |
| Fit (even clicks, 33) | median residual 77.8 ms | |
| Validation (odd clicks, 33) | median 80.5 ms before, 2.7 ms after correction | within 10 ms |
| Validation \|residual\| p95 | 53.0 ms (max 60.7 ms) | 50 ms (missed) |
| Drift inside continuous segments | 0.0 ms/min | within 10 ms/min |
| 0 s start segment extra delay | -4.9 ms | |

Suggested and adopted: `CAPTURE_LATENCY_SEC = 0.050 + 0.0778 = 0.128 s`.

The p95 miss does not come from the constant. Residuals are flat inside each continuous segment
(no drift), but the segment medians differ by up to about 80 ms (for example 17.0, 80.5 and 82.5 ms
in one session; 68.0, 30.0 and 41.8 ms in another): every new anchor after a play, pause or seek
lands with its own offset. Reducing that per-anchor jitter is a separate follow-up.


### 2026-11-15, Aside on the Mac mini (main e815c21, VGT-22 median segment start, constant 0.128 s)

Three sessions of the full plan (pause, seek back, 1.5x stretch), one toolbar click by the user; the
agent started the run with a click on the page's 3회 측정 button.

| | Result | Target |
| --- | --- | --- |
| Complete runs | 3 of 3, no missing click, 0 clicks stored from the 1.5x stretch | all |
| Fit (even clicks, 33) | median residual -59.0 ms | |
| Validation (odd clicks, 33) | median -59.0 ms before, -0.0 ms after correction | within 10 ms |
| Validation \|residual\| p95 | 2.3 ms (max 2.3 ms) | 50 ms |
| Drift inside continuous segments | 0.1 ms/min | within 10 ms/min |
| 0 s start segment extra delay | 0.2 ms | |
| Spread of segment medians per session | 0.7 / 0.3 / 0.3 ms | |
| Same run placed by the first report only (before VGT-22) | median 8.7 ms after correction, p95 55.8 ms, spread 11.9 / 61.3 / 48.4 ms | |

Per-segment shift from the first-report start: -0.7 to -83.4 ms, with an IQR of the block estimates of
1.9 to 3.1 ms. Read as the VGT-22 criteria define it, this confirms the startup-delay cause and the fix,
and every target is met. The median before correction (-59.0 ms) is outside 10 ms, so the report's suggested
constant is adopted as the criteria pre-registered: `CAPTURE_LATENCY_SEC = 0.128 + (-0.0590) = 0.069 s`.
The 2026-11-13 constant had also absorbed the first-report startup delay that VGT-22 removed.

A confirmation run with a 0.069 s probe build was prepared the same day but did not start (no capture
within 25 minutes); it is optional. Raw dump and report outside the repository:
`~/vibe-guitar-audio/latency-probe/probe-2026-11-15-e815c21.json`, `report-2026-11-15.txt`.

## VGT-22: per-anchor offset (success criteria, written before the change)

Written on 2026-11-15 before any code change for VGT-22; the targets below are not moved afterwards.

**Real probe (same protocol as above: 3 sessions of the full plan, one toolbar click, `npm run latency-report`):**

| | Target |
| --- | --- |
| Validation \|residual\| p95 (odd clicks, after the report's correction) | ≤ 50 ms |
| Validation median (after the report's correction) | within 10 ms |
| Drift inside continuous segments | within 10 ms/min |
| Clicks stored from the 1.5x stretch | 0 |
| Complete runs | 3 of 3, no missing click |

The protocol, click track and statistics stay as they are. The median target is checked as the report defines
it (validation clicks after the fit correction). `CAPTURE_LATENCY_SEC` stays 0.128 s in the VGT-22 change; if
the post-fix measurement's median before correction is outside 10 ms, the report's suggested constant is adopted
in a separate commit that cites that measurement.

**Evidence before the real measurement (offline, no browser):**

1. Simulated capture through the production path (`AudioPlacer` → `ListeningSession` → click detector →
   `analyzeProbeDump`, `tests/latency-probe.test.ts`) with a model of the suspected cause: after each play or
   seek the element already reports "playing" (play / seeked event and the 250 ms ticks) while its clock stays
   at the start position for a startup delay of 15–80 ms that differs per start. With the current code this
   harness must reproduce what the 2026-11-13 run showed: segment medians spread by tens of ms (at least 40 ms
   max − min in a session) while residuals stay flat inside each segment. After the fix, the same harness must
   give a spread of at most 5 ms and a validation p95 |residual| of at most 10 ms.
2. A negative control in the same harness: if every report in a segment shares the same offset (an offset per
   start in the browser's own pipeline rather than in how an anchor pairs a position with the audio clock),
   the fix is not expected to remove the spread. The test records that, so the real probe decides between the
   two causes.
3. The 0 s start (`ListeningSession.append` clamp): in the simulated session that starts at 0 s, the first
   segment's extra delay must be at most 2 ms after the fix (it is +37.5 ms with the clamp).
4. The probe dump gains, per stored segment, the start that the first anchor alone gave (the current
   placement) next to the stored start, and how far the anchors inside the segment disagree. The report then
   prints, from the same real run, the segment medians and p95 the current placement would have given. Reading
   the real run: anchors inside a segment that disagree by tens of ms and a p95 within target confirm and fix
   the cause; anchors that agree while segment medians still spread mean the offset comes from the browser per
   start, which this change does not fix, and that is reported as such.

## VGT-22: cause and fix (offline evidence)

**Cause.** `ListeningSession.append` fixed a segment's start from the first stored block only: the
position the latest player report gave at that block's end, minus the block length. Later blocks only checked
continuity (0.35 s tolerance) and never moved the start. When the element reports "playing" (its play or
seeked event and the next 250 ms ticks) before its clock and audio really start, the first reports of that
start run ahead by the startup delay, so the whole segment lands late by it, flat until the next pause or
seek. That is the 2026-11-13 shape: a different offset per anchor, no drift inside a segment.

**Fix.** Every block now adds its own estimate of the segment start (its report's end position minus the
segment's audio length after it), and `Segment.startSec` is the median of those estimates. The reports
after the startup agree with each other, so they outvote the first few. `Segment.firstStartSec` keeps the
first block's estimate (the old placement) and the replay path fixes a stored start with `pinStart`.
The start is no longer clamped at 0 s: `ListeningSession.coverage()` and the auto chart's ownership clip
ranges at 0 s instead, so a chart never gets a negative time.

**Offline evidence** (`tests/latency-probe.test.ts`, "VGT-22", the simulated capture through `AudioPlacer`
→ `ListeningSession` → click detector → `analyzeProbeDump`; true latency 80 ms, constant 50 ms; startup
delays per start 15/75/80, 60/20/35 and 40/70/15 ms):

| | Before (first report, 0 s clamp) | After (median) | Criterion |
| --- | --- | --- | --- |
| Segment-median spread per session | 75.0 / 77.5 / 77.5 ms | 0.0 / 0.0 / 0.0 ms | ≤ 5 ms |
| Validation p95 \|residual\| | 52.5 ms | 0.0 ms | ≤ 10 ms |
| Drift | 0.0 ms/min | 0.0 ms/min | |
| Extra offset of the segment from 0 s, no startup delay | +37.5 ms | 0.0 ms | ≤ 2 ms |

Negative control (every report of a start off by 15–80 ms, no startup delay): the spread stays (65 / 40 /
55 ms) after the fix, and the first report's start equals the stored start in every segment. That is the
signature of a per-start offset in the browser's own pipeline, which this change does not address.

The post-seek segment that showed 30.5 ms instead of +80 ms in the earlier reproduction: the block that
contains the seek is dropped ("재생 위치 이동 중"), and in that session a 250 ms report from after the
80 ms startup arrived 2 ms before the first stored block ended, so that block was already placed with a correct
report. 30.5 ms is the unbiased value (80 − 50 ms plus the detector's 0.5 ms edge). In a real run the tick and
block phases are effectively random, so the old placement's error per start lies anywhere between 0 and the
startup delay, which also matches the irregular segment medians measured on 2026-11-13.

**Dump and report.** The probe dump now carries, per stored segment, `firstStartSec` (the first report's
start) and `startIqrSec` (interquartile range of the per-block estimates). `latency-report` prints per
segment the shift between the stored and the first-report start and the IQR, per session the spread of the
segment medians, and one line with what the first-report placement would have given on the same run
(validation median, p95, spreads). The first-report numbers do not include the old 0 s clamp: on the
simulated startup run they are p95 40.0 ms and spreads 75.0 / 40.0 / 70.0 ms (the table's "before" column
adds the clamp).

**Reading the real run** (criteria above): shifts of tens of ms with a small IQR and the targets met confirm
the cause and the fix. Shifts near 0 ms while the segment medians still spread by tens of ms mean a per-start
offset in the browser (the negative control), which is reported as such and not fixed here.
