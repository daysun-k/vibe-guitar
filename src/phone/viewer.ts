/**
 * VGT-13 phone music stand page (read-only viewer, design B "악보대형"). Served by the relay on the
 * home LAN over plain http, so there is no Screen Wake Lock: the page asks once to turn off
 * auto-lock instead. It never sends anything but clock pings.
 */
import { renderShapeDiagram } from '../extension/sidepanel/diagram';
import {
  ANCHOR_TTL_MS,
  SongAssembler,
  clockSample,
  estimateOffset,
  finite,
  isNewer,
  positionAt,
  validatePublisherMessage,
  type AnchorMessage,
  type ClockEstimate,
  type ClockSample,
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

function ping() {
  if (open) ws!.send(JSON.stringify({ t: 'ping', id: ++pingId, c: now() }));
}

function lost() {
  open = false;
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
  if (m.t === 'pong') {
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

function frame() {
  const t = now();
  const app = $('app');
  const fresh = !!anchor && t - anchorRx <= ANCHOR_TTL_MS;
  const ready = open && publisherConnected && !!song && song.events.length > 0;
  setClass(app, 'waiting', !ready);
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
  }
  if (nextShape !== shown.nextShape) {
    const n = nameOf(s, nextShape);
    setText('next-name', n.name);
    setText('next-snd', n.snd);
    $('next-dia').innerHTML = diagramHtml(s, nextShape, 130);
    shown.nextShape = nextShape;
  }
  setText('where', where(s, f.section, f.bar));
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
lockNotice();
connect();
requestAnimationFrame(frame);
