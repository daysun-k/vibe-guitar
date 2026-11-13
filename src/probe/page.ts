/**
 * Probe page script (served by scripts/latency-probe.mjs on http://127.0.0.1). Plays the
 * click track in a real <audio> element and runs each measurement session: play from 0,
 * pause and resume, seek back, a 1.5x stretch, play to the end, then ask the probe build
 * for the clicks it found in the placed audio. Everything is reachable from page
 * JavaScript as window.vgProbe, so automation needs only the one toolbar click.
 */
import { PAGE_CHANNEL, type PageRequest, type PageResponse, type ProbeDumpReply, type ProbeOp, type ProbeReply, type ProbeStatus } from '../extension/probe/messages';
import type { ProbeDump, ProbePlan, ProbeSessionDump } from './latency';

const audio = document.querySelector<HTMLAudioElement>('#vg-probe-audio')!;
const log = document.querySelector<HTMLElement>('#log')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;

let nextId = 1;
const pending = new Map<number, (r: ProbeReply) => void>();
window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as Partial<PageResponse>;
  if (d?.[PAGE_CHANNEL] !== 'response' || typeof d.id !== 'number' || !d.reply) return;
  pending.get(d.id)?.(d.reply);
  pending.delete(d.id);
});

function request<T>(op: ProbeOp, sessionId?: string, timeoutMs = 10000): Promise<T> {
  if (document.documentElement.dataset.vgLatencyProbe !== 'ready') {
    return Promise.reject(new Error('probe build not detected: load dist-probe/ as an unpacked extension and reload this page'));
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${op}: no answer in ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, (r) => {
      clearTimeout(timer);
      if (r.ok) resolve(r.data as T);
      else reject(new Error(`${op}: ${r.error}`));
    });
    window.postMessage({ [PAGE_CHANNEL]: 'request', id, op, sessionId } satisfies PageRequest, location.origin);
  });
}

function say(line: string): void {
  log.textContent += `${new Date().toISOString().slice(11, 23)} ${line}\n`;
  log.scrollTop = log.scrollHeight;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves when the element's currentTime reaches `t` (polled every 10 ms). */
async function until(t: number, limitMs = 120000): Promise<void> {
  const t0 = performance.now();
  while (audio.currentTime < t && !audio.ended) {
    if (performance.now() - t0 > limitMs) throw new Error(`timed out waiting for ${t} s (at ${audio.currentTime.toFixed(2)} s, paused=${audio.paused})`);
    await sleep(10);
  }
}

function seekTo(t: number): Promise<void> {
  return new Promise((resolve) => {
    audio.addEventListener('seeked', () => resolve(), { once: true });
    audio.currentTime = t;
  });
}

async function waitCapturing(limitMs = 15000): Promise<ProbeStatus> {
  const t0 = performance.now();
  for (;;) {
    try {
      const s = await request<ProbeStatus>('status', undefined, 2000);
      if (s.capturing) return s;
    } catch (e) {
      if (performance.now() - t0 > limitMs) throw e;
    }
    if (performance.now() - t0 > limitMs) throw new Error('tab capture is not running: click the Vibe Guitar toolbar button on this tab once');
    await sleep(300);
  }
}

let plan: ProbePlan | null = null;
const results: ProbeSessionDump[] = [];
let running = false;
/** Message of the last failed run (null after a run that finished). */
let lastError: string | null = null;

async function loadPlan(): Promise<ProbePlan> {
  plan ??= (await (await fetch('/plan.json', { cache: 'no-store' })).json()) as ProbePlan;
  return plan;
}

/** One measurement session on the capture that is running now. Returns its dump. */
async function runSession(sessionId = `s${results.length + 1}-${Date.now()}`): Promise<ProbeSessionDump> {
  const p = await loadPlan();
  const plan = p.session;
  const actions: NonNullable<ProbeSessionDump['actions']> = [];
  const act = (action: string) => {
    actions.push({ action, mediaSec: audio.currentTime, atMs: Date.now() });
    say(`${sessionId}: ${action} @ ${audio.currentTime.toFixed(3)} s`);
  };
  await waitCapturing();
  audio.pause();
  audio.playbackRate = 1;
  await seekTo(0);
  audio.dataset.session = sessionId;
  document.dispatchEvent(new Event('vg-probe-session'));
  await sleep(600); // a few player reports with the new session before audio
  await audio.play();
  act('play');
  await until(plan.pauseAtSec);
  audio.pause();
  act('pause');
  await sleep(plan.pauseForSec * 1000);
  await audio.play();
  act('resume');
  await until(plan.seekFromSec);
  await seekTo(plan.seekToSec);
  act(`seek ${plan.seekFromSec} -> ${plan.seekToSec}`);
  await until(plan.rateFromSec);
  audio.playbackRate = plan.rate;
  act(`rate ${plan.rate}`);
  await until(plan.rateToSec);
  audio.playbackRate = 1;
  act('rate 1');
  await until(p.durationSec);
  act('ended');
  await sleep(1500); // AudioPlacer holds blocks up to 0.5 s; the offscreen tick drains every 250 ms
  const dump = await request<ProbeDumpReply>('dump', sessionId);
  const session: ProbeSessionDump = {
    sessionId,
    captureSampleRate: dump.captureSampleRate,
    latencyUsedSec: dump.latencyUsedSec,
    segments: dump.segments,
    clicks: p.clicks,
    actions,
  };
  results.push(session);
  say(`${sessionId}: ${dump.segments.length} segments, ${dump.segments.reduce((n, s) => n + s.onsetsSec.length, 0)} clicks found`);
  return session;
}

/**
 * Every measurement entry point (buttons and vgProbe) goes through this guard: two runs at
 * once would share the audio element and replace each other's offscreen recording.
 */
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (running) throw new Error('already running');
  running = true;
  lastError = null;
  try {
    return await fn();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    running = false;
  }
}

