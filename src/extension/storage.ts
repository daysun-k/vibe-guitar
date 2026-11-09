/** chrome.storage.local wrappers: charts keyed by recording id, and settings. */
import { DEFAULT_PROFILE, type Level, type Profile } from '../arrange/levels';
import { chartStorageKey, type Chart, type RecordingSource } from '../chart/types';
import { mergeAutoCharts } from '../chart/merge';
import { validateChart } from '../chart/validate';
import type { ChartWriteMessage, ChartWriteResult } from './messages';

export interface Settings {
  level: Level;
  capo: 'auto' | number;
  lookAheadBars: number;
  countIn: boolean;
  countInClick: boolean;
  /** Added to the estimated position (positive = chords earlier). */
  syncOffsetMs: number;
  profile: Profile;
}

export const DEFAULT_SETTINGS: Settings = {
  level: 'beginner',
  capo: 'auto',
  lookAheadBars: 1,
  countIn: true,
  countInClick: true,
  syncOffsetMs: 0,
  profile: DEFAULT_PROFILE,
};

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = (r[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...s, profile: { ...DEFAULT_PROFILE, ...(s.profile ?? {}) } };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

/** YouTube and YouTube Music share video ids, so fall back across the two. */
function lookupKeys(source: RecordingSource, id: string): string[] {
  const keys = [chartStorageKey(source, id)];
  if (source === 'youtube') keys.push(chartStorageKey('ytmusic', id));
  if (source === 'ytmusic') keys.push(chartStorageKey('youtube', id));
  return keys;
}

/** The subset of chrome.storage.local used for charts (injectable for tests). */
export interface StorageArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function chromeArea(): StorageArea {
  return {
    get: (keys) => chrome.storage.local.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => chrome.storage.local.set(items),
  };
}

async function readChart(area: StorageArea, keys: string[]): Promise<Chart | null> {
  const r = await area.get(keys);
  for (const k of keys) {
    const v = r[k];
    if (v && validateChart(v).ok) return v as Chart;
  }
  return null;
}

export async function loadChart(source: RecordingSource, id: string): Promise<Chart | null> {
  return readChart(chromeArea(), lookupKeys(source, id));
}

export async function listCharts(): Promise<Chart[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith('chart:'))
    .map(([, v]) => v as Chart);
}

/** Key of the latest auto chart for a recording (kept even when a manual chart is in use). */
export function autoChartKey(source: RecordingSource, id: string): string {
  return `autochart:${source}:${id}`;
}

function autoLookupKeys(source: RecordingSource, id: string): string[] {
  return lookupKeys(source, id).map((k) => k.replace(/^chart:/, 'autochart:'));
}

export async function loadAutoChart(source: RecordingSource, id: string): Promise<Chart | null> {
  return readChart(chromeArea(), autoLookupKeys(source, id));
}

function checked(chart: Chart): Chart {
  const v = validateChart(chart);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return chart;
}

/**
 * Every chart write (manual save, auto chart, adopting the auto chart) goes through one
 * instance of this class in the service worker. Writes run one at a time and re-read the
 * stored state inside their turn, so an auto chart can never overwrite a manual chart
 * that was saved while the auto save was in flight.
 */
export class ChartStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly area: StorageArea) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  load(source: RecordingSource, id: string): Promise<Chart | null> {
    return readChart(this.area, lookupKeys(source, id));
  }

  loadAuto(source: RecordingSource, id: string): Promise<Chart | null> {
    return readChart(this.area, autoLookupKeys(source, id));
  }

  /** Manual save, import or example: replaces the chart in use. */
  saveManual(chart: Chart): Promise<void> {
    checked(chart);
    return this.exclusive(async () => {
      await this.area.set({ [chartStorageKey(chart.recording.source, chart.recording.id)]: chart });
    });
  }

  /**
   * Stores an auto chart, merged with the previous auto chart so its coverage never
   * shrinks. It becomes the chart in use only when the recording has no chart yet or only
   * an auto chart; a manual or edited chart is never overwritten here (the panel asks the
   * user first, see adoptAuto).
   */
  saveAuto(chart: Chart): Promise<'main' | 'pending'> {
    checked(chart);
    return this.exclusive(async () => {
      const { source, id } = chart.recording;
      const prev = await this.loadAuto(source, id);
      const merged = prev ? checked(mergeAutoCharts(prev, chart)) : chart;
      const existing = await this.load(source, id);
      const toMain = !existing || existing.provenance.createdBy === 'recognizer';
      await this.area.set({ [autoChartKey(source, id)]: merged, ...(toMain ? { [chartStorageKey(source, id)]: merged } : {}) });
      return toMain ? 'main' : 'pending';
    });
  }

  /** Replaces the chart in use by the stored auto chart (call only after the user confirmed). */
  adoptAuto(source: RecordingSource, id: string): Promise<Chart | null> {
    return this.exclusive(async () => {
      const auto = await this.loadAuto(source, id);
      if (!auto) return null;
      const current = await this.load(source, id);
      const items: Record<string, unknown> = { [chartStorageKey(source, id)]: { ...auto, recording: { ...auto.recording, source, id } } };
      // Keep the replaced hand-made chart recoverable.
      if (current && current.provenance.createdBy !== 'recognizer') items[`chartbackup:${source}:${id}`] = current;
      await this.area.set(items);
      return auto;
    });
  }
}

let swStore: ChartStore | null = null;
/** The service worker's single ChartStore (call only in the service worker). */
export function serviceWorkerChartStore(): ChartStore {
  swStore ??= new ChartStore(chromeArea());
  return swStore;
}

async function requestWrite(msg: ChartWriteMessage): Promise<Extract<ChartWriteResult, { ok: true }>> {
  const r = (await chrome.runtime.sendMessage(msg)) as ChartWriteResult | undefined;
  if (!r) throw new Error('서비스 워커가 응답하지 않았습니다');
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** Side panel: saves a chart through the service worker's serialized ChartStore. */
export async function saveChart(chart: Chart): Promise<void> {
  checked(chart);
  await requestWrite({ type: 'chart-write', op: 'save', chart });
}

/** Side panel: adopts the auto chart through the service worker's serialized ChartStore. */
export async function adoptAutoChart(source: RecordingSource, id: string): Promise<Chart | null> {
  const r = await requestWrite({ type: 'chart-write', op: 'adopt-auto', source, id });
  return r.chart ?? null;
}

/** Service worker: runs one chart write request on the serialized store. */
export async function handleChartWrite(store: ChartStore, msg: ChartWriteMessage): Promise<ChartWriteResult> {
  try {
    if (msg.op === 'save') {
      await store.saveManual(msg.chart);
      return { ok: true };
    }
    return { ok: true, chart: await store.adoptAuto(msg.source, msg.id) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
