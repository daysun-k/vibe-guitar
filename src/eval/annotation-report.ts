/**
 * Self-contained Korean HTML report for the public-annotation evaluation (inline CSS, no
 * scripts, phone-friendly), in the style of the accuracy overview report.
 */
import { escapeHtml } from '../extension/sidepanel/diagram';
import type { EvalResult, ExclusionCode, GroupTotals, SongResult } from './annotations';
import type { SongMeanAnalysis } from './song-mean';
import { durationKo } from './report';

const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const pct1 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '–');
const pp1 = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%p` : '–');
const ms = (x: number) => (Number.isFinite(x) ? `${x > 0 ? '+' : ''}${Math.round(x)}` : '–');
const sec1 = (x: number) => `${x.toFixed(1)}초`;
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(1).padStart(4, '0')}`;

const STATUS_KO: Record<SongResult['status'], string> = {
  scored: '채점함',
  excluded: '제외',
  missing: '아직 없음',
  error: '오류',
};

const REASON_KO: Record<ExclusionCode, string> = {
  'no-estimate-beats': '자동 코드표에 박자 시각이 거의 없어요',
  'too-few-landmarks': '정렬에 쓸 기준점이 너무 적어요',
  'duration-mismatch': '업로드 길이가 주석의 음원 길이와 2초 넘게 달라요(다른 버전일 가능성)',
  'landmarks-disagree': '주석의 기준점이 자동 박자와 잘 맞지 않아요',
  drift: '곡의 앞·중간·끝에서 맞춘 시차가 속도 보정 뒤에도 0.1초 넘게 달라요(속도나 편집 차이)',
  ambiguous: '1박 또는 1마디 차이 후보 가운데 시차를 하나로 정할 수 없어요(0초 근처 후보와 마디 위치가 서로 다른 시차를 가리키는 경우 포함)',
};

function groupTiles(title: string, t: GroupTotals, help: string): string {
  const tile = (label: string, w: { score: number; evaluatedSec: number }, mean: number) =>
    `<div class="tile"><div class="tile-label">${label}</div><div class="tile-num">${pct(w.score)}</div><div class="tile-sub">곡 평균 ${pct(mean)} · ${durationKo(w.evaluatedSec)}</div></div>`;
  return `<section class="card"><h2>${escapeHtml(title)}</h2><p class="muted small">${escapeHtml(help)} 채점한 곡 ${t.songs}개.</p><div class="tiles">${tile('장·단 코드 이름', t.majmin, t.songMean.majmin)}${tile('근음', t.root, t.songMean.root)}${tile('7th 포함', t.sevenths, t.songMean.sevenths)}</div></section>`;
}

const COMPLEXITY_KO: Record<string, string> = { simple: '단순', moderate: '보통', complex: '복잡' };

