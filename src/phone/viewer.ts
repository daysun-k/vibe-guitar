/**
 * VGT-13 phone page (read-only viewer). Served by the relay on the home LAN; plain http, so no
 * Screen Wake Lock: the page asks the user to turn off auto-lock instead.
 */
import {
  ANCHOR_TTL_MS,
  clockSample,
  estimateOffset,
  isNewer,
  matchChange,
  positionAt,
  summarizeErrors,
  upcoming,
  type Change,
  type ClockEstimate,
  type ClockSample,
  type MarkMessage,
  type RelayToViewer,
  type StateMessage,
} from './protocol';

const $ = (id: string) => document.getElementById(id)!;
const now = () => performance.timeOrigin + performance.now();
const token = new URLSearchParams(location.search).get('t') ?? '';

let ws: WebSocket | null = null;
let open = false;
let publisherConnected = false;
let state: StateMessage | null = null;
let lastRx = 0;
let samples: ClockSample[] = [];
let clock: ClockEstimate | null = null;
let pingId = 0;
let backoff = 500;
let reconnects = 0;
let lostAt = 0;
let lastOutageMs = 0;
let hiddenCount = 0;
let lastAnyRx = 0;
/** The relay sends a pong every 2 s and states every 1 s; silence this long means a dead link. */
const SILENCE_MS = 6000;
const changes: Change[] = [];
let pendingMarks: MarkMessage[] = [];
const errors: number[] = [];
let prev: { epoch: string; anchorId: number; index: number } | null = null;

function ping() {
  if (open) ws!.send(JSON.stringify({ t: 'ping', id: ++pingId, c: now() }));
}

function lost() {
  if (open) {
    reconnects++;
    lostAt = now();
  }
  open = false;
  setTimeout(connect, backoff);
  backoff = Math.min(5000, backoff * 2);
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/viewer?t=${encodeURIComponent(token)}`);
  ws.onopen = () => {
    open = true;
    lastAnyRx = now();
    backoff = 500;
    if (lostAt) lastOutageMs = now() - lostAt;
    lostAt = 0;
    samples = [];
    for (let i = 0; i < 8; i++) setTimeout(ping, i * 120);
  };
  ws.onmessage = (ev) => {
    lastAnyRx = now();
    let m: RelayToViewer;
    try {
      m = JSON.parse(String(ev.data)) as RelayToViewer;
    } catch {
      return;
    }
    if (m.t === 'pong') {
      samples.push(clockSample(m.c, m.s, now()));
      if (samples.length > 15) samples.shift(); // about 30 s: keeps clock drift well under 1 ms
      clock = estimateOffset(samples);
    } else if (m.t === 'publisher') {
      publisherConnected = m.connected;
      if (!m.connected) state = null;
    } else if (m.t === 'state') {
      publisherConnected = true;
      if (isNewer(state, m)) {
        if (state?.epoch !== m.epoch) changes.length = 0;
        state = m;
        lastRx = now();
      }
    } else if (m.t === 'mark') {
      pendingMarks.push(m);
      matchMarks();
    }
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

function matchMarks() {
  if (!state || !clock) return;
  const macNow = now() + clock.offset;
  pendingMarks = pendingMarks.filter((mk) => {
    if (mk.epoch !== state!.epoch) return false;
    const err = matchChange(changes, mk);
    if (err !== null) {
      errors.push(err);
      if (errors.length > 200) errors.shift();
      return false;
    }
    return macNow - mk.at < 3000; // drop marks the phone never matched (e.g. it was stale)
  });
}

function flash() {
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

let shown = '';
function setText(id: string, text: string) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function frame() {
  const t = now();
  const offset = clock?.offset ?? 0;
  const macNow = t + offset;
  const fresh = !!state && t - lastRx <= ANCHOR_TTL_MS;
  const live = open && publisherConnected && fresh && !!clock;
  let status: string;
  if (!open) status = '다시 연결 중 (Mac의 npm run phone 확인)';
  else if (!publisherConnected) status = 'Mac 확장 페이지가 꺼져 있어요';
  else if (!fresh) status = '다시 연결 중';
  else if (!clock) status = '시계 맞추는 중';
  else status = state!.anchor.paused ? '일시정지' : '연결됨';
  setText('status', status);
  document.body.classList.toggle('stale', !live);

  if (state && clock) {
    const pos = positionAt(state.anchor, state.loop, state.song.duration, macNow);
    const up = upcoming(state.song, state.anchor, state.loop, pos);
    const cur = state.song.chords[up.index]!.name;
    const next = state.song.chords[up.nextIndex]!.name;
    setText('cur', cur);
    setText('next', next);
    setText('when', Number.isFinite(up.wallSeconds) ? `${up.wallSeconds.toFixed(1)}초 · ${Math.ceil(up.beats - 1e-6)}박` : '멈춤');
    const bar = Math.floor((pos * state.song.bpm) / 60 / state.song.beatsPerBar) + 1;
    setText('bar', `${bar}마디 · ${state.anchor.rate === 1 ? '보통 속도' : `${state.anchor.rate}배 속도`}`);
    if (live && prev && prev.epoch === state.epoch && prev.anchorId === state.anchor.id && prev.index !== up.index) {
      changes.push({ index: up.index, at: macNow });
      if (changes.length > 40) changes.shift();
      flash();
      matchMarks();
    }
    prev = live ? { epoch: state.epoch, anchorId: state.anchor.id, index: up.index } : null;
  } else {
    prev = null;
    if (shown !== 'empty') {
      setText('cur', '–');
      setText('next', '–');
      setText('when', '');
      setText('bar', '');
    }
  }
  shown = state ? 'state' : 'empty';

  const e = summarizeErrors(errors);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–');
  setText(
    'debug',
    [
      `offset ${clock ? clock.offset.toFixed(1) : '–'} ±${clock ? clock.bound.toFixed(1) : '–'} ms${clock && !clock.consistent ? ' (불일치)' : ''} · RTT min ${clock ? clock.rtt.toFixed(1) : '–'} ms · samples ${clock?.samples ?? 0}`,
      `change error n=${e.n} median|e| ${f(e.medianAbs)} ms · worst ${f(e.worstAbs)} ms · mean ${f(e.mean)} ms`,
      `reconnects ${reconnects}${lastOutageMs ? ` (last outage ${(lastOutageMs / 1000).toFixed(1)} s)` : ''} · hidden ${hiddenCount} · seq ${state?.seq ?? '–'}`,
    ].join('\n'),
  );
  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenCount++;
});

async function tryWakeLock() {
  const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }).wakeLock;
  if (!wl || !window.isSecureContext) return;
  try {
    await wl.request('screen');
    setText('lock', '화면 켜짐 유지가 켜졌어요.');
  } catch {
    /* keep the auto-lock notice */
  }
}

setInterval(() => {
  watchdog();
  ping();
}, 2000);
connect();
void tryWakeLock();
requestAnimationFrame(frame);
