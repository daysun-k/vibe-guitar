// VGT-13 spike: writes the static phone-screen mockups to docs/vgt-13-mockups/ (no scripts, no external requests).
// Diagrams come from the side panel's renderShapeDiagram so the phone matches the play view.
import * as esbuild from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './phone-lib.mjs';

const out = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents:
      "export { renderShapeDiagram } from './src/extension/sidepanel/diagram.ts'; export { voicingsForChord } from './src/arrange/voicings.ts'; export { parseChord } from './src/arrange/chord.ts'; export { shapeName } from './src/music/key.ts';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const M = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

// Scenario: the song sounds in A; capo 2; the hand plays G-shape now, C-shape next (sounding A, D).
const CAPO = 2;
const cur = M.shapeName('A', CAPO); // G
const next = M.shapeName('D', CAPO); // C
const dia = (shape, width) => M.renderShapeDiagram(M.voicingsForChord(M.parseChord(shape)).find((v) => v.kind === 'open'), width);

const THEMES = {
  dark: '--bg:#131210;--surface:#131210;--ink:#F2ECE1;--ink-2:#CFC6B6;--line:#3A352E;--accent:#F28C4E;--accent-ink:#1B0E06;color-scheme:dark',
  light: '--bg:#F3EFE7;--surface:#F3EFE7;--ink:#1D1A15;--ink-2:#4A443B;--line:#CFC6B6;--accent:#B13E12;--accent-ink:#FFF7EF;color-scheme:light',
  black: '--bg:#000;--surface:#000;--ink:#FFF;--ink-2:#E6E1D8;--line:#3A3A3A;--accent:#FFB347;--accent-ink:#000;color-scheme:dark',
};

const BASE = `
*{box-sizing:border-box}
html,body{margin:0;background:#777}
body{padding:0}
.screen{background:var(--bg);color:var(--ink);overflow:hidden;position:relative;font:20px/1.3 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;-webkit-font-smoothing:antialiased}
.portrait{width:390px;height:844px}
.landscape{width:844px;height:390px}
.chord{font-family:ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",system-ui,-apple-system,sans-serif;font-weight:800;letter-spacing:-.02em;line-height:.9}
.dia{display:block;color:var(--ink);overflow:visible}
.dia .d-str{stroke:currentColor;opacity:.7}
.dia .d-fret{stroke:currentColor;opacity:.45;stroke-width:1.2}
.dia .d-nut{fill:currentColor}
.dia .d-dot{fill:currentColor}
.dia .d-num{fill:var(--surface);font:700 10px system-ui,sans-serif;text-anchor:middle;dominant-baseline:central}
.dia .d-open{fill:none;stroke:currentColor;stroke-width:1.8}
.dia .d-x{stroke:currentColor;stroke-width:1.9;stroke-linecap:round}
.dia .d-fr{fill:currentColor;font:600 9px system-ui,sans-serif}
.capo{font-weight:800;font-size:22px;color:var(--accent)}
.sec{font-weight:700;font-size:22px}
.status{font-size:18px;font-weight:600;color:var(--ink-2)}
`;

