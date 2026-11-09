/**
 * Runtime-neutral model runner so the same recognition code drives onnxruntime-web
 * (offscreen document, bench page) and onnxruntime-node (benchmark script).
 */
export interface ModelRunner {
  /** Runs a model with one float32 input; returns its float32 outputs by name. */
  run(inputName: string, data: Float32Array, dims: number[]): Promise<Record<string, Float32Array>>;
}

/** Minimal shape shared by onnxruntime-web and onnxruntime-node. */
interface OrtTensorCtor {
  new (type: 'float32', data: Float32Array, dims: readonly number[]): unknown;
}
interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>;
}

export function ortRunner(session: OrtSessionLike, Tensor: OrtTensorCtor): ModelRunner {
  return {
    async run(inputName, data, dims) {
      const out = await session.run({ [inputName]: new Tensor('float32', data, dims) });
      const result: Record<string, Float32Array> = {};
      for (const [k, v] of Object.entries(out)) result[k] = v.data as Float32Array;
      return result;
    },
  };
}

/** File names inside dist/models/ (and models/ for Node). */
export const MODEL_FILES = {
  beat: 'beat_this_small.onnx',
  chords: 'btc_large_voca.onnx',
  chordsMajmin: 'btc_majmin.onnx',
  btcMeta: 'btc_meta.json',
} as const;
