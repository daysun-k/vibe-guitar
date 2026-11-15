# Phase 0 evidence record (VGT-6, VGT-5 preparation)

State on 2026-11-15 (audit + quiet checks), main b648864. One row per item of
[phase0-test-checklist.md](phase0-test-checklist.md) (IDs follow the order of the bullets in each checklist
section) and per feature added since 2026-11-12.
109 rows: 18 verified, 65 partial, 26 unverified. The audit (main 2288f5a) compared every row with its checklist
bullet: 22 rows went from verified to partial (a required observation missing or a target missed) and D2 from
partial to unverified; no row was upgraded. The quiet first-session checks later that day (QC1-1115, QC2-1115)
moved C10, F3 and N10 to verified and C2, C5, C6, C7, E2, E4, F5, F10, G1, G6, G7, GC1, GC4, GC12 and S11 from
unverified to partial; F8 and N7 gained receipts and stay partial; no row went down.

Status words:

- **verified**: someone ran it and recorded what this item asks for (the row names who, when and on which build).
- **partial**: some of the item was observed; the rest is listed under "Result".
- **unverified**: no record of anyone running it. Unit tests, reviews and headless renders alone stay here.
- **n/a**: the item no longer applies (reason given).

Scope rules used for every row:

- Agent-run checks in the user's Aside (Chromium on the Mac mini) count as verified for what they observed, on
  the stated date and build. The user's own report counts the same way.
- Capture success (100+ uploads captured for the evaluations) and offline replay parity (R1: replaying a
  capture reproduces the live chart) show that tab capture and the shipped recognizer work in the browser.
  They say nothing about player synchronization, ad handling, in-page navigation or recording identity, so
  those rows need their own evidence.
- Accuracy numbers come from public annotations or sheets, never from the user's ear.
- A row is verified only when its record covers every observation and threshold its bullet asks for. A row
  that misses one is partial, with the gap at the end of "Result" as "Missing: …" or "Below target: …"
  (audit 2026-11-15).
- Evidence from the hidden http preview or the demo (nothing is saved, no lyrics are requested) shows layout
  and in-memory behaviour only. It does not verify storage, persistence across a reload or live lyric requests.
- Simulator results show layout only. They do not verify real-phone readability, Wi-Fi recovery or real-device
  timing.
- Storage checks through the service worker's messages (the ones the panel sends, without the panel UI) verify
  the stored result only. They do not verify the panel's buttons, texts or downloads.
- Unit tests and reviews alone stay unverified (see the status words).

## Sources

