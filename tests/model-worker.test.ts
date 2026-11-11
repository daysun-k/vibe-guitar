import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ListeningController, type ListenModels } from '../src/extension/offscreen/listen';
import { ModelWorkerClient, type ModelWorkerRequest, type ModelWorkerResponse, type WorkerLike } from '../src/recognize/model-worker-client';

/** A fake worker: records requests and lets the test answer them in any order. */
class FakeWorker implements WorkerLike {
  readonly sent: { msg: ModelWorkerRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  private onMessage: ((e: MessageEvent<ModelWorkerResponse>) => void) | null = null;
  private onError: ((e: ErrorEvent) => void) | null = null;

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.sent.push({ msg: message as ModelWorkerRequest, transfer });
  }

  addEventListener(type: 'message' | 'error', listener: (e: never) => void): void {
    if (type === 'message') this.onMessage = listener as (e: MessageEvent<ModelWorkerResponse>) => void;
    else this.onError = listener as (e: ErrorEvent) => void;
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(r: ModelWorkerResponse): void {
    this.onMessage?.({ data: r } as MessageEvent<ModelWorkerResponse>);
  }

  crash(message: string): void {
    this.onError?.({ message } as ErrorEvent);
  }
}

const opts = { wasmPaths: 'chrome-extension://x/ort/', numThreads: 1 };

describe('model worker client', () => {
  it('loads a model with the runtime options', async () => {
    const w = new FakeWorker();
    const c = new ModelWorkerClient(w);
    const p = c.load('beat', 'chrome-extension://x/models/beat.onnx', 'wasm', opts);
    expect(w.sent[0].msg).toEqual({ type: 'load', id: 1, name: 'beat', url: 'chrome-extension://x/models/beat.onnx', ep: 'wasm', wasmPaths: opts.wasmPaths, numThreads: 1 });
    w.answer({ id: 1, ok: true });
    await expect(p).resolves.toBeUndefined();
  });

  it('sends a copy of just the input view and leaves the caller buffer usable', async () => {
    const w = new FakeWorker();
    const run = new ModelWorkerClient(w).runner('beat').run;
    const big = new Float32Array(1000).map((_, i) => i);
    const view = big.subarray(10, 16);
    const p = run('spect', view, [1, 2, 3]);
    const { msg, transfer } = w.sent[0];
    if (msg.type !== 'run') throw new Error('expected a run request');
    expect([...msg.data]).toEqual([10, 11, 12, 13, 14, 15]);
    expect(msg.data.buffer.byteLength).toBe(6 * 4); // not the whole 1000-float buffer
    expect(transfer).toEqual([msg.data.buffer]);
    expect(msg).toMatchObject({ name: 'beat', inputName: 'spect', dims: [1, 2, 3] });
    expect(big.length).toBe(1000); // caller's buffer is not detached
    w.answer({ id: msg.id, ok: true, outputs: { beat: new Float32Array([0.5]) } });
    expect((await p).beat[0]).toBe(0.5);
  });

  it('matches answers to requests by id, in any order, and reports model errors', async () => {
    const w = new FakeWorker();
    const c = new ModelWorkerClient(w);
    const a = c.runner('beat').run('spect', new Float32Array([1]), [1]);
    const b = c.runner('chords').run('feature', new Float32Array([2]), [1]);
    w.answer({ id: 2, ok: true, outputs: { chord: new Float32Array([7]) } });
    w.answer({ id: 1, ok: false, error: 'bad input' });
    expect((await b).chord[0]).toBe(7);
    await expect(a).rejects.toThrow('bad input');
  });

  it('fails waiting and later calls once the worker crashes', async () => {
    const w = new FakeWorker();
    const c = new ModelWorkerClient(w);
    const waiting = c.runner('beat').run('spect', new Float32Array([1]), [1]);
    w.crash('out of memory');
    await expect(waiting).rejects.toThrow('model worker failed: out of memory');
    await expect(c.runner('beat').run('spect', new Float32Array([1]), [1])).rejects.toThrow('out of memory');
    expect(w.sent).toHaveLength(1);
  });

  it('terminate rejects what is waiting and stops the worker', async () => {
    const w = new FakeWorker();
    const c = new ModelWorkerClient(w);
    const waiting = c.load('beat', 'u', 'wasm', opts);
    c.terminate();
    await expect(waiting).rejects.toThrow('terminated');
    expect(w.terminated).toBe(true);
  });
});

describe('offscreen listening keeps inference off the shared main thread', () => {
  it('listen.ts does not load onnxruntime-web itself; the model worker does', () => {
    const listen = readFileSync(new URL('../src/extension/offscreen/listen.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../src/extension/offscreen/model-worker.ts', import.meta.url), 'utf8');
    expect(listen).not.toMatch(/from 'onnxruntime-web'/);
    expect(listen).toMatch(/new Worker\(chrome\.runtime\.getURL\('model-worker\.js'\)\)/);
    expect(worker).toMatch(/from 'onnxruntime-web'/);
  });
});

describe('listening recovers from a crashed model worker', () => {
  it('drops the dead models, reports an error, and loads a new worker on the next start', async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const makeModels = async (): Promise<ListenModels> => {
        const w = new FakeWorker();
        workers.push(w);
        const client = new ModelWorkerClient(w);
        return {
          recognizer: {} as ListenModels['recognizer'],
          beat: client.runner('beat'),
          backend: 'wasm (worker)',
          onFailure: (l) => client.onFailure(l),
          dispose: () => client.terminate(),
        };
      };
      const sent: { modelState?: string; modelError?: string }[] = [];
      const c = new ListeningController((m) => sent.push(m as { modelState?: string }), () => null, makeModels);
      const flush = () => vi.advanceTimersByTimeAsync(0);

      c.start(7);
      await flush();
      expect(workers).toHaveLength(1);

      workers[0].crash('worker script error');
      expect(sent.at(-1)).toMatchObject({ modelState: 'error', modelError: 'model worker failed: worker script error' });
      expect(workers[0].terminated).toBe(true);

      c.stop();
      c.start(7);
      await flush();
      expect(workers).toHaveLength(2); // a fresh worker, not the dead one
      c.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a terminated client never reports a crash', () => {
    const w = new FakeWorker();
    const c = new ModelWorkerClient(w);
    const seen: Error[] = [];
    c.onFailure((e) => seen.push(e));
    c.terminate();
    w.crash('late');
    expect(seen).toEqual([]);
  });
});
