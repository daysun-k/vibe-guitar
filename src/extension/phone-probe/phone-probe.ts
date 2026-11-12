/**
 * VGT-13 probe publisher (extension page, spike). Plays a synthetic chord chart on a local clock and
 * publishes anchors to the relay on ws://127.0.0.1. Flashes at every chord change so a slow-motion
 * video can compare the Mac and the phone. No audio, no lyrics, no real song data.
 */
import { HEARTBEAT_MS, positionAt, upcoming, type Anchor, type Loop, type StateMessage } from '../../phone/protocol';
import { syntheticSong } from '../../phone/synthetic';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const song = syntheticSong();
const WHOLE: Loop = { a: 0, b: song.duration };
// Section loop: bars 5–8 (beats 16–32) of the synthetic chart.
const SECTION: Loop = { a: (16 * 60) / song.bpm, b: (32 * 60) / song.bpm };
const epoch = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('');

let seq = 0;
let anchor: Anchor = { id: 1, at: Date.now(), position: 0, rate: 1, paused: true };
let loop: Loop = WHOLE;
let ws: WebSocket | null = null;
let open = false;
let viewers = 0;
let sentMarks = 0;

const pos = (t = Date.now()) => positionAt(anchor, loop, song.duration, t);

function stateMessage(): StateMessage {
  return { t: 'state', epoch, seq: ++seq, song, anchor, loop };
}

function send(obj: unknown) {
  if (open) ws!.send(JSON.stringify(obj));
}

function setAnchor(changes: Partial<Omit<Anchor, 'id' | 'at'>>) {
  const t = Date.now();
  anchor = { id: anchor.id + 1, at: t, position: pos(t), rate: anchor.rate, paused: anchor.paused, ...changes };
  anchor.position = Math.max(0, Math.min(song.duration, anchor.position));
  send(stateMessage());
}

function connect() {
  const port = Number(($('port') as HTMLInputElement).value) || 47821;
  ws = new WebSocket(`ws://127.0.0.1:${port}/publish`);
  ws.onopen = () => {
    open = true;
    send(stateMessage());
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as { t?: string; n?: number };
      if (m.t === 'viewers' && typeof m.n === 'number') viewers = m.n;
    } catch {
      /* ignore */
    }
  };
  ws.onclose = () => {
    open = false;
    viewers = 0;
    setTimeout(connect, 1000);
  };
}

$('play').addEventListener('click', () => setAnchor({ paused: !anchor.paused }));
$('back').addEventListener('click', () => setAnchor({ position: pos() - 5 }));
$('fwd').addEventListener('click', () => setAnchor({ position: pos() + 5 }));
$('start').addEventListener('click', () => setAnchor({ position: 0 }));
for (const r of [0.5, 0.75, 1]) $(`rate-${String(r).replace('.', '')}`).addEventListener('click', () => setAnchor({ rate: r }));
$('loop').addEventListener('click', () => {
  loop = loop === WHOLE ? SECTION : WHOLE;
  const p = pos();
  setAnchor(p < loop.a || p >= loop.b ? { position: loop.a } : {});
});
$('jump').addEventListener('click', () => setAnchor({ position: loop.a }));
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setAnchor({ paused: !anchor.paused });
  } else if (e.code === 'ArrowLeft') setAnchor({ position: pos() - 5 });
  else if (e.code === 'ArrowRight') setAnchor({ position: pos() + 5 });
});

setInterval(() => send(stateMessage()), HEARTBEAT_MS);

let prev: { anchorId: number; index: number } | null = null;
function frame() {
  const t = Date.now();
  const p = pos(t);
  const up = upcoming(song, anchor, loop, p);
  $('cur').textContent = song.chords[up.index]!.name;
  $('next').textContent = song.chords[up.nextIndex]!.name;
  $('when').textContent = Number.isFinite(up.wallSeconds) ? `${up.wallSeconds.toFixed(1)}초 · ${Math.ceil(up.beats - 1e-6)}박` : '멈춤';
  if (prev && prev.anchorId === anchor.id && prev.index !== up.index) {
    send({ t: 'mark', epoch, index: up.index, at: t });
    sentMarks++;
    const el = $('flash');
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }
  prev = { anchorId: anchor.id, index: up.index };
  $('play').textContent = anchor.paused ? '재생' : '일시정지';
  $('loop').textContent = loop === WHOLE ? '구간 반복 켜기 (5–8마디)' : '구간 반복 끄기';
  $('status').textContent = `${open ? '중계 연결됨' : '중계 연결 안 됨 (npm run phone 실행 확인)'} · 휴대폰 ${viewers}대 · ${p.toFixed(2)}초 / ${song.duration.toFixed(1)}초 · ${anchor.rate}배 · seq ${seq} · 표시 ${sentMarks}회`;
  requestAnimationFrame(frame);
}

connect();
requestAnimationFrame(frame);
