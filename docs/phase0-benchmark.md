# Phase 0 recognition benchmark (VGT-7)

Measured 2026-11-09 on an Apple Silicon Mac (darwin/arm64), node v26.13.0, onnxruntime 1.31.1.
Raw logs were produced in `bench-out/` (gitignored): `log-node.txt`, `log-web.txt`, `log-browser-webgpu.txt`.
Reproduce with the commands in the README "Benchmark" section.

## Data

24 synthetic labeled clips, 825 s total: 72 / 96 / 120 / 150 bpm; 4/4 and 3/4; piano, guitar, pad and
electric-piano timbres; close, inversion and guitar-style voicings; with or without drums and bass; some with
white noise at 20 dB or 10 dB SNR. Labels are exact because the audio is rendered from the labels.

**Caveat: synthetic audio is not real music.** There are no vocals, no real instruments, no mixing and
no ambiguous harmony, so real-song accuracy will be lower. Treat these numbers as a pipeline sanity check
and a speed measurement, not as an accuracy claim. Real accuracy needs the user's hand-made charts
(`npm run bench -- --compare my-chart.json auto-chart.json`).

## Speed (real-time factor, lower is faster; 1.0 = as long as the audio)

| Runtime | Resample | Features | Beats | Chords | Total RTF |
|---|---|---|---|---|---|
| onnxruntime-node (CPU) | 0.0027 | 0.0098 | 0.0111 | 0.0009 | **0.024** |
| onnxruntime-web WASM in Node (1 thread) | 0.0025 | 0.0089 | 0.0908 | 0.0029 | **0.105** |
| Headless Chromium 158, beat model on WebGPU, chords on WASM | 0.0107 | 0.0243 | 0.0063 | 0.0033 | **0.045** |

Latency per model call:

| Runtime | Beat This! 1500-frame chunk (30 s), median / p90 | BTC 108-frame window, median / p90 |
|---|---|---|
| onnxruntime-node | 263 / 368 ms | 8.5 / 13.4 ms |
| WASM in Node | 1605 / 1742 ms | 17.0 / 19.0 ms |
| Chromium WebGPU (beats) / WASM (chords) | 101 / 119 ms | 18.4 ms median |

Even the slowest path (WASM) analyses a song about ten times faster than it plays, so listening mode keeps up
on this machine. Live latency of the capture path itself (worklet buffering, assumed about 50 ms) was not
measured headless.

## Accuracy on the synthetic set

Weighted chord symbol recall (WCSR) and beat metrics:

| Metric | Node CPU and WASM (identical) | Chromium WebGPU/WASM |
|---|---|---|
| WCSR major/minor | **97.1%** | 95.6% |
| WCSR root | 95.2% | 93.6% |
| WCSR sevenths | 90.0% | 88.6% |
| Beat F-measure | 0.838 | 0.818 |
| Downbeat F-measure | 0.890 | 0.799 |
| Tempo within 4% | 62.5% | 62.5% |
| Meter correct | 66.7% | 58.3% |

The browser numbers differ from Node because the in-page path resamples and computes features in the
browser; the cause of the small gap was not isolated in this slice.

Ablations (major/minor WCSR, Node): frame-wise argmax without smoothing 96.5%; without beat-synchronous
units 89.4%; BTC 25-class model 97.0% (no gain over the 170-class model, so it is not packaged).

## Observed failure modes

- **Half tempo without drums:** clips without drums at 96 and 150 bpm were tracked at half tempo
  (for example 96 → 48 bpm), which halves beat F to about 0.65 and often reports 2/4 instead of 4/4.
  Chord accuracy stayed high on those clips because chords change slower than beats.
- **Worst clip:** syn12 (150 bpm 3/4, pad timbre, 10 dB noise) scored 58.4% major/minor and beat F 0.33.
- **Root errors on guitar-style voicings:** syn03 and syn06 kept major/minor near 99% but root dropped to
  about 75%, consistent with sus2/sus4 and inversion root ambiguity.
- **Sevenths:** the sevenths score varies from 50% to 100% per clip (for example syn19 49.6%).
- Feature parity: the TypeScript CQT matches librosa with mean |Δlog| 0.089 and no systematic bias.

## Not covered

- Real songs, vocals and dense mixes (needs user charts).
- The live tabCapture path end to end; only the user's browser can exercise it.
- Apple Music (DRM capture result still unknown).
