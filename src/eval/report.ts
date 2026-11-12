/**
 * Accuracy report (VGT-7): turns one or more "결과 내보내기" files of the accuracy overview
 * into one self-contained HTML page (inline CSS and SVG, no scripts, no external requests).
 * Pure functions; scripts/accuracy-report.mjs reads the files and writes the page.
 *
 * Totals reuse overviewFromRows/accuracyTotals and the sync suggestion reuses the panel's
 * syncOffsetHint, so the numbers match the panel for the same rows.
 */
import type { RecordingSource } from '../chart/types';
import { escapeHtml } from '../extension/sidepanel/diagram';
import { SYNC_HINT_MIN_CHANGES, syncOffsetHint } from '../extension/sidepanel/overview';
import type { WcsrResult } from './metrics';
import { overviewFromRows, type AccuracyOverview, type AccuracyRow, type AccuracyTotals, type ChangeTiming } from './overview';

export const EXPORT_FORMAT = 'vibe-guitar-accuracy-overview';
/** Below this many matched chord changes the suggested offset is labelled as a rough first estimate. */
export const REPORT_CONFIDENT_CHANGES = 20;

const SOURCES: readonly RecordingSource[] = ['youtube', 'ytmusic', 'applemusic'];

export class ReportInputError extends Error {}