/** `n` sessions, each on a fresh tab capture (the first uses the toolbar click's capture). */
function runAll(n = 3): Promise<ProbeDump> {
  return exclusive(async () => {
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        say('recapture: restarting tab capture for a fresh session');
        await request('recapture', undefined, 15000);
      }
      await runSession();
    }
    return dump();
  });
}

const runOne = () => exclusive(() => runSession());
const recapture = () => exclusive(() => request('recapture', undefined, 15000));

function dump(): ProbeDump {
  return { tool: 'vibe-guitar latency probe', version: 1, createdAt: new Date().toISOString(), sessions: [...results] };
}

function download(): void {
  const blob = new Blob([JSON.stringify(dump(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `latency-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function wrap(fn: () => Promise<unknown>) {
  return () =>
    void fn().catch((e: unknown) => {
      say(`error: ${e instanceof Error ? e.message : String(e)}`);
    });
}

document.querySelector('#run1')!.addEventListener('click', wrap(runOne));
document.querySelector('#run3')!.addEventListener('click', wrap(() => runAll(3)));
document.querySelector('#download')!.addEventListener('click', download);
document.querySelector('#recapture')!.addEventListener('click', wrap(() => recapture().then(() => say('recapture ok'))));

setInterval(() => {
  const ext = document.documentElement.dataset.vgLatencyProbe === 'ready' ? 'probe build: detected' : 'probe build: NOT detected';
  statusEl.textContent = `${ext} | t=${audio.currentTime.toFixed(2)} s, paused=${audio.paused}, rate=${audio.playbackRate}, sessions=${results.length}`;
}, 250);

declare global {
  interface Window {
    vgProbe: unknown;
  }
}
window.vgProbe = {
  runSession: runOne,
  runAll,
  status: () => request<ProbeStatus>('status'),
  recapture,
  dump,
  download,
  get results() {
    return [...results];
  },
  get running() {
    return running;
  },
  get lastError() {
    return lastError;
  },
  audio,
};
void loadPlan().then(() => say('ready: click the Vibe Guitar toolbar button on this tab once, then press "3회 측정" or call vgProbe.runAll(3)'));
