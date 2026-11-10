# Phase 0 manual test checklist

Things only a person with Chrome, a guitar and the real services can check. Record the result
(date, Chrome version, OK / not OK, notes) next to each item. Build and load first: see README "Load and test".

## A. Position sync: YouTube and YouTube Music

- [ ] **YouTube**: open a `watch?v=` page and play. The side panel header shows the right video id, title and
      "재생"; the time in the header advances smoothly.
- [ ] Pause, seek (click the progress bar, arrow keys), change speed (0.75x / 1.25x). The header and the
      chord display follow within about 0.3 s.
- [ ] **SPA navigation**: click another video from the recommendations (no full page reload). The header
      switches to the new id and the chart for the new id loads (or "코드표가 없습니다").
- [ ] **Ads**: when an ad plays, the header shows "광고" and the red banner appears; chords do not advance.
      Note whether detection missed any ad format.
- [ ] **YouTube Music**: open `music.youtube.com`, play a song from search, a playlist and the radio queue.
      The id matches the song that is actually playing; title and artist are right; next-track changes are
      picked up.
- [ ] **YouTube Music recording identity**: open `music.youtube.com/watch?v=iKzRIweSBLA`. If the player plays
      a different recording (e.g. "Perfect Duet"), the header shows that recording's own id (not
      iKzRIweSBLA) and a yellow notice "주소의 v=iKzRIweSBLA와 다른 녹음이 재생 중입니다". Record both ids.
      A chart saved now is stored under the playing id (check 편집 → JSON 내보내기 file name).
- [ ] Switching browser tabs: the panel follows the active tab's player.
- [ ] Measure drift: with a hand-made chart, does the chord change land on the audible change? Adjust
      설정 → 싱크 보정 and write down the offset that feels right (ms) for each site.

## B. Tab audio capture

- [ ] YouTube: click the toolbar icon. 캡처 tab shows 상태 "캡처 중", 오디오 수신 "예", a moving RMS value,
      the sample rate (usually 48000 Hz), and chroma bars that change with the music. The tab stays audible.
- [ ] YouTube Music: same as above.
- [ ] Navigate to another video in the same tab: capture keeps running (expected per Chrome docs).
- [ ] 캡처 중지 stops it and the tab sound remains normal.
- [ ] **Apple Music web (music.apple.com)**, signed in, playing a full song:
      - [ ] Click the toolbar icon. Record: 오디오 수신 예/아니요, RMS level, chroma moving or flat.
            "아니요" with RMS ≈ 0 while music is audible means DRM-protected audio is not capturable → per the
            proposal, Apple Music is then unsupported (no circumvention).
      - [ ] 캡처 tab → "Apple Music 어댑터 (실험)": record which path worked: MusicKit, media element, or
            unreachable; whether the position advances and the song id is present.
      - [ ] 연주 tab → play button with 카운트인 1마디: either it pauses, jumps, counts and plays (MusicKit
            bridge), or it shows "이 플레이어에서는 카운트인 재생을 지원하지 않아요" without a count-in overlay.

## C. Play-along with 3–5 hand-made charts

Make charts for 3–5 songs you know (mix of 4/4 and 3/4 or 6/8 if possible; at least one in a flat key such
as Ab or Eb to try the capo suggestion).

For each song:

- [ ] Editor: paste sequence, tap tempo, stamp changes, save. Note how long it took and how many re-takes.
- [ ] Export JSON and re-import it: the chart still works.
- [ ] Play view: is the **next chord** visible before the change (strip: neutral border + big-beat
      countdown; grid: "soon" border on its bar)? Try 미리 알림 ½, 1 and 2 bars in the settings sheet.
- [ ] Capo: does 자동 pick a capo you agree with? With "실제 음 이름 보기" on, do the strip and the grid show the
      sounding names (shape G, sounding A♭)?
- [ ] Levels 입문 / 초급 / 중급 / 상급: are the shapes playable for you? 입문 shows reduced 7ths with a tiny
      superscript 7; 중급/상급 show "…도 돼요" only on low-confidence 7th chords.
- [ ] Slash bass and sus: in a song with a walking bass (C – C/B – Am – Am/G) or a sus resolution
      (Dsus4 → D), are they kept at 입문?
- [ ] Mark a few shapes as "잡을 수 있음" in 설정 tab → "이 곡에 나오는 코드": does the arrangement prefer them?
- [ ] Strumming suggestion (settings sheet → 추천 반주): is the pattern sensible for the meter and level?
- [ ] Play button with 카운트인 1마디 / 2마디: pauses, jumps to the bar start, counts the big beats (6/8: 2 per
      bar; click sound), then plays. 끔 plays at once. Pressing again during the count cancels it.
- [ ] Coverage gaps: in a chart whose coverage skips a section, the grid shows "—" in the gap and no next
      shape is highlighted just before the gap.
