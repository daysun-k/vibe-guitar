/**
 * Input features for the two recognition models, computed in plain TypeScript so the
 * same code runs in the offscreen document, the bench page and Node.
 *
 * - Beat This! (CPJKU/beat_this): 22 050 Hz mono, STFT n_fft 1024 / hop 441 (50 fps),
 *   periodic Hann, center=True with reflect padding, magnitude / sqrt(n_fft)
 *   (torchaudio normalized='frame_length'), 128 slaney mel bands 30–11 000 Hz without
 *   area normalisation, then log1p(1000 · x).
 * - BTC (jayg996/BTC-ISMIR19): librosa-style CQT at 22 050 Hz, hop 2048, 144 bins,
 *   24 bins/octave from C1 (32.70 Hz), Hann windows, L1-normalised filters, scale=True
 *   (|C| · sqrt(N_k)), then log(|C| + 1e-6). Normalisation by the model's mean/std is
 *   done by the caller (src/recognize/chords.ts).
 *
 * Frames are computed from a sample accessor so callers can extract incrementally while
 * audio arrives (only frames whose window is fully available) and pad at the end.
 */
import { fft } from './fft';

export const MODEL_SAMPLE_RATE = 22050;

/** Reflect-padded read of x at index i (numpy/torch 'reflect'). */
function reflectAt(x: ArrayLike<number>, i: number, length: number): number {
  if (length <= 1) return length === 1 ? x[0] : 0;
  let j = i;
  const period = 2 * (length - 1);
  j = ((j % period) + period) % period;
  if (j >= length) j = period - j;
  return x[j];
}

// ---------------------------------------------------------------- mel (Beat This!)

export const MEL = {
  nFft: 1024,
  hop: 441,
  nMels: 128,
  fMin: 30,
  fMax: 11000,
  logMultiplier: 1000,
  fps: 50,
} as const;

function hzToMelSlaney(f: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp;
}

function melToHzSlaney(m: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
}

/** torchaudio.functional.melscale_fbanks(mel_scale='slaney', norm=None): [nFreqs][nMels]. */
export function melFilterbank(sampleRate = MODEL_SAMPLE_RATE, nFft: number = MEL.nFft, nMels: number = MEL.nMels, fMin: number = MEL.fMin, fMax: number = MEL.fMax): Float32Array[] {
  const nFreqs = nFft / 2 + 1;
  const nyq = Math.floor(sampleRate / 2);
  const allFreqs = Array.from({ length: nFreqs }, (_, i) => (nyq * i) / (nFreqs - 1));
  const mMin = hzToMelSlaney(fMin);
  const mMax = hzToMelSlaney(fMax);
  const fPts = Array.from({ length: nMels + 2 }, (_, i) => melToHzSlaney(mMin + ((mMax - mMin) * i) / (nMels + 1)));
  const fb: Float32Array[] = [];
  for (let f = 0; f < nFreqs; f++) {
    const row = new Float32Array(nMels);
    for (let m = 0; m < nMels; m++) {
      const down = (allFreqs[f] - fPts[m]) / (fPts[m + 1] - fPts[m]);
      const up = (fPts[m + 2] - allFreqs[f]) / (fPts[m + 2] - fPts[m + 1]);
      row[m] = Math.max(0, Math.min(down, up));
    }
    fb.push(row);
  }
  return fb;
}

export class MelExtractor {
  private readonly window: Float64Array;
  private readonly fb: Float32Array[];
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** Sparse filterbank: for each frequency bin, the mel bands it touches. */
  private readonly sparse: { m: Uint16Array; w: Float32Array }[];

  constructor() {
    const n = MEL.nFft;
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    this.fb = melFilterbank();
    this.sparse = this.fb.map((row) => {
      const m: number[] = [];
      const w: number[] = [];
      row.forEach((v, i) => {
        if (v > 0) {
          m.push(i);
          w.push(v);
        }
      });
      return { m: Uint16Array.from(m), w: Float32Array.from(w) };
    });
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Number of frames torch.stft(center=True) produces for `length` samples. */
  static frameCount(length: number): number {
    return length > 0 ? 1 + Math.floor(length / MEL.hop) : 0;
  }

  /** Frames whose window lies fully inside the first `length` samples (no right padding needed). */
  static readyFrameCount(length: number): number {
    if (length < MEL.nFft / 2 + 1) return 0;
    return Math.min(MelExtractor.frameCount(length), Math.floor((length - MEL.nFft / 2) / MEL.hop) + 1);
  }

  /** Log-mel frame m of x (total length `length`), written into out[offset .. offset+128). */
  frame(x: ArrayLike<number>, length: number, m: number, out: Float32Array, offset: number): void {
    const n = MEL.nFft;
    const start = m * MEL.hop - n / 2;
    const { re, im, window } = this;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < length ? x[idx] : reflectAt(x, idx, length);
      re[i] = v * window[i];
      im[i] = 0;
    }
    fft(re, im);
    out.fill(0, offset, offset + MEL.nMels);
    const norm = 1 / Math.sqrt(n);
    for (let f = 0; f <= n / 2; f++) {
      const s = this.sparse[f];
      if (s.m.length === 0) continue;
      const mag = Math.hypot(re[f], im[f]) * norm;
      for (let k = 0; k < s.m.length; k++) out[offset + s.m[k]] += mag * s.w[k];
    }
    for (let k = 0; k < MEL.nMels; k++) out[offset + k] = Math.log1p(MEL.logMultiplier * out[offset + k]);
  }

