/** Side panel: play view (mockup B), chart editor, listening/capture readout, settings. */
import { uniqueVoicings } from '../../arrange/arrange';
import { isNoChord } from '../../arrange/chord';
import { LEVELS, type Level } from '../../arrange/levels';
import { VERDICT_TEXT, suitabilityLine, type LevelSuitability } from '../../arrange/suitability';
import { suggestStrumming } from '../../arrange/strum';
import { PITCH_CLASS_LABELS } from '../../audio/chroma';
import { EXAMPLE_CHARTS } from '../../chart/examples';
import type { Chart, Recording, Timing } from '../../chart/types';
import { validateChart } from '../../chart/validate';
import { compareCharts } from '../../eval/metrics';
import {
  addTap,
  attachChartToRecording,
  buildChart,
  chartToSequenceText,
  fitTapTempo,
  nextToStamp,
  parseChordSequence,
  quantizeStamps,
  stamp,
  undoStamp,
  type StampState,
} from '../../editor/core';
import { DraftBook, chartWriteTarget, checkSaveTarget, isDraftEmpty, reattachDraft, recordingKeyOf, type EditorDraft } from '../../editor/drafts';
import type { Lyrics } from '../../lyrics/types';
import { keyLabel, prettyChord } from '../../music/key';
import { DEMO_RECORDING, DemoClock, demoChart, demoLyrics } from '../../play/demo';
import { LevelFitController, type LevelFitState, type LevelWorkerLike } from '../../play/level-fit';
import { buildPlayModel, frameAt, type PlayModel } from '../../play/model';
import type { LyricsReply } from '../lyrics-service';
import type {
  AutoChartSavedMessage,
  CaptureStatsMessage,
  CaptureStatusMessage,
  ExtensionMessage,
  ListenStateMessage,
  LyricsGetMessage,
  PlayerControlMessage,
  PlayerControlResult,
  PlayerStateMessage,
} from '../messages';
import { estimatePosition, type PlayerSnapshot } from '../playview';
import { adoptAutoChart, listCharts, loadAutoChart, loadChart, loadSettings, normalizeSettings, saveChart, saveSettings, type Settings } from '../storage';
import { escapeHtml, renderShapeDiagram } from './diagram';
import { LyricsAsker, lyricsOutcome, lyricsLookupReady } from './lyrics-asker';
import { controlTabId, keepPlayerAfterDemo } from './player-target';
import { prepareCountIn } from './countin-prep';
import { PlayScreen, formatTime } from './play';

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const setText = (id: string, text: string): void => {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
};
const setHtml = (el: HTMLElement, html: string): void => {
  if (el.innerHTML !== html) el.innerHTML = html;
};

/** Demo playback never writes charts or drafts (it replays with a simulated clock). */
const DEMO_BLOCK = '데모 재생 중에는 코드표를 저장하거나 바꾸지 않아요. 데모를 끝낸 뒤 다시 해 주세요.';
const LEVEL_LABEL: Record<Level, string> = { beginner: '입문', novice: '초급', intermediate: '중급', advanced: '상급' };
const params = new URLSearchParams(location.search);
/** False when the page is opened outside the extension (file:// preview, screenshots). */
const hasChrome = typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.runtime?.id;

// ---------- state ----------
let settings: Settings;
let player: PlayerStateMessage | null = null;
let playerTabId: number | null = null;
/** Active tab of the panel's window (followed during demo too); player commands go only there. */
let activeTabId: number | null = null;
let myWindowId: number | null = null;
let chart: Chart | null = null;
let chartKey = '';
let model: PlayModel | null = null;
let screen: PlayScreen;
let editor: StampState = { chords: [], stamps: [] };
let taps: number[] = [];
let editorTiming: Timing = { bpm: 100, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 };
/** Recording the editor draft belongs to (drafts never follow navigation to another song). */
let draftRecording: Recording | null = null;
const draftBook = new DraftBook();
/** Most recent non-empty draft left behind by navigation; can be reattached explicitly. */
let leftDraft: EditorDraft | null = null;
/** Latest listening-mode status for the active tab, and when it arrived. */
let listen: ListenStateMessage | null = null;
let listenAt = 0;
/** Auto chart waiting for the user's confirm (a manual chart is in use). */
let pendingAuto: Chart | null = null;
/** Lyrics for chartKey (null = none / not loaded) and the request bookkeeping. */
let lyrics: Lyrics | null = null;
let lyricsNote = '';
const lyricsAsker = new LyricsAsker();
/** Demo playback: a simulated clock replaying a stored or synthetic chart. */
let demo: { clock: DemoClock; chart: Chart; lyrics: Lyrics | null; key: string } | null = null;
/** Count-in in progress (cancelled by pressing play again or seeking). */
let countInRun = 0;
let countingIn = false;

// ---------- player sync ----------
function snapshot(): PlayerSnapshot | null {
  return player ? { currentTime: player.currentTime, paused: player.paused, playbackRate: player.playbackRate, sampledAt: player.sampledAt } : null;
}

function positionNow(withOffset = true): number {
  if (demo) return demo.clock.t;
  const s = snapshot();
  return s ? estimatePosition(s, Date.now(), withOffset ? settings.syncOffsetMs : 0) : 0;
}

function recordingKey(r: Recording | null): string {
  return r ? `${r.source}:${r.id}` : '';
}

async function onPlayerState(msg: PlayerStateMessage, sender: chrome.runtime.MessageSender): Promise<void> {
  const tab = sender.tab;
  if (!tab || tab.id === undefined) return;
  if (myWindowId !== null && tab.windowId !== myWindowId) return;
  if (!tab.active) return;
  activeTabId = tab.id;
  if (demo) return;
  const durationBefore = player?.duration ?? 0;
  player = msg;
  playerTabId = tab.id;
  if (msg.adapter === 'applemusic') renderAppleMusicStatus(msg);
  const key = recordingKey(msg.recording);
  if (key !== chartKey) {
    stopCountIn();
    chartKey = key;
    lyrics = null;
    lyricsNote = '';
    lyricsAsker.reset();
    switchDraft(msg.recording);
    await reloadChart();
    renderEditorTarget();
  } else if (!durationBefore && msg.duration > 0 && chart) {
    recompute();
  }
  void requestLyrics();
  renderHeader();
}

/** Forget the current player (tab switch, demo exit) until the active tab's player reports. */
function forgetPlayer(): void {
  stopCountIn(); // the count-in loop must not outlive the model it counts against
  if (player === null && playerTabId === null) return;
  switchDraft(null);
  player = null;
  playerTabId = null;
  chartKey = '';
  chart = null;
  lyrics = null;
  lyricsNote = '';
  recompute();
  renderHeader();
}

/** Re-read the active tab of the panel's window (unknown on failure, which blocks player commands). */
async function refreshActiveTab(): Promise<void> {
  if (!hasChrome) return;
  try {
    const [t] = await chrome.tabs.query(myWindowId !== null ? { active: true, windowId: myWindowId } : { active: true, currentWindow: true });
    activeTabId = t?.id ?? null;
  } catch {
    activeTabId = null;
  }
}

async function reloadChart(): Promise<void> {
  if (demo) return;
  const r = player?.recording;
  chart = r && hasChrome ? await loadChart(r.source, r.id) : null;
  recompute();
  await refreshPendingAuto();
}

async function refreshPendingAuto(): Promise<void> {
  const r = player?.recording;
  pendingAuto = null;
  if (r && chart && chart.provenance.createdBy !== 'recognizer' && hasChrome) {
    const auto = await loadAutoChart(r.source, r.id);
    if (auto) pendingAuto = auto;
  }
  renderPending();
}

