/**
 * VGT-13 phone music stand page (design B "악보대형"). Served by the relay on the home LAN over plain
 * http, so there is no Screen Wake Lock (the README says to turn off auto-lock; the page does not).
 * It shows only the chords, their diagrams, the current bar's progress and icon buttons; the status
 * line appears only when something needs attention (stand.ts). It sends clock pings and, VGT-16, only while the panel approved this connection, the commands
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
  type CommandOutcome,
  type PairMessage,
  type PhoneCommand,
} from './protocol';
import { phoneFrame, readSongView, shapeVoicing, type PhoneSong } from './song-view';
import { beatSegments, outcomeText, statusLine, toggleLook } from './stand';

const $ = (id: string) => document.getElementById(id)!;
const now = () => performance.timeOrigin + performance.now();
const token = new URLSearchParams(location.search).get('t') ?? '';
/** The relay pongs every 2 s and the panel sends an anchor every 1 s; silence this long means a dead link. */
const SILENCE_MS = 6000;

let ws: WebSocket | null = null;
let open = false;
/** The socket was open at least once: a later close is a lost link, not the first connect. */
let everOpen = false;
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
let pending: { id: number; at: number } | null = null;
/** Request whose count-in runs: its final result (playing or a failure) still comes. */
let countinId = 0;
let message = { text: '', alert: false, until: 0 };

/** Shows `text` on the status line for a few seconds; '' clears an earlier message at once. */
function say(text: string, alert: boolean) {
  message = text ? { text, alert, until: now() + MESSAGE_MS } : { text: '', alert: false, until: 0 };
}

function sendCommand(cmd: PhoneCommand) {
  const cur = assembler.current;
  if (!open || pair.state !== 'approved' || pending || !cur) return;
  const id = ++cmdId;
  pending = { id, at: now() };
  ws!.send(JSON.stringify({ t: 'cmd', id, epoch: cur.epoch, rev: cur.rev, cmd }));
}

function onResult(id: number, o: CommandOutcome) {
  if (pending && id === pending.id) {
    pending = null;
    if (o.ok && o.state === 'countin') countinId = id;
    say(outcomeText(o, !!anchor?.loop), !o.ok);
  } else if (countinId && id === countinId) {
    countinId = 0;
    // The count-in ended: playback started, it was cancelled (paused) or play failed.
    say(outcomeText(o, !!anchor?.loop), !o.ok);
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
      // Approval shows as the buttons appearing; losing it is said, since the buttons just vanish.
      if (was === 'approved' && v.state !== 'approved') say('조작 승인이 해제됐어요', true);
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
    everOpen = true;
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

let meterKey = '';
/** The current bar's card: the playhead at `fraction` of the bar and one segment per big beat. */
function drawMeter(total: number, filled: number, bar: number, fraction: number) {
  const key = `${total}`;
  if (key !== meterKey) {
    meterKey = key;
    $('ticks').innerHTML = '<i></i>'.repeat(total);
  }
  $('ticks').querySelectorAll('i').forEach((x, i) => x.classList.toggle('on', i < filled));
  const ph = $('ph');
  if (ph.hidden !== bar < 0) ph.hidden = bar < 0;
  if (bar >= 0) ph.style.left = `${(fraction * 100).toFixed(2)}%`;
}

const REJECTED_TEXT = 'Mac 패널에서 이 휴대폰의 조작을 거절했어요 · 다시 요청하려면 페이지를 새로 고쳐 주세요';

const CONTROL_BUTTONS = ['ctl-prev', 'ctl-toggle', 'ctl-next', 'ctl-restart'];

/** Pairing code and the control buttons (their outcome goes to the status line). */
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
    const look = toggleLook(!!anchor && !anchor.paused && !anchor.ad, !!countinId);
    const toggle = $('ctl-toggle');
    setClass(toggle, 'pause', look.pause);
    if (toggle.getAttribute('aria-label') !== look.label) {
      toggle.setAttribute('aria-label', look.label);
      toggle.title = look.label;
    }
  }
  if (message.text && t > message.until) message = { text: '', alert: false, until: 0 };
}

function frame() {
  const t = now();
  const app = $('app');
  const fresh = !!anchor && t - anchorRx <= ANCHOR_TTL_MS;
  const ready = open && publisherConnected && !!song && song.events.length > 0;
  setClass(app, 'waiting', !ready);
  drawControl(t, ready);
  const live = fresh && !!clock;
  const status = statusLine({ ready, live, ad: !!anchor?.ad, message });
  setText('status', status?.text ?? '');
  setClass($('status'), 'alert', !!status?.alert);
  if (!ready) {
    const [head, sub] = !open
      ? everOpen
        ? ['Mac과 연결이 끊겼어요 · 다시 연결하는 중', 'Mac 터미널에서 npm run phone이 켜져 있는지 확인해 주세요']
        : ['Mac에 연결하는 중', 'Mac 터미널에서 npm run phone이 켜져 있는지 확인해 주세요']
      : !publisherConnected
        ? ['패널의 휴대폰 악보대가 꺼져 있어요', 'Mac의 Vibe Guitar 패널 › 연주 설정에서 켜 주세요']
        : ['곡을 기다리는 중', 'Mac에서 코드표가 있는 곡을 재생해 주세요'];
    const w = $('wait');
    if (w.firstChild?.textContent !== head) {
      const small = document.createElement('small');
      small.textContent = sub;
      w.replaceChildren(head, small);
    }
    requestAnimationFrame(frame);
    return;
  }
  const s = song!;
  setClass(app, 'stale', !live || !!anchor?.ad);
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
  const seg = beatSegments(s.big.bigPerBar, f.bar, f.bigInBar);
  drawMeter(seg.total, seg.filled, f.bar, f.barFraction);
  if (fitDirty) {
    // The next chord never looks bigger than the current one, also when a long current name shrank.
    const nowPx = fitText($('now-name'));
    fitDirty = nowPx === null || fitText($('next-name'), Math.round(nowPx * NEXT_SCALE)) === null;
  }
  requestAnimationFrame(frame);
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
// changed (a status line or pairing code shown or gone resizes the diagrams, which are sized by their row).
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
connect();
requestAnimationFrame(frame);