/** The predeclared primary analysis (VGT-7, PR #31): song mean, bootstrap interval, sensitivity. */
function analysisSection(a: SongMeanAnalysis): string {
  const c = a.counts;
  const b = a.bootstrap;
  const codes = Object.entries(c.excludedByCode)
    .map(([k, n]) => `${REASON_KO[k as ExclusionCode] ?? k} ${n}`)
    .join(', ');
  const t = a.tInterval ? `${pct1(a.tInterval.lower)} ~ ${pct1(a.tInterval.upper)} (자유도 ${a.tInterval.df})` : '곡이 2개보다 적어서 계산하지 않았어요';
  const comp = Object.entries(a.composition.complexity)
    .map(([k, n]) => `${COMPLEXITY_KO[k] ?? k} ${n}`)
    .join(', ');
  const repeated = a.composition.repeatedArtists.map((r) => `${escapeHtml(r.artist)} ${r.songs}곡`).join(', ');
  const L = a.composition.lengthSec;
  const len = Number.isFinite(L.median) ? `가장 짧은 곡 ${mmss(L.min)}, 가운데값 ${mmss(L.median)}, 가장 긴 곡 ${mmss(L.max)}` : '–';
  const s = a.sufficiency;
  const tile = (label: string, v: string, sub: string) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-num">${v}</div><div class="tile-sub">${sub}</div></div>`;
  return `<section class="card"><h2>미리 정한 주 분석: 학습에 없는 곡의 곡 평균</h2>
<p class="small">곡마다 장·단 코드 이름 점수를 구한 뒤, 곡마다 같은 비중으로 평균을 냈어요(길이로 가중하지 않아요). 채점했고 점수가 있고 평가 시간이 0초보다 긴 곡 ${c.primary}개가 들어갔어요.</p>
<div class="tiles">${tile('장·단 코드 이름 (주 지표)', pct1(a.mean), `95% 구간 ${pct1(b.lower)} ~ ${pct1(b.upper)}`)}${tile('근음', pct1(a.songMean.root), '곡 평균')}${tile('7th 포함', pct1(a.songMean.sevenths), '곡 평균')}</div>
<ul class="notes small">
<li><b>95% 신뢰구간</b>: 곡 단위 부트스트랩으로 구했어요(곡 ${c.primary}개를 중복을 허용해 다시 뽑기 ${b.resamples.toLocaleString('en-US')}번, mulberry32 시드 ${b.seed}, 2.5%와 97.5% 지점). ${pct1(b.lower)} ~ ${pct1(b.upper)}, 반폭 ${pp1(b.halfWidth)}.</li>
<li>참고용 t 구간(주 구간을 대신하지 않아요): ${t}.</li>
<li>채점하지 못한 곡을 0% 또는 100%로 둔 범위(추정 점수가 아니라 한계값이에요): ${pct1(a.bounds.lower)} ~ ${pct1(a.bounds.upper)}, 고른 곡 ${a.bounds.songs}개 기준.</li>
<li>가운데값 ${pct1(a.median)}, 가장 낮은 곡 ${pct1(a.min)}, 가장 높은 곡 ${pct1(a.max)}.</li>
<li>곡 수: 고른 곡 ${c.selected}, 채점 ${c.scored}, 주 분석 ${c.primary}${c.scoredNotPrimary ? `(채점했지만 평가 시간이 없거나 점수가 없는 곡 ${c.scoredNotPrimary})` : ''}, 제외 ${c.excluded}${codes ? `(${escapeHtml(codes)})` : ''}, 아직 없음 ${c.missing}, 오류 ${c.error}, 0초 근처 후보와 마디 위치가 충돌한 곡 ${c.barConflict}.</li>
<li>주 분석 곡의 구성: 복잡도 ${comp || '–'}; 주석 길이 ${len}${repeated ? `; 같은 가수의 여러 곡: ${repeated}` : ''}.</li>
</ul>
<p class="note small">VGT-7 마무리 기준(주 분석 곡 ${s.minSongs}개 이상, 구간 반폭 ${pp1(s.maxHalfWidth)} 이하): <b>${s.met ? '충족' : '미충족'}</b> (곡 ${s.n}개, 반폭 ${pp1(s.halfWidth)}). 이 기준은 측정이 충분히 정밀한지를 보는 것이고, 정확도가 앱에 충분한지 판단하는 기준이 아니에요.</p>
<p class="muted small">이 구간은 공식 업로드가 있고 정렬을 통과한, 이런 곡들에 대한 불확실성이에요. 곡끼리 서로 독립이라고 가정해요. 업로드 유무나 정렬 통과 여부로 곡이 걸러지는 효과, 정렬 오류, 학습 자료와 겹칠 가능성, Billboard 곡 전체에 대한 일반화는 이 구간에 들어 있지 않아요.</p></section>`;
}

function alignmentCell(r: SongResult): string {
  const a = r.alignment;
  if (!a) return '–';
  const kind = a.method === 'beats' ? '박자 기준(강함)' : '코드 경계 기준(약함)';
  const parts = [`${kind}`, `시차 ${ms(a.offsetSec * 1000)} ms`];
  const rate = a.rate;
  if (rate !== 1) parts.push(`속도 차이 ${rate > 1 ? '+' : ''}${((rate - 1) * 100).toFixed(3)}% 보정`);
  if (a.driftSec !== null) parts.push(`앞·중간·끝 차이 ${Math.round(a.driftSec * 1000)} ms${rate !== 1 ? '(속도 보정 뒤)' : ''}`);
  if (a.durationDiffSec !== null) parts.push(`길이 차이 ${a.durationDiffSec > 0 ? '+' : ''}${a.durationDiffSec.toFixed(1)}초`);
  parts.push(`기준점 일치 ${pct(a.matchedFraction)}`);
  if (a.barConflict) parts.push('<b>0초 근처 후보와 마디 위치가 서로 다른 시차를 가리켜서 시차가 정해지지 않았어요</b>');
  else if (a.ambiguous) parts.push('<b>1박 또는 1마디 차이 후보를 가릴 수 없어 시차가 정해지지 않았어요</b>');
  for (const w of a.warnings) parts.push(`<span class="muted">${escapeHtml(w)}</span>`);
  return parts.join('<br>');
}

