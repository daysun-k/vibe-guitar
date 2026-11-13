# Capture-latency probe (dev only, VGT-7)

Listening mode places each captured tab-audio block on the song timeline with `AudioPlacer`
(`src/recognize/placement.ts`): the player position at the block's AudioContext time minus
`CAPTURE_LATENCY_SEC` (`src/extension/offscreen/listen.ts`, a 50 ms guess). This probe measures the
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
start of a song, separate from the constant, and it grows when the constant grows.

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