function page(title, theme, cls, css, body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${BASE}
.screen{${THEMES[theme]}}
${css}
</style>
</head>
<body>
<div class="screen ${cls}">
${body}
</div>
</body>
</html>
`;
}

// ---------- A: 무대형 (stacked, one column) ----------
const cssA = `
.a{display:flex;flex-direction:column;padding:56px 24px 28px}
.a .top{display:flex;justify-content:space-between;align-items:baseline}
.a .now{display:flex;flex-direction:column;align-items:center;margin-top:20px}
.a .now .chord{font-size:150px}
.a .now .dia{margin-top:14px}
.a .beats{display:flex;gap:10px;justify-content:center;margin:22px 0 0}
.a .beats i{width:58px;height:14px;border:3px solid var(--ink);display:block}
.a .beats i.on{background:var(--ink)}
.a .next{margin-top:auto;border-top:3px solid var(--line);padding-top:16px;display:grid;grid-template-columns:auto 1fr auto;align-items:center;column-gap:16px}
.a .next .lbl{grid-column:1/-1;font-size:22px;font-weight:700;color:var(--ink-2);margin-bottom:6px}
.a .next .chord{font-size:84px}
.a .count{text-align:right}
.a .count b{display:block;font:800 92px/0.9 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;color:var(--accent);font-variant-numeric:tabular-nums}
.a .count span{font-size:22px;font-weight:700}
.a .status{margin-top:14px}
`;
const bodyA = `
<div class="top"><span class="capo">카포 2 모양</span><span class="sec">후렴 · 9 / 16마디</span></div>
<section class="now" aria-label="지금 코드">
  <div class="chord">${cur}</div>
  ${dia(cur, 210)}
</section>
<div class="beats" aria-label="이 마디 2박째"><i class="on"></i><i class="on"></i><i></i><i></i></div>
<section class="next" aria-label="다음 코드">
  <div class="lbl">다음</div>
  <div class="chord">${next}</div>
  ${dia(next, 78)}
  <div class="count"><b>3</b><span>박 뒤</span></div>
</section>
<div class="status">Mac과 연결됨 · 화면 자동 잠금 꺼 두기</div>
`;

// ---------- B: 악보대형 (split halves; portrait and landscape) ----------
const cssB = `
.b{display:grid}
.b .top{display:flex;justify-content:space-between;align-items:baseline}
.b .half{display:flex;align-items:center;gap:18px}
.b .now .chord{font-size:140px}
.b .nx .chord{font-size:92px}
.b .lbl{font-size:22px;font-weight:700;color:var(--ink-2)}
.b .dots{display:flex;gap:12px;margin-top:10px}
.b .dots i{width:30px;height:30px;border-radius:50%;border:3px solid var(--accent);display:block}
.b .dots i.on{background:var(--accent)}
.b .cnt{font-size:24px;font-weight:800;margin-top:8px}
.b.portrait{grid-template-rows:auto 1fr auto 1fr auto;padding:56px 24px 28px}
.b.portrait .now{justify-content:space-between}
.b.portrait .rule{border-top:3px solid var(--line);margin:4px 0 0}
.b.portrait .nx{justify-content:space-between}
.b.landscape{grid-template-columns:1.35fr 1fr;grid-template-rows:auto 1fr auto;column-gap:28px;padding:24px 56px 18px}
.b.landscape .top{grid-column:1/-1}
.b.landscape .nx{flex-direction:column;align-items:flex-start;border-left:3px solid var(--line);padding-left:28px;justify-content:center}
.b.landscape .nx .row{display:flex;align-items:center;gap:16px}
.b.landscape .status{grid-column:1/-1}
`;
const nextBlock = (w) => `<div>
    <div class="lbl">다음</div>
    <div class="chord">${next}</div>
    <div class="dots" aria-label="바뀌기까지 3박"><i class="on"></i><i class="on"></i><i class="on"></i><i></i></div>
    <div class="cnt">3박 뒤에 바뀜</div>
  </div>
  ${dia(next, w)}`;
const bodyBPortrait = `
<div class="top"><span class="capo">카포 2 모양</span><span class="sec">2절 · 9마디</span></div>
<section class="half now" aria-label="지금 코드"><div class="chord">${cur}</div>${dia(cur, 170)}</section>
<div class="rule"></div>
<section class="half nx" aria-label="다음 코드">${nextBlock(130)}</section>
<div class="status">Mac과 연결됨</div>
`;
const bodyBLandscape = `
<div class="top"><span class="capo">카포 2 모양</span><span class="sec">2절 · 9마디</span></div>
<section class="half now" aria-label="지금 코드"><div class="chord">${cur}</div>${dia(cur, 165)}</section>
<section class="half nx" aria-label="다음 코드"><div class="row">${nextBlock(124)}</div></section>
<div class="status">Mac과 연결됨</div>
`;

// ---------- C: 카운트다운형 (black, the change is the hero) ----------
const cssC = `
.c{display:flex;flex-direction:column;padding:56px 24px 28px}
.c .top{display:flex;justify-content:space-between;align-items:baseline}
.c .now{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding-bottom:18px;border-bottom:3px solid var(--line)}
.c .now .lbl,.c .go .lbl{font-size:22px;font-weight:700;color:var(--ink-2)}
.c .now .chord{font-size:112px}
.c .go{margin:auto 0;display:grid;grid-template-columns:1fr auto;align-items:end}
.c .big{font:800 230px/0.8 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;color:var(--accent);font-variant-numeric:tabular-nums}
.c .unit{font-size:26px;font-weight:800;margin-top:10px}
.c .target{display:flex;flex-direction:column;align-items:center}
.c .target .chord{font-size:96px;margin-bottom:8px}
.c .bar{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.c .bar i{height:22px;display:block;border:3px solid var(--ink)}
.c .bar i.on{background:var(--ink)}
.c .bar-l{display:flex;justify-content:space-between;font-size:20px;font-weight:700;margin-top:8px}
.c .status{margin-top:12px}
`;
const bodyC = `
<div class="top"><span class="capo">카포 2 모양</span><span class="sec">후렴 · 9 / 16마디</span></div>
<section class="now" aria-label="지금 코드"><div><div class="lbl">지금</div><div class="chord">${cur}</div></div>${dia(cur, 150)}</section>
<section class="go" aria-label="다음 코드까지">
  <div><div class="lbl">바뀌기까지</div><div class="big">3</div><div class="unit">박 뒤 ${next}</div></div>
  <div class="target"><div class="chord">${next}</div>${dia(next, 120)}</div>
</section>
<div class="bar" aria-label="이 마디 2박째"><i class="on"></i><i class="on"></i><i></i><i></i></div>
<div class="bar-l"><span>1박</span><span>4박</span></div>
<div class="status">Mac과 연결됨</div>
`;

const files = {
  'a-stage-dark.html': page('시안 A 무대형 (어두운 화면)', 'dark', 'a portrait', cssA, bodyA),
  'a-stage-light.html': page('시안 A 무대형 (밝은 화면)', 'light', 'a portrait', cssA, bodyA),
  'b-stand-light.html': page('시안 B 악보대형 (세로)', 'light', 'b portrait', cssB, bodyBPortrait),
  'b-stand-light-landscape.html': page('시안 B 악보대형 (가로)', 'light', 'b landscape', cssB, bodyBLandscape),
  'c-countdown-black.html': page('시안 C 카운트다운형 (검은 화면)', 'black', 'c portrait', cssC, bodyC),
};
const dir = path.join(root, 'docs/vgt-13-mockups');
await mkdir(dir, { recursive: true });
for (const [name, html] of Object.entries(files)) {
  if (/<script|https?:\/\//i.test(html.replace('http://www.w3.org/2000/svg', ''))) throw new Error(`${name}: scripts or external URLs are not allowed`);
  await writeFile(path.join(dir, name), html);
  console.log(`wrote docs/vgt-13-mockups/${name}`);
}
