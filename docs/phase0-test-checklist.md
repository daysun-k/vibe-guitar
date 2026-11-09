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
      The id matches the `v=` of the song; title and artist are right; next-track changes are picked up.
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

## C. Play-along with 3–5 hand-made charts

Make charts for 3–5 songs you know (mix of 4/4 and 3/4 or 6/8 if possible; at least one in a flat key such
as Ab or Eb to try the capo suggestion).

For each song:

- [ ] Editor: paste sequence, tap tempo, stamp changes, save. Note how long it took and how many re-takes.
- [ ] Export JSON and re-import it: the chart still works.
- [ ] Play view: is the **next chord** visible at least one bar ahead? Is the beat countdown readable while
      playing? Try 미리 보기 1, 2 and 4 bars.
- [ ] Capo: does 자동 pick a capo you agree with? Does the line "소리 Ab · 카포 1 · 모양 G" make sense?
- [ ] Levels 입문 / 초급 / 중급 / 상급: are the shapes playable for you? Are "대체" badges shown exactly when the
      sound changes (e.g. F → Fmaj7), and "쉬운 운지" when only the shape changes (F barre → xx3211)?
- [ ] Slash bass and sus: in a song with a walking bass (C – C/B – Am – Am/G) or a sus resolution
      (Dsus4 → D), are they kept at 입문?
- [ ] Mark a few shapes as "잡을 수 있음" in "이 곡에 나오는 코드": does the arrangement prefer them?
- [ ] Strumming suggestion: is the pattern sensible for the meter and level?
- [ ] "이 마디 처음부터 카운트인 후 재생": pauses, jumps to the bar start, counts 1–N (click sound), then plays.
- [ ] Overall: could you play along without stopping? Write the top 3 annoyances.

## D. Known limits to keep in mind while testing

- Example charts have fake timings; use them only to try the UI.
- No chord or beat recognition in this slice; the 20-song accuracy benchmark is the next slice.
- Apple Music support is experimental and may stop working when the site changes.
