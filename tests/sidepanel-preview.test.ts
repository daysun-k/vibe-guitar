/**
 * Dev-only hidden preview: `sidepanel.html?demo=1&chart=<URL>&t=<s>` on a page served over http loads
 * that chart (checked by the chart validator) from the same server only; an invalid chart gives the
 * import's "형식 오류: …"; without `chart` (or outside http) nothing is fetched. The preview never
 * touches extension storage (it reads one URL with the given fetch and nothing else).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Chart } from '../src/chart/types';
import { loadPreviewChart, previewChartUrl, previewOption } from '../src/extension/sidepanel/preview';
import { demoChart } from '../src/play/demo';

const PAGE = 'http://127.0.0.1:8765/sidepanel.html';
const q = (s: string) => new URLSearchParams(s);
const reply = (status: number, body: string) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

describe('previewChartUrl', () => {
  it('no chart param, or not demo=1: no preview (the demo is unchanged)', () => {
    expect(previewChartUrl(q('demo=1'), PAGE)).toBeNull();
    expect(previewChartUrl(q('demo=1&t=14'), PAGE)).toBeNull();
    expect(previewChartUrl(q('chart=a.json'), PAGE)).toBeNull();
  });
  it('a relative or absolute URL on the same server', () => {
    expect(previewChartUrl(q('demo=1&chart=charts/a.json&t=14.2'), PAGE)).toEqual({ ok: true, value: 'http://127.0.0.1:8765/charts/a.json' });
    expect(previewChartUrl(q('demo=1&chart=/x/b.json'), 'http://127.0.0.1:8765/dist/sidepanel.html?demo=1')).toEqual({ ok: true, value: 'http://127.0.0.1:8765/x/b.json' });
    expect(previewChartUrl(q(`demo=1&chart=${encodeURIComponent('http://127.0.0.1:8765/c.json')}`), PAGE)).toEqual({ ok: true, value: 'http://127.0.0.1:8765/c.json' });
  });
  it('another server, or a page that is not served over http(s) (the extension), is refused', () => {
    expect(previewChartUrl(q(`demo=1&chart=${encodeURIComponent('http://example.com/c.json')}`), PAGE)).toMatchObject({ ok: false });
    expect(previewChartUrl(q(`demo=1&chart=${encodeURIComponent('http://127.0.0.1:9999/c.json')}`), PAGE)).toMatchObject({ ok: false });
    expect(previewChartUrl(q('demo=1&chart=c.json'), 'chrome-extension://abc/sidepanel.html?demo=1')).toEqual({ ok: false, error: '미리보기 코드표는 http로 연 패널에서만 열 수 있어요.' });
  });
});

describe('loadPreviewChart', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a valid chart loads, fetched once from that URL with same-origin credentials and no redirect', async () => {
    const fetcher = vi.fn(async () => reply(200, JSON.stringify(demoChart())));
    const r = await loadPreviewChart('http://127.0.0.1:8765/charts/a.json', fetcher as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:8765/charts/a.json', { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect((r as { value: Chart }).value.events).toEqual(demoChart().events);
  });
  it('an invalid chart gives the import\'s "형식 오류: …"', async () => {
    const r = await loadPreviewChart('http://h/a.json', (async () => reply(200, '{"schemaVersion":1,"events":"nope"}')) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^형식 오류: /);
  });
  it('not JSON, an HTTP error or a failed fetch are errors too', async () => {
    expect(await loadPreviewChart('http://h/a.json', (async () => reply(200, '<html>')) as unknown as typeof fetch)).toEqual({ ok: false, error: '형식 오류: JSON이 아니에요' });
    expect(await loadPreviewChart('http://h/a.json', (async () => reply(404, 'no')) as unknown as typeof fetch)).toEqual({ ok: false, error: '미리보기 코드표를 받지 못했어요 (HTTP 404).' });
    const failed = await loadPreviewChart('http://h/a.json', (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    expect(failed).toEqual({ ok: false, error: '미리보기 코드표를 받지 못했어요. Failed to fetch' });
  });
  it('touches no storage: chrome and web storage are not used', async () => {
    const boom = () => {
      throw new Error('storage touched');
    };
    vi.stubGlobal('chrome', new Proxy({}, { get: boom }));
    vi.stubGlobal('localStorage', new Proxy({}, { get: boom }));
    vi.stubGlobal('sessionStorage', new Proxy({}, { get: boom }));
    const r = await loadPreviewChart('http://h/a.json', (async () => reply(200, JSON.stringify(demoChart()))) as unknown as typeof fetch);
    expect(r.ok).toBe(true);
  });
});

describe('previewOption', () => {
  it('the demo choice names the song as a preview', () => {
    const c = demoChart();
    expect(previewOption(c, 'preview:k')).toEqual({ key: 'preview:k', label: `${c.recording.title} (미리보기)`, chart: c });
  });
});