function songRow(r: SongResult): string {
  const group = r.btcTraining === 'likely' ? '학습 겹침 가능' : '학습에 없음';
  const name = `<b>${escapeHtml(r.title)}</b><br><span class="muted">${escapeHtml(r.artist)} · ${escapeHtml(group)}${r.youtubeId ? ` · ${escapeHtml(r.youtubeId)}` : ''}</span>`;
  const c = r.score?.comparison;
  const cell = (w: { score: number } | undefined) => (w ? pct(w.score) : '–');
  const time = r.score
    ? `평가 ${durationKo(c!.majmin.evaluatedSec)}<br><span class="muted">제외 장·단 ${sec1(r.score.excludedSec.majmin)} · 근음 ${sec1(r.score.excludedSec.root)} · 7th ${sec1(r.score.excludedSec.sevenths)}${r.score.notCoveredSec > 0.5 ? ` · 기록 안 됨 ${sec1(r.score.notCoveredSec)}` : ''}</span>`
    : `<span class="muted">${escapeHtml(STATUS_KO[r.status])}${r.reason ? `: ${escapeHtml(r.reason)}` : ''}</span>`;
  return `<tr><td class="song" data-label="곡">${name}</td><td data-label="정렬" class="small">${alignmentCell(r)}</td><td class="num" data-label="장·단">${cell(c?.majmin)}</td><td class="num" data-label="근음">${cell(c?.root)}</td><td class="num" data-label="7th">${cell(c?.sevenths)}</td><td data-label="시간" class="small">${time}</td></tr>`;
}

function songTable(rows: SongResult[]): string {
  if (!rows.length) return '<p class="muted">곡이 없어요.</p>';
  return `<table class="songs"><thead><tr><th>곡</th><th>정렬</th><th>장·단</th><th>근음</th><th>7th</th><th>시간</th></tr></thead><tbody>${rows.map(songRow).join('')}</tbody></table>`;
}

function exclusionList(rows: SongResult[]): string {
  const out = rows.filter((r) => r.status !== 'scored');
  if (!out.length) return '';
  const items = out.map((r) => {
    const code = r.alignment?.excluded?.code;
    const why = code ? REASON_KO[code] : r.status === 'missing' ? '아직 업로드를 고르지 않았거나 자동 코드표를 내보내지 않았어요' : '파일을 읽지 못했어요';
    return `<li><b>${escapeHtml(r.title)}</b> (${escapeHtml(r.artist)}): ${escapeHtml(STATUS_KO[r.status])}. ${escapeHtml(why)}${r.reason ? ` <span class="muted">[${escapeHtml(r.reason)}]</span>` : ''}</li>`;
  });
  return `<section class="card"><h2>채점하지 않은 곡</h2><ul class="notes">${items.join('')}</ul></section>`;
}

function timingSection(res: EvalResult, rows: SongResult[]): string {
  const t = res.totals;
  const line = (label: string, g: GroupTotals) =>
    `<li><b>${label}</b>: 맞춘 변화 ${g.changes.matched}개, 1초 안에 자동 변화가 없던 변화 ${g.changes.unmatched}개. 가운데값 ${ms(g.changes.medianMs)} ms, 10~90% 범위 ${ms(g.changes.p10Ms)} ~ ${ms(g.changes.p90Ms)} ms, ±100 ms 안 ${pct(g.changes.within100Ms)}.</li>`;
  const details = rows
    .filter((r) => r.score)
    .map((r) => {
      const list = r.score!.changes.map((c) => `${mmss(c.refSec)} ${c.offsetMs === null ? '없음' : `${ms(c.offsetMs)}`}`).join(' · ');
      return `<details><summary>${escapeHtml(r.title)} <span class="muted">(${r.score!.changes.length}개, 가운데값 ${ms(r.score!.changeMedianMs)} ms)</span></summary><p class="small mono">${escapeHtml(list)}</p></details>`;
    })
    .join('');
  return `<section class="card"><h2>코드가 바뀌는 시점 (참고용)</h2><p class="small">주석에서 코드가 바뀌는 시점마다, 1초 안에 있는 가장 가까운 자동 코드표의 변화와의 차이(자동 − 주석, ms)를 적었어요. 양수는 자동 코드표가 늦게 바뀐다는 뜻이에요.</p><p class="note small">이 숫자는 인식 모델의 시점 오차와, 듣기 모드가 코드를 박자에 맞춰 배치하는 방식이 섞여 있어요. 그래서 어느 한쪽의 품질로 해석하지 말고 설명용으로만 보세요.</p><ul class="notes small">${line('학습에 없는 곡', t.heldOut)}${line('학습 겹침 가능 곡', t.trainingOverlap)}${line('전체', t.all)}</ul>${details}</section>`;
}