- [ ] Drafts: start a chart on song A, skip to song B: the editor is empty for B, saving cannot write A's
      stamps under B, and returning to A restores the draft.
- [ ] Overall: could you play along without stopping? Write the top 3 annoyances.

## D. Listening mode (recognition)

Use songs with no chart first. Note Chrome version and the 캡처 tab "실행 방식" (wasm or webgpu).

- [ ] Click the toolbar icon on a playing YouTube song. 캡처 tab: 인식 모델 "준비됨" within ~5 s.
- [ ] 듣기·캡처 tab: the "듣기 모드 · 인식 중" card shows a chord that changes with the music, about 1 s late.
      With no chart the 연주 tab's empty state shows the heard percentage.
      Note how often it is right for 3 songs you know (rough %).
- [ ] Pause → card says "기록 멈춤: 일시정지"; seek ahead → coverage shows 2 ranges; 1.25x → "재생 속도"
      and no recording; ad → "광고 중".
- [ ] Let one song play to the end (≥ 90 % heard): an auto chart appears in the play view with the badge
      "자동 코드표 · 사람이 확인하지 않음". Note analysis seconds shown.
- [ ] Press "들은 구간으로 자동 코드표 만들기" after half a song: the play view shows chords only for the heard
      range and "—" after it.
- [ ] On a song with a hand-made chart: let it build an auto chart. Your chart must stay in use; the card shows
      "직접 만든 코드표와의 일치율 …". Record the numbers (this is the user-chart vs auto-chart evaluation).
      Try "자동 코드표로 바꾸기" → confirm dialog; cancel keeps your chart.
- [ ] Open the bench page (캡처 tab link), run WASM with 6 clips and WebGPU with 6 clips; record the latency
      lines and the summary.
- [ ] Watch CPU in Chrome's task manager (offscreen document) during listening; record the % and whether the
      tab audio ever stutters.
- [ ] Sync check: do auto-chart chord changes land on the audible change? Note the offset (ms) if any.

## E. Play view B, lyrics and music fixes

Screenshots of the synthetic demo: [docs/screens/](screens/) (`node scripts/screens.mjs`).

- [ ] Demo without a player: settings sheet → 데모 재생 (or open `sidepanel.html?demo=1` from the extension's
      URL). The synthetic song plays with a simulated clock; 0.5× works; "끝내기" returns to the live player.
      Pick a stored recording in the demo bar: its chart replays (cached lyrics only, no request).
- [ ] Panel width: at ~400 px the strip scrolls sideways with a fade on the right and keeps the current
      (and, just before a change, the next) shape in view; at ~600 px all shapes of a typical song fit in one
      row. Diagrams are 120 px wide. Light and dark (theme button) both readable.
- [ ] Key spelling on a song in a flat key (e.g. Perfect, A♭ major, auto chart): the strip and grid show
      A♭, Fm, D♭, E♭ (capo 0) or G, Em, C, D with sounding A♭… (capo 1) — never G#, D#.
      설정 tab → 분석 정보 shows the estimated key.
- [ ] Bar phase: chord changes sit at the start of grid cells (분석 정보 shows "마디 시작 보정 …" when the
      tracker's downbeat was moved and how many changes now land on bar starts).
- [ ] 6/8 (or 12/8): the grid draws 2 (or 4) ticks per bar, the countdown counts big beats, and the count-in
      counts 2 per bar.
- [ ] Lyrics on (default): on a song with LRCLIB lyrics the pinned line shows chords over the words where they
      change, the sung word underlined, "다음 · …" below and "♪ 연주만 나와요" between sung parts; section labels
      (인트로 / N절 / 후렴 / 간주 / 아웃트로) come from the lyrics. 분석 정보 shows the lyric source and the
      estimated offset (Perfect lyric video: about +0.45 s).
- [ ] A song without lyrics on LRCLIB: no lyric line; sections are "1–8마디", "9–16마디", ….
- [ ] Lyrics off: open a new song with "가사 가져오기" off. In the service worker's DevTools Network panel there
      is no request to lrclib.net. Turn it on: exactly one request (or get + search) for that recording;
      reopening the song makes no new request (cached).
- [ ] Click a bar: the player jumps there. Scroll the grid by hand: "현재 위치로" appears and brings it back.

## F. Known limits to keep in mind while testing

- Example charts have fake timings; use them only to try the UI.
- Recognition accuracy was measured only on synthetic audio (docs/phase0-benchmark.md); real-song accuracy is
  what section D and the 20-song evaluation should measure.
- The capture-to-playback latency used to place audio on the timeline is a fixed 50 ms guess.
- Apple Music support is experimental and may stop working when the site changes.
- Section names are guessed from lyric repetition (repeated lines → 후렴); a pre-chorus or a verse with
  repeated lines can be labelled wrongly.
- Lyrics depend on LRCLIB's timing for one release; the offset estimate fixes a constant shift only.
