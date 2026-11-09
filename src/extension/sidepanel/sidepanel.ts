/** Side panel: play-along view, chart editor, capture spike readout, settings. */
import { arrangeChart, suggestCapo, uniqueVoicings, type ArrangedEvent, type Arrangement, type CapoSuggestion } from '../../arrange/arrange';
import { chordToneNames, isNoChord, parseChord } from '../../arrange/chord';
import { fretString } from '../../arrange/guitar';
import type { Level } from '../../arrange/levels';
import { suggestStrumming } from '../../arrange/strum';
import { PITCH_CLASS_LABELS } from '../../audio/chroma';
import { EXAMPLE_CHARTS } from '../../chart/examples';
import { previousDownbeat } from '../../chart/timing';
import type { Chart, Recording, Timing } from '../../chart/types';
import { validateChart } from '../../chart/validate';
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
import { DraftBook, checkSaveTarget, isDraftEmpty, reattachDraft, recordingKeyOf, type EditorDraft } from '../../editor/drafts';
import type {
  CaptureStatsMessage,
  CaptureStatusMessage,
  ExtensionMessage,
  PlayerControlMessage,
  PlayerControlResult,
  PlayerStateMessage,
} from '../messages';
import { computePlayView, estimatePosition, type PlayerSnapshot } from '../playview';
import { loadChart, loadSettings, saveChart, saveSettings, type Settings } from '../storage';
import { escapeHtml, renderChordDiagram } from './diagram';

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

const LEVEL_LABEL: Record<Level, string> = { beginner: '입문', novice: '초급', intermediate: '중급', advanced: '상급' };

// ---------- state ----------
let settings: Settings;
let player: PlayerStateMessage | null = null;
let playerTabId: number | null = null;
let myWindowId: number | null = null;
let chart: Chart | null = null;
let chartKey = '';
let arrangement: Arrangement | null = null;
let capoSuggestions: CapoSuggestion[] = [];
let lastRenderedIndex = -2;
let lastRenderedArrangement: Arrangement | null = null;
let countInOverride: number | null = null;
let editor: StampState = { chords: [], stamps: [] };
let taps: number[] = [];
let editorTiming: Timing = { bpm: 100, beatsPerBar: 4, beatUnit: 4, firstDownbeatSec: 0 };
/** Recording the editor draft belongs to (drafts never follow navigation to another song). */
let draftRecording: Recording | null = null;
const draftBook = new DraftBook();
/** Most recent non-empty draft left behind by navigation; can be reattached explicitly. */
let leftDraft: EditorDraft | null = null;

// ---------- player sync ----------
function snapshot(): PlayerSnapshot | null {
  return player ? { currentTime: player.currentTime, paused: player.paused, playbackRate: player.playbackRate, sampledAt: player.sampledAt } : null;
}

function positionNow(withOffset = true): number {
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
  player = msg;
  playerTabId = tab.id;
  if (msg.adapter === 'applemusic') renderAppleMusicStatus(msg);
  const key = recordingKey(msg.recording);
  if (key !== chartKey) {
    chartKey = key;
    switchDraft(msg.recording);
    await reloadChart();
    renderEditorTarget();
  }
  renderHeader();
}

async function reloadChart(): Promise<void> {
  const r = player?.recording;
  chart = r ? await loadChart(r.source, r.id) : null;
  recompute();
}

function recompute(): void {
  if (!chart) {
    arrangement = null;
    capoSuggestions = [];
  } else {
    capoSuggestions = suggestCapo(chart, settings.level, settings.profile);
    const capo = settings.capo === 'auto' ? (capoSuggestions[0]?.capo ?? 0) : settings.capo;
    arrangement = arrangeChart(chart, { level: settings.level, capo, profile: settings.profile });
  }
  lastRenderedIndex = -2;
  renderStatic();
}