function datasetSection(res: EvalResult): string {
  const items = Object.values(res.datasets).map(
    (d) =>
      `<li><b>${escapeHtml(d.name)}</b> (<span class="mono">${escapeHtml(d.page)}</span>)<br>라이선스: ${escapeHtml(d.licence)}<br><span class="muted">공식 페이지 문구: “${escapeHtml(d.licenceQuote)}”</span><br>인용: ${escapeHtml(d.attribution)}<br>BTC 학습 여부: ${escapeHtml(d.btcTraining)}</li>`,
  );
  return `<section class="card small"><h2>데이터 출처와 라이선스</h2><ul class="notes">${items.join('')}</ul><p class="muted">주석 파일은 저장소에 넣지 않았어요. 위 공식 주소에서 받아서 썼어요.</p></section>`;
}

function songListNote(res: EvalResult): string {
  const evalN = res.songs.filter((r) => r.role === 'eval').length;
  const pilotN = res.songs.filter((r) => r.role === 'pilot').length;
  const what = pilotN ? `시범 ${pilotN}곡, 평가 ${evalN}곡` : `평가 ${evalN}곡`;
  return `<dt>곡 목록</dt><dd>결과를 보기 전에 곡 목록(${what})을 정해서 저장소에 커밋했어요.${pilotN ? ' 시범 곡은 전체 숫자에 넣지 않아요.' : ''}</dd>`;
}

const METHOD_REST = `
<dt>시간 맞추기(정렬)</dt><dd>코드 인식 결과는 쓰지 않았어요. 주석의 박자(없으면 주석의 코드 경계)를 자동 코드표의 Beat This! 박자와 맞춰 곡 전체의 시차를 정하고, 채점 전에 고정했어요. 같은 녹음도 음원마다 재생 속도가 아주 조금(0.2% 이하) 다를 수 있어서, 이런 속도 차이는 시차와 함께 맞춰요. 단, 곡을 다섯 구간으로 나눠 한 구간씩 빼고 맞춘 값이 뺀 구간에서도 분명히 더 잘 맞을 때만 속도 차이를 써요(5%p 이상 개선, 아무 시각이나 찍어도 맞는 비율을 뺀 뒤 80% 이상 일치). 그렇게 맞춘 뒤에도 곡의 앞·중간·끝 시차가 0.1초 넘게 다르거나, 업로드와 주석 음원의 길이가 2초 넘게 다르거나, 길이 비율로 본 재생 속도가 다르면 다른 녹음일 수 있어서 제외했어요. 박자 주석이 없는 곡(Queen, Billboard)은 정렬 근거가 약하다고 표시했어요.</dd>
<dt>1박 차이 문제</dt><dd>박자는 일정하게 반복돼서 1박 어긋난 시차도 거의 똑같이 잘 맞아요. 같은 음원이면 시작 시차가 작으므로, 0.2초 안쪽 후보가 있고 다른 후보가 0.4초보다 멀리 떨어져 있으면 그 값을 써요. 이때 마디 첫 박 위치가 분명히 다른 후보를 가리키면, 마디 위치로 후보를 바꾸지 않고 시차가 정해지지 않은 것으로 보고 제외해요. 후보 간격이 0.4초 이하면 어떤 시차든 0.2초 안쪽 후보가 우연히 생기므로, 마디 첫 박 위치로 골라요. 마디 첫 박 위치로도 후보 하나를 가를 수 없으면 시차가 정해지지 않은 것으로 보고 제외했어요.</dd>
<dt>채점</dt><dd>저장소의 비교 코드(npm run bench -- --compare, 정확도 모아 보기와 같은 compareCharts)로, 주석의 첫 코드부터 마지막 코드까지 자동 코드표가 기록한 시간만 비교했어요. 장·단, 근음, 7th 포함 세 가지 기준이에요.</dd>
<dt>주석 라벨 바꾸기</dt><dd>주석의 Harte 표기(예: Bb:maj6(7,#11), C:min/b3)를 저장소 코드 이름으로 바꿨어요. 실제 음높이 그대로, 샵 표기로 통일해서 Db와 C#을 같은 코드로 봐요. 자리바꿈(슬래시 베이스)은 기본형과 같게 채점해요. 9·11·13 같은 확장음은 장·단과 근음에서는 무시하고, 7th 포함 기준에서는 7th만 봐요. 3음이 없는 코드(파워 코드 C5, 단음)는 근음 기준에서만 채점해요. N(코드 없음)은 자동 코드표도 N이어야 맞아요. X(알 수 없음)는 채점에서 빼요.</dd>
<dt>제외 시간</dt><dd>비교한 시간 가운데 그 기준으로 채점할 수 없는 시간이에요(X, 기준 밖 코드: 예를 들어 장·단 기준에서 sus4·dim·aug). 기록 안 됨은 주석에는 코드가 있는데 자동 코드표가 기록하지 않은 시간이에요.</dd>
</dl></section>`;

