/**
 * Dedicated worker that owns the onnxruntime-web sessions (see recognize/model-worker-client.ts).
 * Audio features arrive as float32 arrays and stay inside the browser.
 */
import * as ort from 'onnxruntime-web';
import type { ModelWorkerRequest, ModelWorkerResponse } from '../../recognize/model-worker-client';

const sessions = new Map<string, ort.InferenceSession>();
let configured = false;

function reply(r: ModelWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(r, transfer);
}

self.addEventListener('message', (e: MessageEvent<ModelWorkerRequest>) => {
  void handle(e.data);
});

async function handle(req: ModelWorkerRequest): Promise<void> {
  try {
    if (req.type === 'load') {
      if (!configured) {
        ort.env.wasm.wasmPaths = req.wasmPaths;
        ort.env.wasm.numThreads = req.numThreads;
        configured = true;
      }
      sessions.set(req.name, await ort.InferenceSession.create(req.url, { executionProviders: [req.ep] }));
      reply({ id: req.id, ok: true });
      return;
    }
    const session = sessions.get(req.name);
    if (!session) throw new Error(`model "${req.name}" is not loaded`);
    const out = await session.run({ [req.inputName]: new ort.Tensor('float32', req.data, req.dims) });
    const outputs: Record<string, Float32Array> = {};
    // Own copies: an output may be a view the runtime still uses, which must not be transferred.
    for (const [k, v] of Object.entries(out)) outputs[k] = new Float32Array(v.data as Float32Array);
    reply({ id: req.id, ok: true, outputs }, Object.values(outputs).map((a) => a.buffer));
  } catch (err) {
    reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