  /** All frames of a complete signal: [frames * 128]. */
  all(x: Float32Array): Float32Array {
    const frames = MelExtractor.frameCount(x.length);
    const out = new Float32Array(frames * MEL.nMels);
    for (let m = 0; m < frames; m++) this.frame(x, x.length, m, out, m * MEL.nMels);
    return out;
  }
}

// ---------------------------------------------------------------- CQT (BTC)

export const CQT = {
  hop: 2048,
  nBins: 144,
  binsPerOctave: 24,
  fMin: 32.70319566257483,
  logEps: 1e-6,
  /** One FFT size for every bin: next power of two above the longest filter (≈ 23 000 samples). */
  nFft: 32768,
} as const;

export const CQT_FRAME_SEC = CQT.hop / MODEL_SAMPLE_RATE;

interface SparseKernel {
  idx: Uint32Array;
  re: Float32Array;
  im: Float32Array;
  /** sqrt(N_k): librosa scale=True. */
  scale: number;
}

let cachedKernels: SparseKernel[] | null = null;

function cqtKernels(): SparseKernel[] {
  if (cachedKernels) return cachedKernels;
  const sr = MODEL_SAMPLE_RATE;
  const n = CQT.nFft;
  const Q = 1 / (Math.pow(2, 1 / CQT.binsPerOctave) - 1);
  const kernels: SparseKernel[] = [];
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let k = 0; k < CQT.nBins; k++) {
    const f = CQT.fMin * Math.pow(2, k / CQT.binsPerOctave);
    const lenF = (Q * sr) / f;
    const len = Math.ceil(lenF);
    re.fill(0);
    im.fill(0);
    let wsum = 0;
    const t0 = -Math.floor(len / 2);
    for (let i = 0; i < len; i++) wsum += 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
    for (let i = 0; i < len; i++) {
      const t = t0 + i;
      const w = (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len)) / wsum;
      const pos = n / 2 + t; // filter centred in the FFT frame
      re[pos] = w * Math.cos((2 * Math.PI * f * t) / sr);
      im[pos] = w * Math.sin((2 * Math.PI * f * t) / sr);
    }
    fft(re, im);
    // Keep the significant part of conj(H)/n on the positive frequencies.
    let max = 0;
    for (let j = 0; j <= n / 2; j++) max = Math.max(max, Math.hypot(re[j], im[j]));
    const idx: number[] = [];
    const kr: number[] = [];
    const ki: number[] = [];
    for (let j = 0; j <= n / 2; j++) {
      if (Math.hypot(re[j], im[j]) >= max * 1e-3) {
        idx.push(j);
        kr.push(re[j] / n);
        ki.push(-im[j] / n);
      }
    }
    kernels.push({ idx: Uint32Array.from(idx), re: Float32Array.from(kr), im: Float32Array.from(ki), scale: Math.sqrt(lenF) });
  }
  cachedKernels = kernels;
  return kernels;
}

export class CqtExtractor {
  private readonly kernels = cqtKernels();
  private readonly re = new Float64Array(CQT.nFft);
  private readonly im = new Float64Array(CQT.nFft);

  static frameCount(length: number): number {
    return length > 0 ? 1 + Math.floor(length / CQT.hop) : 0;
  }

  static readyFrameCount(length: number): number {
    if (length < CQT.nFft / 2 + 1) return 0;
    return Math.min(CqtExtractor.frameCount(length), Math.floor((length - CQT.nFft / 2) / CQT.hop) + 1);
  }

  /** log|CQT| frame m of x (length `length`) into out[offset .. offset+144). */
  frame(x: ArrayLike<number>, length: number, m: number, out: Float32Array, offset: number): void {
    const n = CQT.nFft;
    const start = m * CQT.hop - n / 2;
    const { re, im } = this;
    for (let i = 0; i < n; i++) {
      const idx = start + i;
      re[i] = idx >= 0 && idx < length ? x[idx] : reflectAt(x, idx, length);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < CQT.nBins; k++) {
      const ker = this.kernels[k];
      let cr = 0;
      let ci = 0;
      for (let q = 0; q < ker.idx.length; q++) {
        const j = ker.idx[q];
        const a = ker.re[q];
        const b = ker.im[q];
        cr += a * re[j] - b * im[j];
        ci += a * im[j] + b * re[j];
      }
      out[offset + k] = Math.log(Math.hypot(cr, ci) * ker.scale + CQT.logEps);
    }
  }

  all(x: Float32Array): Float32Array {
    const frames = CqtExtractor.frameCount(x.length);
    const out = new Float32Array(frames * CQT.nBins);
    for (let m = 0; m < frames; m++) this.frame(x, x.length, m, out, m * CQT.nBins);
    return out;
  }
}
