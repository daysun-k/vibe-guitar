// Checks the `## 검증` receipt in a pull request body against VERIFICATION.md "Merge rules".
//   PR_BODY="$(gh pr view <n> --json body -q .body)" GITHUB_EVENT_NAME=pull_request node scripts/check-pr-receipt.mjs
// CI passes the body through the PR_BODY environment variable (never interpolated into the shell).
// Any event other than pull_request (push, workflow_dispatch) prints a skip line and exits 0.
// Rules (one pipe table, rows starting with `|`, under the first `## 검증` heading, outside code fences and HTML comments):
// - a header row, a separator row and at least one data row, with a header cell named State, Status or 상태;
// - every data row has the header's number of cells, none of them empty;
// - the state cell is one of executed, cached, skipped, unavailable (backticks allowed);
// - every data row names a commit SHA: a 7 to 40 character hex token with at least one letter a-f
//   (an all-digit token is read as a run or issue number, not a SHA).

import { pathToFileURL } from 'node:url';

export const STATES = ['executed', 'cached', 'skipped', 'unavailable'];
const STATE_HEADERS = ['state', 'status', '상태'];
const SHA = /(?<![0-9A-Za-z])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9A-Za-z])/;

function stripNoise(body) {
  return body
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '');
}

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

const isTableLine = (line) => line.trim().startsWith('|');
const isSeparator = (line) => cells(line).every((c) => /^:?-{3,}:?$/.test(c));

/** Returns the list of problems with the receipt; an empty list means it meets the rule. */
export function checkReceipt(body) {
  const lines = stripNoise(body ?? '').split('\n');
  const start = lines.findIndex((l) => /^##\s+검증\s*$/.test(l.trim()));
  if (start < 0) return ['no `## 검증` section in the pull request body'];
  let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l.trim()));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end);
  const first = section.findIndex(isTableLine);
  if (first < 0) return ['the `## 검증` section has no table'];
  const table = [];
  for (let i = first; i < section.length && isTableLine(section[i]); i++) table.push(section[i]);
  if (table.length < 2 || !isSeparator(table[1])) return ['the `## 검증` table has no header and separator row'];
  const header = cells(table[0]);
  const stateCol = header.findIndex((h) => STATE_HEADERS.includes(h.replace(/`/g, '').toLowerCase()));
  if (stateCol < 0) return [`the \`## 검증\` table header has no State column (one of: ${STATE_HEADERS.join(', ')})`];
  const rows = table.slice(2);
  if (rows.length === 0) return ['the `## 검증` table has no rows'];
  const problems = [];
  rows.forEach((line, i) => {
    const n = i + 1;
    const row = cells(line);
    if (row.length !== header.length) {
      problems.push(`row ${n}: ${row.length} cells, the header has ${header.length}`);
      return;
    }
    const empty = row.map((c, j) => (c === '' ? header[j] || `column ${j + 1}` : null)).filter(Boolean);
    if (empty.length) problems.push(`row ${n}: empty cell(s): ${empty.join(', ')}`);
    const state = row[stateCol].replace(/`/g, '').trim();
    if (!state && row[stateCol] !== '') problems.push(`row ${n}: the State cell has no state word`);
    if (state && !STATES.includes(state)) problems.push(`row ${n}: state "${state}" is not one of ${STATES.join(', ')}`);
    if (!SHA.test(line)) problems.push(`row ${n}: no commit SHA (7-40 hex characters)`);
  });
  return problems;
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  if (event !== 'pull_request') {
    console.log(`receipt check skipped: event "${event || 'none'}" is not a pull request`);
    return 0;
  }
  const problems = checkReceipt(process.env.PR_BODY);
  if (problems.length === 0) {
    console.log('receipt check passed: the `## 검증` table meets VERIFICATION.md "Merge rules"');
    return 0;
  }
  console.log('receipt check failed (VERIFICATION.md "Merge rules"); edit the pull request body to re-run:');
  for (const p of problems) console.log(`::error title=PR receipt::${p}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