export interface ParsedExport {
  name: string;
  exportedAt: string;
  changeWindowSec: number;
  rows: AccuracyRow[];
  /** The file's own pooled timing over hand-made references (exact: computed from every matched change). */
  manualTiming: ChangeTiming | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isCount = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
/** More chord changes than any real song (one every 0.1 s for over 2 hours): larger counts are not an export. */
export const MAX_CHANGES = 100_000;

function notExport(name: string, why: string): ReportInputError {
  return new ReportInputError(`${name}: 정확도 모아 보기의 "결과 내보내기" 파일이 아니에요 (${why}).`);
}

function wcsrFrom(v: unknown, name: string, where: string): WcsrResult {
  if (!isObj(v) || !(v.score === null || (isNum(v.score) && v.score >= 0 && v.score <= 1)) || !(isNum(v.evaluatedSec) && v.evaluatedSec >= 0))
    throw notExport(name, `${where} 값이 올바르지 않아요 (score는 0~1 또는 null, evaluatedSec는 0 이상이어야 해요)`);
  return { score: v.score === null ? NaN : v.score, evaluatedSec: v.evaluatedSec };
}

function timingFrom(v: unknown, name: string, where: string): ChangeTiming | null {
  if (v === null) return null;
  if (!isObj(v) || !(v.medianOffsetMs === null || isNum(v.medianOffsetMs)) || !isCount(v.matched) || !isCount(v.unmatched) || v.matched + v.unmatched > MAX_CHANGES)
    throw notExport(name, `${where} timing 값이 올바르지 않아요 (matched와 unmatched는 0 이상의 정수, 합계 ${MAX_CHANGES}개 이하여야 해요)`);
  return { medianMs: v.medianOffsetMs === null ? NaN : v.medianOffsetMs, matched: v.matched, unmatched: v.unmatched };
}

/**
 * The export keeps each song's median, not every offset. The song's median repeated once per
 * matched change stands in for its offsets, so pooling several songs gives a median of the
 * song medians weighted by matched changes (exact for one song).
 */
function standInOffsets(t: ChangeTiming | null): number[] {
  return t && t.matched > 0 && Number.isFinite(t.medianMs) ? new Array<number>(t.matched).fill(t.medianMs) : [];
}

function rowFrom(v: unknown, name: string, i: number): AccuracyRow {
  const where = `${i + 1}번째 곡`;
  if (!isObj(v)) throw notExport(name, `${where}이 객체가 아니에요`);
  if (!SOURCES.includes(v.source as RecordingSource)) throw notExport(name, `${where}의 source를 알 수 없어요`);
  if (typeof v.id !== 'string' || !v.id) throw notExport(name, `${where}에 id가 없어요`);
  if (v.referenceKind !== 'manual' && v.referenceKind !== 'edited') throw notExport(name, `${where}의 referenceKind가 올바르지 않아요`);
  if (v.referenceFrom !== 'main' && v.referenceFrom !== 'backup') throw notExport(name, `${where}의 referenceFrom이 올바르지 않아요`);
  if (!isCount(v.manualEvents) || !isCount(v.events) || v.manualEvents > v.events || !(isNum(v.overlapSec) && v.overlapSec >= 0))
    throw notExport(name, `${where}의 숫자 값이 올바르지 않아요`);
  // Validated for every row; an edited reference's timing is then dropped (its times are the auto chart's).
  const parsedTiming = timingFrom(v.timing, name, where);
  const timing = v.referenceKind === 'manual' ? parsedTiming : null;
  // Only known fields are copied: anything else in the file (it has no lyrics or audio) is dropped.
  return {
    source: v.source as RecordingSource,
    id: v.id,
    title: typeof v.title === 'string' ? v.title : '',
    artist: typeof v.artist === 'string' ? v.artist : '',
    referenceKind: v.referenceKind,
    referenceFrom: v.referenceFrom,
    manualEvents: v.manualEvents,
    events: v.events,
    comparison: {
      overlapSec: v.overlapSec,
      majmin: wcsrFrom(v.majmin, name, `${where}의 majmin`),
      root: wcsrFrom(v.root, name, `${where}의 root`),
      sevenths: wcsrFrom(v.sevenths, name, `${where}의 sevenths`),
    },
    timing,
    offsetsMs: standInOffsets(timing),
  };
}

/** Validates one parsed JSON value as an accuracy overview export (format version 1). */
export function parseAccuracyExport(value: unknown, name: string): ParsedExport {
  if (!isObj(value)) throw notExport(name, 'JSON 객체가 아니에요');
  if (value.format !== EXPORT_FORMAT) throw notExport(name, `format이 "${EXPORT_FORMAT}"가 아니에요`);
  if (value.version !== 1) throw notExport(name, `지원하지 않는 version ${JSON.stringify(value.version)}`);
  if (typeof value.exportedAt !== 'string' || Number.isNaN(Date.parse(value.exportedAt))) throw notExport(name, 'exportedAt 날짜가 없어요');
  if (value.changeWindowSec === undefined || value.changeWindowSec === null) throw notExport(name, 'changeWindowSec가 없어요');
  // Normal exports always carry a finite window >= 0; a hand-edited file may not.
  if (!isNum(value.changeWindowSec) || value.changeWindowSec < 0) throw notExport(name, 'changeWindowSec 값이 올바르지 않아요 (0 이상의 숫자여야 해요)');
  if (!Array.isArray(value.rows)) throw notExport(name, 'rows 목록이 없어요');
  const rows = value.rows.map((r, i) => rowFrom(r, name, i));
  const totals = value.totals;
  const manual = isObj(totals) && isObj(totals.manual) ? totals.manual : null;
  if (!manual) throw notExport(name, 'totals.manual이 없어요');
  return {
    name,
    exportedAt: value.exportedAt,
    changeWindowSec: value.changeWindowSec,
    rows,
    manualTiming: timingFrom(manual.timing, name, 'totals.manual'),
  };
}

export const recordingKey = (r: { source: RecordingSource; id: string }) => `${r.source}:${r.id}`;

export interface MergedAccuracy {
  overview: AccuracyOverview;
  inputs: { name: string; exportedAt: string; songs: number }[];
  /** Songs that appeared in more than one file (the latest export was kept). */
  duplicates: number;
  /** True when the timing totals are the file's own exact pooled median; false for the weighted song-median estimate. */
  timingExact: boolean;
  changeWindowsSec: number[];
}

/**
 * Merges exports by recording (source:id); for a song in several files the latest exportedAt
 * wins (a tie keeps the later file in argument order). Totals are recomputed with overview.ts.
 */
export function mergeExports(exports: ParsedExport[]): MergedAccuracy {
  if (!exports.length) throw new ReportInputError('입력 파일이 없어요.');
  const order = exports.map((e, i) => ({ e, i })).sort((a, b) => Date.parse(a.e.exportedAt) - Date.parse(b.e.exportedAt) || a.i - b.i);
  const byKey = new Map<string, { row: AccuracyRow; from: ParsedExport }>();
  let seen = 0;
  for (const { e } of order)
    for (const row of e.rows) {
      seen++;
      byKey.set(recordingKey(row), { row, from: e });
    }
  const kept = [...byKey.values()];
  const overview = overviewFromRows(kept.map((k) => k.row));
  // One file contributing every row (nothing replaced): its own pooled median is exact, use it.
  const only = kept.length ? kept[0].from : null;
  const fromOneFile = !!only && kept.every((k) => k.from === only) && kept.length === only.rows.length;
  if (fromOneFile && only && overview.totals.manual.timing) {
    overview.totals.manual.timing = only.manualTiming;
    overview.totals.all.timing = only.manualTiming;
  }
  return {
    overview,
    inputs: exports.map((e) => ({ name: e.name, exportedAt: e.exportedAt, songs: e.rows.length })),
    duplicates: seen - kept.length,
    timingExact: fromOneFile || countTimedSongs(overview.rows) <= 1,
    changeWindowsSec: [...new Set(exports.map((e) => e.changeWindowSec))].sort((a, b) => a - b),
  };
}

const countTimedSongs = (rows: AccuracyRow[]) => rows.filter((r) => r.timing && r.timing.matched > 0).length;

export type SyncAdviceLevel = 'none' | 'rough' | 'ok';

export interface SyncAdvice {
  level: SyncAdviceLevel;
  /** The value for 설정 → 싱크 보정 (same rule as the panel: 10 ms steps, ±500 ms); null when level is 'none'. */
  offsetMs: number | null;
  medianMs: number | null;
  matched: number;
}

/** Suggested 싱크 보정 value from hand-made references only (edited references carry no timing). */
export function syncAdvice(manual: AccuracyTotals): SyncAdvice {
  const t = manual.timing;
  const matched = t?.matched ?? 0;
  const medianMs = t && Number.isFinite(t.medianMs) ? t.medianMs : null;
  const offsetMs = syncOffsetHint(manual);
  const level: SyncAdviceLevel = offsetMs === null ? 'none' : matched < REPORT_CONFIDENT_CHANGES ? 'rough' : 'ok';
  return { level, offsetMs, medianMs, matched };
}

// ---------------------------------------------------------------- HTML

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const signed = (ms: number) => `${ms > 0 ? '+' : ''}${Math.round(ms)}`;

/** "3분 20초", "45초", "1시간 2분". */
export function durationKo(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h) return `${h}시간${m ? ` ${m}분` : ''}`;
  return `${m}분${r ? ` ${r}초` : ''}`;
}

