/** HTML for the 듣기·캡처 tab's accuracy overview (pure; the panel loads storage and wires the buttons). */
import type { AccuracyOverview, AccuracyRow, AccuracyTotals, ChangeTiming } from '../../eval/overview';
import { escapeHtml } from './diagram';
import { formatTime } from './play';

export const OVERVIEW_EMPTY = '직접 만들거나 고친 코드표가 있는 곡을 듣기 모드로 끝까지 들려 주시면, 여기에 정확도가 쌓여요.';

/** Fewest matched chord changes before the overview suggests a sync offset. */
export const SYNC_HINT_MIN_CHANGES = 5;

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const signedMs = (ms: number) => `${ms > 0 ? '+' : ''}${Math.round(ms)}ms`;

function scores(c: { overlapSec: number; majmin: { score: number }; root: { score: number }; sevenths: { score: number } }): string {
  return `겹친 ${formatTime(c.overlapSec)} · 장·단 ${pct(c.majmin.score)} · 근음 ${pct(c.root.score)} · 7th 포함 ${pct(c.sevenths.score)}`;
}

function timingText(t: ChangeTiming): string {
  if (!t.matched) return `코드 바뀌는 시점: 맞출 수 있는 변화가 없어요${t.unmatched ? ` (못 맞춘 ${t.unmatched}개)` : ''}`;
  const dir = Math.abs(t.medianMs) < 0.5 ? '거의 같아요' : t.medianMs > 0 ? '자동이 늦게 바뀌어요' : '자동이 일찍 바뀌어요';
  return `코드 바뀌는 시점: ${signedMs(t.medianMs)}, ${dir} (중앙값, 맞춘 변화 ${t.matched}개 · 못 맞춘 ${t.unmatched}개)`;
}

/**
 * Suggested 싱크 오프셋 for playing auto charts, from hand-made references only (an edited
 * chart keeps the auto chart's times). Positive offset = chords earlier, so an auto chart
 * that changes late needs a positive offset. Rounded to the slider's 10 ms step and range.
 */
export function syncOffsetHint(manual: AccuracyTotals): number | null {
  const t = manual.timing;
  if (!t || t.matched < SYNC_HINT_MIN_CHANGES || !Number.isFinite(t.medianMs)) return null;
  return Math.max(-500, Math.min(500, Math.round(t.medianMs / 10) * 10));
}

function rowHtml(r: AccuracyRow): string {
  const name = r.title ? `<b>${escapeHtml(r.title)}</b>${r.artist ? ` — ${escapeHtml(r.artist)}` : ''}` : `<b>${escapeHtml(`${r.source} ${r.id}`)}</b>`;
  const kind = r.referenceKind === 'manual' ? '직접 만든 코드표' : `고친 코드표(직접 고친 코드 ${r.manualEvents}/${r.events}개)`;
  const from = r.referenceFrom === 'backup' ? ' <span class="pill">자동으로 바꾸기 전 코드표</span>' : '';
  const lines = [`${name} <span class="pill">${kind}</span>${from}`];
  if (r.comparison.overlapSec <= 0) lines.push('<span class="muted">두 코드표가 겹치는 구간이 없어요.</span>');
  else {
    lines.push(`<span class="num">${scores(r.comparison)}</span>`);
    if (r.timing) lines.push(`<span class="num">${timingText(r.timing)}</span>`);
  }
  return `<li>${lines.join('<br>')}</li>`;
}

function totalsHtml(label: string, t: AccuracyTotals): string {
  const lines = [`<b>${label} ${t.songs}곡</b>`, `<span class="num">${scores(t)}</span>`];
  if (t.timing) lines.push(`<span class="num">${timingText(t.timing)}</span>`);
  return `<div class="ov-total">${lines.join('<br>')}</div>`;
}

export function renderOverviewHtml(o: AccuracyOverview): string {
  if (!o.rows.length) return `<p class="muted">${OVERVIEW_EMPTY}</p>`;
  const parts: string[] = [];
  if (o.totals.manual.songs) parts.push(totalsHtml('직접 만든 코드표', o.totals.manual));
  const hint = syncOffsetHint(o.totals.manual);
  if (hint !== null)
    parts.push(`<p class="muted">추정값: 자동 코드표로 연주할 때 설정 탭의 싱크 오프셋을 ${hint > 0 ? '+' : ''}${hint} ms 근처로 맞춰 보세요. 자동으로 바꾸지는 않아요.</p>`);
  if (o.totals.edited.songs) {
    parts.push(totalsHtml('고친 코드표(일부만 직접 확인)', o.totals.edited));
    parts.push('<p class="muted">고친 코드표는 손대지 않은 코드와 시간이 자동 코드표 그대로라서 일치율이 높게 나오고, 바뀌는 시점은 재지 않아요. 그래서 따로 모아요.</p>');
  }
  const rows = [...o.rows].sort((a, b) => (a.referenceKind === b.referenceKind ? 0 : a.referenceKind === 'manual' ? -1 : 1));
  parts.push(`<ul class="ov-list">${rows.map(rowHtml).join('')}</ul>`);
  return parts.join('');
}