| Short name | What it is | Where |
| --- | --- | --- |
| B5-AUTO | Agent automated run, 2026-11-13, main ec7aedd: Aside driven by the agent plus a USB-connected iPhone (safaridriver). One summary table survives; the raw results file was in /tmp and is gone. | briefing `2026-11-13-vibe-guitar-real-use-test.html`, table "제가 이미 확인한 것" |
| B5-DONE | Bundle 5 closeout, 2026-11-13 (after PR #23-#26 merged) | briefing `2026-11-13-vibe-guitar-bundle5-done.html` |
| PR23-LIVE | Live rate check of the PR #23 build in Aside, 2026-11-13, head 8ea4094, real www.youtube.com tab | PR #23 comment 6841962724 |
| LAT | Capture-latency probe in Aside, 2026-11-13, main 5e5b7b1 | docs/latency-probe.md:96-116, PR #26 |
| LAT-1115 | Capture-latency re-measurement in Aside, 2026-11-15, main e815c21 (VGT-22); constant 0.128 → 0.069 s | docs/latency-probe.md:120-144, PR #57 |
| HELDOUT-V2 | VGT-7 held-out accuracy, 46 predeclared songs, 18 scored | briefing `2026-11-14-vibe-guitar-accuracy-heldout-v2.html` / `.json`, list PR #33 |
| VGT18-TEST | Shipped recognizer one-shot TEST, 2026-11-14 | docs/recognition-candidates.md:253-279, PR #37 |
| VGT19-BROWSER | Uncertain-stretch browser check, 2026-11-15, dump build of e2c89ce in Aside | docs/uncertainty-results.md:125-135, PR #46 |
| BACKLOG-1115 | Backlog briefing that lists ads, page navigation, YouTube Music recording identity and Apple Music as having no record | briefing `2026-11-15-vibe-guitar-backlog-bundle.html` |
| QC1-1115 | First quiet first-session check agent, 2026-11-15, main 2288f5a plus its fix b0ec80b. Storage through the service worker of the extension installed in the user's Aside (its build was not replaced), on disposable `zzvgtest-` recordings (keys 358 → 364 → 358, none left; real songs read only), and the hidden http preview of the stored practice charts and test charts. It found and fixed F10 (PR #60, main b648864, independent review PASS). | `~/vgt-reprio-b/checks/` (`shots/`, `g1-*.json`, `g2-results.json`, `scripts/`), PR #60 |
| QC2-1115 | Second quiet check agent, 2026-11-15, main 4402c9a. Hidden http preview, a booted iPhone 17 simulator fed by a scripted publisher through the relay, and offline arrangement runs. Nothing was written to the extension's storage; the frontmost app stayed Aside except about 1 s of Xcode's DeviceHub when the safaridriver session started. | `~/vgt-reprio-b/checks2/` (`shots/`, `logs/`, `scripts/`) |

Where B5-AUTO's one-line summary and BACKLOG-1115 disagree (in-page navigation, YouTube Music), the row is
**partial**: the summary says it worked but does not record the sub-steps the checklist asks for.

## A. Position sync

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Header id, title, 재생; time advances | partial | ec7aedd, 2026-11-13 | www.youtube.com | Panel followed playback. Header text was not recorded line by line. Missing: the header's video id, title and "재생". | B5-AUTO "재생 위치 따라가기" |
| A2 | Pause, seek, speed: header and chords follow within 0.3 s | verified | ec7aedd, 2026-11-13 | www.youtube.com | Followed within 20-130 ms after pause, seek and speed changes (limit 300 ms). | B5-AUTO |
| A3 | In-page navigation to a recommended video | partial | ec7aedd, 2026-11-13 | www.youtube.com | Summary says a recommended-video move was followed. Whether the new id's chart (or "코드표가 없습니다") loaded is not recorded; BACKLOG-1115 lists navigation as unrecorded. | B5-AUTO, BACKLOG-1115 |
| A4 | Ads: header "광고", red banner, chords stop | unverified | – | – | No record. | BACKLOG-1115 |
| A5 | YouTube Music: search, playlist, radio, next track | partial | ec7aedd, 2026-11-13 | music.youtube.com | Summary says "YouTube Music도 정상"; which of search / playlist / radio / next track was tried is not recorded. | B5-AUTO, BACKLOG-1115 |
| A6 | YouTube Music recording identity (iKzRIweSBLA) | unverified | – | – | No record of the two ids or the yellow notice. | BACKLOG-1115 |
| A7 | Switching browser tabs | verified | ec7aedd, 2026-11-13 | www.youtube.com | Panel followed the active tab. | B5-AUTO |
| A8 | Drift / 싱크 보정 per site | partial | 5e5b7b1, 2026-11-13; e815c21, 2026-11-15 | www.youtube.com | Measured with the latency probe instead of by ear: drift inside continuous segments 0.0 ms/min; capture placement constant changed 0.050 → 0.128 s (validation median 2.7 ms). p95 53 ms misses the 50 ms target because each new anchor after play/pause/seek lands with its own offset (up to about 80 ms apart; follow-up VGT-22). Not measured: music.youtube.com, a felt offset with a chart. Re-measured on 2026-11-15 after VGT-22 (e815c21): validation \|residual\| p95 2.3 ms, drift 0.1 ms/min, per-session spread of segment medians 0.7/0.3/0.3 ms; constant 0.128 → 0.069 s (PR #57). A confirmation run on the 0.069 s build did not start. | LAT, LAT-1115, PR #26, #57 |

## B. Tab audio capture

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| B1 | YouTube capture: 캡처 중, audio yes, sample rate, chroma, tab audible | partial | ec7aedd, 2026-11-13 | www.youtube.com | 캡처 중, 오디오 수신 "예", 48000 Hz, model ready (wasm); tab sound unchanged after stop. Over 100 later captures for VGT-7/18/19/21 all produced charts (e.g. 18/18 TEST, 20/20 TEST-3). Chroma bars not recorded. Missing: the moving RMS value and chroma bars that change with the music. | B5-AUTO; docs/recognition-candidates.md:257-260; docs/uncertainty-results.md:162 |
| B2 | YouTube Music capture | unverified | – | music.youtube.com | No record of a capture on music.youtube.com. | – |
| B3 | Navigate in the same tab: capture continues, 대상 탭 address follows | partial | ec7aedd, 2026-11-13 | www.youtube.com | The run found the address did not follow (F3); fixed in PR #23 with unit tests. No live re-check after the fix. | B5-AUTO "F3", PR #23 |
| B4 | 캡처 중지 clears readouts; toolbar restarts | partial | main after PR #23, 2026-11-13 | www.youtube.com | After stop the listening card showed "기록 멈춤: 캡처가 꺼졌어요" (F2 fixed). Restart by a second toolbar click not recorded separately. | B5-DONE, B5-AUTO "F2" |
| B5 | Apple Music web: one capability check | unverified | – | music.apple.com | Never run. | BACKLOG-1115 |

## C. Play-along

Hand-made chart authoring is now optional: the user receives prepared practice charts built from public
annotations. The set on 2026-11-15 is Let It Be, Come Together, Drive My Car and While My Guitar Gently Weeps
(an earlier list had And She Was). On 2026-11-15 the parent agent stored Come Together (`oolpPmuK2I8`) and While
My Guitar Gently Weeps (`bI8P6ZSHSvE`) in the user's Aside extension through the panel's own save path (the
service worker's chart-write save); both read back equal by value to the practice-chart files, and the auto
charts were kept. Let It Be (`QDYfEBY9NM4`) already held the same practice chart (same events, timing and
coverage). Drive My Car (`kfSQkZuIx84`) was not replaced because it holds an edited auto chart (last edit
2026-11-15T01:14Z, origin unknown); its practice chart is imported by hand only if the user wants it. This does
not verify C2: nothing was exported or re-imported through the panel's UI, so C2 stayed unverified (it became
partial later that day through QC1-1115, still without the panel's UI).

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Editor: paste, tap tempo, stamp, save (optional) | unverified | – | – | Unit tests only. | – |
| C2 | Export and re-import JSON | partial | 2288f5a + b0ec80b, 2026-11-15 | Aside extension storage, offline | Before 2026-11-15: unit tests only; importing a prepared chart is the first live use. QC1-1115 (disposable `zzvgtest-` recording): Let It Be's stored chart was exported to JSON with the app's export function, imported again with its import function and saved through the service worker; read back, chords, beats and heard ranges equal the original (only title, artist and provenance differ, set by attaching it to the current song). Missing: 편집 → JSON 내보내기 / 가져오기 in the panel (the download and the file picker) and the imported chart playing in time on its song. | QC1-1115 |
| C3 | Next chord visible in time; 미리 알림 ½ / 1 / 2 | unverified | – | – | Strip rendered in headless screenshots (PR #6) and in the Aside demo (PR #45); comfort while playing not recorded. | PR #6, #45 |
| C4 | Capo: 자동 choice; sounding names | partial | ec7aedd, 2026-11-13 | www.youtube.com | Flat spelling and sounding names displayed (Perfect Duet: A♭, no G#/D#); capo hint shown in headless Chrome (PR #10). Whether the user likes the 자동 capo is not recorded. | B5-AUTO "화면 표시", PR #10 |
| C5 | Levels: shapes playable | partial | 2288f5a + b0ec80b, 2026-11-15 | http preview | Difficulty compared by scores only (briefing `2026-11-10-vibe-guitar-easier-beginner-done.html`). QC1-1115, three practice charts at two levels each: 입문 turned F into Fmaj7, merged short chords and dropped slash bass; 중급 with 카포 1 showed barre shapes at the 4th and 11th fret. Missing: whether the shapes are playable for the user (step 1 of "Still needs the user"), the 입문 change mark (●) with its tooltip and no superscript 7, and "…도 돼요" only on low-confidence 7ths at 중급/상급. | QC1-1115 |
| C6 | Slash bass and sus by level (finger-pressed bass and sus at 초급; 입문 simplifies them, keeps open-string bass) | partial | 2288f5a + b0ec80b / 4402c9a, 2026-11-15 | http preview | Before 2026-11-15: unit tests only. The checklist bullet was rewritten on 2026-11-15 to match docs/level-vocabulary.md (it used to ask for both kept at 입문). QC1-1115 and QC2-1115, test chart C, C/B, Am, Am/G, Dsus4, D, Gsus4, G: 입문 plays C/B → C, Am/G → Am, Dsus4 → D and Gsus4 → G, each with a note ("베이스음 지정(/)을 빼고 …", "sus 음을 3음으로 바꾼 …"); 초급 keeps all four. Missing: a slash chord with an open-string bass (C/E, D/A, Am/E) staying at 입문 (the test chart had none). | QC1-1115, QC2-1115 |
| C7 | "잡을 수 있음" shapes preferred | partial | 4402c9a, 2026-11-15 | offline | Before 2026-11-15: unit tests only. QC2-1115, offline arrangement (`buildPlayModel`) of 4 real charts at 초급 and 중급, 카포 0 and 자동: marking every default shape left the arrangement unchanged (16/16); marking alternative shapes instead moved 27 of 149 chords to them (e.g. G 320003 → 320033), and easy open shapes such as C x32010 stay even when not marked, because an unmarked shape only gets a +3 penalty. Missing: marking shapes in 설정 → 이 곡에 나오는 코드 in the panel, and a decision whether this weak preference (it acts only between shapes of similar difficulty) is the intended strength. | QC2-1115 |
| C8 | Strumming suggestion | unverified | – | – | – | – |
| C9 | Count-in 1 / 2 bars, 끔, cancel | partial | ec7aedd, 2026-11-13 | www.youtube.com | Count-in worked with the loop and from the phone's ▶. 2 bars, 끔 and cancel during the count not recorded. | B5-AUTO "속도·구간 반복", "휴대폰 조작" |
| C10 | Coverage gaps "—" | verified | 2288f5a + b0ec80b, 2026-11-15 | http preview | Before 2026-11-15: unit tests only. (The "—?" seen in PR #48 is a no-chord span, not a coverage gap.) QC1-1115: a test chart with no coverage from 30 to 60 s showed "—" in the bars of the gap, and no next shape was highlighted just before it. | QC1-1115 |
| C11 | Drafts per song | unverified | – | – | Unit tests only. | – |
| C12 | Play along without stopping; top 3 annoyances | unverified | – | – | Needs the user. | – |

## D. Listening mode

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | 인식 모델 "준비됨" within ~5 s | partial | ec7aedd, 2026-11-13 | www.youtube.com | 준비됨, 실행 방식 wasm. Time to ready not recorded. Missing: the time to 준비됨 (target about 5 s). | B5-AUTO "탭 소리 캡처" |
| D2 | "인식 중" card follows the music | unverified | – | – | Live charts are built in the browser (every evaluation capture). The card itself was not recorded. The old "rough % right" step was removed: accuracy now comes from public annotations (see N13). Audit 2026-11-15: nothing the item asks (the card's chord, its delay, the heard percentage) was recorded. | – |
| D3 | Pause, seek, slow speed, ad states | partial | ec7aedd / 5e5b7b1, 2026-11-13 | www.youtube.com | 0.5× and 0.75× stored nothing (B5-AUTO); 1.5× stored nothing and pause/seek sessions completed (LAT). Card texts and the ad state not recorded. | B5-AUTO, LAT |
| D4 | Full song → auto chart with badge | partial | ec7aedd, 2026-11-13 | www.youtube.com | One full song gave an auto chart of 107 chords, analysis 2.5 s. Badge text not recorded. Missing: the badge "자동 코드표 · 사람이 확인하지 않음". | B5-AUTO "듣기 모드" |
| D5 | "들은 구간으로 자동 코드표 만들기" after half a song | unverified | – | – | Unit tests only. | – |
| D6 | Hand chart stays; match %; adopt dialog | unverified | – | – | Needs a non-auto chart (prepared or hand-made). | – |
| D7 | 정확도 모아 보기 | unverified | – | – | Only a headless render with a read-only storage stub and three synthetic songs (PR #15); not run on real stored charts. | PR #15 |
| D8 | 결과 내보내기 | unverified | – | – | – | – |
| D9 | `npm run accuracy-report` | unverified | – | – | Built only from a test fixture (PR #17); no real export yet. Superseded for accuracy by the annotation evaluation; optional. | PR #17 |
| D10 | Bench page WASM / WebGPU, 6 clips | partial | b24912f, 2026-11-09 | Aside | Models load and run in the browser (1 clip, majmin 99.6%). 6-clip runs and WebGPU not recorded. | PR #3 |
| D11 | CPU and stutter while listening | partial | 2026-11-11 / 2026-11-14 | Aside / offline | Freeze cause found in Aside and fixed by moving models to a worker (PR #8). Offline replay: peak memory at most +1.4%, analysis time within noise (docs/uncertainty-results.md:137-150). Live CPU % and stutter while listening not recorded. | PR #8, briefing `2026-11-11-vibe-guitar-stutter-done.html` |
| D12 | Auto-chart sync vs audible change | partial | 5e5b7b1, 2026-11-13; e815c21, 2026-11-15 | www.youtube.com | See A8: placement measured and corrected to 0.128 s; per-anchor offset open (VGT-22). VGT-22 fixed the per-anchor start on 2026-11-15 and the constant is now 0.069 s (LAT-1115, PR #57). How the auto chart lines up with the audible change is still not recorded. | LAT, LAT-1115 |

### D2 (checklist section). Fixing one chord (코드 고치기)

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Panel opens at the playhead; outline; header; ‹ › | partial | a372dbd / c510d2f, 2026-11-15 | www.youtube.com (And She Was), http preview | Header "0:06~0:13 E 자동으로 들은 코드 대안: C♯m", four bars outlined, next chord's bar not outlined (PR #51). Arrows stepped event starts and "?" stretches (PR #52, N7). The user also used it on And She Was and reported the old one-bar outline (PR #51 report). Missing: the player jumping to each stop in a real tab (the "?" stops were seen in the hidden preview, which has no player) and a bar click that only seeks. | PR #51, #52 |
| F2 | Pick root and kind, preview, "이 코드로 고치기" | partial | ec7aedd, 2026-11-13 | www.youtube.com | Fix applied and shown. Status text not recorded. Missing: the preview "G → Am" and the status line "고쳤어요: …" with "되돌리기". | B5-AUTO "코드 고치기" |
| F3 | Slash bass row preselect | verified | 2288f5a + b0ec80b / 4402c9a, 2026-11-15 | http preview | Before 2026-11-15: unit tests only (PR #14). QC1-1115: a C/B preselected "/B", Am/G with 카포 1 preselected the shape name "/F♯", a plain Dm preselected "베이스 없음". QC2-1115: picking Am on C/B previewed "C/B → Am/B", 베이스 없음 gave "C/B → Am", and with 카포 1 "B/B♭ → G♯m/B♭". The item asks for the picker only; storing the fix is F4. | PR #14, QC1-1115, QC2-1115 |
| F4 | Only that chord changed | verified | ec7aedd, 2026-11-13 | www.youtube.com | Stored chart: only the fixed chord changed. | B5-AUTO |
| F5 | Badge "1곳 고침" | partial | 2288f5a + b0ec80b, 2026-11-15 | Aside extension storage, http preview | QC1-1115: after one fix saved through the service worker the stored chart held exactly one fixed chord; the hidden preview of that chart showed the badge "자동 코드표 · 1곳 고침 · 나머지는 미확인" and, 300 px wide, "자동 · 일부 고침". Missing: the badge's explanation (how many chords were fixed and that the rest are unchecked). | QC1-1115 |
| F6 | Capo: stores the sounding chord | partial | ec7aedd, 2026-11-13 | www.youtube.com | Stored as the sounding chord with the capo applied. Missing: the picker showing shape names only, the grid showing the shape (Em), and the "실제 …" name in the picker header and preview. | B5-AUTO |
| F7 | 되돌리기 | partial | ec7aedd, 2026-11-13 | www.youtube.com | Undo restored the chord. Missing: the badge returning to "자동 코드표 · 사람이 확인하지 않음". | B5-AUTO |
| F8 | Survives new analysis and reload | partial | ec7aedd, 2026-11-13; 2288f5a + b0ec80b, 2026-11-15 | www.youtube.com; Aside extension storage | Fix kept after reload; keeping the fix across a new analysis was not recorded then. QC1-1115 (service worker, disposable recording): after a fix a new auto chart arrived and the fixed chart stayed in use; read again from a new page it was unchanged; "자동 코드표로 바꾸기" (adopt) kept the fixed chart as the backup (`chartbackup`). Missing: the play tab notice that a new auto chart is ready, and reloading the panel and the YouTube tab after a new analysis. | B5-AUTO, QC1-1115 |
| F9 | No false "준비됐어요" notice | unverified | – | – | Unit tests only. | – |
| F10 | Editor load / save keeps auto data | partial | 2288f5a + b0ec80b, 2026-11-15 | Aside extension storage, offline | Before 2026-11-15: unit tests only. QC1-1115 found a defect: 저장된 코드표를 편집기로 불러오기 → 이 곡에 저장 without changes dropped every "?" stretch and its alternatives (a copy of Drive My Car in the real extension: 44 → 0 spans) although the status said the auto data was kept. Fixed in PR #60 (b0ec80b, main b648864): unchanged event times keep the spans, re-stamped times drop them; its regression test failed before the fix (1 failed, 19 passed) and passes after (20 passed). The fixed save, run offline on the same copy and written back through the service worker, kept all 44 spans. Missing: a panel click on the rebuilt extension (the user's installed build does not have the fix yet), the status text, "바꾼 코드 1개만 …" after one changed chord and the re-stamp message. | QC1-1115, PR #60 |
| F11 | Demo: fix not saved | partial | 9ef5398 / c510d2f, 2026-11-15 | demo, http preview | Fixes in demo and the hidden preview change only the in-memory chart. Missing: the text "(데모라서 저장하지는 않아요)" and a look at the real song's stored chart after 끝내기. "In-memory only" is the design (README.md:413-414); demo and preview evidence does not verify storage. | PR #48, #52 |

### D3 (checklist section). Practice speed and A/B loop

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 0.5× / 0.75× / 1× reach YouTube's player | partial | 8ea4094, 2026-11-13 | www.youtube.com | Player API, `<video>` and ⚙ menu agreed (0.5, 0.75, 보통); 1.5 refused. Chords staying in time at each speed not recorded. Missing: chords and lyrics staying in time at each speed (A2 records only the 20-130 ms follow right after a speed change). | PR23-LIVE |
| S2 | Site menu rate shown next to buttons | unverified | – | – | – | – |
| S3 | Speed stays; resets on next video; YouTube Music | unverified | – | – | – | – |
| S4 | Slow speed is not recorded | partial | ec7aedd, 2026-11-13 | www.youtube.com | Nothing stored at 0.5× and 0.75×. Missing: the card text "재생 속도 0.5x (1x에서만 기록)" and recording starting again at 1×. | B5-AUTO |
| S5 | Loop A…B set, either order | partial | ec7aedd, 2026-11-13 | www.youtube.com | Loop worked. Reverse-order setting not recorded. Missing: the bars pressed in reverse order, the green tint with A and B tags, and the note "N–M마디 반복 중". | B5-AUTO |
| S6 | Loop boundary at 1×, 0.75×, 0.5× | verified | ec7aedd, 2026-11-13 | www.youtube.com | Overshoot past B at most 15 ms at all three speeds; no double jump. | B5-AUTO |
| S7 | Bar presses and slider outside the loop | partial | ec7aedd, 2026-11-13 | www.youtube.com | Moving outside the loop worked. Missing: which move was tried (a bar press right after B, YouTube's slider past B) and dragging back into the loop; B5-AUTO says only "구간 밖 이동 정상". | B5-AUTO |
| S8 | Count-in with the loop; speed change cancels | partial | ec7aedd, 2026-11-13 | www.youtube.com | Count-in worked; cancel on speed change not recorded. | B5-AUTO |
| S9 | Ads with the loop on | unverified | – | – | – | BACKLOG-1115 |
| S10 | Clearing (반복 해제, video/tab/demo change) | partial | ec7aedd, 2026-11-13 | www.youtube.com | 반복 해제 worked; clearing on video, tab and demo changes not recorded. | B5-AUTO |
| S11 | 400 px with 카포 1 fits one row | partial | 2288f5a + b0ec80b, 2026-11-15 | http preview | QC1-1115, 400 px CSS width with 카포 1: the speed buttons and "구간 반복" fit on one row and the bars showed shape names only. Missing: the note "N–M마디 반복 중" on that row with the loop on. | QC1-1115 |

## E. Play view, lyrics and fixes

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Demo without a player | partial | 2026-11-10 / 2026-11-15 | Aside | Demo rendered at 560 px (PR #4) and 400 px (PR #45); hidden http preview (PR #52). Picking a stored recording in the demo bar not recorded. Missing: 0.5× in the demo, "끝내기" returning to the live player, and a stored recording replayed from the demo bar with cached lyrics only. | PR #4, #45, #52 |
| E2 | Shape strip: three slots, 120 px, light/dark | partial | 2288f5a + b0ec80b / 4402c9a, 2026-11-15 | http preview | Earlier: headless screenshots only (PR #6, settings grid measured at 120 px); the Aside demo at 400 px (PR #45) did not record the strip, narrow widths or the dark theme. QC1-1115: three slots; diagram width 119 px at 400 px, 92 px at 320 px, 76 px at 272 px; light and dark both readable. QC2-1115, 12 s of playback sampled every 100 ms (110 samples): the lane stayed at one position, always three slots, 119 px at 400 px and 99 px at 340 px; 설정 → 이 곡에 나오는 코드 showed all 12 shapes at 120 px but printed the names in ASCII ("F#", "G#m/F#", "B/Bb") while the strip uses ♯/♭, fixed in PR #61. Missing: the accent border and the countdown badge's slot, the coming chord in the first slot between chords, whether the sampled stretch had a four-fret shape replacing a five-fret one, and the settings list after PR #61. | PR #6, QC1-1115, QC2-1115 |
| E3 | Key spelling in a flat key | partial | ec7aedd, 2026-11-13 | www.youtube.com | Perfect Duet: A♭, flats only (no G#/D#). 분석 정보 key line not recorded. Missing: the estimated key in 설정 → 분석 정보. | B5-AUTO "화면 표시" |
| E4 | Bar phase | partial | 2288f5a + b0ec80b, 2026-11-15 | http preview | Before 2026-11-15: unit tests only. QC1-1115: 분석 정보 of three charts read "마디 시작: 그대로" with 55/136, 21/28 and 133/141 changes on bar starts. Missing: a chart whose downbeat was moved ("마디 시작 보정 …"); none of the three had one. | QC1-1115 |
| E5 | 6/8 ticks, countdown, count-in | partial | ec7aedd, 2026-11-13 | www.youtube.com | 6/8 drawn with 2 ticks per bar. Countdown and count-in in 6/8 not recorded. | B5-AUTO |
| E6 | Lyrics on: words, sections | partial | 2026-11-10 / ec7aedd 2026-11-13 | Aside | LRCLIB returned 31 lines / 291 words for Perfect and cached them; chords over sung words in demo replay (PR #4). Lyric line and section names normal (B5-AUTO). Missing: the underlined sung word, "다음 · …", "♪ 연주만 나와요" between sung parts, and the lyric source and offset in 분석 정보 on a live song (the checklist notes about +0.45 s seen on 2026-11-10, build not named). Chords over words in a demo replay do not verify live lyric requests. | PR #4, B5-AUTO |
| E7 | Song without lyrics | unverified | – | – | – | – |
| E8 | Lyrics off: no request | unverified | – | – | Unit tests only. | – |
| E9 | Bar click seeks; "현재 위치로" | partial | ec7aedd, 2026-11-13 | www.youtube.com | Bar presses seek (S7). "현재 위치로" not recorded. | B5-AUTO |
| E10 | 코드 고치기 panel at 400 px, light/dark | partial | 2026-11-12 / 2026-11-15 | headless / Aside | 400 px with capo 1 in a headless page (PR #12); outlined bars visible above the panel (PR #51). Dark theme not recorded. | PR #12, #51 |

## G. Phone music stand

| ID | Item | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| G1 | Off by default; no connection when off | partial | 4402c9a, 2026-11-15 | http preview, scripted relay | Before 2026-11-15: `npm run phone-check` and unit tests only. QC2-1115: the sheet's 휴대폰 악보대 switch was off by default and showed 연결 안 됨; while off (about 9 s) the relay log had no connection attempt; with `phone` on, attempts appeared and the relay refused them as designed for an http origin (`publisher rejected (origin http://127.0.0.1:8792)`). Missing: the real extension on a fresh profile with the service worker's and panel's DevTools Network panels, and the quiet retry slowing to every 15 s. | QC2-1115 |
| G2 | Finder double-click starts the relay | partial | PR #18 head / ec7aedd | Mac | Launcher run from a shell with a short PATH (PR #18). Real Finder double-click not recorded. | PR #18, B5-AUTO |
| G3 | Firewall prompt; QR scan; 휴대폰 1대; 403 on a bad token | partial | 2026-11-12 | real phone | The user connected a real phone and reported it works (PR #16). 403 page: tests only. | PR #16 |
| G4 | No auto-lock notice | verified | 2026-11-12 | real iPhone 16 Pro | Notice removed (PR #20); page checked on a real iPhone. | PR #20 |
| G5 | Same shapes as the panel; bar card; portrait and landscape | partial | ec7aedd, 2026-11-13; PR #20, 2026-11-12 | real iPhone | Chord names matched the panel (B5-AUTO); no overflow in portrait (B5-AUTO) and landscape 874 px (PR #20). Reading at arm's length while playing not recorded. Missing: the bar card (playhead moving with the panel's, one segment per big beat) and reading at arm's length while playing. | B5-AUTO, PR #20 |
| G6 | Capo shape names; 실제 names | partial | 4402c9a, 2026-11-15 | iPhone 17 simulator, scripted publisher | QC2-1115, Let It Be 중급 카포 1: the phone showed "B/B♭" with "실제 C/B" and next "G♯m" with "실제 Am"; no "카포" text; with 카포 0 no "실제" line. Missing: the real panel publishing (a script stood in), and turning 실제 음 이름 보기 off with the line gone within a second. | QC2-1115 |
| G7 | Follows level, capo, fix, demo within a second | partial | 4402c9a, 2026-11-15 | iPhone 17 simulator, scripted publisher | QC2-1115: four changes of 난이도 and 카포 sent by the scripted publisher; each time the new names were already on the phone at the first check (141–151 ms). Missing: the panel republishing a change, a chord fix (코드 고치기), 데모 재생 and leaving it, and real-device timing. | QC2-1115 |
| G8 | Pause, seek, slow speed, loop on the phone | partial | ec7aedd, 2026-11-13 | real iPhone | Change timing measured (G10) and controls inside the loop worked; frozen pause, slow countdown and loop wrap on the phone not recorded. | B5-AUTO |
| G9 | Ad on the phone | unverified | – | – | – | – |
| G10 | Change timing phone vs panel | partial | ec7aedd, 2026-11-13 | real iPhone | 40 changes: median 4 ms, 90% within 20 ms, max 111 ms (target 100 ms; one outlier above). Below target: max 111 ms against the 100 ms target. | B5-AUTO "휴대폰 악보대" |
| G11 | Recovery (relay restart, Wi-Fi off/on, panel closed) | unverified | – | – | – | – |
| G12 | Two Chrome windows | unverified | – | – | – | – |
| G13 | Second start refused | partial | ec7aedd, 2026-11-13 | Mac | Second start refused. Missing: the new window's "already running" message and the first window still working; B5-AUTO says only "두 번 실행하면 거절". | B5-AUTO "중계 실행 파일" |
| G14 | Idle auto-stop after 10 min | partial | PR #18 head | Mac | Idle stop after 1 minute (`--idle-minutes 1`) run by hand; 10-minute default not recorded. | PR #18 |
| G15 | Stop: Ctrl+C, closing the window, ports closed | partial | ec7aedd, 2026-11-13 | Mac | Ctrl+C printed "중계기가 꺼졌습니다" and the ports closed. Closing the Terminal window not recorded. | B5-AUTO |
| GC1 | Phone control off by default | partial | 4402c9a, 2026-11-15 | http preview, iPhone 17 simulator | Before 2026-11-15: unit tests only. QC2-1115: with 휴대폰 악보대 off the 휴대폰에서 조작 허용 switch was hidden; on, it was shown and off; while control was off the phone showed no code and no buttons. Missing: the real extension (a default on a fresh profile comes from storage, which the preview does not verify). | QC2-1115 |
| GC2 | Pairing codes, approve one phone | partial | ec7aedd, 2026-11-13 | real iPhone | Code matched and approval worked. A second phone getting a different code not recorded. | B5-AUTO "휴대폰 조작" |
| GC3 | Play / pause; count-in | partial | ec7aedd, 2026-11-13 | real iPhone | ▶ played after the count-in; ❚❚ followed in 40-230 ms. Cancel during the count-in not recorded. Missing: a second tap during the count-in cancelling it with nothing played. | B5-AUTO |
| GC4 | 처음부터 (↻) | partial | 4402c9a, 2026-11-15 | iPhone 17 simulator, scripted publisher | QC2-1115: after approval the button is named "처음부터" (74×64); pressing it logged `phone command restart forwarded` at the relay and the position went to 0 s. Missing: the case with an A/B loop (back to the loop's first bar), playing or paused staying as it was, a real finger tap (WebDriver touch did not press it; a script `click()` did) and the real panel's response. | QC2-1115 |
| GC5 | 이전 / 다음 마디 | partial | ec7aedd, 2026-11-13 | real iPhone | Followed in 40-230 ms, stayed inside the loop, "마지막 마디예요" shown. Missing: 이전 마디 in bar 1 and right after a bar start, "구간 반복의 마지막 마디예요" at B, and the phone's bar card restarting at the new bar. | B5-AUTO |
| GC6 | Layout with long names, portrait and landscape | verified | 2026-11-12 | real iPhone 16 Pro, iPhone 17 simulator | Bm7, C#m7b5/G#, F#7sus4: nothing outside the screen; buttons 56 px. | PR #20, briefing `2026-11-12-vibe-guitar-bundle4-done.html` |
| GC7 | Autoplay blocked message | partial | 2026-11-12 | real iPhone | The longest attention texts fit on a real iPhone (layout). The blocked-autoplay flow itself not recorded. | PR #20 |
| GC8 | Ads during control | unverified | – | – | – | – |
| GC9 | Rapid taps refused | verified | ec7aedd, 2026-11-13 | real iPhone | Fast repeated taps ignored. | B5-AUTO |
| GC10 | Revoke; re-pair after reload | partial | ec7aedd, 2026-11-13 | real iPhone | 승인 해제 worked. Reload re-pairing and switch-off cases not recorded. | B5-AUTO |
| GC11 | Revoke mid-command | unverified | – | – | Review and unit tests only (PR #19). | – |
| GC12 | Refused phone keeps showing chords | partial | 4402c9a, 2026-11-15 | iPhone 17 simulator, scripted publisher | QC2-1115: after a refusal the phone showed "Mac 패널에서 이 휴대폰의 조작을 거절했어요…" with no buttons and kept following a 카포 0 → 1 change (C/B → B/B♭). Missing: 거절 pressed in the real panel (the scripted publisher sent it) and a real phone. | QC2-1115 |

## N. Features added since 2026-11-12

| ID | Feature | Status | Build, date | Site | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | Shipped recognizer change (VGT-18: meanLog + ±1 semitone pitch-shift averaging) | verified | acb242f (finalist 6638ae0), 2026-11-14 | www.youtube.com captures, offline | TEST once, 18 held-out songs: majmin 82.3 → 83.3 (+1.01 pp, 95% [+0.37, +1.80], PASS). Live charts in Aside equal the offline finalist on 3 DEV and 18/18 TEST captures. Aside reloaded with the merged build. | VGT18-TEST, PR #37, briefing `2026-11-14-vibe-guitar-recognition-improvement-done.html` |
| N2 | Capture placement constant (0.128 s, then 0.069 s) | verified | f55e594, 2026-11-13; e815c21, 2026-11-15 | www.youtube.com | Probe-measured; validation median 2.7 ms after correction. 2026-11-15 (VGT-22, e815c21): validation median -0.0 ms and \|residual\| p95 2.3 ms after correction; constant 0.069 s since PR #57. A confirmation run on the 0.069 s build did not start (optional). | LAT, PR #26, LAT-1115, PR #57 |
| N3 | Uncertain "?" marks: computation in the live chart | verified | e2c89ce, 2026-11-15 | www.youtube.com | Live `uncertain` spans equal the offline flag and replace runs on 2 songs (R1 2/2). | VGT19-BROWSER |
| N4 | "?" in the lane, 대안 in 코드 고치기, one-tap replace (two tiers) | partial | e2c89ce, 2026-11-15; 9ef5398 and a372dbd, 2026-11-15 | www.youtube.com, demo | One-tap replace ("바꿨어요: Am -> D"), undo, an info-only stretch and the switch off were seen on the pre-PR #47 design. The quiet design (PR #47): demo panel "대안: G" (PR #48) and a real chart's header "대안: C♯m" (PR #51). Whether the marks help or distract the user is not recorded. Missing: a one-tap replace in a stored chart on the current design (seen only in the demo and on the pre-PR #47 design), 불확실한 곳 표시 off on the phone, and whether the marks help or distract (checklist C, last bullet; needs the user). | VGT19-BROWSER, PR #45, #47, #48, #51 |
| N5 | "?" on no-chord spans | partial | 9ef5398, 2026-11-15 | demo | Demo at 90.0 s: "코드 없음 · 대안: G" and "—?" in the lane. Not seen on a real song. | PR #48 |
| N6 | "?" on the phone stand | partial | 9ef5398, 2026-11-15 | phone page in Aside | The phone page rendered in a browser showed "Em?" and "C?". Not seen on a real phone through the relay (it appears after the relay is restarted with the new build). | PR #48, briefing `2026-11-15-vibe-guitar-uncertain-followups-done.html` |
| N7 | 처음 코드로 되돌리기 | partial | 9ef5398, 2026-11-15; c510d2f; 2288f5a + b0ec80b, 2026-11-15 | demo, offline, Aside extension storage | Demo: 대안 tap → "처음 들은 코드: Em · 처음 코드로 되돌리기" → restore → "대안: G" again. Offline: fix-then-restore at all 923 "?" stops of 23 DEV charts returned identical events and spans. QC1-1115 (service worker, disposable recording): a restore after a 대안 tap and one after a "?" stretch fix both returned the chord and the "?" spans equal to the original; a fix made in the older format (Em at 30.7 s, before events carried their auto chord) went back to E from the stored auto chart. Missing: the restore pressed in the real panel ("처음 들은 코드: X" and "처음 코드로 되돌리기" on a real song). | PR #48, #52, QC1-1115 |
| N8 | Fix panel: every bar outlined, time range | verified | a372dbd, 2026-11-15 | www.youtube.com (And She Was) | See F1. | PR #51 |
| N9 | Arrows stop at "?" stretches | verified | c510d2f, 2026-11-15 | http preview | And She Was at 14.2 s: E 0:14~0:23 (5 bars) → 0:14~0:15 (1) → 0:17~0:19 (2, 대안: A button) → 0:20~0:23 (2) → A♯ 0:23~0:24 (1). | PR #52 |
| N10 | Stretch-only fix stored in a real chart | verified | c510d2f; 2288f5a + b0ec80b, 2026-11-15 | offline, Aside extension storage | Exact restore offline (N7). Before 2026-11-15 the stored path (`stretchIsCurrent` conflict check) had unit tests only. QC1-1115: a fix at a "?" stop, saved through the service worker on a disposable copy of a stored chart, changed only the stretch [26.12, 27.9) s (two joined pieces); the parts of the chord before and after it stayed as they were. This row covers the stored result; the panel's stops and texts are F1 and N9. | PR #52, QC1-1115 |
| N11 | Hidden http preview `sidepanel.html?demo=1&chart=…&t=…` | verified | c510d2f, 2026-11-15 | aside repl http page | Loaded a chart, paused at t, no lyrics; frontmost app unchanged. The invalid-chart message: unit tests only. | PR #52, README.md:395-406 |
| N12 | Lane joins small same-chord gaps | verified | 20268b9 / 74695df, 2026-11-15 | offline | TEST-3, 20 new songs: lane "?" per minute 18.81 → 14.59 (−22.5%, pass line 15%). Drawing: unit tests. | docs/uncertainty-results.md:152-170, PR #49, #50 |
| N13 | Real-song accuracy (VGT-7, VGT-21) | verified | 2026-11-13 / 2026-11-14 | www.youtube.com captures | Held-out Billboard, 18 scored of 46: song-mean majmin 83.1% (95% 77.3-88.7). K-pop chord-order evaluation, 12 songs: recommendation "not now" for fine-tuning. | HELDOUT-V2, docs/kpop-eval-results.md:7-18 |

## Unverified items an agent can check without the user

Only rows, or the missing part of a partial row, that need neither the user's ears, guitar, accounts or phone
nor a toolbar click. None of them touches the user's browser windows (see the quiet-check rule); the hidden
preview's parameters are in README.md "Demo playback and screenshots".

| ID | What is left | Method |
| --- | --- | --- |
| C6 | A slash chord with an open-string bass (C/E, D/A, Am/E) staying at 입문 | hidden preview of a chart with C/E, D/A and Am/E, `level=beginner` |
| C8 | Strumming suggestion matches the meter and level | hidden preview, `sheet=1`, a 4/4 and a 6/8 chart at each level |
| E1 | 0.5× in the demo (the rest needs a live tab) | hidden preview, `rate=0.5` |
| E2 | Accent border and countdown badge, the coming chord between chords, a four-fret shape replacing a five-fret one, the settings list after PR #61 | hidden preview at 400 px and narrower, `theme=dark` |
| E4 | Bar phase line in 분석 정보 for a moved downbeat | hidden preview of a chart whose downbeat was moved |
| E5 | Countdown and count-in in 6/8 | hidden preview of a 6/8 chart with `mute` (no click sound) |
| E7 | Sections "1–8마디" without lyrics (the live lookup stays open) | hidden preview (it never requests lyrics) |
| E9 | "현재 위치로" after scrolling the grid | hidden preview |
| E10 | Fix panel in the dark theme | hidden preview, `theme=dark&fix`, 400 px |
| F2, F5, F7, F11 | Preview and status texts, the badge's explanation after a fix and the badge after 되돌리기, demo notice | hidden preview, `fix` on a C/B chord and a plain chord (texts only; storage stays open) |
| S11 | The note "N–M마디 반복 중" on the row with the loop on | hidden preview, `capo=1`, 400 px |
| D9 | `npm run accuracy-report` on a real export | offline, after D8 |
| D7, D8 | 정확도 모아 보기 and 결과 내보내기 on stored charts | extension page in a background tab, after the user's session has stored a comparable song (D6) |

Rows that need the panel on a real tab but no judgment (an agent can do them only in a session the user opens
for it): A3 (the new id's chart), C1, C2, C7, C11, E8, F9, F10, N7, S2, G1, G6, G7, G12, GC1, GC4, GC11, GC12.

## Still needs the user

Ordered so a sitting can start with one song and stop after any step. No step asks you to judge a chord by ear.

### 1. Required, about 5 minutes: one practice song (C12, C3, C5, A8, D12)

In Aside open ONE of the three practice songs on www.youtube.com: Let It Be (`QDYfEBY9NM4`), Come Together
(`oolpPmuK2I8`) or While My Guitar Gently Weeps (`bI8P6ZSHSvE`). Their practice charts are already stored in your
extension, so there is no import step. (Drive My Car, `kfSQkZuIx84`, keeps the edited auto chart it already has;
import its practice chart with 편집 → JSON 가져오기 only if you want it.) Click the toolbar icon, choose a level,
and play along once with the guitar.

Answer one question: **where did you stop or struggle?** An approximate minute is enough ("about 1:30"), or
"nowhere". The agent reads the chart at that minute and maps the answer to the rows: C12 (could you play along
without stopping), C3 (the next chord came too late), C5 (a shape too hard at that level), A8 and D12 (the chart
was ahead of or behind the song there).

### 2. Optional short cards (each independent)

- **An ad, if one plays (0 min extra; A4, S9, G9, GC8).** Does the header show "광고" with the red banner and do
  the chords stop? With a loop on, does anything jump? With the phone connected, does it show "광고 중"?
- **Phone stand while playing (about 5 min; G2, G5, G8, G11, N6).** Double-click `Vibe Guitar Phone.command` in
  Finder, turn on 휴대폰 악보대, scan the QR code and play the same song with the phone on a stand. Did Finder start
  the relay? Can you read names and diagrams at arm's length, portrait and landscape? Turn the phone's Wi-Fi off
  and on: does it reconnect by itself? (N6: on a song with an auto chart, does a "?" appear on the phone where the
  panel lane shows one?)
- **Speed on the next video (1 min; S3).** Press 0.75×, then let the next video start: does the speed go back to 1×?
- **YouTube Music recording identity (2 min; A6).** Open `music.youtube.com/watch?v=iKzRIweSBLA` and click the
  toolbar icon. Write down the header's id and whether the yellow notice "주소의 v=iKzRIweSBLA와 다른 녹음이 재생
  중입니다" appears.
- **Apple Music web capability (2 min; B5).** Signed in to music.apple.com, play a full song with the sound audible
  and click the toolbar icon. Write down 오디오 수신 예 / 아니요. Audible music with "아니요" (no captured audio) means
  unsupported; stop there. A silent or muted tab decides nothing.
- **"?" marks on an auto chart (3 min; N4, checklist C last bullet).** On a song WITHOUT a practice chart (it
  gets an auto chart), play for a while: do the small "?" marks help, distract or go unnoticed? This is separate
  from the practice-song question in step 1.

### 3. Optional capture checks

These need a live tab capture: one toolbar click per tab starts it, and sound plays during the check. The
agent can talk you through them; you only click.

- **B2, A5 (YouTube Music capture).** On music.youtube.com, one toolbar click: 상태 "캡처 중", 오디오 수신 "예".
  Then play from search, a playlist and the radio queue and let one track change.
- **B3, A3 (navigation in the same tab).** In a captured www.youtube.com tab click a recommended video: 대상 탭
  shows the new address and the new id's chart (or "코드표가 없습니다") loads.
- **B4 (stop and restart).** Press 캡처 중지, then click the toolbar icon a second time: "캡처 중" comes back.
- **D2, D3 (listening card).** In a captured tab with no chart, watch the "인식 중" card; pause, seek ahead and set
  1.25× once.
- **D5 (half a song).** After about half a song press "들은 구간으로 자동 코드표 만들기".
- **F8 (new analysis).** Fix any chord, press "들은 구간으로 자동 코드표 만들기", then reload the panel and the tab:
  the fix stays.
- **N5, N7 (real song).** On a song with an auto chart, look for a "?" on a "—" span; tap a 대안 or fix a "?"
  stretch, then 처음 코드로 되돌리기.
- **D6 (optional).** On a practice song, let a full listen build an auto chart: the practice chart stays in use
  and the card shows the match percentage; "자동 코드표로 바꾸기" → cancel keeps it.