const songName = (r: AccuracyRow) => r.title || `${r.source} ${r.id}`;

function shorten(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** Horizontal bar with a 4 px rounded data end, anchored at x. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w, h / 2);
  if (w <= 0) return '';
  return `M${x} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x}Z`;
}

/** Per-song 장·단 accuracy, one bar each (single series: no legend, the heading names it). */
export function barChartSvg(rows: AccuracyRow[]): string {
  const W = 340;
  const labelW = 118;
  const valueW = 40;
  const plotW = W - labelW - valueW;
  const rowH = 26;
  const barH = 14;
  const top = 6;
  const axisH = 20;
  const H = top + rows.length * rowH + axisH;
  const parts: string[] = [];
  for (const g of [0, 0.5, 1]) {
    const x = labelW + g * plotW;
    parts.push(`<line class="grid" x1="${x}" y1="${top}" x2="${x}" y2="${top + rows.length * rowH}"/>`);
    parts.push(`<text class="axis" x="${x}" y="${H - 6}" text-anchor="middle">${g * 100}%</text>`);
  }
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const s = r.comparison.majmin.score;
    const label = escapeHtml(shorten(songName(r), 9));
    parts.push(`<text class="label" x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end">${label}</text>`);
    const by = y + (rowH - barH) / 2;
    if (Number.isFinite(s)) {
      const w = Math.max(0, Math.min(1, s)) * plotW;
      const tip = `${escapeHtml(songName(r))}: 장·단 ${pct(s)}, 근음 ${pct(r.comparison.root.score)}, 7th 포함 ${pct(r.comparison.sevenths.score)}`;
      parts.push(`<g><title>${tip}</title><rect class="hit" x="${labelW}" y="${y}" width="${plotW}" height="${rowH}"/>${w > 0 ? `<path class="bar${r.referenceKind === 'edited' ? ' edited' : ''}" d="${barPath(labelW, by, w, barH)}"/>` : ''}</g>`);
    }
    parts.push(`<text class="value" x="${labelW + plotW + 6}" y="${y + rowH / 2 + 4}">${pct(s)}</text>`);
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="곡별 장·단 코드 정확도 막대그래프">${parts.join('')}</svg>`;
}

function tile(label: string, w: WcsrResult, help: string): string {
  return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-num">${pct(w.score)}</div><div class="tile-sub">비교한 시간 ${durationKo(w.evaluatedSec)}</div><div class="tile-help">${help}</div></div>`;
}