function renderPending(): void {
  const box = $('listen-pending');
  $('pending-note').hidden = !pendingAuto || !chart;
  if (!pendingAuto || !chart) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const c = compareCharts(chart, pendingAuto);
  const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
  setText(
    'listen-compare',
    c.overlapSec > 0
      ? `직접 만든 코드표와의 일치율(겹친 ${formatTime(c.overlapSec)}): 장·단 ${pct(c.majmin.score)} · 근음 ${pct(c.root.score)} · 7th 포함 ${pct(c.sevenths.score)}${c.beatF ? ` · 박 F ${c.beatF.f.toFixed(2)}` : ''}`
      : '두 코드표가 겹치는 구간이 없습니다.',
  );
}

// ---------- lyrics ----------
/** Ask the service worker for this recording's lyrics (cache first; LRCLIB only when the setting is on). */
async function requestLyrics(): Promise<void> {
  if (demo || !hasChrome || !chart) return;
  const r = player?.recording;
  if (!r) return;
  const duration = player?.duration ?? 0;
  if (!lyricsLookupReady(player)) return; // ads report their own duration under the song id
  if (!lyricsAsker.shouldAsk(chartKey, settings.fetchLyrics, duration > 0)) return;
  const forKey = chartKey;
  const ticket = lyricsAsker.begin();
  const msg: LyricsGetMessage = { type: 'lyrics-get', recording: r, durationSec: duration, allowFetch: settings.fetchLyrics };
  let reply: LyricsReply | undefined;
  try {
    reply = (await chrome.runtime.sendMessage(msg)) as LyricsReply | undefined;
  } catch (e) {
    reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (forKey !== chartKey) return;
  const out = lyricsOutcome(reply, settings.fetchLyrics);
  // A superseded reply (e.g. the lookup cancelled by OFF arriving after ON asked again) must not
  // overwrite the newer status; found lyrics are still worth showing.
  if (!lyricsAsker.isLatest(ticket) && !out.lyrics) return;
  if (out.lyrics !== undefined) lyrics = out.lyrics;
  lyricsNote = out.note;
  recompute();
}

// ---------- model ----------
function currentCapo(): 'auto' | number {
  const q = params.get('capo');
  if (demo && q !== null) return q === 'auto' ? 'auto' : Number(q);
  return settings.capo;
}

// Other levels' suitability: a dedicated worker, or the main thread after the first render.
let levelFits = new Map<Level, LevelFitState>();
const levelFit = new LevelFitController({
  createWorker: () => new Worker('level-worker.js') as unknown as LevelWorkerLike,
  onUpdate: (states) => {
    levelFits = states;
    renderLevelFit();
    renderChip();
  },
  schedule: (fn) => requestAnimationFrame(() => setTimeout(fn, 0)),
  onTiming: (ms, lv) => console.debug(`level-fit worker: ${lv.join(',')} in ${ms} ms`),
});

function recompute(): void {
  const c = demo ? demo.chart : chart;
  const ly = demo ? demo.lyrics : lyrics;
  const opts = {
    level: settings.level,
    capo: currentCapo(),
    profile: settings.profile,
    allowRootChange: settings.allowRootChange,
    durationSec: demo ? demo.clock.durationSec : player?.duration,
  };
  try {
    model = c ? buildPlayModel(c, opts, ly) : null;
  } catch (e) {
    console.error(e);
    // Lyrics are optional: if they break the model, keep the chord view without them.
    try {
      model = c && ly ? buildPlayModel(c, opts, null) : null;
    } catch (e2) {
      console.error(e2);
      model = null;
    }
  }
  screen.setModel(model);
  screen.setLook(settings.lookAheadBars);
  // Any song or settings change drops pending replies. The current level's line comes from the
  // model; the worker adds only its "with root changes" count (it also computes the other levels).
  levelFit.update(c && model ? { chart: c, capo: opts.capo, profile: { ...settings.profile }, allowRootChange: settings.allowRootChange } : null, [...LEVELS]);
  renderStatic();
}

/** Suitability of a level: the shown arrangement for the current level, else the computed one. */
function fitOf(level: Level): LevelSuitability | 'pending' | 'error' | null {
  if (!model) return null;
  const st = levelFits.get(level);
  if (level === settings.level) {
    const hint = st?.status === 'done' ? st.result.hardChordsWithRootChange : null;
    return { ...model.suitability, hardChordsWithRootChange: hint };
  }
  if (!st) return null;
  return st.status === 'done' ? st.result : st.status;
}

function renderLevelFit(): void {
  const ul = document.getElementById('level-fit');
  if (!ul) return;
  if (!model) {
    setHtml(ul, '');
    return;
  }
  const rows = LEVELS.map((level) => {
    const f = fitOf(level);
    const cur = level === settings.level ? ' class="cur"' : '';
    if (f === null || f === 'pending') return `<li${cur}><b>${LEVEL_LABEL[level]}</b> · <span class="pend">계산 중…</span></li>`;
    if (f === 'error') return `<li${cur}><b>${LEVEL_LABEL[level]}</b> · 계산하지 못했어요</li>`;
    const line = escapeHtml(suitabilityLine(f, LEVEL_LABEL[level], prettyChord));
    const sub: string[] = [];
    if (f.changed) sub.push(`바뀐 코드 ${f.changed}개${f.rootChanged ? ` (근음 바뀜 ${f.rootChanged}개)` : ''}`);
    if (f.hardBeatShare !== null && f.hardChords.length) sub.push(`어려운 코드 비중 ${Math.round(f.hardBeatShare * 100)}%`);
    if (f.hardChordsWithRootChange !== null) sub.push(`근음 바꾸기를 켜면 어려운 코드 ${f.hardChordsWithRootChange}개`);
    const title = f.hardChords.length ? ` title="${escapeHtml(f.hardChords.map((h) => `${prettyChord(h.name)}: ${prettyChord(h.shape)} ${h.frets ?? '운지 없음'}`).join(', '))}"` : '';
    return `<li${cur}${title} data-v="${f.verdict}">${line.replace(LEVEL_LABEL[level], `<b>${LEVEL_LABEL[level]}</b>`)}${sub.length ? `<small>${escapeHtml(sub.join(' · '))}</small>` : ''}</li>`;
  });
  setHtml(ul, rows.join(''));
}

// ---------- header / static parts ----------
function shownRecording(): Recording | null {
  return demo ? demo.chart.recording : (player?.recording ?? null);
}

function renderHeader(): void {
  const r = shownRecording();
  if (!r) {
    setText('song-title', player ? '곡 ID를 찾지 못했어요' : '재생 중인 곡이 없어요');
    setText('song-artist', '');
  } else {
    setText('song-title', r.title || '(제목 없음)');
    setText('song-artist', r.artist || '');
  }
  if (player && !demo) {
    const state = player.isAd ? '광고' : player.paused ? '정지' : '재생';
    const rate = player.playbackRate !== 1 ? ` · ${player.playbackRate}x` : '';
    const via = player.via !== 'video-element' ? ` · ${player.via}` : '';
    setText('rec-meta', `${player.adapter}${r ? ` · ${r.id}` : ''} · ${state}${rate}${via} · ${formatTime(positionNow(false))}`);
  }
  $('ad-banner').hidden = !player?.isAd || !!demo;
  const idWarn = $('id-warning');
  const fallback = !demo && player?.adapter === 'ytmusic' && player.idSource && player.idSource !== 'player';
  idWarn.hidden = demo !== null || (!fallback && !player?.urlIdMismatch);
  setText(
    'id-warning',
    player?.urlIdMismatch
      ? `주소의 v=${player.urlIdMismatch}와 다른 녹음이 재생 중이에요. 코드표는 실제 재생 중인 ${r?.id ?? ''}에 연결해요.`
      : fallback
        ? '플레이어에서 재생 중인 곡 ID를 확인하지 못해 주소의 ID를 써요. 실제 재생 곡과 다를 수 있어요.'
        : '',
  );
}

function renderBadge(): void {
  const c = demo ? demo.chart : chart;
  const badge = $('badge');
  const pop = $('badge-pop');
  if (!c || (c.provenance.createdBy !== 'recognizer' && !c.provenance.example)) {
    badge.hidden = true;
    pop.classList.remove('open');
    return;
  }
  badge.hidden = false;
  if (c.provenance.example) {
    setText('badge-long', '예시 코드표 · 타이밍은 가짜');
    setText('badge-short', '예시 코드표');
    badge.setAttribute('aria-label', '예시 코드표, 타이밍은 가짜. 설명 보기');
    pop.innerHTML = '<p>코드 진행만 보여 주는 <b>예시 코드표</b>예요. 박자와 타이밍은 실제 곡과 맞지 않아요.</p>';
    return;
  }
  setText('badge-long', '자동 코드표 · 사람이 확인하지 않음');
  setText('badge-short', '자동 코드표 · 미확인');
  badge.setAttribute('aria-label', '자동 코드표, 사람이 확인하지 않음. 설명 보기');
  const heard = c.coverage.reduce((s, r) => s + r.toSec - r.fromSec, 0);
  const dur = demo ? demo.clock.durationSec : player?.duration || 0;
  pop.innerHTML =
    `<p>재생하면서 들은 소리로 자동으로 만든 코드표예요. ${dur ? `곡 ${formatTime(dur)} 중 ${formatTime(heard)}를 들었지만` : '사람이 확인하지는 않았어요.'}${dur ? ', 사람이 확인하지는 않았어요.' : ''}</p>` +
    '<p>화면에는 <b>가능성 높은 코드</b>를 보여 드려요. 중급 이상에서는 더 쉬운 코드로 쳐도 되는 곳을 함께 알려 드려요.' +
    (model?.lyrics ? ' 구간 이름은 가사로 짐작한 것이에요.' : '') +
    '</p>';
}

function capoText(): string {
  const cap = currentCapo();
  const used = model?.arrangement.capo ?? (cap === 'auto' ? 0 : cap);
  return cap === 'auto' ? `카포 ${used}(자동)` : `카포 ${used}`;
}

function renderChip(): void {
  const fit = model?.suitability;
  const t = `${LEVEL_LABEL[settings.level]} · ${capoText()}${fit ? ` · ${VERDICT_TEXT[fit.verdict]}` : ''}`;
  setText('chip', t);
  $('chip').setAttribute('aria-label', `연주 설정: ${t}. 설정 열기`);
}

function renderEmpty(): void {
  const empty = $('empty');
  const show = !model;
  empty.hidden = !show;
  if (!show) return;
  const r = shownRecording();
  $('empty-edit').hidden = !r;
  $('empty-listen').hidden = !r;
  if (!player && !demo) {
    setText('empty-title', '재생 중인 곡이 없어요');
    setText('empty-text', hasChrome ? 'YouTube · YouTube Music · Apple Music 탭에서 곡을 재생하세요. 탭이 열려 있는데도 이 문구가 보이면 그 탭을 새로고침하세요.' : '확장 밖에서 열었어요. 데모 재생으로 화면을 확인할 수 있어요.');
  } else if (!r) {
    setText('empty-title', '곡 ID를 찾지 못했어요');
    setText('empty-text', '재생 중인 곡을 알아내지 못했어요. 탭을 새로고침해 보세요.');
  } else {
    setText('empty-title', '이 곡의 코드표가 아직 없어요');
    const fresh = listen && Date.now() - listenAt < 3000 && (!listen.recordingKey || listen.recordingKey === chartKey);
    setText(
      'empty-text',
      fresh
        ? `듣기 모드로 ${Math.round(listen!.coveredFraction * 100)}%를 들었어요. 90% 이상 듣고 끝까지 재생하면 자동 코드표를 만들어요.`
        : '툴바의 Vibe Guitar 아이콘을 누르면 듣기 모드가 시작돼요. 직접 만들려면 편집 탭을 쓰세요.',
    );
  }
}

function renderStatic(): void {
  renderBadge();
  renderChip();
  renderEmpty();
  renderLevelFit();
  // capo suggestion
  const sug = model?.capoSuggestions ?? [];
  setText('capo-suggest', sug.length ? `추천: ${sug.slice(0, 2).map((s) => `${s.capo === 0 ? '없음' : `${s.capo}프렛`}(${s.shapes.slice(0, 4).map(prettyChord).join(' ')})`).join(' · ')}` : '');
  const cap = currentCapo();
  setText('capo-out', cap === 'auto' ? `자동 · ${model?.arrangement.capo ?? 0}` : cap === 0 ? '없음' : `${cap}프렛`);
  // look-ahead / count-in notes in big beats
  if (model) {
    const b = model.big;
    const unit = b.compound ? '큰 박' : '박';
    setText('look-note', `바뀌기 전에 다음 코드를 강조해요 · 1마디 = ${unit} ${b.bigPerBar}개`);
    setText('countin-note', `패널에서 재생을 누르면 ${unit}을 세어 줘요 (${b.label})`);
    // Compound meter detected from a 6-beat tracker grid counts as 6/8 for strumming too.
    const s = suggestStrumming(settings.level, model.big.compound ? { ...model.timing, beatUnit: 8 } : model.timing);
    setText('strum', `${s.meter} ${s.style === 'fingerstyle' ? '핑거스타일' : '스트로크'}: ${s.steps.join(' ')}${s.style === 'fingerstyle' ? ' (p=엄지 i=검지 m=중지 a=약지)' : ' (D=다운 U=업)'}`);
  } else setText('strum', '');
  // analysis readout
  if (model) {
    const parts = [
      model.key ? `조성 ${keyLabel(model.key)}` : '조성 –',
      `${model.big.label}${model.big.compound ? ` (큰 박 ${model.big.bigPerBar}개)` : ''}`,
      model.phaseShifted ? `마디 시작 보정: ${model.phase.phase}박 이동 (코드 전환 ${model.phase.hits}/${model.phase.onBeat}개가 마디 시작)` : `마디 시작: 그대로 (코드 전환 ${model.phase.currentHits}/${model.phase.onBeat}개가 마디 시작)`,
      model.lyrics ? `가사 ${model.lyrics.kind === 'words' ? '단어 단위' : '줄 단위'}, 시간 보정 ${model.lyricOffset?.offsetSec ? `${model.lyricOffset.offsetSec > 0 ? '+' : ''}${model.lyricOffset.offsetSec.toFixed(2)}초` : '없음'}` : '가사 없음',
    ];
    setText('analysis', `${parts.join(' · ')}${lyricsNote && !demo ? ` · ${lyricsNote}` : ''}`);
  } else setText('analysis', lyricsNote || '–');
  // chords in this song (settings tab), with "잡을 수 있음" toggles
  const grid = $('song-chords');
  if (!model) setHtml(grid, '');
  else {
    const known = new Set(settings.profile.knownShapes);
    const cells = uniqueVoicings(model.arrangement).map((u) => {
      const dg = u.voicing ? renderShapeDiagram(u.voicing, 120) : '<div class="muted small">운지 없음</div>';
      const toggle = u.voicing ? `<label class="small"><input type="checkbox" data-known="${escapeHtml(u.voicing.id)}" ${known.has(u.voicing.id) ? 'checked' : ''}/> 잡을 수 있음</label>` : '';
      return `<div class="cell"><div class="name">${escapeHtml(u.shape)}</div>${dg}${toggle}</div>`;
    });
    if (model.arrangement.unplayable.length) cells.push(`<div class="cell err small">운지를 찾지 못함: ${escapeHtml(model.arrangement.unplayable.join(', '))}</div>`);
    setHtml(grid, cells.join(''));
  }
  renderEditorTarget();
}

// ---------- frame loop ----------
let lastT = -1;
function loop(now: number): void {
  try {
    if (demo) {
      demo.clock.tick(now);
    }
    renderHeader();
    if (model && (demo || (player && !player.isAd))) {
      const t = positionNow();
      const playing = demo ? demo.clock.playing : !!player && !player.paused;
      screen.render(t, playing || countingIn, Math.abs(t - lastT) > 1.5);
      lastT = t;
    }
    if (listen && !$('listen-card').hidden && Date.now() - listenAt > 3000) renderListen();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(loop);
}

// ---------- listening mode ----------
function onListenState(msg: ListenStateMessage): void {
  if (playerTabId !== null && msg.tabId !== playerTabId) return;
  listen = msg;
  listenAt = Date.now();
  const model = { idle: '대기', loading: '불러오는 중', ready: '준비됨', error: '오류' }[msg.modelState];
  setText('cap-model', `${model}${msg.modelError ? `: ${msg.modelError}` : ''}`);
  setText('cap-backend', msg.backend || '–');
  renderListen();
}

function renderListen(): void {
  const card = $('listen-card');
  const fresh = listen && Date.now() - listenAt < 3000;
  const key = player?.recording ? `${player.recording.source}:${player.recording.id}` : null;
  if (!fresh || !listen || (listen.recordingKey && key && listen.recordingKey !== key)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const l = listen;
  if (l.modelState !== 'ready') {
    setText('listen-chord', '–');
    setText('listen-conf', l.modelState === 'error' ? `모델 오류: ${l.modelError ?? ''}` : '모델을 불러오는 중…');
  } else if (l.live) {
    setText('listen-chord', l.live.chord === 'N' ? 'N.C.' : l.live.chord);
    setText('listen-conf', `신뢰도 ${Math.round(l.live.confidence * 100)}% · ${formatTime(l.live.atSec)} 부근`);
  } else {
    setText('listen-chord', '–');
    setText('listen-conf', '');
  }
  const pct = Math.round(l.coveredFraction * 100);
  ($('listen-coverage-fill') as HTMLElement).style.width = `${pct}%`;
  const heard = l.coverage.reduce((s, r) => s + r.toSec - r.fromSec, 0);
  setText('listen-coverage', l.durationSec > 0 ? `들은 구간 ${pct}% (${formatTime(heard)} / ${formatTime(l.durationSec)}, 구간 ${l.coverage.length}개) · 90% 이상 듣고 끝까지 재생하면 자동으로 코드표를 만듭니다.` : '곡 길이를 기다리는 중');
  setText('listen-status', l.analyzing ? '분석 중… (곡 길이에 따라 수 초)' : l.recordingAudio ? '기록 중' : `기록 멈춤: ${l.idleReason ?? '오디오 대기'}`);
  $<HTMLButtonElement>('listen-analyze').disabled = l.analyzing || l.modelState !== 'ready' || l.coverage.length === 0;
  const a = l.lastAnalysis;
  if (a && a.recordingKey === key) {
    $('listen-result').className = `small ${a.error ? 'err' : 'ok'}`;
    setText('listen-result', a.error ? `자동 코드표 실패: ${a.error}` : `자동 코드표: 코드 ${a.events}개, 분석 ${(a.ms / 1000).toFixed(1)}초`);
  } else setText('listen-result', '');
}

function onAutoChartSaved(msg: AutoChartSavedMessage): void {
  const key = player?.recording ? `${player.recording.source}:${player.recording.id}` : null;
  if (msg.recordingKey !== key) return;
  if (msg.error) {
    $('listen-result').className = 'small err';
    setText('listen-result', `자동 코드표 저장 실패: ${msg.error}`);
  }
  void reloadChart();
}

async function doAdoptAuto(): Promise<void> {
  const target = chartWriteTarget(currentRecording(), demo !== null);
  if (!target.ok) return target.reason === 'demo' ? setText('listen-result', DEMO_BLOCK) : undefined;
  if (!pendingAuto) return;
  if (!confirm('직접 만든 코드표를 자동 코드표로 바꿀까요?\n직접 만든 코드표는 chartbackup 키에 보관됩니다(편집 탭의 JSON 내보내기로도 백업할 수 있습니다).')) return;
  const r = target.recording;
  await adoptAutoChart(r.source, r.id);
  await reloadChart();
}

// ---------- capture readout ----------
function renderCaptureStatus(msg: CaptureStatusMessage): void {
  const label = { starting: '시작 중', running: '캡처 중', stopped: '중지됨', error: '오류' }[msg.state];
  setText('cap-state', label);
  if (msg.url) setText('cap-tab', msg.url);
  setText('cap-error', msg.error ?? '–');
  $('cap-error').className = msg.state === 'error' ? 'err' : '';
}

function renderCaptureStats(msg: CaptureStatsMessage): void {
  setText('cap-state', '캡처 중');
  if (msg.url) setText('cap-tab', msg.url);
  setHtml($('cap-received'), msg.audioReceived ? '<span class="ok">예</span>' : `<span class="err">아니요</span>${msg.everReceived ? ' (이전에는 수신됨: 일시정지?)' : ` (${msg.elapsedSec.toFixed(0)}초째 무음)`}`);
  const db = msg.rms > 0 ? 20 * Math.log10(msg.rms) : -Infinity;
  setText('cap-rms', `${msg.rms.toFixed(5)} (${Number.isFinite(db) ? db.toFixed(1) : '-∞'} dBFS)`);
  setText('cap-rate', `${msg.sampleRate} Hz`);
  setText('cap-track', `${msg.trackState}${msg.trackMuted ? ' · muted' : ''}`);
  const bins = msg.chroma
    .map((v, i) => `<div class="bin"><div class="cbar" style="height:${Math.round(v * 100)}%"></div><div class="pc">${PITCH_CLASS_LABELS[i]}</div></div>`)
    .join('');
  $('chroma').innerHTML = bins;
}

function renderAppleMusicStatus(msg: PlayerStateMessage): void {
  const how =
    msg.via === 'musickit'
      ? '<span class="ok">MusicKit 인스턴스에서 재생 위치를 읽었습니다.</span>'
      : msg.via === 'media-element'
        ? '<span class="ok">페이지의 media 요소에서 재생 위치를 읽었습니다.</span>'
        : '<span class="err">재생 위치에 접근하지 못했습니다.</span>';
  const pos = msg.via === 'unreachable' ? '' : ` 위치 ${msg.currentTime.toFixed(1)}s, ${msg.paused ? '정지' : '재생'}, id ${escapeHtml(msg.recording?.id ?? '없음')}`;
  setHtml($('am-status'), `${how}${pos}${msg.note ? `<div class="muted">${escapeHtml(msg.note)}</div>` : ''}<div class="muted">오디오 캡처 결과는 위 표의 "오디오 수신"을 보세요(DRM 때문에 무음일 수 있음).</div>`);
}

// ---------- editor ----------
function currentRecording(): Recording | null {
  return player?.recording ?? null;
}

function currentDraft(): EditorDraft {
  return {
    recordingKey: recordingKeyOf(draftRecording),
    recording: draftRecording,
    seqText: $<HTMLTextAreaElement>('seq').value,
    chords: [...editor.chords],
    stamps: [...editor.stamps],
    timing: readEditorTiming(),
  };
}

function applyDraft(d: EditorDraft): void {
  draftRecording = d.recording;
  $<HTMLTextAreaElement>('seq').value = d.seqText;
  editor = { chords: [...d.chords], stamps: [...d.stamps] };
  writeEditorTiming(d.timing);
  taps = [];
  setText('seq-status', d.chords.length ? `${d.chords.length}개 코드` : '');
  setText('tap-status', '첫 탭은 마디의 첫 박(다운비트)에 맞춰 누르고, 이후 박마다 누릅니다.');
  renderStamps();
}

/** Store the draft of the song we leave and restore (or start) the draft of the new one. */
function switchDraft(next: Recording | null): void {
  const cur = currentDraft();
  if (!cur.recordingKey) {
    // An unbound draft (typed before any song was detected; it cannot have stamps) is
    // adopted by the next song; an empty one restores that song's stored draft.
    applyDraft(next && !isDraftEmpty(cur) ? reattachDraft(cur, next) : draftBook.switchTo(cur, next));
    renderReattach();
    return;
  }
  if (!isDraftEmpty(cur) && cur.recordingKey !== recordingKeyOf(next)) leftDraft = cur;
  applyDraft(draftBook.switchTo(cur, next));
  renderReattach();
}

function renderReattach(): void {
  const btn = $('draft-reattach');
  const show = !!leftDraft && !!currentRecording() && leftDraft.recordingKey !== recordingKeyOf(currentRecording());
  btn.hidden = !show;
  if (show) setText('draft-reattach', `이전 곡(${leftDraft!.recording?.title || leftDraft!.recordingKey})의 초안을 이 곡으로 옮기기`);
}

function doReattach(): void {
  const r = currentRecording();
  if (!leftDraft || !r) return;
  if (!isDraftEmpty(currentDraft()) && !confirm('지금 곡의 편집 초안을 이전 곡 초안으로 바꿀까요?')) return;
  draftBook.delete(leftDraft.recordingKey);
  applyDraft(reattachDraft(leftDraft, r));
  leftDraft = null;
  renderReattach();
  setStatus('save-status', '이전 곡의 초안을 이 곡에 연결했습니다. 타이밍이 맞는지 확인하세요.', false);
}

/** Stamping/tapping only for the song the draft belongs to. */
function draftMatchesPlayer(): boolean {
  if (!player || !draftRecording || recordingKeyOf(player.recording) !== recordingKeyOf(draftRecording)) {
    setStatus('save-status', '편집 초안이 지금 재생 중인 곡과 다릅니다. 찍기/탭을 무시했습니다.', true);
    return false;
  }
  return true;
}

function renderEditorTarget(): void {
  const r = currentRecording();
  setText('edit-target', r ? `${r.source} · ${r.id} · ${r.title}` : '재생 중인 곡이 없습니다.');
  renderReattach();
  setText('edit-existing', chart ? `저장된 코드표: 코드 ${chart.events.length}개, ${chart.timing.bpm} BPM${chart.provenance.example ? ' (예시)' : ''}` : '저장된 코드표 없음');
}

function meterToTiming(meter: string): Pick<Timing, 'beatsPerBar' | 'beatUnit'> {
  if (meter === '3/4') return { beatsPerBar: 3, beatUnit: 4 };
  if (meter === '6/8') return { beatsPerBar: 6, beatUnit: 8 };
  return { beatsPerBar: 4, beatUnit: 4 };
}

function readEditorTiming(): Timing {
  const bpm = Number($<HTMLInputElement>('bpm').value) || 100;
  const firstDownbeatSec = Math.max(0, Number($<HTMLInputElement>('downbeat').value) || 0);
  editorTiming = { ...editorTiming, bpm, firstDownbeatSec, ...meterToTiming($<HTMLSelectElement>('meter').value) };
  return editorTiming;
}

function writeEditorTiming(t: Timing): void {
  editorTiming = { ...t };
  $<HTMLInputElement>('bpm').value = String(t.bpm);
  $<HTMLInputElement>('downbeat').value = String(t.firstDownbeatSec);
  $<HTMLSelectElement>('meter').value = t.beatsPerBar === 3 ? '3/4' : t.beatsPerBar === 6 && t.beatUnit === 8 ? '6/8' : '4/4';
}

function renderStamps(): void {
  const next = nextToStamp(editor);
  setText('stamp', next ? `다음 코드 찍기: ${next} (J)` : editor.chords.length ? '모두 찍었습니다' : '먼저 코드 진행을 읽으세요');
  setText('stamp-status', `${editor.stamps.length} / ${editor.chords.length}`);
  $('stamp-list').innerHTML = editor.stamps.map((s, i) => `<li>${escapeHtml(editor.chords[i])} @ ${s.toFixed(2)}s</li>`).join('');
}

function parseSequenceFromTextarea(): void {
  const r = parseChordSequence($<HTMLTextAreaElement>('seq').value);
  editor = { chords: r.chords, stamps: editor.stamps.slice(0, r.chords.length) };
  setHtml($('seq-status'), `${r.chords.length}개 코드${r.errors.length ? `<div class="err">${r.errors.map(escapeHtml).join('<br>')}</div>` : ''}`);
  renderStamps();
}

function doStamp(): void {
  if (demo) return setStatus('save-status', DEMO_BLOCK, true);
  if (!draftMatchesPlayer()) return;
  editor = stamp(editor, positionNow(false));
  renderStamps();
}

function doTap(): void {
  if (demo) return setStatus('save-status', DEMO_BLOCK, true);
  if (!draftMatchesPlayer()) return;
  taps = addTap(taps, positionNow(false));
  const fit = fitTapTempo(taps);
  if (fit) {
    writeEditorTiming({ ...readEditorTiming(), bpm: fit.bpm, firstDownbeatSec: fit.firstDownbeatSec });
    setText('tap-status', `${fit.taps}번 탭: ${fit.bpm} BPM, 첫 다운비트 ${fit.firstDownbeatSec.toFixed(2)}s (흔들림 ${(fit.jitterSec * 1000).toFixed(0)}ms)`);
  } else setText('tap-status', `${taps.length}번 탭 (4번 이상 필요, 2.5초 쉬면 다시 시작)`);
}

async function doSave(): Promise<void> {
  const check = checkSaveTarget(currentDraft(), currentRecording(), { demo: demo !== null });
  if (!check.ok) {
    return setStatus(
      'save-status',
      check.reason === 'demo' ? DEMO_BLOCK : check.reason === 'no-recording' ? '재생 중인 곡이 없습니다.' : '이 초안은 다른 곡에서 만들었습니다. 저장하지 않았습니다(옮기려면 "초안을 이 곡으로 옮기기"를 누르세요).',
      true,
    );
  }
  const r = check.recording;
  if (!editor.stamps.length) return setStatus('save-status', '찍은 코드가 없습니다.', true);
  try {
    const timing = readEditorTiming();
    const stamps = $<HTMLInputElement>('quantize').checked ? quantizeStamps(editor.stamps, timing, 2) : editor.stamps;
    const existing = chartKey === recordingKeyOf(r) ? chart : null;
    const built = buildChart({ recording: r, timing, chords: editor.chords, stamps, durationSec: player?.duration || undefined, existing });
    await saveChart(built);
    chart = built;
    recompute();
    setStatus('save-status', `저장했습니다: 코드 ${built.events.length}개`, false);
  } catch (e) {
    setStatus('save-status', (e as Error).message, true);
  }
}

function setStatus(id: string, text: string, error: boolean): void {
  const el = $(id);
  el.textContent = text;
  el.className = `small ${error ? 'err' : 'ok'}`;
}

function loadExistingIntoEditor(): void {
  if (!chart || !player?.recording) return;
  draftRecording = player.recording;
  $<HTMLTextAreaElement>('seq').value = chartToSequenceText(chart);
  editor = { chords: chart.events.map((e) => e.chord), stamps: chart.events.map((e) => e.startSec) };
  writeEditorTiming(chart.timing);
  parseSequenceFromTextarea();
  editor = { ...editor, stamps: chart.events.map((e) => e.startSec) };
  renderStamps();
}

function exportJson(): void {
  if (!chart) return setStatus('io-status', '내보낼 코드표가 없습니다.', true);
  const blob = new Blob([JSON.stringify(chart, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vibe-guitar-${chart.recording.source}-${chart.recording.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJson(file: File): Promise<void> {
  if (demo) return setStatus('io-status', DEMO_BLOCK, true);
  try {
    const data = JSON.parse(await file.text()) as unknown;
    const v = validateChart(data);
    if (!v.ok) return setStatus('io-status', `형식 오류: ${v.errors.slice(0, 5).join('; ')}`, true);
    let c = v.chart!;
    // Re-check after the await: demo playback may have started while the file was read.
    if (demo) return setStatus('io-status', DEMO_BLOCK, true);
    const r = currentRecording();
    if ($<HTMLInputElement>('import-attach').checked && r) c = attachChartToRecording(c, r);
    await saveChart(c);
    if (recordingKey(c.recording) === chartKey) {
      chart = c;
      recompute();
    }
    setStatus('io-status', `가져왔습니다: ${c.recording.source}:${c.recording.id}`, false);
  } catch (e) {
    setStatus('io-status', (e as Error).message, true);
  }
}

async function attachExample(): Promise<void> {
  const target = chartWriteTarget(currentRecording(), demo !== null);
  if (!target.ok) return setStatus('io-status', target.reason === 'demo' ? DEMO_BLOCK : '재생 중인 곡이 없습니다.', true);
  const r = target.recording;
  const ex = EXAMPLE_CHARTS[Number($<HTMLSelectElement>('example-select').value)];
  const c = attachChartToRecording(ex, r);
  await saveChart(c);
  chart = c;
  recompute();
  setStatus('io-status', '예시 코드표를 현재 곡에 연결했습니다(타이밍은 가짜입니다).', false);
}

// ---------- transport, count-in ----------
async function sendControl(msg: PlayerControlMessage): Promise<PlayerControlResult> {
  if (demo) {
    if (msg.action === 'play') demo.clock.play(performance.now());
    else if (msg.action === 'pause') demo.clock.pause();
    else if (msg.time !== undefined) demo.clock.seek(msg.time);
    return { ok: true };
  }
  // Never control a player that is not in the active tab (e.g. the old tab after a demo).
  const target = controlTabId(playerTabId, activeTabId);
  if (target === null || !hasChrome) return { ok: false, reason: 'no player in the active tab' };
  try {
    const r = (await chrome.tabs.sendMessage(target, msg)) as PlayerControlResult | undefined;
    return r ?? { ok: false, reason: 'the player did not answer' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

let clickCtx: AudioContext | null = null;
function click(accent: boolean): void {
  if (!settings.countInClick || params.has('mute')) return;
  try {
    clickCtx ??= new AudioContext();
    const t = clickCtx.currentTime;
    const osc = clickCtx.createOscillator();
    const gain = clickCtx.createGain();
    osc.frequency.value = accent ? 1600 : 1000;
    gain.gain.setValueAtTime(0.3, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(clickCtx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
  } catch {
    // no audio output: the count is still shown
  }
}

function isPlaying(): boolean {
  return demo ? demo.clock.playing : !!player && !player.paused;
}

function stopCountIn(): void {
  countInRun++;
  countingIn = false;
  $('countin').classList.remove('on');
}

async function seekTo(sec: number): Promise<void> {
  stopCountIn();
  const r = await sendControl({ type: 'player-control', action: 'seek', time: Math.max(0, sec) });
  if (!r.ok) setText('countin-status', `이동하지 못했어요 (${r.reason ?? '알 수 없음'}).`);
  else setText('countin-status', '');
  lastT = -10;
}

/** Play / pause from the panel. Starting plays a count-in of big beats from the bar start. */
async function togglePlay(): Promise<void> {
  setText('countin-status', '');
  if (countingIn) return stopCountIn();
  if (isPlaying()) {
    const r = await sendControl({ type: 'player-control', action: 'pause' });
    if (!r.ok) setText('countin-status', `이 플레이어는 패널에서 멈출 수 없어요 (${r.reason ?? '알 수 없음'}).`);
    return;
  }
  if (!settings.countInBars || !model) {
    const r = await sendControl({ type: 'player-control', action: 'play' });
    if (!r.ok) setText('countin-status', `이 플레이어는 패널에서 재생할 수 없어요 (${r.reason ?? '알 수 없음'}).`);
    return;
  }
  const run = ++countInRun;
  const m = model;
  const pos = positionNow(false);
  const f = frameAt(m, pos);
  const bar = f.bar >= 0 ? m.bars[f.bar] : null;
  const target = Math.max(0, bar ? bar.startSec : pos);
  const prep = await prepareCountIn(sendControl, () => run === countInRun, target);
  if (prep.kind === 'cancelled') return;
  if (prep.kind === 'failed') {
    return setText('countin-status', prep.step === 'pause'
      ? `이 플레이어에서는 카운트인 재생을 지원하지 않아요 (${prep.reason ?? '알 수 없음'}).`
      : `마디 처음으로 이동하지 못해 카운트인을 취소했어요 (${prep.reason ?? '알 수 없음'}).`);
  }
  const rate = (demo ? demo.clock.rate : player?.playbackRate) || 1;
  const n = settings.countInBars * m.big.bigPerBar;
  const stepMs = (screen.bigBeatSec() * 1000) / rate;
  const box = $('countin');
  const num = box.querySelector('b')!;
  countingIn = true;
  box.classList.add('on');
  for (let i = n; i >= 1; i--) {
    if (run !== countInRun) return;
    num.textContent = String(i);
    click((n - i) % m.big.bigPerBar === 0);
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (run !== countInRun) return;
  countingIn = false;
  box.classList.remove('on');
  const play = await sendControl({ type: 'player-control', action: 'play' });
  if (!play.ok) setText('countin-status', `재생을 다시 시작하지 못했어요 (${play.reason ?? '알 수 없음'}).`);
}

// ---------- demo playback ----------
async function demoOptions(): Promise<{ key: string; label: string; chart: Chart }[]> {
  const out: { key: string; label: string; chart: Chart }[] = [];
  if (hasChrome) {
    try {
      for (const c of await listCharts()) {
        if (!validateChart(c).ok || c.provenance.example) continue;
        out.push({ key: recordingKey(c.recording), label: `${c.recording.title || c.recording.id}${c.provenance.createdBy === 'recognizer' ? ' (자동)' : ''}`, chart: c });
      }
    } catch {
      // storage unavailable: synthetic demo only
    }
  }
  out.push({ key: recordingKey(DEMO_RECORDING), label: '합성 데모 곡 (가짜 데이터)', chart: demoChart() });
  return out;
}

async function demoLyricsFor(c: Chart): Promise<Lyrics | null> {
  if (c.recording.id === DEMO_RECORDING.id) return params.get('lyrics') === '0' ? null : demoLyrics();
  if (!hasChrome) return null;
  try {
    const msg: LyricsGetMessage = { type: 'lyrics-get', recording: c.recording, durationSec: 0, allowFetch: false };
    const reply = (await chrome.runtime.sendMessage(msg)) as LyricsReply | undefined;
    return reply?.ok && reply.entry?.result === 'found' ? (reply.entry.lyrics ?? null) : null;
  } catch {
    return null;
  }
}

async function startDemo(preferKey?: string): Promise<void> {
  stopCountIn();
  const opts = await demoOptions();
  const pick = opts.find((o) => o.key === preferKey) ?? opts.find((o) => o.key === chartKey) ?? opts[opts.length - 1];
  const sel = $<HTMLSelectElement>('demo-select');
  sel.innerHTML = opts.map((o) => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`).join('');
  sel.value = pick.key;
  const end = Math.max(...pick.chart.coverage.map((r) => r.toSec), pick.chart.events.at(-1)?.startSec ?? 0) + 1;
  const start = demo === null && params.has('t') ? Number(params.get('t')) : 0;
  const clock = new DemoClock(end, start);
  const rate = Number(params.get('rate'));
  if (rate === 0.5) clock.rate = 0.5;
  demo = { clock, chart: pick.chart, lyrics: await demoLyricsFor(pick.chart), key: pick.key };
  $('demo-bar').hidden = false;
  $('rate-seg').hidden = false;
  for (const b of document.querySelectorAll('#rate-seg [data-rate]')) b.setAttribute('aria-pressed', String(Number((b as HTMLElement).dataset.rate) === clock.rate));
  showTab('play');
  closeSheet();
  recompute();
  lastT = -10;
  if (params.has('play')) clock.play(performance.now());
}

async function exitDemo(): Promise<void> {
  stopCountIn();
  demo = null;
  $('demo-bar').hidden = true;
  $('rate-seg').hidden = true;
  // Tab switches were not followed during the demo: drop a player that is no longer in the
  // active tab, re-check which tab is active now, and wait for that tab's player to report.
  if (!keepPlayerAfterDemo(playerTabId, activeTabId)) forgetPlayer();
  await refreshActiveTab();
  if (demo) return; // a new demo started meanwhile
  if (!keepPlayerAfterDemo(playerTabId, activeTabId)) forgetPlayer();
  // Back to the real song: its chart may have changed while storage events were ignored.
  recompute();
  renderHeader();
  void reloadChart();
}

// ---------- settings sheet ----------
let lastFocus: Element | null = null;
function openSheet(): void {
  lastFocus = document.activeElement;
  $('scrim').classList.add('open');
  $('sheet').classList.add('open');
  setTimeout(() => $('sheet-done').focus(), 50);
}
function closeSheet(): void {
  if (!$('sheet').classList.contains('open')) return;
  $('scrim').classList.remove('open');
  $('sheet').classList.remove('open');
  (lastFocus as HTMLElement | null)?.focus?.();
}

/** Saves the settings (the returned promise settles once they are stored) and re-renders. */
function persist(rebuild: boolean): Promise<void> {
  const saved = hasChrome ? saveSettings(settings).catch((e: unknown) => console.error(e)) : Promise.resolve();
  if (rebuild) recompute();
  else {
    screen.setLook(settings.lookAheadBars);
    renderStatic();
  }
  return saved;
}

function syncSheet(): void {
  for (const g of document.querySelectorAll<HTMLElement>('#sheet .seg[data-k]')) {
    const k = g.dataset.k as 'level' | 'lookAheadBars' | 'countInBars';
    for (const b of g.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(String(settings[k]) === b.dataset.v));
  }
  $('snd-sw').setAttribute('aria-checked', String(settings.showSounding));
  $('root-sw').setAttribute('aria-checked', String(settings.allowRootChange));
  $('lyrics-sw').setAttribute('aria-checked', String(settings.fetchLyrics));
  document.documentElement.classList.toggle('show-snd', settings.showSounding);
}

const CAPO_STEPS: ('auto' | number)[] = ['auto', 0, 1, 2, 3, 4, 5, 6, 7];

function bindSheet(): void {
  $('set-btn').onclick = openSheet;
  $('chip').onclick = openSheet;
  $('scrim').onclick = closeSheet;
  $('sheet-done').onclick = closeSheet;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
  for (const g of document.querySelectorAll<HTMLElement>('#sheet .seg[data-k]')) {
    g.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      const k = g.dataset.k;
      if (k === 'level') settings.level = b.dataset.v as Level;
      if (k === 'lookAheadBars') settings.lookAheadBars = Number(b.dataset.v);
      if (k === 'countInBars') settings.countInBars = Number(b.dataset.v) as 0 | 1 | 2;
      syncSheet();
      persist(k === 'level');
    });
  }
  const stepCapo = (d: number) => {
    const i = CAPO_STEPS.indexOf(settings.capo);
    settings.capo = CAPO_STEPS[Math.max(0, Math.min(CAPO_STEPS.length - 1, (i < 0 ? 0 : i) + d))];
    persist(true);
  };
  $('capo-down').onclick = () => stepCapo(-1);
  $('capo-up').onclick = () => stepCapo(1);
  $('snd-sw').onclick = () => {
    settings.showSounding = !settings.showSounding;
    syncSheet();
    persist(false);
  };
  $('root-sw').onclick = () => {
    settings.allowRootChange = !settings.allowRootChange;
    syncSheet();
    persist(true);
  };
  $('lyrics-sw').onclick = async () => {
    settings.fetchLyrics = !settings.fetchLyrics;
    const on = settings.fetchLyrics;
    syncSheet();
    // Ask only after the setting is stored: the service worker re-reads it before every request.
    await persist(false);
    if (settings.fetchLyrics !== on) return; // flipped again meanwhile: that click asks
    // An explicit OFF→ON allows one fresh lookup for this song (an earlier one may have been
    // cancelled by OFF); player updates still never retry on their own.
    if (on) lyricsAsker.fetchTurnedOn(chartKey);
    void requestLyrics();
  };
  $('demo-btn').onclick = () => void startDemo();
  $('badge').onclick = (e) => {
    const open = $('badge-pop').classList.toggle('open');
    (e.currentTarget as HTMLElement).setAttribute('aria-expanded', String(open));
  };
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('#badge,#badge-pop')) {
      $('badge-pop').classList.remove('open');
      $('badge').setAttribute('aria-expanded', 'false');
    }
  });
  syncSheet();
}

function applyTheme(): void {
  const forced = params.get('theme');
  const theme = forced === 'light' || forced === 'dark' ? forced : settings.theme;
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ---------- settings tab ----------
function bindSettings(): void {
  const cc = $<HTMLInputElement>('countin-click');
  cc.checked = settings.countInClick;
  cc.onchange = () => {
    settings.countInClick = cc.checked;
    persist(false);
  };
  const barre = $<HTMLInputElement>('can-barre');
  barre.checked = settings.profile.canBarre;
  barre.onchange = () => {
    settings.profile.canBarre = barre.checked;
    persist(true);
  };
  const stretch = $<HTMLSelectElement>('max-stretch');
  stretch.value = String(settings.profile.maxStretch);
  stretch.onchange = () => {
    settings.profile.maxStretch = Number(stretch.value);
    persist(true);
  };
  const speed = $<HTMLSelectElement>('change-speed');
  speed.value = settings.profile.changeSpeed;
  speed.onchange = () => {
    settings.profile.changeSpeed = speed.value as Settings['profile']['changeSpeed'];
    persist(true);
  };
  const cmin = $<HTMLInputElement>('capo-min');
  const cmax = $<HTMLInputElement>('capo-max');
  cmin.value = String(settings.profile.capoMin);
  cmax.value = String(settings.profile.capoMax);
  const capoRange = (): void => {
    const lo = Math.max(0, Math.min(7, Number(cmin.value) || 0));
    const hi = Math.max(lo, Math.min(9, Number(cmax.value) || 0));
    settings.profile.capoMin = lo;
    settings.profile.capoMax = hi;
    persist(true);
  };
  cmin.onchange = capoRange;
  cmax.onchange = capoRange;
  const off = $<HTMLInputElement>('sync-offset');
  off.value = String(settings.syncOffsetMs);
  setText('sync-offset-val', String(settings.syncOffsetMs));
  off.oninput = () => {
    settings.syncOffsetMs = Number(off.value);
    setText('sync-offset-val', off.value);
    persist(false);
  };
  $('known-reset').onclick = () => {
    settings.profile.knownShapes = [];
    renderKnownCount();
    persist(true);
  };
  $('theme-btn').onclick = () => {
    const dark = getComputedStyle(document.documentElement).colorScheme === 'dark';
    settings.theme = dark ? 'light' : 'dark';
    applyTheme();
    persist(false);
  };
  renderKnownCount();
}

function renderKnownCount(): void {
  setText('known-count', `잡을 수 있다고 표시한 모양: ${settings.profile.knownShapes.length}개`);
}

// ---------- wiring ----------
function showTab(name: string): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav.tabs button')) {
    b.classList.toggle('active', b.dataset.tab === name);
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const s of document.querySelectorAll<HTMLElement>('.tab')) s.hidden = s.id !== `tab-${name}`;
}

function bindTabs(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('nav.tabs button')) b.onclick = () => showTab(b.dataset.tab!);
  for (const b of document.querySelectorAll<HTMLElement>('[data-goto]')) b.addEventListener('click', () => showTab(b.dataset.goto!));
  $('empty-edit').onclick = () => showTab('edit');
  $('empty-demo').onclick = () => void startDemo();
  $('demo-exit').onclick = () => void exitDemo();
  $<HTMLSelectElement>('demo-select').onchange = (e) => void startDemo((e.target as HTMLSelectElement).value);
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ($('tab-play').hidden || $('sheet').classList.contains('open')) return;
    if (t && t.closest('input,textarea,select,button,[contenteditable]')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      void togglePlay();
    } else if (e.key === 'ArrowRight') void seekTo(positionNow(false) + 5);
    else if (e.key === 'ArrowLeft') void seekTo(positionNow(false) - 5);
  });
}

function bindEditor(): void {
  $('seq-parse').onclick = parseSequenceFromTextarea;
  $('stamp').onclick = doStamp;
  $('stamp-undo').onclick = () => {
    editor = undoStamp(editor);
    renderStamps();
  };
  $('stamp-reset').onclick = () => {
    editor = { ...editor, stamps: [] };
    renderStamps();
  };
  $('tap').onclick = doTap;
  $('downbeat-now').onclick = () => demo ? setStatus('save-status', DEMO_BLOCK, true) : writeEditorTiming({ ...readEditorTiming(), firstDownbeatSec: Math.round(positionNow(false) * 1000) / 1000 });
  $('save-chart').onclick = () => void doSave();
  $('edit-load-existing').onclick = loadExistingIntoEditor;
  $('draft-reattach').onclick = doReattach;
  $('export-json').onclick = exportJson;
  $<HTMLInputElement>('import-json').onchange = (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void importJson(f);
    (e.target as HTMLInputElement).value = '';
  };
  const sel = $<HTMLSelectElement>('example-select');
  sel.innerHTML = EXAMPLE_CHARTS.map((c, i) => `<option value="${i}">${escapeHtml(c.recording.title)}</option>`).join('');
  $('example-attach').onclick = () => void attachExample();
  $('listen-analyze').onclick = () => {
    if (demo) return setText('listen-status', DEMO_BLOCK);
    chrome.runtime.sendMessage({ type: 'listen-analyze', target: 'offscreen' } satisfies ExtensionMessage).catch(() => setText('listen-status', '캡처 중이 아닙니다'));
  };
  $('listen-adopt').onclick = () => void doAdoptAuto();
  $('cap-stop').onclick = () => {
    chrome.runtime.sendMessage({ type: 'capture-stop', target: 'offscreen' } satisfies ExtensionMessage).catch(() => setText('cap-state', '캡처 중이 아닙니다'));
  };
  $('song-chords').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const id = input.dataset.known;
    if (!id) return;
    const set = new Set(settings.profile.knownShapes);
    if (input.checked) set.add(id);
    else set.delete(id);
    settings.profile.knownShapes = [...set];
    renderKnownCount();
    persist(true);
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if ($('tab-edit').hidden) return;
    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      doStamp();
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      doTap();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      editor = undoStamp(editor);
      renderStamps();
    }
  });
  writeEditorTiming(editorTiming);
  renderStamps();
}

function onMessage(msg: ExtensionMessage, sender: chrome.runtime.MessageSender): void {
  switch (msg.type) {
    case 'player-state':
      void onPlayerState(msg, sender);
      break;
    case 'capture-status':
      renderCaptureStatus(msg);
      break;
    case 'capture-stats':
      renderCaptureStats(msg);
      break;
    case 'listen-state':
      onListenState(msg);
      if (!model) renderEmpty();
      break;
    case 'auto-chart-saved':
      onAutoChartSaved(msg);
      break;
    case 'command':
      if (msg.command === 'stamp-chord') doStamp();
      if (msg.command === 'tap-tempo') doTap();
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  settings = hasChrome ? await loadSettings() : normalizeSettings(undefined);
  const lv = params.get('level');
  if (lv && lv in LEVEL_LABEL) settings.level = lv as Level;
  if (params.has('snd')) settings.showSounding = true;
  if (params.has('root')) settings.allowRootChange = true;
  applyTheme();
  screen = new PlayScreen({
    seek: (sec) => void seekTo(sec),
    togglePlay: () => void togglePlay(),
    setRate: (r) => {
      if (demo) demo.clock.rate = r;
    },
  });
  if (hasChrome) {
    try {
      myWindowId = (await chrome.windows.getCurrent()).id ?? null;
    } catch {
      myWindowId = null;
    }
  }
  bindTabs();
  bindSheet();
  bindSettings();
  bindEditor();
  if (hasChrome) {
    chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender) => {
      onMessage(msg, sender);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || demo) return;
      if (chartKey && Object.keys(changes).some((k) => k.startsWith('chart:') && k.endsWith(`:${player?.recording?.id ?? ''}`))) void reloadChart();
    });
    // Switching tabs: forget the old player until the new active tab reports.
    // The active tab is followed during demo too, so leaving the demo knows where the user is.
    chrome.tabs.onActivated.addListener((info) => {
      if (myWindowId === null || info.windowId === myWindowId) activeTabId = info.tabId;
      if (demo) return;
      forgetPlayer();
    });
    await refreshActiveTab();
  }
  recompute();
  renderHeader();
  if (params.get('demo') === '1') await startDemo(params.get('rec') ?? undefined);
  if (params.get('sheet') === '1') openSheet();
  requestAnimationFrame(loop);
}

void main();

// Exported for debugging from the DevTools console of the panel.
(globalThis as unknown as { vibeGuitar: unknown }).vibeGuitar = {
  get chart() {
    return demo ? demo.chart : chart;
  },
  get model() {
    return model;
  },
  isNoChord,
};
