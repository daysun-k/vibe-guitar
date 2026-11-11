/**
 * Runs recognition models in a dedicated worker so inference never blocks a page.
 *
 * Every page of the extension (side panel, offscreen document) shares one renderer main thread.
 * A Beat This! chunk takes about 1.6 s on single-threaded WASM, so running it in the offscreen
 * document froze the side panel's playback display for that long every 30 s of listening.
 */
import type { ModelRunner } from './runner';

export type ExecutionProvider = 'wasm' | 'webgpu';

export interface ModelLoadOptions {
  /** Base URL of the onnxruntime-web WASM files. */
  wasmPaths: string;
  numThreads: number;
}

export type ModelWorkerRequest =
  | { type: 'load'; id: number; name: string; url: string; ep: ExecutionProvider; wasmPaths: string; numThreads: number }
  | { type: 'run'; id: number; name: string; inputName: string; data: Float32Array; dims: number[] };

export type ModelWorkerResponse =
  | { id: number; ok: true; outputs?: Record<string, Float32Array> }
  | { id: number; ok: false; error: string };

/** A request before the client numbers it (distributes over the union). */
type Unnumbered<T> = T extends unknown ? Omit<T, 'id'> : never;

/** The part of `Worker` the client uses (a fake in tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ModelWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void;
  terminate(): void;
}

interface Pending {
  resolve: (r: ModelWorkerResponse & { ok: true }) => void;
  reject: (e: Error) => void;
}

export class ModelWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private failure: Error | null = null;
  private readonly failureListeners: ((e: Error) => void)[] = [];

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', (e: MessageEvent<ModelWorkerResponse>) => {
      const r = e.data;
      const p = this.pending.get(r.id);
      if (!p) return;
      this.pending.delete(r.id);
      if (r.ok) p.resolve(r);
      else p.reject(new Error(r.error));
    });
    worker.addEventListener('error', (e: ErrorEvent) => {
      // A crashed worker answers nothing more: fail what is waiting and every later call.
      if (this.failure) return;
      const failure = new Error(`model worker failed: ${e.message || 'unknown error'}`);
      this.failure = failure;
      for (const p of this.pending.values()) p.reject(failure);
      this.pending.clear();
      for (const l of this.failureListeners) l(failure);
    });
  }

  /** Called once if the worker crashes (not after terminate()); immediately if it already has. */
  onFailure(listener: (e: Error) => void): void {
    if (this.failure && !this.terminated) listener(this.failure);
    else if (!this.failure) this.failureListeners.push(listener);
  }

  private call(req: Unnumbered<ModelWorkerRequest>, transfer: Transferable[] = []): Promise<ModelWorkerResponse & { ok: true }> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  async load(name: string, url: string, ep: ExecutionProvider, opts: ModelLoadOptions): Promise<void> {
    await this.call({ type: 'load', name, url, ep, wasmPaths: opts.wasmPaths, numThreads: opts.numThreads });
  }

  /** A runner for a loaded model. Inputs are copied, so callers may keep using their buffers. */
  runner(name: string): ModelRunner {
    return {
      run: async (inputName, data, dims) => {
        // slice(): only this view is sent (cloning a view would copy its whole buffer) and the
        // copy can be transferred without detaching the caller's memory.
        const copy = data.slice();
        const r = await this.call({ type: 'run', name, inputName, data: copy, dims: [...dims] }, [copy.buffer]);
        return r.outputs ?? {};
      },
    };
  }

  private terminated = false;

  terminate(): void {
    this.terminated = true;
    this.failureListeners.length = 0;
    this.failure ??= new Error('model worker terminated');
    for (const p of this.pending.values()) p.reject(this.failure);
    this.pending.clear();
    this.worker.terminate();
  }
}