function timingCell(r: AccuracyRow): string {
  if (r.referenceKind === 'edited') return '<span class="muted">재지 않음 (고친 코드표)</span>';
  const t = r.timing;
  if (!t || !t.matched || !Number.isFinite(t.medianMs)) return '<span class="muted">맞춘 변화 없음</span>';
  const dir = Math.abs(t.medianMs) < 0.5 ? '거의 같음' : t.medianMs > 0 ? '자동이 늦음' : '자동이 빠름';
  return `<span>${signed(t.medianMs)} ms · ${dir}<br><span class="muted small">맞춘 변화 ${t.matched}개 · 못 맞춘 ${t.unmatched}개</span></span>`;
}

function songTable(rows: AccuracyRow[]): string {
  const body = rows
    .map((r) => {
      const kind = r.referenceKind === 'manual' ? '직접 만든 코드표' : `고친 코드표 (직접 고친 코드 ${r.manualEvents}/${r.events}개)`;
      const name = `<b>${escapeHtml(songName(r))}</b>${r.artist ? `<br><span class="muted">${escapeHtml(r.artist)}</span>` : ''}`;
      const c = r.comparison;
      return `<tr><td data-label="곡" class="song">${name}</td><td data-label="기준 코드표">${kind}</td><td data-label="겹친 시간">${durationKo(c.overlapSec)}</td><td data-label="장·단" class="num">${pct(c.majmin.score)}</td><td data-label="근음" class="num">${pct(c.root.score)}</td><td data-label="7th 포함" class="num">${pct(c.sevenths.score)}</td><td data-label="바뀌는 시점">${timingCell(r)}</td></tr>`;
    })
    .join('');
  return `<table class="songs"><thead><tr><th>곡</th><th>기준 코드표</th><th>겹친 시간</th><th>장·단</th><th>근음</th><th>7th 포함</th><th>바뀌는 시점</th></tr></thead><tbody>${body}</tbody></table>`;
}

function syncSection(a: SyncAdvice, timingExact: boolean): string {
  const where = '확장 프로그램 패널의 <b>설정</b> 탭 → <b>싱크 보정</b> 카드 → <b>오프셋</b> 슬라이더';
  const parts = ['<h2>추천 싱크 오프셋</h2>'];
  if (a.level === 'none' || a.offsetMs === null) {
    parts.push(
      `<p>아직 추천할 수 없어요. 직접 만든 코드표에서 자동 코드표와 맞춘 코드 변화가 ${a.matched}개라서, 최소 ${SYNC_HINT_MIN_CHANGES}개가 필요해요. 직접 만든 코드표가 있는 곡을 듣기 모드로 더 들려 주세요.</p>`,
    );
    return `<section class="card">${parts.join('')}</section>`;
  }
  parts.push(`<div class="big-offset">${signed(a.offsetMs)} ms</div>`);
  parts.push(`<p>${where}를 <b>${signed(a.offsetMs)} ms</b> 근처로 맞춰 보세요. 자동 코드표로 연주할 때 코드가 바뀌는 순간이 실제 소리에 더 가까워져요.</p>`);
  const dir = (a.medianMs ?? 0) > 0 ? '자동 코드표가 실제보다 늦게 바뀌어요. 그래서 양수(코드를 일찍 바꾸기)를 추천해요.' : (a.medianMs ?? 0) < 0 ? '자동 코드표가 실제보다 일찍 바뀌어요. 그래서 음수(코드를 늦게 바꾸기)를 추천해요.' : '자동 코드표와 직접 만든 코드표가 거의 같은 순간에 바뀌어요.';
  parts.push(`<p>근거: 직접 만든 코드표의 코드 변화 <b>${a.matched}개</b>를 자동 코드표와 맞춰 본 중앙값 ${signed(a.medianMs ?? 0)} ms. ${dir}</p>`);
  if (a.level === 'rough')
    parts.push(`<p class="note">맞춘 변화가 ${REPORT_CONFIDENT_CHANGES}개보다 적어서 아직 대략적인 값이에요. 곡을 더 모으면 값이 달라질 수 있으니, 연주하면서 귀로 확인해 주세요.</p>`);
  if (!timingExact)
    parts.push('<p class="muted small">여러 파일을 합쳤기 때문에, 이 중앙값은 곡별 중앙값을 맞춘 변화 수만큼 가중해서 구한 추정값이에요.</p>');
  parts.push('<p class="muted small">고친 코드표는 시간이 자동 코드표 그대로라서 이 계산에 넣지 않았어요. 값은 패널처럼 10 ms 단위로 반올림하고 −500~+500 ms 안으로 맞췄어요. 자동으로 바뀌지는 않아요.</p>');
  return `<section class="card">${parts.join('')}</section>`;
}