// ---------- rendering: header / static parts ----------
function renderHeader(): void {
  if (!player) {
    setText('rec-title', '재생 중인 곡이 없습니다 (YouTube · YouTube Music · Apple Music 탭을 여세요)');
    setText('rec-meta', '');
    return;
  }
  const r = player.recording;
  setText('rec-title', r ? `${r.title || '(제목 없음)'}${r.artist ? ` — ${r.artist}` : ''}` : '곡 ID를 찾지 못했습니다');
  const state = player.isAd ? '광고' : player.paused ? '정지' : '재생';
  const rate = player.playbackRate !== 1 ? ` · ${player.playbackRate}x` : '';
  const via = player.via !== 'video-element' ? ` · ${player.via}` : '';
  setText('rec-meta', `${player.adapter}${r ? ` · ${r.id}` : ''} · ${state}${rate}${via} · ${formatTime(positionNow(false))}`);
  $('ad-banner').hidden = !player.isAd;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function shapeLine(e: ArrangedEvent | null, capo: number): string {
  if (!e || e.rest || !e.sounding) return '';
  if (capo === 0) return e.voicing ? fretString(e.voicing.frets) : '운지 없음';
  return `소리 ${e.sounding} · 카포 ${capo} · 모양 ${e.shape}`;
}

function badgesHtml(e: ArrangedEvent | null): string {
  if (!e || e.rest) return '';
  const out: string[] = [];
  for (const t of e.transformations) {
    if (t.kind === 'substitution') out.push(`<span class="badge sub" title="${escapeHtml(t.detail ?? t.reason)}">대체 ${escapeHtml(t.from)}→${escapeHtml(t.to)}</span>`);
    if (t.kind === 'voicing') out.push(`<span class="badge voicing" title="${escapeHtml(`${t.from} → ${t.to}`)}">쉬운 운지</span>`);
    if (t.kind === 'merge') out.push(`<span class="badge merge">짧은 ${escapeHtml(t.from)} 생략</span>`);
  }
  if (e.uncertain) out.push('<span class="badge uncertain">불확실</span>');
  if (!e.voicing) out.push('<span class="badge sub">운지 없음</span>');
  return out.join('');
}

function renderStatic(): void {
  $('no-chart').hidden = !!chart || !player?.recording;
  // capo suggestion text
  if (capoSuggestions.length) {
    const top = capoSuggestions.slice(0, 3).map((s) => `${s.capo === 0 ? '카포 없음' : `카포 ${s.capo}`}(${s.shapes.slice(0, 4).join(' ')})`);
    setText('capo-suggest', `추천: ${top.join(' · ')}`);
  } else setText('capo-suggest', '');

  // strumming
  if (chart && arrangement) {
    const s = suggestStrumming(settings.level, chart.timing);
    const label = s.style === 'fingerstyle' ? '핑거스타일' : '스트로크';
    const steps = s.steps.join(' ');
    const feel = s.feel === 'shuffle' && s.stepsPerBeat === 2 ? ' · 셔플(스윙 8분)' : '';
    setHtml(
      $('strum'),
      `<div class="label">추천 반주 (원곡 기타 파트가 아닙니다)</div><div><b>${escapeHtml(s.meter)}</b> ${label}${feel}: <code>${escapeHtml(steps)}</code></div>` +
        (s.style === 'fingerstyle' ? '<div class="muted small">p=엄지(베이스) i=검지 m=중지 a=약지</div>' : '<div class="muted small">D=다운 U=업 -=쉼(손은 계속 움직임)</div>') +
        (s.meterFallback ? '<div class="muted small">박자표가 4/4·3/4·6/8이 아니어서 가까운 패턴을 썼습니다.</div>' : ''),
    );
  } else setHtml($('strum'), '');

  // unique chords preview
  const grid = $('song-chords');
  if (!arrangement) {
    setHtml(grid, '');
  } else {
    const known = new Set(settings.profile.knownShapes);
    const cells = uniqueVoicings(arrangement).map((u) => {
      const name = arrangement!.capo ? `${escapeHtml(u.shape)} <span class="muted small">(${escapeHtml(u.sounding)})</span>` : escapeHtml(u.sounding);
      const dg = u.voicing ? renderChordDiagram(u.voicing, { width: 92 }) : '<div class="muted small">운지 없음</div>';
      const toggle = u.voicing
        ? `<label class="small"><input type="checkbox" data-known="${escapeHtml(u.voicing.id)}" ${known.has(u.voicing.id) ? 'checked' : ''}/> 잡을 수 있음</label>`
        : '';
      return `<div class="cell"><div class="name">${name}${u.substitution ? ' <span class="badge sub">대체</span>' : ''}</div>${dg}${toggle}</div>`;
    });
    if (arrangement.unplayable.length) cells.push(`<div class="cell err small">운지를 찾지 못함: ${escapeHtml(arrangement.unplayable.join(', '))}</div>`);
    setHtml(grid, cells.join(''));
  }
  renderEditorTarget();
}

// ---------- rendering: live play view ----------
function renderLive(): void {
  renderHeader();
  if (!arrangement || !chart || !player || player.isAd) {
    if (!arrangement) {
      setText('cur-chord', '–');
      setText('next-chord', '–');
      setText('cur-shape', '');
      setText('next-shape', '');
      setHtml($('cur-diagram'), '');
      setHtml($('next-diagram'), '');
      setHtml($('beat-dots'), '');
      setText('next-countdown', '');
      setText('bar-pos', '');
    }
    return;
  }
  const pos = positionNow();
  const view = computePlayView(arrangement, chart.timing, pos, settings.lookAheadBars);
  const capo = arrangement.capo;

  if (view.currentIndex !== lastRenderedIndex || lastRenderedArrangement !== arrangement) {
    lastRenderedIndex = view.currentIndex;
    lastRenderedArrangement = arrangement;
    const cur = view.current;
    setText('cur-chord', cur ? (cur.rest ? 'N.C.' : (capo ? cur.shape! : cur.sounding!)) : '–');
    setText('cur-shape', shapeLine(cur, capo));
    setText('cur-notes', cur && !cur.rest && cur.sounding ? safeToneNames(cur.sounding) : '');
    setHtml($('cur-badges'), badgesHtml(cur));
    setHtml($('cur-diagram'), cur?.voicing ? renderChordDiagram(cur.voicing, { width: 140 }) : '');
    const nx = view.next;
    setText('next-chord', nx ? (nx.rest ? 'N.C.' : (capo ? nx.shape! : nx.sounding!)) : view.endOfCoverage !== null ? '코드표 구간 끝' : cur ? '끝' : '–');
    setText('next-shape', shapeLine(nx, capo));
    setHtml($('next-badges'), badgesHtml(nx));
    setHtml($('next-diagram'), nx?.voicing ? renderChordDiagram(nx.voicing, { width: 100 }) : '');
  }
  $('next-card').classList.toggle('dim', !view.inLookAhead);
  setText('next-countdown', view.countdown !== null ? `${view.countdown}박 뒤` : '');
  const bpb = chart.timing.beatsPerBar;
  const dots = Array.from({ length: bpb }, (_, i) => `<span class="${i <= view.beatInBar ? 'on' : ''}"></span>`).join('');
  setHtml($('beat-dots'), view.inLookAhead ? dots : '');
  setText('bar-pos', `${view.bar + 1}마디 ${view.beatInBar + 1}박 · ${formatTime(pos)}${chart.provenance.example ? ' · 예시 코드표(가짜 타이밍)' : ''}`);

  const count = countInOverride ?? (settings.countIn ? view.countIn : null);
  const ci = $('countin');
  ci.hidden = count === null;
  if (count !== null) setText('countin', String(count));
}

function safeToneNames(sym: string): string {
  try {
    return chordToneNames(parseChord(sym)).join(' ');
  } catch {
    return '';
  }
}

function loop(): void {
  try {
    renderLive();
  } catch (e) {
    console.error(e);
  }
  requestAnimationFrame(loop);
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
    .map((v, i) => `<div class="bin"><div class="bar" style="height:${Math.round(v * 100)}%"></div><div class="pc">${PITCH_CLASS_LABELS[i]}</div></div>`)
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

// ---------- player control / count-in ----------
async function sendControl(msg: PlayerControlMessage): Promise<PlayerControlResult> {
  if (playerTabId === null) return { ok: false, reason: 'no player tab' };
  try {
    const r = (await chrome.tabs.sendMessage(playerTabId, msg)) as PlayerControlResult | undefined;
    return r ?? { ok: false, reason: 'the player did not answer' };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

let clickCtx: AudioContext | null = null;
function click(accent: boolean): void {
  if (!settings.countInClick) return;
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
}

async function countInAndPlay(): Promise<void> {
  if (!chart || !player) return;
  const t = chart.timing;
  const target = Math.max(0, previousDownbeat(t, positionNow(false)));
  setText('countin-status', '');
  // Stop before showing the count-in overlay when the player cannot be controlled.
  const paused = await sendControl({ type: 'player-control', action: 'pause' });
  if (!paused.ok) {
    setText('countin-status', `이 플레이어에서는 카운트인 재생을 지원하지 않습니다 (${paused.reason ?? '알 수 없음'}).`);
    return;
  }
  const seek = await sendControl({ type: 'player-control', action: 'seek', time: target });
  if (!seek.ok) {
    setText('countin-status', `마디 처음으로 이동하지 못했습니다 (${seek.reason ?? '알 수 없음'}). 카운트인을 취소했습니다.`);
    return;
  }
  const beatMs = 60000 / t.bpm / (player.playbackRate || 1);
  for (let i = 1; i <= t.beatsPerBar; i++) {
    countInOverride = i;
    click(i === 1);
    await new Promise((r) => setTimeout(r, beatMs));
  }
  countInOverride = null;
  const play = await sendControl({ type: 'player-control', action: 'play' });
  if (!play.ok) setText('countin-status', `재생을 다시 시작하지 못했습니다 (${play.reason ?? '알 수 없음'}).`);
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
  if (!draftMatchesPlayer()) return;
  editor = stamp(editor, positionNow(false));
  renderStamps();
}

function doTap(): void {
  if (!draftMatchesPlayer()) return;
  taps = addTap(taps, positionNow(false));
  const fit = fitTapTempo(taps);
  if (fit) {
    writeEditorTiming({ ...readEditorTiming(), bpm: fit.bpm, firstDownbeatSec: fit.firstDownbeatSec });
    setText('tap-status', `${fit.taps}번 탭: ${fit.bpm} BPM, 첫 다운비트 ${fit.firstDownbeatSec.toFixed(2)}s (흔들림 ${(fit.jitterSec * 1000).toFixed(0)}ms)`);
  } else setText('tap-status', `${taps.length}번 탭 (4번 이상 필요, 2.5초 쉬면 다시 시작)`);
}

async function doSave(): Promise<void> {
  const check = checkSaveTarget(currentDraft(), currentRecording());
  if (!check.ok) {
    return setStatus(
      'save-status',
      check.reason === 'no-recording' ? '재생 중인 곡이 없습니다.' : '이 초안은 다른 곡에서 만들었습니다. 저장하지 않았습니다(옮기려면 "초안을 이 곡으로 옮기기"를 누르세요).',
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
  try {
    const data = JSON.parse(await file.text()) as unknown;
    const v = validateChart(data);
    if (!v.ok) return setStatus('io-status', `형식 오류: ${v.errors.slice(0, 5).join('; ')}`, true);
    let c = v.chart!;
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
  const r = currentRecording();
  if (!r) return setStatus('io-status', '재생 중인 곡이 없습니다.', true);
  const ex = EXAMPLE_CHARTS[Number($<HTMLSelectElement>('example-select').value)];
  const c = attachChartToRecording(ex, r);
  await saveChart(c);
  chart = c;
  recompute();
  setStatus('io-status', '예시 코드표를 현재 곡에 연결했습니다(타이밍은 가짜입니다).', false);
}

// ---------- settings ----------
async function persistSettings(): Promise<void> {
  await saveSettings(settings);
  recompute();
}

function bindSettings(): void {
  const level = $<HTMLSelectElement>('level');
  level.value = settings.level;
  level.onchange = () => {
    settings.level = level.value as Level;
    void persistSettings();
  };
  const capo = $<HTMLSelectElement>('capo');
  capo.value = String(settings.capo);
  capo.onchange = () => {
    settings.capo = capo.value === 'auto' ? 'auto' : Number(capo.value);
    void persistSettings();
  };
  const look = $<HTMLInputElement>('lookahead');
  look.value = String(settings.lookAheadBars);
  setText('lookahead-val', String(settings.lookAheadBars));
  look.oninput = () => {
    settings.lookAheadBars = Number(look.value);
    setText('lookahead-val', look.value);
    void saveSettings(settings);
  };
  const ci = $<HTMLInputElement>('countin-enable');
  ci.checked = settings.countIn;
  ci.onchange = () => {
    settings.countIn = ci.checked;
    void saveSettings(settings);
  };
  const cc = $<HTMLInputElement>('countin-click');
  cc.checked = settings.countInClick;
  cc.onchange = () => {
    settings.countInClick = cc.checked;
    void saveSettings(settings);
  };
  const barre = $<HTMLInputElement>('can-barre');
  barre.checked = settings.profile.canBarre;
  barre.onchange = () => {
    settings.profile.canBarre = barre.checked;
    void persistSettings();
  };
  const stretch = $<HTMLSelectElement>('max-stretch');
  stretch.value = String(settings.profile.maxStretch);
  stretch.onchange = () => {
    settings.profile.maxStretch = Number(stretch.value);
    void persistSettings();
  };
  const speed = $<HTMLSelectElement>('change-speed');
  speed.value = settings.profile.changeSpeed;
  speed.onchange = () => {
    settings.profile.changeSpeed = speed.value as Settings['profile']['changeSpeed'];
    void persistSettings();
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
    void persistSettings();
  };
  cmin.onchange = capoRange;
  cmax.onchange = capoRange;
  const off = $<HTMLInputElement>('sync-offset');
  off.value = String(settings.syncOffsetMs);
  setText('sync-offset-val', String(settings.syncOffsetMs));
  off.oninput = () => {
    settings.syncOffsetMs = Number(off.value);
    setText('sync-offset-val', off.value);
    void saveSettings(settings);
  };
  $('known-reset').onclick = () => {
    settings.profile.knownShapes = [];
    renderKnownCount();
    void persistSettings();
  };
  renderKnownCount();
}

function renderKnownCount(): void {
  setText('known-count', `잡을 수 있다고 표시한 모양: ${settings.profile.knownShapes.length}개`);
}

// ---------- wiring ----------
function bindTabs(): void {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('nav.tabs button')];
  const show = (name: string): void => {
    for (const b of buttons) b.classList.toggle('active', b.dataset.tab === name);
    for (const s of document.querySelectorAll<HTMLElement>('section.tab')) s.hidden = s.id !== `tab-${name}`;
  };
  for (const b of buttons) b.onclick = () => show(b.dataset.tab!);
  $('goto-edit').onclick = () => show('edit');
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
  $('downbeat-now').onclick = () => writeEditorTiming({ ...readEditorTiming(), firstDownbeatSec: Math.round(positionNow(false) * 1000) / 1000 });
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
  $('countin-play').onclick = () => void countInAndPlay();
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
    void persistSettings();
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
    case 'command':
      if (msg.command === 'stamp-chord') doStamp();
      if (msg.command === 'tap-tempo') doTap();
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  settings = await loadSettings();
  try {
    myWindowId = (await chrome.windows.getCurrent()).id ?? null;
  } catch {
    myWindowId = null;
  }
  bindTabs();
  bindSettings();
  bindEditor();
  chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender) => {
    onMessage(msg, sender);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (chartKey && Object.keys(changes).some((k) => k.startsWith('chart:') && k.endsWith(`:${player?.recording?.id ?? ''}`))) void reloadChart();
  });
  // Switching tabs: forget the old player until the new active tab reports.
  chrome.tabs.onActivated.addListener(() => {
    switchDraft(null);
    player = null;
    playerTabId = null;
    chartKey = '';
    chart = null;
    recompute();
  });
  recompute();
  renderHeader();
  requestAnimationFrame(loop);
}

void main();

// Exported for debugging from the DevTools console of the panel.
(globalThis as unknown as { vibeGuitar: unknown }).vibeGuitar = {
  get chart() {
    return chart;
  },
  get arrangement() {
    return arrangement;
  },
  isNoChord,
};
