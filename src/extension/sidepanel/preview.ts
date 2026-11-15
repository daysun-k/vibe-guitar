/**
 * Dev-only hidden preview, for testing without the user's browser windows: the built side panel page
 * served over plain http, opened as `sidepanel.html?demo=1&chart=<chart JSON URL>&t=<seconds>`, plays
 * that chart in demo fashion (paused at t, no lyrics, 코드 고치기 in memory, never saved). Only a page
 * served over http(s) takes a preview chart, and only from its own server; the extension path (and the
 * demo without `chart`) is unchanged.
 */
import type { Chart } from '../../chart/types';
import { validateChart } from '../../chart/validate';

export type PreviewResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * URL of the preview chart named by `chart` (relative to the page or absolute), or why it cannot be
 * used; null when the page asks for no preview (no `chart`, or not `demo=1`).
 */
export function previewChartUrl(params: URLSearchParams, pageHref: string): PreviewResult<string> | null {
  const raw = params.get('chart');
  if (raw === null || params.get('demo') !== '1') return null;
  const page = new URL(pageHref);
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return { ok: false, error: '미리보기 코드표는 http로 연 패널에서만 열 수 있어요.' };
  let url: URL;
  try {
    url = new URL(raw, page);
  } catch {
    return { ok: false, error: '미리보기 코드표 주소가 올바르지 않아요.' };
  }
  if (url.origin !== page.origin) return { ok: false, error: '미리보기 코드표는 이 패널과 같은 서버에 있어야 해요.' };
  return { ok: true, value: url.href };
}

/**
 * Fetches the preview chart from `url` (same server, no cookies elsewhere, no redirect) and checks it
 * with the chart validator; errors read like the import's ("형식 오류: …").
 */
export async function loadPreviewChart(url: string, fetcher: typeof fetch = fetch): Promise<PreviewResult<Chart>> {
  let res: Response;
  try {
    res = await fetcher(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  } catch (e) {
    return { ok: false, error: `미리보기 코드표를 받지 못했어요. ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { ok: false, error: `미리보기 코드표를 받지 못했어요 (HTTP ${res.status}).` };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: '형식 오류: JSON이 아니에요' };
  }
  const v = validateChart(data);
  if (!v.ok || !v.chart) return { ok: false, error: `형식 오류: ${v.errors.slice(0, 5).join('; ')}` };
  return { ok: true, value: v.chart };
}

/** The preview chart as a demo choice (the demo select's entry). */
export function previewOption(chart: Chart, key: string): { key: string; label: string; chart: Chart } {
  return { key, label: `${chart.recording.title || chart.recording.id} (미리보기)`, chart };
}