/** Plain-language reading of the totals for a beginner. */
/** editedInHeadline: the headline is the edited charts themselves (no hand-made chart in the report). */
export function meaningNotes(t: AccuracyTotals, editedSongs: number, editedInHeadline = false): string[] {
  const notes: string[] = [];
  const mm = t.majmin.score;
  const root = t.root.score;
  const sev = t.sevenths.score;
  if (Number.isFinite(mm)) {
    if (mm >= 0.8) notes.push(`장·단 정확도가 ${pct(mm)}예요. 자동 코드표를 그대로 따라 쳐도 대부분 맞는 코드예요.`);
    else if (mm >= 0.6) notes.push(`장·단 정확도가 ${pct(mm)}예요. 대체로 맞지만, 몇 마디마다 틀린 코드가 섞여 있을 수 있어요. 어색하게 들리는 곳은 코드 고치기로 바로잡아 주세요.`);
    else notes.push(`장·단 정확도가 ${pct(mm)}예요. 틀린 곳이 꽤 많아서, 자동 코드표는 참고용으로 보고 귀로 확인하면서 쳐 주세요.`);
  }
  if (Number.isFinite(mm) && Number.isFinite(root)) {
    if (root - mm >= 0.1)
      notes.push(`근음 정확도(${pct(root)})가 장·단(${pct(mm)})보다 높아요. 코드의 뿌리음(C, G처럼 이름 첫 글자)은 대체로 맞게 듣지만, 메이저인지 마이너인지(예: C와 Cm)를 자주 헷갈린다는 뜻이에요. 이름에 m이 붙거나 빠진 곳을 귀로 한 번 더 확인해 보세요.`);
    else notes.push(`근음과 장·단 정확도가 비슷해요(${pct(root)}, ${pct(mm)}). 틀릴 때는 메이저·마이너보다 뿌리음 자체를 다르게 들은 경우가 많다는 뜻이에요.`);
  }
  if (Number.isFinite(mm) && Number.isFinite(sev) && mm - sev >= 0.1)
    notes.push(`7th 포함 정확도(${pct(sev)})가 더 낮아요. G7, Am7 같은 7th 코드까지 정확히 맞히기는 아직 어렵다는 뜻이에요. 처음에는 7을 빼고 기본 코드(G, Am)로 쳐도 크게 어색하지 않아요.`);
  const tm = t.timing;
  if (tm && tm.matched > 0 && Number.isFinite(tm.medianMs)) {
    const ms = Math.round(tm.medianMs);
    if (Math.abs(ms) < 50) notes.push(`코드가 바뀌는 시점은 자동 코드표와 직접 만든 코드표가 거의 같아요(중앙값 ${signed(ms)} ms).`);
    else notes.push(`자동 코드표가 코드를 보통 ${Math.abs(ms)} ms ${ms > 0 ? '늦게' : '일찍'} 바꿔요. 위의 추천 싱크 오프셋으로 맞출 수 있어요.`);
  }
  if (editedSongs && editedInHeadline)
    notes.push(`위의 큰 숫자는 고친 코드표 ${editedSongs}곡으로만 계산했어요. 고친 코드표는 손대지 않은 코드와 시간이 자동 코드표 그대로라서 일치율이 실제보다 높게 나와요. 직접 만든 코드표가 있는 곡을 더하면 더 믿을 수 있는 숫자가 나와요.`);
  else if (editedSongs)
    notes.push(`고친 코드표 ${editedSongs}곡은 손대지 않은 코드와 시간이 자동 코드표 그대로라서 일치율이 실제보다 높게 나와요. 그래서 위의 큰 숫자에는 넣지 않고 따로 보여 드려요.`);
  return notes;
}