const CSS = `
:root{color-scheme:light dark;--bg:#f6f6f4;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--note:#fff6e0;--note-ink:#5c4400}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#898781;--line:#2c2c2a;--note:#3a2f12;--note-ink:#f3dfa8}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif;word-break:keep-all;overflow-wrap:anywhere}
main{max-width:860px;margin:0 auto;padding:16px}
h1{font-size:1.4rem;margin:8px 0 4px}
h2{font-size:1.1rem;margin:0 0 8px}
p{margin:6px 0}
.muted{color:var(--muted)}.small{font-size:.85rem}.mono{font-family:ui-monospace,Menlo,monospace;font-size:.8rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px;margin:14px 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:10px;padding:10px}
.tile-label{color:var(--ink2);font-size:.9rem}
.tile-num{font-size:2rem;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2}
.tile-sub{color:var(--ink2);font-size:.85rem}
.note{background:var(--note);color:var(--note-ink);border-radius:8px;padding:8px 10px}
details{border-top:1px solid var(--line);padding:6px 0}summary{cursor:pointer}
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

export function renderAnnotationReport(res: EvalResult): string {
  const evalRows = res.songs.filter((r) => r.role === 'eval');
  const pilots = res.songs.filter((r) => r.role === 'pilot');
  const count = (s: SongResult['status']) => evalRows.filter((r) => r.status === s).length;
  const t = res.totals;
  const parts = [
    `<h1>공개 정답 코드와 비교한 자동 코드표 정확도</h1>`,
    `<p class="muted small">만든 날짜 ${escapeHtml(res.generatedAt.slice(0, 10))} · 곡 목록 확정 ${escapeHtml(res.songList.declaredAt)}${res.songList.sha256 ? ` (sha256 ${escapeHtml(res.songList.sha256.slice(0, 12))})` : ''} · 평가 곡 ${evalRows.length}개 중 채점 ${count('scored')}, 제외 ${count('excluded')}, 아직 없음 ${count('missing')}, 오류 ${count('error')}</p>`,
    `<section class="card"><p>연구용으로 공개된 사람의 코드 주석(정답)과, 같은 녹음의 공식 업로드를 끝까지 재생해서 만든 자동 코드표를 비교했어요. 귀로 판단하지 않아도 되는 객관적인 숫자예요.</p><p class="note small">코드 인식 모델(BTC)은 Isophonics 주석(Beatles, Queen 등)으로 학습됐어요. 그래서 “학습 겹침 가능” 곡의 숫자는 실제보다 높게 나올 수 있어요. 앱의 실제 실력은 “학습에 없는 곡” 숫자로 판단하세요.</p></section>`,
    res.analysis ? analysisSection(res.analysis.heldOut) : '',
    groupTiles('학습에 없는 곡 (가장 믿을 만한 숫자)', t.heldOut, 'McGill Billboard 곡이에요. BTC 학습 자료와 겹치지 않는 곡만 골랐어요.'),
    groupTiles('학습 겹침 가능 곡 (낙관적인 숫자)', t.trainingOverlap, 'Isophonics(Beatles, Queen) 곡이에요.'),
    groupTiles('평가 곡 전체', t.all, '두 묶음을 합친 숫자예요. 시범 곡은 빼요.'),
    `<section class="card"><h2>곡별 결과</h2>${songTable(evalRows)}</section>`,
    exclusionList(evalRows),
    pilots.length ? `<section class="card"><h2>시범 곡 (전체 숫자에 넣지 않음)</h2>${songTable(pilots)}</section>` : '',
    timingSection(res, [...evalRows, ...pilots]),
    `<section class="card small"><h2>계산 방법</h2><dl class="glossary">\n${songListNote(res)}${METHOD_REST}`,
    datasetSection(res),
  ];
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Guitar 공개 주석 정확도</title><style>${CSS}</style></head><body><main>${parts.join('\n')}</main></body></html>\n`;
}
