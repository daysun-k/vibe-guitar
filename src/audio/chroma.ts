/** Small DSP helpers for the capture spike (no recognition model). */

export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Pitch class (0 = C) of a frequency in Hz. */
export function frequencyToPitchClass(hz: number): number {
  const midi = 69 + 12 * Math.log2(hz / 440);
  return ((Math.round(midi) % 12) + 12) % 12;
}

/**
 * 12-bin chroma from an FFT magnitude spectrum in dB (AnalyserNode.getFloatFrequencyData).
 * Bins between fmin and fmax are folded onto pitch classes; result is normalised to max 1.
 */
export function chromaFromDbSpectrum(spectrumDb: ArrayLike<number>, sampleRate: number, fftSize: number, fmin = 65, fmax = 2100): number[] {
  const chroma = new Array<number>(12).fill(0);
  const binHz = sampleRate / fftSize;
  const first = Math.max(1, Math.floor(fmin / binHz));
  const last = Math.min(spectrumDb.length - 1, Math.ceil(fmax / binHz));
  for (let k = first; k <= last; k++) {
    const db = spectrumDb[k];
    if (!Number.isFinite(db)) continue;
    const mag = Math.pow(10, db / 20);
    chroma[frequencyToPitchClass(k * binHz)] += mag * mag;
  }
  const max = Math.max(...chroma);
  return max > 0 ? chroma.map((c) => c / max) : chroma;
}

export const PITCH_CLASS_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
