# Vibe Guitar

Personal tool: while a song plays on YouTube / YouTube Music / Apple Music (desktop Chrome),
show time-synced acoustic guitar chords, fingering diagrams, and skill-level arrangements
(easier voicings, capo, strumming suggestions).

Personal use only; not distributed. Audio never leaves the browser.

- Proposal: [docs/proposal.md](docs/proposal.md)
- Phase 0 manual checklist: [docs/phase0-test-checklist.md](docs/phase0-test-checklist.md)

## Phase 0 prototype (this branch)

A Chrome MV3 extension driven by hand-made chord charts, plus a tab-capture spike.
No recognition model yet, no server, no network calls at runtime.

| Path | What |
|---|---|
| `src/chart/` | Chart v1 types, `chart.schema.json`, runtime validator, beat grid, 2 example charts (fake timings) |
| `src/arrange/` | Chord parser/spelling, voicing DB, level simplification + substitutions, cost model, whole-song DP, capo, strumming |
| `src/editor/core.ts` | Pure editor logic: sequence paste, stamping, tap tempo, quantize, build chart |
| `src/audio/chroma.ts` | RMS and 12-bin chroma for the capture spike |
| `src/extension/` | MV3: service worker, content scripts (YouTube, YouTube Music, experimental Apple Music), offscreen capture, side panel |
| `tests/` | Vitest unit tests |
| `scripts/build.mjs` | esbuild bundle → `dist/` + manifest reference check |

## Load and test

Requirements: Node 20+ and desktop Chrome 116 or newer.

1. Build:
   ```sh
   npm install
   npm run typecheck && npm test && npm run build
   ```
   The build writes the unpacked extension to `dist/`.
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
   - **캡처 (Capture)** tab: audio received yes/no, RMS, sample rate and a live 12-bin chroma.
9. After code changes: `npm run build`, then press the reload icon on the extension card in `chrome://extensions`
   and reload the YouTube tab (old content scripts stop when the extension reloads).

Charts are stored in `chrome.storage.local`, keyed by `chart:<source>:<recording id>`; use the JSON
export/import buttons in the Edit tab to back them up.

Debugging: right-click inside the side panel → Inspect; the service worker and offscreen document are listed
on the extension card (`Inspect views`).
