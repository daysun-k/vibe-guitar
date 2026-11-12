/**
 * VGT-13 phone music stand page (design B "악보대형"). Served by the relay on the home LAN over plain
 * http, so there is no Screen Wake Lock: the page asks once to turn off auto-lock instead.
 * It sends clock pings and, VGT-16, only while the panel approved this connection, the commands
 * (재생/일시정지, 처음부터, 이전 마디, 다음 마디) for the song it shows. A pending command is never re-sent
 * after a reconnect. Chord names are fitted to the space beside their diagrams (fit.ts) so the page
 * never gets wider than the screen.
 */
import { renderShapeDiagram } from '../extension/sidepanel/diagram';
import { NEXT_SCALE, fitText } from './fit';
import {
  ANCHOR_TTL_MS,
  SongAssembler,
  clockSample,
  estimateOffset,
  finite,
  isNewer,
  positionAt,
  validatePublisherMessage,
  validateRelayToViewer,
  type AnchorMessage,
  type ClockEstimate,
  type ClockSample,
  type CommandFailure,
  type CommandOutcome,
  type PairMessage,
  type PhoneCommand,
} from './protocol';
import { phoneFrame, readSongView, shapeVoicing, type PhoneSong } from './song-view';

const $ = (id: string) => document.getElementById(id)!;
const now = () => performance.timeOrigin + performance.now();
const token = new URLSearchParams(location.search).get('t') ?? '';
/** The relay pongs every 2 s and the panel sends an anchor every 1 s; silence this long means a dead link. */
const SILENCE_MS = 6000;
const LOCK_KEY = 'vg-phone-lock-ok';

let ws: WebSocket | null = null;
let open = false;
let publisherConnected = false;
const assembler = new SongAssembler();
let song: PhoneSong | null = null;
let anchor: AnchorMessage | null = null;
let anchorRx = 0;
let lastAnyRx = 0;
let samples: ClockSample[] = [];
let clock: ClockEstimate | null = null;
let pingId = 0;
let backoff = 500;

// ---------- control (VGT-16) ----------
/** A command's answer may take the panel's 3 s observation plus the trip; past this it is given up. */
const COMMAND_WAIT_MS = 8000;
const MESSAGE_MS = 4000;
let pair: PairMessage = { t: 'pair', state: 'off' };
let cmdId = 0;
let pending: { id: number; cmd: PhoneCommand; at: number } | null = null;
/** Request whose count-in runs: its final result (playing or a failure) still comes. */
let countinId = 0;
let message = { text: '', alert: false, until: 0 };

const FAILURE_TEXT: Record<CommandFailure, string> = {
  off: 'Mac 패널에서 휴대폰 조작이 꺼져 있어요',
  'not-approved': 'Mac 패널에서 이 휴대폰을 먼저 승인해 주세요',
  stale: '곡이 바뀌었어요 · 다시 눌러 주세요',
  duplicate: '이미 보낸 요청이에요',
  rate: '너무 빨리 눌렀어요 · 잠시 뒤에 다시 눌러 주세요',
  ad: '광고 중에는 조작할 수 없어요',
  'no-target': 'Mac에서 조작할 곡이나 플레이어를 찾지 못했어요',
  busy: 'Mac이 앞 요청을 처리하는 중이에요',
  autoplay: 'Mac 브라우저가 재생을 막았어요 · 맥에서 한 번 재생을 눌러 주세요',
  timeout: 'Mac에서 바뀐 것을 확인하지 못했어요 · Mac 화면을 확인해 주세요',
  failed: 'Mac에서 실행하지 못했어요',
  cancelled: '조작 권한이 바뀌어서 취소했어요',
  'last-bar': '마지막 마디예요 · 더 갈 마디가 없어요',
  'no-panel': 'Mac 패널이 연결되어 있지 않아요',
};

/** Korean message for an outcome. */
function outcomeText(cmd: PhoneCommand | null, o: CommandOutcome): string {
  if (!o.ok && o.code === 'last-bar' && anchor?.loop) return '구간 반복의 마지막 마디예요';
  if (!o.ok) return FAILURE_TEXT[o.code];
  if (o.state === 'countin') return '카운트인 뒤에 재생해요 · 한 번 더 누르면 멈춰요';
  if (cmd === 'restart') return o.state === 'playing' ? '처음부터 다시 재생해요' : '처음 위치로 옮겼어요';
  if (cmd === 'prev-bar') return '이전 마디로 옮겼어요';
  if (cmd === 'next-bar') return '다음 마디로 옮겼어요';
  return o.state === 'playing' ? '재생했어요' : '일시정지했어요';
}

