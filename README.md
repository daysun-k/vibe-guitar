# Vibe Guitar

Personal tool: while a song plays on YouTube / YouTube Music / Apple Music (desktop Chrome),
show time-synced acoustic guitar chords, fingering diagrams, and skill-level arrangements
(easier voicings, capo, strumming suggestions).

Personal use only; not distributed. Audio never leaves the browser.

- Proposal: [docs/proposal.md](docs/proposal.md)
- Phase 0 manual checklist: [docs/phase0-test-checklist.md](docs/phase0-test-checklist.md)

## Phase 0 prototype (this branch)

A Chrome MV3 extension driven by hand-made chord charts, plus listening mode: in-browser beat/downbeat
and chord recognition on the captured tab audio (slice 2). No server, no network calls at runtime;
audio never leaves the browser.

| Path | What |
|---|---|
| `src/chart/` | Chart v1 types, `chart.schema.json`, runtime validator, beat grid, 2 example charts (fake timings) |
| `src/arrange/` | Chord parser/spelling, voicing DB, level simplification + substitutions, cost model, whole-song DP, capo, strumming |
| `src/editor/core.ts` | Pure editor logic: sequence paste, stamping, tap tempo, quantize, build chart |
| `src/audio/` | RMS/chroma (capture readout), FFT, streaming resampler, model features (log-mel for Beat This!, librosa-style CQT for BTC) |
| `src/recognize/` | Beat This! chunking + peak picking, BTC windows + vocabulary + beat-synchronous Viterbi, listening session, auto chart |
| `src/eval/metrics.ts` | WCSR (majmin/root/sevenths), beat F-measure, chart-vs-chart comparison |
| `src/bench/` | Synthetic labeled set and benchmark core (Node script and in-extension bench page) |
| `scripts/fetch-models.mjs` | Downloads the pinned models (sha256-checked) into `models/` (gitignored) |
| `src/extension/` | MV3: service worker, content scripts (YouTube, YouTube Music, experimental Apple Music), offscreen capture, side panel |
| `tests/` | Vitest unit tests |
| `scripts/build.mjs` | esbuild bundle → `dist/` + manifest reference check |

## Load and test

Requirements: Node 20+ and desktop Chrome 116 or newer.

1. Build:
   ```sh
   npm install
   npm run fetch-models          # once: ~22 MB into models/ (see "Models" below)
   npm run typecheck && npm test && npm run build
   ```
   The build writes the unpacked extension to `dist/` (about 46 MB: models + onnxruntime-web WASM).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `dist/` folder of this repository.
5. Pin the extension: puzzle-piece icon in the toolbar → pin **Vibe Guitar (phase 0, personal)**.
6. Open a song on `https://www.youtube.com/watch?v=…` or `https://music.youtube.com/watch?v=…` and start playback.
7. Click the **Vibe Guitar** toolbar icon. This opens the side panel **and** starts tab-audio capture for that tab
   (Chrome only allows tab capture after you click the extension). The tab should stay audible.
8. In the side panel:
   - **연주 (Play)** tab: the header shows the video id and the playback state. With no chart you will see
     "이 곡의 코드표가 없습니다".
   - **편집 (Edit)** tab: either attach an example ("예시를 현재 곡에 연결해 저장"; timings are fake), or make a
     real chart: paste the chord sequence → 코드 읽기 → tap tempo (T, first tap on a downbeat) → play the song
     and press **J** (or click the big button) at each chord change → 이 곡에 저장.
     Click inside the panel first so it receives key presses; when the YouTube page has focus use the
     global shortcuts Alt+Shift+K (stamp) and Alt+Shift+T (tap tempo). Check or change them at
     `chrome://extensions/shortcuts`.
   - **캡처 (Capture)** tab: audio received yes/no, RMS, sample rate, a live 12-bin chroma, and the
     recognition model state / backend (WASM or WebGPU).
9. After code changes: `npm run build`, then press the reload icon on the extension card in `chrome://extensions`
   and reload the YouTube tab (old content scripts stop when the extension reloads).

## Listening mode (recognition)

After the toolbar click starts capture, the offscreen document also runs listening mode:

