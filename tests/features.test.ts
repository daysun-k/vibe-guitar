import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fft } from '../src/audio/fft';
import { CQT, CqtExtractor, MEL, MelExtractor, MODEL_SAMPLE_RATE, melFilterbank } from '../src/audio/features';
import { resample } from '../src/audio/resample';

const sine = (hz: number, sec: number, sr = MODEL_SAMPLE_RATE, amp = 0.5) =>
  Float32Array.from({ length: Math.round(sec * sr) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

describe('fft', () => {
  it('matches a direct DFT', () => {
    const n = 16;
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i) + 0.3 * Math.cos(3 * i));
    const im = new Float64Array(n);
    const ref = Array.from({ length: n }, (_, k) => {
      let r = 0;
      let m = 0;
      for (let t = 0; t < n; t++) {
        r += re[t] * Math.cos((2 * Math.PI * k * t) / n);
        m -= re[t] * Math.sin((2 * Math.PI * k * t) / n);
      }
      return [r, m];
    });
    fft(re, im);
    ref.forEach(([r, m], k) => {
      expect(re[k]).toBeCloseTo(r, 9);
      expect(im[k]).toBeCloseTo(m, 9);
    });
  });
});

describe('resample', () => {
  it('keeps a 440 Hz tone at 440 Hz and its level when going 48 kHz -> 22.05 kHz', () => {
    const x = sine(440, 1, 48000);
    const y = resample(x, 48000, MODEL_SAMPLE_RATE);
    expect(y.length).toBe(Math.floor((x.length * MODEL_SAMPLE_RATE) / 48000));
    const ref = sine(440, 1);
    let err = 0;
    for (let i = 200; i < y.length - 200; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
    expect(err).toBeLessThan(0.01);
  });
});

describe('mel features (Beat This!)', () => {
  const refPath = 'models/mel-filterbank.bin';
  it.skipIf(!existsSync(refPath))('filterbank equals torchaudio MelScale.fb (models/mel-filterbank.bin)', () => {
    const buf = readFileSync(refPath);
    const ref = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const fb = melFilterbank();
    let maxErr = 0;
    for (let f = 0; f < 513; f++) for (let m = 0; m < 128; m++) maxErr = Math.max(maxErr, Math.abs(fb[f][m] - ref[f * 128 + m]));
    expect(maxErr).toBeLessThan(1e-4);
  });

  it('has torch.stft(center=True) frame counts and puts a 1 kHz tone in the right band', () => {
    const x = sine(1000, 1);
    expect(MelExtractor.frameCount(x.length)).toBe(1 + Math.floor(x.length / MEL.hop));
    const mel = new MelExtractor().all(x);
    const frame = mel.subarray(25 * 128, 26 * 128);
    const peak = frame.indexOf(Math.max(...frame));
    const fb = melFilterbank();
    const bin = Math.round((1000 / MODEL_SAMPLE_RATE) * MEL.nFft);
    const expected = fb[bin].indexOf(Math.max(...fb[bin]));
    expect(Math.abs(peak - expected)).toBeLessThanOrEqual(1);
  });
});

describe('CQT features (BTC)', () => {
  it('peaks at the bin of the played note (A4 = C1 + 3 octaves + 9 semitones = bin 90)', () => {
    const x = sine(440, 3);
    const cqt = new CqtExtractor().all(x);
    const m = 16;
    const frame = cqt.subarray(m * CQT.nBins, (m + 1) * CQT.nBins);
    const peak = frame.indexOf(Math.max(...frame));
    expect(peak).toBe(3 * 24 + 18);
  });

  it('scales like librosa scale=True: |C| ≈ sqrt(N_k) * A / 2 for a centred sinusoid', () => {
    const x = sine(440, 3, MODEL_SAMPLE_RATE, 0.5);
    const cqt = new CqtExtractor().all(x);
    const k = 3 * 24 + 18;
    const Q = 1 / (Math.pow(2, 1 / 24) - 1);
    const expected = Math.sqrt((Q * MODEL_SAMPLE_RATE) / 440) * 0.25;
    expect(Math.exp(cqt[16 * CQT.nBins + k])).toBeCloseTo(expected, 1);
  });
});

describe('CQT parity with librosa (optional: run scripts/verify-features.py first)', () => {
  const p = 'bench-out/cqt-parity.json';
  it.skipIf(!existsSync(p))('log-CQT matches librosa.cqt within the model-relevant range', () => {
    const ref = JSON.parse(readFileSync(p, 'utf8')) as { signal: number[]; frames: number; logcqt: number[] };
    const x = Float32Array.from(ref.signal);
    const ours = new CqtExtractor().all(x);
    expect(CqtExtractor.frameCount(x.length)).toBe(ref.frames);
    // Compare interior frames (edges depend on padding details) and bins with energy.
    let sumAbs = 0;
    let n = 0;
    let maxAbs = 0;
    for (let m = 3; m < ref.frames - 3; m++) {
      for (let k = 0; k < CQT.nBins; k++) {
        const r = ref.logcqt[m * CQT.nBins + k];
        if (r < -6) continue; // near-silent bins: log of noise floor
        const d = Math.abs(ours[m * CQT.nBins + k] - r);
        sumAbs += d;
        maxAbs = Math.max(maxAbs, d);
        n++;
      }
    }
    const meanAbs = sumAbs / n;
    console.log(`CQT parity: ${n} cells, mean |Δlog| ${meanAbs.toFixed(4)}, max ${maxAbs.toFixed(4)}`);
    expect(meanAbs).toBeLessThan(0.1);
  });
});