function say(text: string, alert: boolean) {
  message = { text, alert, until: now() + MESSAGE_MS };
}

function sendCommand(cmd: PhoneCommand) {
  const cur = assembler.current;
  if (!open || pair.state !== 'approved' || pending || !cur) return;
  const id = ++cmdId;
  pending = { id, cmd, at: now() };
  ws!.send(JSON.stringify({ t: 'cmd', id, epoch: cur.epoch, rev: cur.rev, cmd }));
}

function onResult(id: number, o: CommandOutcome) {
  if (pending && id === pending.id) {
    const cmd = pending.cmd;
    pending = null;
    if (o.ok && o.state === 'countin') countinId = id;
    say(outcomeText(cmd, o), !o.ok);
  } else if (countinId && id === countinId) {
    countinId = 0;
    // The count-in ended: playback started, it was cancelled (paused) or play failed.
    say(outcomeText('toggle', o), !o.ok);
  }
}

/** Forget everything about commands: after a disconnect nothing is retried. */
function resetControl() {
  pair = { t: 'pair', state: 'off' };
  pending = null;
  countinId = 0;
}

function ping() {
  if (open) ws!.send(JSON.stringify({ t: 'ping', id: ++pingId, c: now() }));
}

function lost() {
  open = false;
  resetControl();
  setTimeout(connect, backoff);
  backoff = Math.min(5000, backoff * 2);
}

function onMessage(text: string) {
  let m: { t?: unknown; id?: unknown; c?: unknown; s?: unknown; connected?: unknown };
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (m.t === 'pair' || m.t === 'result') {
    const v = validateRelayToViewer(text);
    if (!v) return;
    if (v.t === 'pair') {
      const was = pair.state;
      pair = v;
      if (v.state !== 'approved') {
        pending = null;
        countinId = 0;
      }
      if (was === 'approved' && v.state !== 'approved') say('조작 승인이 해제됐어요', true);
      else if (was !== 'approved' && v.state === 'approved') say('Mac 패널에서 승인했어요 · 이제 조작할 수 있어요', false);
    } else onResult(v.id, v);
  } else if (m.t === 'pong') {
    if (!finite(m.c, 0, 1e15) || !finite(m.s, 0, 1e15)) return;
    samples.push(clockSample(m.c, m.s, now()));
    if (samples.length > 15) samples.shift(); // about 30 s: keeps clock drift well under 1 ms
    clock = estimateOffset(samples);
  } else if (m.t === 'publisher') {
    publisherConnected = m.connected === true;
    if (!publisherConnected) {
      assembler.clear();
      song = null;
      anchor = null;
    }
  } else if (m.t === 'song' || m.t === 'anchor') {
    const v = validatePublisherMessage(text);
    if (!v) return;
    publisherConnected = true;
    if (v.t === 'anchor') {
      if (anchor && !isNewer({ epoch: anchor.epoch, n: anchor.seq }, { epoch: v.epoch, n: v.seq })) return;
      anchor = v;
      anchorRx = now();
    } else {
      const r = assembler.add(v);
      if (typeof r === 'object') {
        song = readSongView(r);
        shown.nowShape = shown.nextShape = -3; // redraw both diagrams
      }
    }
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/viewer?t=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    open = true;
    lastAnyRx = now();
    backoff = 500;
    samples = [];
    for (let i = 0; i < 8; i++) setTimeout(ping, i * 120);
  };
  ws.onmessage = (ev) => {
    lastAnyRx = now();
    onMessage(String(ev.data));
  };
  ws.onclose = lost;
}

/** A silently dead TCP link (e.g. Wi-Fi dropped) may never fire onclose; drop it ourselves. */
function watchdog() {
  if (!open || now() - lastAnyRx <= SILENCE_MS) return;
  const dead = ws!;
  dead.onclose = dead.onmessage = dead.onopen = null;
  dead.close();
  lost();
}

// ---------- drawing ----------