- **연주** tab → card **듣기 모드 · 인식 중**: the chord the model hears now (about 1 s late; for "what is
  this chord?", not for play-along), the heard coverage of the song, and whether audio is being recorded.
  Audio is stored only while the song plays at 1x with no ad; pauses and seeks start a new segment. Each
  captured block is placed by its AudioContext sample time (player reports are mapped to that clock), so late
  message delivery does not move audio on the timeline.
- When at least 90 % of the song was heard and playback reaches the end, an **auto chart** is built with full
  context (Beat This! beats/downbeats, BTC chords smoothed per beat). Or press
  **들은 구간으로 자동 코드표 만들기** at any time. Auto charts have `source: auto` events with per-event
  confidence and coverage only for the heard ranges.
- Storage: the auto chart becomes the chart in use only if the recording has no chart or only an older auto
  chart. If you made a chart by hand, it is kept; the card then shows the agreement between your chart and the
  auto chart and a **자동 코드표로 바꾸기** button (asks first; the replaced chart is kept under
  `chartbackup:<source>:<id>`). The latest auto chart is always kept under `autochart:<source>:<id>`.
  A new auto chart is merged with the stored one: it wins where it has coverage, the earlier chart keeps the
  ranges only it heard, so a short re-analysis never shrinks coverage. All chart writes (editor save, import,
  auto chart, adopt) run one at a time in the service worker, so an auto chart cannot overwrite a chart you
  saved while it was being stored.
- YouTube Music: the adapter reports the id of what the player is actually playing
  (`movie_player.getVideoData()`), which can differ from the URL `v=`; a yellow notice shows when it differs or
  when only the URL id was available.

## Models

| File | Model | Source | License | Size |
|---|---|---|---|---|
| `beat_this_small.onnx` | Beat This! small0 (CPJKU, ISMIR 2024), beats + downbeats | ONNX export in [Andremi/audioweb-models](https://huggingface.co/Andremi/audioweb-models) @953d0a9, upstream [CPJKU/beat_this](https://github.com/CPJKU/beat_this) | MIT | 4.92 MB |
| `btc_large_voca.onnx` | BTC, 170 chord classes (Park et al., ISMIR 2019) | same repo, upstream [jayg996/BTC-ISMIR19](https://github.com/jayg996/BTC-ISMIR19) | MIT per upstream and the export notice; another redistributor labels these weights CC-BY-NC-SA 4.0. Fine for personal use; recheck before any distribution. | 6.47 MB |
| `btc_meta.json` | BTC normalization + labels | same repo | MIT | 4 KB |
| `btc_majmin.onnx` | BTC 25 classes (benchmark comparison only, not packaged) | same repo | as above | 6.44 MB |
| `mel-filterbank.bin` | torchaudio mel filterbank (test reference only, not packaged) | [musetric/beat-this-onnx](https://huggingface.co/musetric/beat-this-onnx) @2530870 | MIT | 0.26 MB |

All files are pinned by revision and sha256 in `scripts/models.manifest.json`; `fetch-models` refuses mismatches.
Runtime: `onnxruntime-web` 1.31.1 (WASM; WebGPU for the beat model when available and numerically equal to WASM).

## Benchmark

```sh
npm run bench                     # onnxruntime-node (CPU), 24 synthetic clips → bench-out/bench-node.json
npm run bench -- --runtime web    # onnxruntime-web WASM inside Node
npm run bench -- --compare my-chart.json auto-chart.json   # chart-vs-chart agreement (exported JSON)
```

In the browser: open `chrome-extension://<extension id>/bench.html` (link in the 캡처 tab) and press
**WASM으로 실행** or **WebGPU로 실행**. Results and caveats: [docs/phase0-benchmark.md](docs/phase0-benchmark.md).
Optional feature parity check against librosa: `uv run --with librosa==0.10.2.post1 --with numpy python
scripts/verify-features.py`, then `npm test`.

Charts are stored in `chrome.storage.local`, keyed by `chart:<source>:<recording id>`; use the JSON
export/import buttons in the Edit tab to back them up.

Debugging: right-click inside the side panel → Inspect; the service worker and offscreen document are listed
on the extension card (`Inspect views`).
