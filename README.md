# Vibe Guitar

Personal tool: while a song plays on YouTube / YouTube Music / Apple Music (desktop Chrome),
show time-synced acoustic guitar chords, fingering diagrams, and skill-level arrangements
(easier voicings, capo, strumming suggestions).

Personal use only; not distributed. Audio never leaves the browser. Besides the optional lyrics lookup
(song title, artist and duration go to [LRCLIB](https://lrclib.net), once per recording; setting
"가사 가져오기", on by default), data leaves the browser only when "휴대폰 악보대" is on (off by default):
then the shown chords, bars and playback position go through a relay on this Mac (`npm run phone`) to a
phone on the local network. Audio and lyrics never do. See [Phone music stand](#phone-music-stand-휴대폰-악보대).

- Proposal: [docs/proposal.md](docs/proposal.md)
- Phase 0 manual checklist: [docs/phase0-test-checklist.md](docs/phase0-test-checklist.md)

## Phase 0 prototype (this branch)

A Chrome MV3 extension driven by hand-made chord charts, plus listening mode: in-browser beat/downbeat
and chord recognition on the captured tab audio (slice 2). No server; audio never leaves the browser.
The only runtime network calls are the lyrics lookup described in [Lyrics](#lyrics-lrclib) and, when turned
on, the loopback connection to the [phone music stand](#phone-music-stand-휴대폰-악보대) relay.

| Path | What |
|---|---|
| `src/chart/` | Chart v1 types, `chart.schema.json`, runtime validator, beat grid, 2 example charts (fake timings) |
| `src/arrange/` | Chord parser/spelling, voicing DB, level simplification + substitutions, cost model, whole-song DP, capo, strumming |
| `src/editor/core.ts` | Pure editor logic: sequence paste, stamping, tap tempo, quantize, build chart |
| `src/audio/` | RMS/chroma (capture readout), FFT, streaming resampler, model features (log-mel for Beat This!, librosa-style CQT for BTC) |
| `src/recognize/` | Beat This! chunking + peak picking, BTC windows + vocabulary + beat-synchronous Viterbi, listening session, auto chart |
| `src/music/` | Key estimation + key-aware spelling (`key.ts`), big beats for compound meter and bar-phase correction (`meter.ts`) |
| `src/lyrics/` | LRCLIB client and parsers (`lrclib.ts`), lyric↔chart offset, chord-over-word placement, pinned line (`align.ts`) |
| `src/play/` | Play-view model (`model.ts`), lane/sections/strip (`lane.ts`), demo clock and synthetic demo song (`demo.ts`) |
| `src/phone/` | Phone music stand: song view (`song-view.ts`), wire protocol and timing (`protocol.ts`), relay (`relay.ts`), WebSocket frames, QR encoder, phone page (`viewer.ts/html`) |
| `scripts/phone.mjs`, `scripts/phone-check.mjs` | `npm run phone` (relay + QR) and `npm run phone-check` (scripted relay checks) |
| `Vibe Guitar Phone.command` | double-click launcher for `npm run phone` (macOS Finder) |
| `src/eval/metrics.ts` | WCSR (majmin/root/sevenths), beat F-measure, chart-vs-chart comparison |
| `src/bench/` | Synthetic labeled set and benchmark core (Node script and in-extension bench page) |
| `scripts/fetch-models.mjs` | Downloads the pinned models (sha256-checked) into `models/` (gitignored) |
| `src/extension/` | MV3: service worker, content scripts (YouTube, YouTube Music, experimental Apple Music), offscreen capture, side panel |
| `tests/` | Vitest unit tests |
| `scripts/build.mjs` | esbuild bundle → `dist/` + manifest reference check |
| `scripts/screens.mjs` | Headless-Chromium screenshots of `sidepanel.html?demo=1` into `docs/screens/` (no network) |

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
   - **연주 (Play)** tab: song title/artist, the chord-shape strip, the pinned lyric line and the bar grid
     (see [Play view](#play-view)). With no chart you will see "이 곡의 코드표가 아직 없어요".
   - **편집 (Edit)** tab: either attach an example ("예시를 현재 곡에 연결해 저장"; timings are fake), or make a
     real chart: paste the chord sequence → 코드 읽기 → tap tempo (T, first tap on a downbeat) → play the song
     and press **J** (or click the big button) at each chord change → 이 곡에 저장.
     Click inside the panel first so it receives key presses; when the YouTube page has focus use the
     global shortcuts Alt+Shift+K (stamp) and Alt+Shift+T (tap tempo). Check or change them at
     `chrome://extensions/shortcuts`.
     Saving a loaded auto (or edited) chart keeps what the recognizer knew when the chord times are
     unchanged: untouched chords keep their source and confidence, the heard ranges keep their gaps, and
     only changed chords become manual. If times changed (re-stamped), every chord becomes manual and the
     heard range becomes one range; the save status says which happened. To fix a single wrong chord,
     "코드 고치기" in the Play tab is simpler.
   - **듣기·캡처 (Listen / Capture)** tab: listening-mode progress, audio received yes/no, RMS, sample rate,
     a live 12-bin chroma, the recognition model state / backend (WASM or WebGPU) and the player readout
     (adapter, video id, state).
   - **설정 (Settings)** tab: personal profile, the song's shapes with "잡을 수 있음" toggles, sync offset,
     count-in click and an analysis readout (key, meter, bar-phase fix, lyric offset).
9. After code changes: `npm run build`, then press the reload icon on the extension card in `chrome://extensions`
   and reload the YouTube tab (old content scripts stop when the extension reloads).

## Play view

Port of the approved mockup B ("진행표형", diagrams 3x):

- **Header**: title and artist, one badge ("자동 코드표 · 사람이 확인하지 않음" for auto charts, "자동 코드표 ·
  N곳 고침 · 나머지는 미확인" (narrow: "자동 · 일부 고침") once some chords of an auto chart were fixed, "예시
  코드표" for bundled examples, nothing for manual charts; click it for a short explanation) and a level/capo chip
  that opens the **settings sheet** (난이도, 카포, 미리 알림, 카운트인 끔/1마디/2마디, 실제 음 이름 보기 (off),
  가사 가져오기 (on), 추천 반주, 데모 재생).
- **Chord-shape strip**: exactly three slots with 120 px diagrams and finger numbers: the current shape,
  the next one and the one after it (not every shape of the song). Current shape: accent border; next
  shape: neutral border with the big-beat countdown.
- **Pinned lyric line** (only when lyrics exist): the line sung at the playhead with chord names over the
  words where the changes happen, the current word underlined and the current chord highlighted; the next
  line small below. Between sung parts: "♪ 연주만 나와요".
- **Bar grid**: 4 bars per row (44 px cells, 40 px under 340 px), section labels (from lyrics: 인트로, N절,
  후렴, 간주, 아웃트로; without lyrics: groups of 8 bars), repeat bars as %, one tick per big beat, a playhead
  line, auto-follow with "현재 위치로" after manual scrolling, click a bar to seek, and a "soon" border on the
  bar of the next change.
- **Transport**: seek bar with section ticks, play/pause (with the count-in when it is on), time, section
  and the **코드 고치기** button; below them the speed buttons and **구간 반복**. Play/pause/seek/speed control
  the YouTube (and YouTube Music) player through the content script.
- **Speed (0.5× / 0.75× / 1×)**: sets the player's playback rate (the demo clock in demo playback). The
  buttons show the rate the player reports, so a change in the site's own speed menu shows there too (a rate
  other than the three is shown next to them, e.g. "1.25×"). The speed stays until the user changes it; when
  another recording plays in that tab, a speed the panel set goes back to 1×. Not during an ad. The Apple
  Music adapter supports speed only through a media element (not MusicKit).
- **A/B loop (구간 반복)**: press it, then press the first and the last bar of the passage in the bar grid
  (either order; the same bar twice loops one bar). Only while choosing do bar presses pick bars; otherwise
  a bar press still seeks. The looped bars are tinted green with A and B tags and playback moves to A; when
  playback passes the end of B it seeks back to the start of A. "반복 해제" clears it with one press. The
  loop uses the chart's bar grid (not lyric lines). It clears on a recording or tab change, on entering or
  leaving demo playback, and when the chart changes so that its bars no longer exist ("코드표가 바뀌어 반복을
  풀었어요"); a chord fix or a level/capo change keeps it. The jump is decided from the player's observed
  position, not from the seek reply: after a seek the panel waits until the reported position is back near
  the target (at most 1.5 s, then judges from the current position), a crossing of B up to 3 s late still
  jumps, a move more than 3 s past B (the site's own slider) does not, and nothing jumps while an ad plays or
  while paused. With the loop on, play outside the loop starts at A.
- **Count-in with speed and loop**: an explicit start (play button or Space) counts in, from A when the loop
  is on and the playhead is outside it, else from the current bar, timed for the current speed. Automatic
  loop repeats only seek and never count in. A speed change during a count-in cancels it ("속도가 바뀌어서
  카운트인을 멈췄어요. 다시 눌러 주세요.").
- **Fixing one chord (코드 고치기)**: the button opens a small panel at the chord under the playhead (‹ ›
  step to the previous/next chord and seek there; the bar gets a dashed outline). Pick a root and a kind (or
  코드 없음) and press "이 코드로 고치기". A bass row (베이스 없음 or /C … /B) keeps a slash chord's bass
  by default (C/B → pick Am → Am/B) and lets you change or remove it; a bass equal to the root is no slash. Names follow the screen: with a capo the picker shows shape names
  (the sounding name only as a small extra when 실제 음 이름 보기 is on); the chart stores the sounding chord,
  moved up by the capo and spelled for the key (shape G with capo 1 in A♭ major → A♭). Only that event's
  chord changes: its time, every other chord with its confidence and the heard ranges stay. The event
  becomes a manual event and the chart `edited`, so a later auto analysis waits as pending instead of
  replacing it. The write goes through the service worker's serialized chart writes (`ChartStore.correctEvent`),
  so it applies to the stored chart even if an auto chart arrived meanwhile. "되돌리기" in the status line
  undoes the last fix while the stored chart is still the fixed one. Clicking a bar still only seeks. In demo
  playback the fix changes only the in-memory demo chart.
- **Uncertainty** is shown only by the badge, plus at 중급/상급 an actionable hint such as "Em도 돼요" on
  low-confidence 7th chords. 입문 reduces 7/maj7 to triads; the change mark (●) and its tooltip say so (no
  superscript 7 next to the name).

Music fixes applied before drawing (pure functions in `src/music/`, tests in `tests/music.test.ts`):

- **Key-aware spelling**: all 24 keys are scored by how well the duration-weighted chords fit the key's
  diatonic triads (+ a tonic and dominant bonus that separates relative major/minor); roots and slash basses
  are then spelled with that key's letters (a recognizer's G#, C#, D# in A♭ major → A♭, D♭, E♭).
- **Bar phase**: chord changes are voted onto beat positions in the bar; when another position clearly
  wins (3+ more changes and 1.5× the current one), the grid is shifted so that position is the downbeat
  (explicit beat times are kept; synthetic beats are prepended).
- **Compound meter**: a 6/9/12-beat bar counted in eighths (beatUnit 8, or a tracker tempo ≥ 120) counts
  dotted-quarter big beats for the countdown, look-ahead and count-in.

## Lyrics (LRCLIB)

The service worker (`src/extension/lyrics-service.ts`) answers the side panel's `lyrics-get` message:

1. Cache first: `lyrics:<source>:<id>` in `chrome.storage.local` (YouTube and YouTube Music share ids).
2. Only for a recording that has a chart, when "가사 가져오기" is on and the player reports a duration:
   `GET https://lrclib.net/api/get` with
   `artist_name`, `track_name`, `duration`; on 404 `GET /api/search` and pick the result with word timing
   and a duration within ±4 s. The YouTube title is cleaned first ("Artist - Title [Official Lyric Video]"
   → artist + title; "- Topic"/"VEVO" channel suffixes removed).
3. Parse `lyricsfile` (YAML with per-word `start_ms`); fall back to `syncedLyrics` (LRC, line level, word
   times interpolated) and then to no lyrics. Found and not-found results are cached (one request per
   recording); network errors are not cached, so the next visit retries.

Lyrics are stored only in this browser; none are in the repository or tests (tests use synthetic text).
The side panel then estimates a constant lyric→chart offset: it slides the lyrics over −1.5…+1.5 s (50 ms
steps) and keeps the shift with the most chord changes within ±0.15 s of a word onset (ties: the smallest
total distance). The shift is used only when it beats the unshifted lyrics by 3+ changes and the scan's
median (chance level) by 25 % and 4+ changes; otherwise it stays 0.

## Phone music stand (휴대폰 악보대)

Stand a phone next to the guitar like a music stand: it shows the current chord and the next one side by
side with their diagrams, the big beats left until the change, the bar/section and "카포 N 모양" when a capo
is used, while the song plays on the Mac. Portrait and landscape both work.

**Run it**

1. `npm run build`, reload the extension, then in the panel: 연주 설정 › **휴대폰 악보대** on. The sheet shows
   연결 안 됨 / 연결됨 · 휴대폰 n대.
2. Start the relay: double-click **`Vibe Guitar Phone.command`** in this folder in Finder. A Terminal window
   opens and prints a QR code and `http://192.168.x.x:47822/?t=…`; keep that window open while playing. It is
   the same as `npm run phone` in a terminal in this repository, which still works (extra options go after
   `--`, e.g. `npm run phone -- --idle-minutes 20`; the launcher passes them on too when started from a
   terminal). The first time, macOS may ask whether node may accept incoming connections: allow it (or later
   in System Settings › Network › Firewall › Options). Wrong Wi-Fi address picked: `npm run phone -- --host
   192.168.x.x` (one private IPv4 of this Mac; `0`, `0.0.0.0`, `::`, hostnames and loopback are refused).
3. Put the phone on **the same home Wi-Fi** and scan the QR code (or type the address).
4. Turn off the phone's auto-lock while playing (the page says so once): plain http on the home network cannot
   use the browser's keep-screen-on feature. iPhone: 설정 › 디스플레이 및 밝기 › 자동 잠금 › 안 함; Android:
   설정 › 디스플레이 › 화면 자동 꺼짐. Turn it back afterwards.
5. Stop by closing that Terminal window or pressing **Ctrl+C** in it. If you forget, it stops by itself: when no
   side panel has been connected for 10 minutes (휴대폰 악보대 switched off, panel closed, Chrome quit) it closes
   both ports and exits with "패널이 10분 동안 연결되지 않아 중계기를 껐습니다". A phone that is still connected does
   not keep it running; switching the panel back on within the 10 minutes does. `--idle-minutes <n>` changes
   the time (default 10, minimum 1). Each run makes a new token, so scan the new QR code after a restart.

**About the launcher.** It installs nothing and needs no administrator password. It looks for Node in the
usual places even when Finder's PATH lacks them (`/opt/homebrew/bin`, `/usr/local/bin`, nvm's default) and
says so in Korean when Node 20+ is missing or `npm ci` has not been run in this folder yet. Double-clicking it
again while the relay runs is refused with a message (it checks whether the relay's ports already answer and
never stops a process it did not start); the first window keeps working. Gatekeeper: a file that comes from
`git clone`/`git pull` carries no download quarantine mark, so macOS opens it in Terminal without a warning
(checked on macOS 27.2: `xattr` shows only `com.apple.provenance`). Only if the repository arrived as a
browser-downloaded zip may macOS refuse to open it with a message that Apple could not check it; then allow it once under System
Settings › Privacy & Security › "Open Anyway", or run `npm run phone` instead. The file must keep its execute
permission (git stores it); after copying it elsewhere by hand, `chmod +x "Vibe Guitar Phone.command"`.

**What is sent, and where.** The side panel (a visible extension page; it exists only while the panel is open)
connects to `ws://127.0.0.1:47821/publish` on this Mac. It sends a *song view* built from the same play model
the panel draws (arranged chord events with the same shape names and diagram fingerings, sounding names, bars,
section names such as "1절"/"후렴", the beat grid, capo, the 실제 음 이름 보기 setting, title and artist) and
small *anchors* (position, rate, paused, ad, loop range, sequence number, sampling time) on every play/pause,
seek, rate, ad or loop change and once a second. Never sent: audio, lyrics, chart history, drafts or storage
keys. The relay keeps only the latest song view and anchor in memory, forwards them to the phone and writes
nothing to disk. The phone extrapolates `position + rate × elapsed` from the anchor, using a clock offset it
measures with pings to the relay, and holds the chord while paused (shows "광고 중" during ads).

**Security choices.** The publisher port listens on `127.0.0.1` only and accepts only a WebSocket whose `Host`
is the loopback address and whose `Origin` is this extension (by default the id Chrome gives an unpacked
extension loaded from this repository's `dist/` folder; `--extension-id <id>` for another folder,
`--any-extension` to accept any Chrome extension on this Mac). The phone port listens on one LAN IPv4
address (never `0.0.0.0`) and needs a per-run 128-bit token from the QR URL on both the page and its
WebSocket, plus an exact `Host` (DNS rebinding) and `Origin` match. The token is access control, **not
encryption**: traffic is plain http, so use it only on a trusted home Wi-Fi, not on public Wi-Fi. Frames over
8 KiB, malformed or unknown messages, more than 40 messages a second, more than 4 phones and 20 s of silence
close the connection; a song view larger than one frame is sent in up to 16 parts and checked as a whole
before any phone sees it. The phone page sends only clock pings and, with phone control (below), the two
commands; it is served with
`Cache-Control: no-store` and a CSP that allows only its own script and WebSocket. No manifest change: the
extension pages' CSP has no `connect-src` limit, so `ws://127.0.0.1` needs no permission.

**Phone control (휴대폰에서 조작 허용, off by default).** With 휴대폰 악보대 on, a second switch appears:
휴대폰에서 조작 허용. While it is on, a phone that opens the stand page shows a 4-digit code, and the settings
sheet lists every connected phone's code with **승인** / **거절**. Approve only the code your own phone shows.
The approved phone gets two large buttons, **재생/일시정지** and **처음부터** (back to loop A when a loop is
set, otherwise to the start of the current bar; it keeps playing or paused). Nothing else can be controlled
from the phone: no seeking to a chosen time, no speed, no other tab or page. Anyone with the QR URL can still
*watch*, but only the one approved phone can *control*. The approval belongs to that one connection and this
panel session; it ends with **승인 해제**, when the switch goes off, when the phone disconnects or reloads,
when the panel closes or another window's panel takes over, and when the relay restarts. Nothing about it is
stored. The relay forwards a command only from the approved connection, only while control is on, only for the
song the panel currently shows, with an increasing request id and at most about 4 per second (excess is
rejected, never queued); the panel checks all of that again and refuses during ads or without a controllable
player. A command runs through the panel's own play button and bar-click seek (count-in, loop start and
"pause cancels the count-in" included), and the phone hears the outcome only after the panel saw the player
change (up to 3 s); 처음부터 counts only once the observed position is at the target. The panel stops
accepting the phone's commands the moment you press 승인 해제 or 거절, approve another phone or switch control
off, without waiting for the relay. When the phone loses control while one of its commands is still running,
the panel sends nothing further for it: no next seek or play, and a count-in it started stops before playing;
the phone, if still connected, then hears "조작 권한이 바뀌어서 취소했어요". A pause, seek or play already sent
before that may still take effect, and the phone is then told what the player actually did.
A tap on the phone does not count as a click on the Mac's page, so Chrome may block a
remote play until the page has been clicked once: the phone then says "맥에서 한 번 재생을 눌러 주세요". Use it
on a trusted home Wi-Fi only (plain http, see above).

**Checks.** `npm run phone-check` starts the relay on this Mac's LAN address, checks the access rules and
malformed input, publishes the real demo song view (also split into parts), and measures how far a scripted
phone's extrapolated chord changes land from the panel's (same Mac, so Wi-Fi delay is not included; the
target is ≤ 100 ms; on the development Mac the worst case was under 2 ms). It also runs a second relay with a
1.5 s idle time to check the idle auto-stop (stays up with a panel, stops once only a phone is left, both ports
closed), and checks phone control: a command is refused while control is off and from an unapproved phone,
reaches the fake panel once approved, and is refused again after the switch goes off. Real-phone steps:
[checklist section G](docs/phase0-test-checklist.md#g-phone-music-stand-휴대폰-악보대--real-phone).

## Demo playback and screenshots

`sidepanel.html?demo=1` (or "데모 재생" in the settings sheet, or the empty-state button) replays a chart with a
simulated clock: the current recording's chart, any stored chart chosen in the demo bar, or a built-in
synthetic song (made-up 6/8 progression in A♭ named with sharps, a beat grid that starts mid-bar, and
placeholder lyrics 0.4 s early) that exercises the spelling, phase and offset fixes. Stored recordings use
cached lyrics only (no request in demo mode). Query parameters: `t=<sec>`, `play`, `rate=0.5|0.75`,
`loop=<a>-<b>` (mark bars a–b, 1-based, as the loop),
`theme=light|dark`, `level=beginner|novice|intermediate|advanced`, `capo=auto|0..7`, `snd` (sounding
names), `sheet=1`, `lyrics=0`, `mute` (no count-in click), `phonectl` (휴대폰에서 조작 허용 on), `phone` (휴대폰 악보대 switch on; connects to
`127.0.0.1` only).

Opened outside the extension (file://) the page runs the synthetic demo with default settings, which is
how `node scripts/screens.mjs` (after `npm run build`) writes `docs/screens/*.png` at 400 and 600 px, light
and dark. It uses `$CHROME` or Playwright's cached Chromium, blocks every http(s) request and needs no
extra npm dependency.

## Listening mode (recognition)

After the toolbar click starts capture, the offscreen document also runs listening mode:

- **듣기·캡처** tab → card **듣기 모드 · 인식 중**: the chord the model hears now (about 1 s late; for "what is
  this chord?", not for play-along), the heard coverage of the song, and whether audio is being recorded.
  Audio is stored only while the song plays at 1x with no ad; pauses and seeks start a new segment. Each
  captured block is placed by its AudioContext sample time (player reports are mapped to that clock), so late
  message delivery does not move audio on the timeline. Practice at 0.5×/0.75× is therefore never stored, and
  each A/B loop jump starts a new segment, so coverage lists only the looped bars, not the gap a jump skips.
  Every 1× loop pass is stored again; the 20-minute per-session cap (`MAX_SESSION_SEC`) bounds that, and once
  it is reached listening stops storing for that session.
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
- **정확도 모아 보기** (듣기·캡처 tab, collapsed): every stored recording that has both your chart and an auto
  chart, compared with the same numbers as `npm run bench -- --compare` (overlap, majmin / root / sevenths
  WCSR), plus the chord-change timing: for each of your chord changes inside the overlap, the nearest auto
  change within ±1 s, reported as the median offset (auto minus yours, ms) with matched and unmatched counts.
  Your chart is the chart in use when it is manual or edited, otherwise the hand-made chart kept in
  `chartbackup:`; bundled examples are skipped. Totals are weighted by evaluated seconds. Fixed auto charts
  (`edited`, see 코드 고치기) are listed as 고친 코드표(일부만 직접 확인) and totalled separately: their unfixed
  chords and all their times are still the auto chart's, so they inflate agreement and say nothing about timing:
  their timing is not measured (null in the export) and every timing total pools hand-made charts only.
  From at least 5 matched changes of hand-made charts it suggests a 싱크 오프셋 for playing auto charts (an
  estimate; nothing is changed automatically, and the 50 ms capture latency constant stays as is).
  **결과 내보내기** downloads one JSON file with the per-song numbers and totals (no audio, lyrics or chords).
  `npm run accuracy-report -- <export.json> [more.json ...] [--out <file.html>]` turns one or more of those files
  into one self-contained Korean HTML report (inline CSS and SVG, no scripts, no network; default
  `<export>-report.html` next to the first file, path printed): overall 장·단 / 근음 / 7th 포함 with the evaluated
  time, a per-song bar chart and table (stacks on a phone), the suggested 싱크 오프셋 for 설정 → 싱크 보정 (same rule
  as the panel, marked as rough below 20 matched changes) and a plain-language "이 숫자가 뜻하는 것". Several files
  are merged by recording (`source:id`, latest `exportedAt` wins) and totals are recomputed with
  `src/eval/overview.ts`; the export keeps only each song's median offset, so a merged timing total is the
  median of song medians weighted by matched changes (one unmerged file uses its own exact total). Synthetic
  sample: `tests/fixtures/accuracy-export-sample.json`.
  It reads storage only, each time the section opens, one song per task on the panel's thread (about 1.5 ms
  for a 4-minute song), so it needs no worker.
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
