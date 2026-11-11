/**
 * Suitability of every level for the side panel's 연주 설정 sheet. The current level's
 * arrangement is built on the main thread with the play model; the other levels are computed
 * in a dedicated worker (level-worker.js). Results are cached per chart identity and revision,
 * timing, level, profile, capo setting, root-change setting and vocabulary version; a reply
 * for an older song or older settings is discarded. Without a worker (the file:// demo) the
 * levels are computed on the main thread after the first render, one level per task.
 */
import { VOCAB_VERSION } from '../arrange/curriculum';
import type { Level, Profile } from '../arrange/levels';
import { levelSuitability, type LevelSuitability } from '../arrange/suitability';
import type { Chart } from '../chart/types';
import { prepareChart } from './prepare';

export interface LevelFitInput {
  chart: Chart;
  capo: 'auto' | number;
  profile: Profile;
  allowRootChange: boolean;
}

export interface LevelFitWorkerRequest extends LevelFitInput {
  id: number;
  levels: Level[];
}

export type LevelFitWorkerResponse =
  | { id: number; ok: true; results: LevelSuitability[]; ms: number }
  | { id: number; ok: false; error: string };

/** Pure computation shared by the worker and the main-thread fallback. */
export function computeLevelFits(input: LevelFitInput, levels: Level[]): LevelSuitability[] {
  const prepared = prepareChart(input.chart).chart;
  return levels.map((level) => levelSuitability(prepared, level, { capo: input.capo, profile: input.profile, allowRootChange: input.allowRootChange }));
}

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** Cache key of one level's result. The revision hashes the events and coverage, so an edit is a new key. */
export function levelFitKey(input: LevelFitInput, level: Level): string {
  const c = input.chart;
  const rev = `${c.provenance.updatedAt ?? c.provenance.createdAt}#${c.events.length}#${hash(JSON.stringify([c.events.map((e) => [e.startSec, e.chord]), c.coverage]))}`;
  return [
    `v${VOCAB_VERSION}`,
    `${c.recording.source}:${c.recording.id}`,
    rev,
    hash(JSON.stringify(c.timing)),
    level,
    String(input.capo),
    input.allowRootChange ? 'root' : 'noroot',
    hash(JSON.stringify(input.profile)),
  ].join('|');
}

/** The part of `Worker` the controller uses (a fake in tests). */
export interface LevelWorkerLike {
  postMessage(message: LevelFitWorkerRequest): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<LevelFitWorkerResponse>) => void): void;
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void;
  terminate(): void;
}

export type LevelFitState = { status: 'pending' } | { status: 'done'; result: LevelSuitability } | { status: 'error' };

export interface LevelFitControllerOptions {
  /** Creates the worker; null or a throw means "no worker" (main-thread fallback). */
  createWorker: () => LevelWorkerLike | null;
  /** Called whenever a level's state changes for the current request. */
  onUpdate: (states: Map<Level, LevelFitState>) => void;
  /** Runs a task later (fallback: one level per task). */
  schedule?: (fn: () => void) => void;
  compute?: typeof computeLevelFits;
  /** Worker timing, for diagnostics. */
  onTiming?: (ms: number, levels: Level[]) => void;
}

export class LevelFitController {
  private readonly cache = new Map<string, LevelSuitability>();
  private worker: LevelWorkerLike | null | undefined;
  private generation = 0;
  private nextId = 1;
  /** Request id → generation and the levels/keys it was sent for. */
  private readonly inflight = new Map<number, { generation: number; levels: Level[]; keys: string[] }>();
  private states = new Map<Level, LevelFitState>();
  private input: LevelFitInput | null = null;
  private readonly schedule: (fn: () => void) => void;
  private readonly compute: typeof computeLevelFits;

  constructor(private readonly o: LevelFitControllerOptions) {
    this.schedule = o.schedule ?? ((fn) => setTimeout(fn, 0));
    this.compute = o.compute ?? computeLevelFits;
  }

  /** True when the worker could not be created (the main thread computes instead). */
  get usingFallback(): boolean {
    return this.worker === null;
  }

  private ensureWorker(): LevelWorkerLike | null {
    if (this.worker !== undefined) return this.worker;
    try {
      this.worker = this.o.createWorker();
    } catch {
      this.worker = null;
    }
    const w = this.worker;
    if (w) {
      w.addEventListener('message', (e) => this.onReply(e.data));
      w.addEventListener('error', () => {
        // A worker that fails (or cannot load its script) answers nothing more: compute here.
        if (this.worker !== w) return;
        this.worker = null;
        try {
          w.terminate();
        } catch {
          // already gone
        }
        const pending = [...this.inflight.values()].filter((r) => r.generation === this.generation);
        this.inflight.clear();
        for (const r of pending) this.runFallback(r.levels, this.generation);
      });
    }
    return this.worker;
  }

  /**
   * New song or settings: drop every pending reply, report cached levels at once and start the
   * missing ones. `levels` are the levels to compute (the sheet shows all four).
   */
  update(input: LevelFitInput | null, levels: Level[]): void {
    this.generation++;
    this.inflight.clear();
    this.input = input;
    this.states = new Map();
    if (!input) {
      this.o.onUpdate(this.states);
      return;
    }
    const missing: Level[] = [];
    for (const level of levels) {
      const hit = this.cache.get(levelFitKey(input, level));
      if (hit) this.states.set(level, { status: 'done', result: hit });
      else {
        this.states.set(level, { status: 'pending' });
        missing.push(level);
      }
    }
    this.o.onUpdate(this.states);
    if (!missing.length) return;
    const w = this.ensureWorker();
    if (w) {
      const id = this.nextId++;
      this.inflight.set(id, { generation: this.generation, levels: missing, keys: missing.map((l) => levelFitKey(input, l)) });
      w.postMessage({ id, levels: missing, ...input });
    } else this.runFallback(missing, this.generation);
  }

  private onReply(r: LevelFitWorkerResponse): void {
    const req = this.inflight.get(r.id);
    this.inflight.delete(r.id);
    // Stale: an older song or older settings (update() cleared it), or an unknown id.
    if (!req || req.generation !== this.generation) return;
    if (!r.ok) {
      for (const l of req.levels) this.states.set(l, { status: 'error' });
      this.o.onUpdate(this.states);
      return;
    }
    this.o.onTiming?.(r.ms, req.levels);
    r.results.forEach((res, i) => {
      this.cache.set(req.keys[i], res);
      this.states.set(res.level, { status: 'done', result: res });
    });
    this.o.onUpdate(this.states);
  }

  private runFallback(levels: Level[], generation: number): void {
    const queue = [...levels];
    const step = (): void => {
      if (generation !== this.generation || !this.input) return; // superseded
      const level = queue.shift();
      if (!level) return;
      const input = this.input;
      try {
        const [res] = this.compute(input, [level]);
        this.cache.set(levelFitKey(input, level), res);
        this.states.set(level, { status: 'done', result: res });
      } catch (e) {
        console.error(e);
        this.states.set(level, { status: 'error' });
      }
      this.o.onUpdate(this.states);
      if (queue.length) this.schedule(step);
    };
    this.schedule(step);
  }

  dispose(): void {
    this.generation++;
    this.worker?.terminate();
    this.worker = undefined;
  }
}
