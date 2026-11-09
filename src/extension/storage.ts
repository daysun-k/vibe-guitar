/** chrome.storage.local wrappers: charts keyed by recording id, and settings. */
import { DEFAULT_PROFILE, type Level, type Profile } from '../arrange/levels';
import { chartStorageKey, type Chart, type RecordingSource } from '../chart/types';
import { validateChart } from '../chart/validate';

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

export async function loadChart(source: RecordingSource, id: string): Promise<Chart | null> {
  const keys = lookupKeys(source, id);
  const r = await chrome.storage.local.get(keys);
  for (const k of keys) {
    const v = r[k];
    if (v && validateChart(v).ok) return v as Chart;
  }
  return null;
}

export async function saveChart(chart: Chart): Promise<void> {
  const v = validateChart(chart);
  if (!v.ok) throw new Error(v.errors.join('; '));
  await chrome.storage.local.set({ [chartStorageKey(chart.recording.source, chart.recording.id)]: chart });
}

export async function deleteChart(source: RecordingSource, id: string): Promise<void> {
  await chrome.storage.local.remove(chartStorageKey(source, id));
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

/**
 * Stores an auto chart. It becomes the chart in use only when the recording has no
 * chart yet or only an older auto chart; a manual or edited chart is never overwritten
 * here (the panel asks the user first, see adoptAutoChart).
 */
export async function saveAutoChart(chart: Chart): Promise<'main' | 'pending'> {
  const v = validateChart(chart);
  if (!v.ok) throw new Error(v.errors.join('; '));
  const { source, id } = chart.recording;
  await chrome.storage.local.set({ [autoChartKey(source, id)]: chart });
  const existing = await loadChart(source, id);
  if (!existing || existing.provenance.createdBy === 'recognizer') {
    await chrome.storage.local.set({ [chartStorageKey(source, id)]: chart });
    return 'main';
  }
  return 'pending';
}

export async function loadAutoChart(source: RecordingSource, id: string): Promise<Chart | null> {
  const keys = lookupKeys(source, id).map((k) => k.replace(/^chart:/, 'autochart:'));
  const r = await chrome.storage.local.get(keys);
  for (const k of keys) {
    const v = r[k];
    if (v && validateChart(v).ok) return v as Chart;
  }
  return null;
}

/** Replaces the chart in use by the stored auto chart (call only after the user confirmed). */
export async function adoptAutoChart(source: RecordingSource, id: string): Promise<Chart | null> {
  const auto = await loadAutoChart(source, id);
  if (!auto) return null;
  const current = await loadChart(source, id);
  if (current && current.provenance.createdBy !== 'recognizer') {
    // Keep the replaced hand-made chart recoverable.
    await chrome.storage.local.set({ [`chartbackup:${source}:${id}`]: current });
  }
  await chrome.storage.local.set({ [chartStorageKey(source, id)]: { ...auto, recording: { ...auto.recording, source, id } } });
  return auto;
}