const shown = { nowShape: -3, nextShape: -3 };
/** The chord names must be fitted again (new name, new screen size, or not measurable yet). */
let fitDirty = true;

function setText(id: string, text: string) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function setClass(el: HTMLElement, name: string, on: boolean) {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

function diagramHtml(s: PhoneSong, shape: number, width: number): string {
  const v = shape >= 0 ? shapeVoicing(s.view.shapes[shape]!) : null;
  if (v) return renderShapeDiagram(v, width);
  return shape >= 0 ? '<div class="nodia">운지 없음</div>' : '';
}

function nameOf(s: PhoneSong, shape: number): { name: string; snd: string } {
  if (shape < 0) return { name: '–', snd: '' };
  const sh = s.view.shapes[shape]!;
  const snd = s.view.showSounding && s.view.capo > 0 && sh.sounding !== sh.name ? `실제 ${sh.sounding}` : '';
  return { name: sh.name, snd };
}

let dotsKey = '';
function setDots(total: number, on: number) {
  const key = `${total}/${on}`;
  if (key === dotsKey) return;
  dotsKey = key;
  $('dots').innerHTML = total > 0 && total <= 6 ? Array.from({ length: total }, (_, i) => `<i${i < on ? ' class="on"' : ''}></i>`).join('') : '';
}

function where(s: PhoneSong, section: number, bar: number): string {
  const name = s.view.sections[section]?.[0] ?? '';
  const barText = bar >= 0 ? `${bar + 1}마디` : '';
  // Sections without lyrics are already named by bars ("1–8마디"): show only the bar then.
  if (!name || /마디$/.test(name)) return barText;
  return barText ? `${name} · ${barText}` : name;
}

const REJECTED_TEXT = 'Mac 패널에서 이 휴대폰의 조작을 거절했어요 · 다시 요청하려면 페이지를 새로 고쳐 주세요';

const CONTROL_BUTTONS = ['ctl-prev', 'ctl-toggle', 'ctl-next', 'ctl-restart'];

/** Pairing code, the control buttons and the last outcome. */
function drawControl(t: number, ready: boolean) {
  if (pending && t - pending.at > COMMAND_WAIT_MS) {
    pending = null;
    say('Mac에서 답이 없어요 · 다시 눌러 주세요', true);
  }
  const p = pair;
  const waitingCode = open && (p.state === 'pending' || p.state === 'rejected');
  $('pair').hidden = !waitingCode;
  if (waitingCode) {
    setText('pair-code', p.state === 'pending' ? p.code : '');
    setText('pair-text', p.state === 'pending' ? 'Mac 패널에서 이 번호를 승인하면 여기서 조작할 수 있어요' : REJECTED_TEXT);
  }
  const controls = open && p.state === 'approved' && ready;
  $('ctl').hidden = !controls;
  if (controls) {
    const busy = !!pending;
    for (const id of CONTROL_BUTTONS) {
      const b = $(id) as HTMLButtonElement;
      if (b.disabled !== busy) b.disabled = busy;
    }
    const playing = !!anchor && !anchor.paused && !anchor.ad;
    setText('ctl-toggle', busy ? '보내는 중…' : countinId ? '멈추기' : playing ? '일시정지' : '재생');
  }
  if (message.text && t > message.until) message = { text: '', alert: false, until: 0 };
  setText('ctl-msg', message.text);
  setClass($('ctl-msg'), 'alert', message.alert);
}

function frame() {
  const t = now();
  const app = $('app');
  const fresh = !!anchor && t - anchorRx <= ANCHOR_TTL_MS;
  const ready = open && publisherConnected && !!song && song.events.length > 0;
  setClass(app, 'waiting', !ready);
  drawControl(t, ready);
  let status: string;
  let alert = false;
  if (!open) status = 'Mac과 연결이 끊겼어요 · 다시 연결하는 중';
  else if (!publisherConnected) status = 'Mac과 연결됨 · 패널의 휴대폰 악보대가 꺼져 있어요';
  else if (!song || !song.events.length) status = 'Mac과 연결됨';
  else if (!fresh || !clock) status = '재생 위치를 받는 중';
  else if (anchor!.ad) {
    status = '광고 중 · 광고가 끝나면 이어서 보여 줘요';
    alert = true;
  } else status = `Mac과 연결됨${anchor!.paused ? ' · 일시정지' : ''}${song.view.title ? ` · ${song.view.title}` : ''}`;
  setText('status', status);
  setClass($('status'), 'alert', alert);
  if (!ready) {
    const [head, sub] = !open
      ? ['Mac에 연결하는 중', 'Mac 터미널에서 npm run phone이 켜져 있는지 확인해 주세요']
      : !publisherConnected
        ? ['패널의 휴대폰 악보대가 꺼져 있어요', 'Mac의 Vibe Guitar 패널 › 연주 설정에서 켜 주세요']
        : ['곡을 기다리는 중', 'Mac에서 코드표가 있는 곡을 재생해 주세요'];
    const w = $('wait');
    if (w.firstChild?.textContent !== head) {
      const small = document.createElement('small');
      small.textContent = sub;
      w.replaceChildren(head, small);
    }
    setText('capo', '');
    setText('where', '');
    requestAnimationFrame(frame);
    return;
  }
  const s = song!;
  setText('capo', s.view.capo > 0 ? `카포 ${s.view.capo} 모양` : '');
  const live = fresh && !!clock;
  setClass(app, 'stale', !live || anchor!.ad);
  const pos = anchor && clock ? positionAt(anchor, s.view.durationSec, t + clock.offset) : 0;
  const f = phoneFrame(s, pos);
  const nowShape = f.nowEvent >= 0 ? s.events[f.nowEvent]!.shape : -1;
  const nextShape = f.nextEvent >= 0 ? s.events[f.nextEvent]!.shape : -1;
  if (nowShape !== shown.nowShape) {
    const n = nameOf(s, nowShape);
    setText('now-name', n.name);
    setText('now-snd', n.snd);
    $('now-dia').innerHTML = diagramHtml(s, nowShape, 170);
    shown.nowShape = nowShape;
    fitDirty = true;
  }
  if (nextShape !== shown.nextShape) {
    const n = nameOf(s, nextShape);
    setText('next-name', n.name);
    setText('next-snd', n.snd);
    $('next-dia').innerHTML = diagramHtml(s, nextShape, 130);
    shown.nextShape = nextShape;
    fitDirty = true;
  }
  setText('where', where(s, f.section, f.bar));
  if (fitDirty) {
    // The next chord never looks bigger than the current one, also when a long current name shrank.
    const nowPx = fitText($('now-name'));
    fitDirty = nowPx === null || fitText($('next-name'), Math.round(nowPx * NEXT_SCALE)) === null;
  }
  if (anchor?.ad) {
    setDots(0, 0);
    setText('count', '광고 중');
  } else if (nextShape < 0) {
    setDots(0, 0);
    setText('count', '마지막 코드예요');
  } else {
    setDots(s.big.bigPerBar, Math.min(f.beatsLeft, s.big.bigPerBar));
    setText('count', `${f.beatsLeft}박 뒤에 바뀜`);
  }
  requestAnimationFrame(frame);
}

function lockNotice() {
  let seen = false;
  try {
    seen = localStorage.getItem(LOCK_KEY) === '1';
  } catch {
    /* storage blocked: show the notice every time */
  }
  $('lock').hidden = seen;
  $('lock-ok').addEventListener('click', () => {
    $('lock').hidden = true;
    try {
      localStorage.setItem(LOCK_KEY, '1');
    } catch {
      /* ignore */
    }
  });
}

setInterval(() => {
  watchdog();
  ping();
}, 2000);
$('ctl-toggle').addEventListener('click', () => sendCommand('toggle'));
$('ctl-restart').addEventListener('click', () => sendCommand('restart'));
$('ctl-prev').addEventListener('click', () => sendCommand('prev-bar'));
$('ctl-next').addEventListener('click', () => sendCommand('next-bar'));
// Rotation or a resized window changes the space beside the diagrams, and so does a row whose height
// changed (a message or notice shown or gone resizes the diagrams, which are sized by their row).
addEventListener('resize', () => (fitDirty = true));
if (typeof ResizeObserver === 'function') {
  const widths = new Map<Element, number>();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = e.contentRect.width;
      if (widths.get(e.target) !== w) fitDirty = true;
      widths.set(e.target, w);
    }
  });
  ro.observe($('now-name'));
  ro.observe($('next-name'));
}
lockNotice();
connect();
requestAnimationFrame(frame);
