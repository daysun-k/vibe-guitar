/**
 * Offscreen document for the capture spike: opens the tabCapture stream, routes it
 * back to the speakers (capturing mutes the tab), and reports level, sample rate
 * and a 12-bin chroma to the side panel. Audio never leaves this document.
 */
import { chromaFromDbSpectrum, rms } from '../../audio/chroma';
import type { CaptureStatsMessage, ExtensionMessage } from '../messages';

const SILENCE_RMS = 1e-4;
const REPORT_MS = 100;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let tabId = -1;
let tabUrl: string | undefined;
let startedAt = 0;
let lastAudioAt = 0;
let everReceived = false;

function send(msg: ExtensionMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

async function stop(reason?: string): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser = null;
  if (ctx) await ctx.close().catch(() => undefined);
  ctx = null;
  if (tabId >= 0) send({ type: 'capture-status', state: 'stopped', tabId, url: tabUrl, error: reason });
  tabId = -1;
}

async function start(streamId: string, id: number, url?: string): Promise<void> {
  await stop();
  tabId = id;
  tabUrl = url;
  try {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as unknown as MediaStreamConstraints;
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(ctx.destination); // keep the tab audible
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    startedAt = Date.now();
    lastAudioAt = 0;
    everReceived = false;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => void stop('track ended (tab closed or capture revoked)'));
    send({ type: 'capture-status', state: 'running', tabId, url: tabUrl });
    timer = setInterval(report, REPORT_MS);
  } catch (e) {
    send({ type: 'capture-status', state: 'error', tabId, url: tabUrl, error: e instanceof Error ? e.message : String(e) });
    tabId = -1;
  }
}

const timeBuf = new Float32Array(8192);
const freqBuf = new Float32Array(4096);

function report(): void {
  if (!ctx || !analyser || !stream) return;
  analyser.getFloatTimeDomainData(timeBuf);
  analyser.getFloatFrequencyData(freqBuf);
  const level = rms(timeBuf);
  const now = Date.now();
  if (level > SILENCE_RMS) {
    lastAudioAt = now;
    everReceived = true;
  }
  const track = stream.getAudioTracks()[0];
  const msg: CaptureStatsMessage = {
    type: 'capture-stats',
    tabId,
    url: tabUrl,
    audioReceived: now - lastAudioAt < 2000,
    everReceived,
    rms: level,
    sampleRate: ctx.sampleRate,
    chroma: level > SILENCE_RMS ? chromaFromDbSpectrum(freqBuf, ctx.sampleRate, analyser.fftSize) : new Array(12).fill(0),
    trackState: track?.readyState ?? 'none',
    trackMuted: track?.muted ?? false,
    elapsedSec: (now - startedAt) / 1000,
  };
  send(msg);
}

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg.type === 'capture-start' && msg.target === 'offscreen') {
    void start(msg.streamId, msg.tabId, msg.url);
    sendResponse({ ok: true });
  }
  if (msg.type === 'capture-stop' && msg.target === 'offscreen') {
    void stop('stopped by user');
    sendResponse({ ok: true });
  }
});
