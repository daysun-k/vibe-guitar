/** chrome.storage.local wrappers: charts keyed by recording id, and settings. */
import { DEFAULT_PROFILE, type Level, type Profile } from '../arrange/levels';
import { chartStorageKey, type Chart, type RecordingSource } from '../chart/types';
import { mergeAutoCharts } from '../chart/merge';
import { validateChart } from '../chart/validate';
import { CorrectionConflict, correctChordEvent, type EventRef } from '../editor/correct';
import type { ChartWriteMessage, ChartWriteResult } from './messages';

export interface Settings {
  level: Level;
  capo: 'auto' | number;
  /** Look-ahead before a change, in bars (converted to big beats for compound meter). */
  lookAheadBars: number;
  /** Legacy on/off; superseded by countInBars. */
  countIn?: boolean;
  /** Count-in before playing from the panel: 0 (off), 1 or 2 bars of big beats. */
  countInBars: 0 | 1 | 2;
  countInClick: boolean;
  /** Show the sounding chord names (e.g. A♭ with capo 1 shape G). */
  showSounding: boolean;
  /** Look up time-synced lyrics on lrclib.net (title, artist, duration only). */
  fetchLyrics: boolean;
  theme: 'auto' | 'light' | 'dark';
  /** Added to the estimated position (positive = chords earlier). */
  syncOffsetMs: number;
  /** Allow root-changing substitutions (relative major/minor triad). Owner's choice: off by default. */
  allowRootChange: boolean;
  profile: Profile;
}

export const DEFAULT_SETTINGS: Settings = {
  level: 'beginner',
  capo: 'auto',
  lookAheadBars: 1,
  countInBars: 1,
  countInClick: true,
  showSounding: false,
  fetchLyrics: true,
  theme: 'auto',
  syncOffsetMs: 0,
  allowRootChange: false,
  profile: DEFAULT_PROFILE,
};

const SETTINGS_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(r[SETTINGS_KEY]);
}

/** Defaults for missing fields; the old countIn flag maps to 1 bar (on) or 0 (off). */
export function normalizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const countInBars = s.countInBars === 0 || s.countInBars === 1 || s.countInBars === 2 ? s.countInBars : s.countIn === false ? 0 : 1;
  const { countIn: _legacy, ...rest } = s;
  return { ...DEFAULT_SETTINGS, ...rest, countInBars, allowRootChange: s.allowRootChange === true, profile: { ...DEFAULT_PROFILE, ...(s.profile ?? {}) } };
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

  /**
   * Fixes one event's chord on the chart in use (play view), inside the write turn so it
   * applies to the stored chart even if an auto chart arrived after the panel read it.
   */
  correctEvent(source: RecordingSource, id: string, event: EventRef, chord: string, at: Date): Promise<{ before: Chart; after: Chart }> {
    return this.exclusive(async () => {
      const before = await this.load(source, id);
      if (!before) throw new CorrectionConflict('저장된 코드표가 없어요.');
      const after = checked(correctChordEvent(before, event, chord, at));
      await this.area.set({ [chartStorageKey(before.recording.source, before.recording.id)]: after });
      return { before, after };
    });
  }

  /**
   * Undoes correctEvent while the stored chart is still the corrected one. An auto chart in
   * use is restored as the latest stored auto chart (later analyses were merged into it).
   */
  undoCorrection(before: Chart, after: Chart): Promise<Chart> {
    checked(before);
    return this.exclusive(async () => {
      const { source, id } = after.recording;
      const current = await this.load(source, id);
      const same = current && current.provenance.updatedAt === after.provenance.updatedAt && JSON.stringify(current.events) === JSON.stringify(after.events);
      if (!same) throw new CorrectionConflict('그 사이에 코드표가 바뀌어서 되돌리지 못했어요.');
      const auto = before.provenance.createdBy === 'recognizer' ? await this.loadAuto(source, id) : null;
      const restored = auto ? { ...auto, recording: { ...auto.recording, source, id } } : before;
      await this.area.set({ [chartStorageKey(source, id)]: restored });
      return restored;
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

/** Side panel: fixes one chord of the chart in use through the serialized ChartStore. */
export async function correctChartEvent(source: RecordingSource, id: string, event: EventRef, chord: string): Promise<{ before: Chart; after: Chart }> {
  const r = await requestWrite({ type: 'chart-write', op: 'correct-event', source, id, event, chord, at: new Date().toISOString() });
  if (!r.chart || !r.before) throw new Error('서비스 워커가 고친 코드표를 돌려주지 않았어요');
  return { before: r.before, after: r.chart };
}

/** Side panel: undoes correctChartEvent through the serialized ChartStore. */
export async function undoChartCorrection(before: Chart, after: Chart): Promise<Chart> {
  const r = await requestWrite({ type: 'chart-write', op: 'undo-correct', before, after });
  if (!r.chart) throw new Error('서비스 워커가 되돌린 코드표를 돌려주지 않았어요');
  return r.chart;
}

/** Service worker: runs one chart write request on the serialized store. */
export async function handleChartWrite(store: ChartStore, msg: ChartWriteMessage): Promise<ChartWriteResult> {
  try {
    if (msg.op === 'save') {
      await store.saveManual(msg.chart);
      return { ok: true };
    }
    if (msg.op === 'correct-event') {
      const { before, after } = await store.correctEvent(msg.source, msg.id, msg.event, msg.chord, new Date(msg.at));
      return { ok: true, chart: after, before };
    }
    if (msg.op === 'undo-correct') return { ok: true, chart: await store.undoCorrection(msg.before, msg.after) };
    return { ok: true, chart: await store.adoptAuto(msg.source, msg.id) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