const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f4;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--bar:#2a78d6;--bar2:#9ec5f4;--note:#fff6e0;--note-ink:#5c4400}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--line:#2c2c2a;--bar:#3987e5;--bar2:#1c5cab;--note:#3a2f12;--note-ink:#f3dfa8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:8px 0 4px}
h2{font-size:1.1rem;margin:0 0 8px}
p{margin:6px 0}
.muted{color:var(--muted)}.small{font-size:.85rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px}
.tile-label{color:var(--ink2);font-size:.9rem}
.tile-num{font-size:2rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
.tile-sub{color:var(--ink2);font-size:.85rem}
.tile-help{color:var(--muted);font-size:.8rem;margin-top:4px}
.big-offset{font-size:2.2rem;font-weight:700;font-variant-numeric:tabular-nums}
.note{background:var(--note);color:var(--note-ink);border-radius:8px;padding:8px 10px}
.chart{display:block;max-width:560px;height:auto}
.chart .grid{stroke:var(--line);stroke-width:1}
.chart .axis{fill:var(--muted);font-size:10px}
.chart .label{fill:var(--ink2);font-size:12px}
.chart .value{fill:var(--ink);font-size:12px;font-variant-numeric:tabular-nums}
.chart .bar{fill:var(--bar)}.chart .bar.edited{fill:var(--bar2)}
.chart .hit{fill:transparent}
table.songs{width:100%;border-collapse:collapse;font-size:.92rem}
table.songs th,table.songs td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
table.songs th{color:var(--ink2);font-weight:600}
table.songs td.num{font-variant-numeric:tabular-nums}
ul.notes{padding-left:1.2em;margin:6px 0}ul.notes li{margin:6px 0}
dl.glossary{margin:6px 0}dl.glossary dt{font-weight:600;margin-top:8px}dl.glossary dd{margin:0;color:var(--ink2)}
@media (max-width:640px){
 main{padding:12px}
 table.songs thead{display:none}
 table.songs,table.songs tbody,table.songs tr,table.songs td{display:block;width:100%}
 table.songs tr{border:1px solid var(--line);border-radius:10px;padding:6px 10px;margin:0 0 10px}
 table.songs td{display:flex;gap:10px;justify-content:space-between;border:0;padding:4px 0;text-align:right}
 table.songs td::before{content:attr(data-label);color:var(--ink2);text-align:left;flex:none}
 table.songs td.song{display:block;text-align:left;border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:2px}
 table.songs td.song::before{content:none}
}
`;

export interface ReportOptions {
  generatedAt: Date;
}

/** The whole report: one HTML document with inline CSS and SVG, no scripts and no external references. */
export function renderAccuracyReport(m: MergedAccuracy, opts: ReportOptions): string {
  const o = m.overview;
  const manual = o.totals.manual;
  const headline = manual.songs ? manual : o.totals.all;
  const headlineLabel = manual.songs ? `직접 만든 코드표 ${manual.songs}곡 기준` : `고친 코드표 ${o.totals.edited.songs}곡 기준 (직접 만든 코드표가 없어서 고친 코드표로 계산했어요. 실제보다 높게 나와요)`;
  const rows = [...o.rows].sort((a, b) => (a.referenceKind === b.referenceKind ? 0 : a.referenceKind === 'manual' ? -1 : 1));
  const date = (iso: string) => escapeHtml(iso.slice(0, 10));
  const parts: string[] = [];
  parts.push('<h1>Vibe Guitar 정확도 보고서</h1>');
  parts.push(
    `<p class="muted small">만든 날짜 ${escapeHtml(opts.generatedAt.toISOString().slice(0, 10))} · 파일 ${m.inputs.length}개 · 곡 ${o.rows.length}개${m.duplicates ? ` · 여러 파일에 있던 곡 ${m.duplicates}개는 가장 최근 파일 값을 썼어요` : ''}</p>`,
  );
  parts.push('<p class="small">자동 코드표가 직접 만든 코드표와 얼마나 같은지 정리한 보고서예요. 가사나 소리는 들어 있지 않아요.</p>');

  if (!o.rows.length) {
    parts.push('<section class="card"><p>비교할 곡이 없어요. 직접 만들거나 고친 코드표가 있는 곡을 듣기 모드로 끝까지 들려 준 뒤, 정확도 모아 보기에서 다시 내보내 주세요.</p></section>');
  } else {
    parts.push(
      `<section class="card"><h2>한눈에 보기</h2><p class="muted small">${headlineLabel}. 각 숫자는 곡 길이(비교한 시간)만큼 가중한 평균이에요.</p><div class="tiles">${[
        tile('장·단 코드 이름', headline.majmin, '메이저·마이너까지 맞은 비율'),
        tile('근음', headline.root, '코드 뿌리음만 맞은 비율'),
        tile('7th 포함', headline.sevenths, '7th 코드까지 맞은 비율'),
      ].join('')}</div>${
        manual.songs && o.totals.edited.songs
          ? `<p class="small muted">고친 코드표 ${o.totals.edited.songs}곡: 장·단 ${pct(o.totals.edited.majmin.score)} · 근음 ${pct(o.totals.edited.root.score)} · 7th 포함 ${pct(o.totals.edited.sevenths.score)} (실제보다 높게 나와요)</p>`
          : ''
      }</section>`,
    );
    parts.push(syncSection(syncAdvice(manual), m.timingExact));
    parts.push(
      `<section class="card"><h2>곡별 장·단 정확도</h2>${barChartSvg(rows)}${o.totals.edited.songs ? '<p class="muted small">연한 막대는 고친 코드표예요(실제보다 높게 나와요).</p>' : ''}</section>`,
    );
    parts.push(`<section class="card"><h2>곡별 결과</h2>${songTable(rows)}<p class="muted small">바뀌는 시점: 자동 코드표가 코드를 바꾼 순간 − 직접 만든 코드표가 바꾼 순간의 중앙값. 양수면 자동이 늦어요.</p></section>`);
    parts.push(`<section class="card"><h2>이 숫자가 뜻하는 것</h2><ul class="notes">${meaningNotes(headline, o.totals.edited.songs, !manual.songs).map((n) => `<li>${n}</li>`).join('')}</ul></section>`);
  }
  parts.push(
    `<section class="card small"><h2>용어와 계산 방법</h2><dl class="glossary"><dt>장·단 코드 이름</dt><dd>C와 Cm처럼 메이저·마이너까지 맞아야 맞은 것으로 쳐요. 연주에 가장 중요한 숫자예요.</dd><dt>근음</dt><dd>코드의 뿌리음(C, G, A …)만 맞으면 맞은 것으로 쳐요.</dd><dt>7th 포함</dt><dd>G7, Am7 같은 7th까지 구분해서 맞아야 맞은 것으로 쳐요.</dd><dt>비교한 시간</dt><dd>두 코드표가 모두 코드를 적어 둔 시간이에요. 길수록 숫자를 더 믿을 수 있어요.</dd></dl><p class="muted">입력 파일: ${m.inputs.map((i) => `${escapeHtml(i.name)} (${date(i.exportedAt)}, ${i.songs}곡)`).join(', ')}. 코드 변화 맞춤 범위 ±${m.changeWindowsSec.map((s) => escapeHtml(String(s))).join(' / ')}초.${m.changeWindowsSec.length > 1 ? ' 파일마다 맞춤 범위가 달라서 바뀌는 시점은 비교하기 어려울 수 있어요.' : ''}</p></section>`,
  );
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Guitar 정확도 보고서</title><style>${CSS}</style></head><body><main>${parts.join('\n')}</main></body></html>\n`;
}
