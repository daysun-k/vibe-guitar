/**
 * Streaming windowed-sinc resampler (mono). Used to bring captured tab audio
 * (usually 48 kHz) to the 22 050 Hz the recognition models expect.
 */
export class StreamingResampler {
  readonly ratio: number;
  private readonly half: number;
  private readonly cutoff: number;
  private buf: Float32Array = new Float32Array(0);
  /** Absolute input index of buf[0]. */
  private bufStart = 0;
  /** Absolute (fractional) input position of the next output sample. */
  private nextPos = 0;
  private readonly table: Float32Array;
  private readonly tableRes = 512;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
    halfTaps = 24,
  ) {
    this.ratio = fromRate / toRate;
    this.half = halfTaps;
    // Low-pass at 0.95 of the lower Nyquist.
    this.cutoff = Math.min(1, toRate / fromRate) * 0.95;
    // Precompute the windowed sinc kernel on a fine grid: x in [-half, half].
    const n = 2 * halfTaps * this.tableRes + 1;
    this.table = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i / this.tableRes - halfTaps;
      this.table[i] = this.kernel(x);
    }
  }

  private kernel(x: number): number {
    const c = this.cutoff;
    const s = x === 0 ? c : Math.sin(Math.PI * c * x) / (Math.PI * x);
    const w = Math.abs(x) >= this.half ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * x) / this.half);
    return s * w;
  }

  /** Feed input samples; returns the output samples that became computable. */
  push(input: ArrayLike<number>): Float32Array {
    if (this.fromRate === this.toRate) return Float32Array.from(input);
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    for (let i = 0; i < input.length; i++) merged[this.buf.length + i] = input[i];
    this.buf = merged;
    const lastAvail = this.bufStart + this.buf.length - 1;
    const out: number[] = [];
    while (this.nextPos + this.half <= lastAvail) {
      out.push(this.sampleAt(this.nextPos));
      this.nextPos += this.ratio;
    }
    // Drop input no longer needed.
    const keepFrom = Math.max(0, Math.floor(this.nextPos) - this.half - 1 - this.bufStart);
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom);
      this.bufStart += keepFrom;
    }
    return Float32Array.from(out);
  }

  private sampleAt(pos: number): number {
    const center = Math.floor(pos);
    const frac = pos - center;
    let acc = 0;
    for (let k = -this.half + 1; k <= this.half; k++) {
      const idx = center + k - this.bufStart;
      if (idx < 0 || idx >= this.buf.length) continue;
      const x = k - frac; // distance in input samples
      const t = (x + this.half) * this.tableRes;
      const ti = Math.floor(t);
      const tf = t - ti;
      const kv = ti + 1 < this.table.length ? this.table[ti] * (1 - tf) + this.table[ti + 1] * tf : 0;
      acc += this.buf[idx] * kv;
    }
    return acc;
  }
}

/** One-shot resample of a whole buffer. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const r = new StreamingResampler(fromRate, toRate);
  const head = r.push(input);
  const tail = r.push(new Float32Array(64));
  const expected = Math.floor((input.length * toRate) / fromRate);
  const out = new Float32Array(expected);
  out.set(head.subarray(0, expected), 0);
  if (head.length < expected) out.set(tail.subarray(0, expected - head.length), head.length);
  return out;
}
