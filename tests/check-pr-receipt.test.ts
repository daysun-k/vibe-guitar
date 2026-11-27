import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types
import { checkReceipt } from '../scripts/check-pr-receipt.mjs';

const SHA = '7e23ec3f0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const HEADER = '| Command | Result | State | Evidence |\n|---|---|---|---|';
const row = (state: string, sha = SHA) => `| \`npm test\` on \`${sha}\` | 60 files passed | \`${state}\` | output inline |`;
const body = (rows: string[], extra = '') => `## 요약\n\ntext\n\n## 검증\n\n${HEADER}\n${rows.join('\n')}\n\n## 리뷰\n${extra}`;

describe('checkReceipt', () => {
  it('accepts a valid table with every state word', () => {
    expect(checkReceipt(body(['executed', 'cached', 'skipped', 'unavailable'].map((s) => row(s))))).toEqual([]);
  });

  it('accepts a short SHA and a Korean State header', () => {
    const t = '## 검증\n| 명령 | 결과 | 상태 | 근거 |\n|:---|---|---|---:|\n| `npm test` @ 7e23ec3 | ok | executed | run URL |';
    expect(checkReceipt(t)).toEqual([]);
  });

  it('fails when the section is missing, empty or null', () => {
    expect(checkReceipt('## Checks\n- npm test: ok')).toEqual(['no `## 검증` section in the pull request body']);
    expect(checkReceipt(null)).toEqual(['no `## 검증` section in the pull request body']);
    expect(checkReceipt('## 검증\n\nnothing here\n')).toEqual(['the `## 검증` section has no table']);
  });

  it('ignores a section inside a code fence or an HTML comment', () => {
    const fenced = '```md\n## 검증\n' + HEADER + '\n' + row('executed') + '\n```\n';
    expect(checkReceipt(fenced)).toEqual(['no `## 검증` section in the pull request body']);
    const commented = `<!--\n## 검증\n${HEADER}\n${row('executed')}\n-->`;
    expect(checkReceipt(commented)).toEqual(['no `## 검증` section in the pull request body']);
  });

  it('fails when the table has no State column or no rows', () => {
    expect(checkReceipt(`## 검증\n| Command | Result | Evidence |\n|---|---|---|\n| a ${SHA} | ok | x |`)[0]).toMatch(/no State column/);
    expect(checkReceipt(`## 검증\n${HEADER}\n`)).toEqual(['the `## 검증` table has no rows']);
  });

  it('fails on missing status values and empty cells', () => {
    const p = checkReceipt(body([`| \`npm test\` ${SHA} | ok |  | output |`]));
    expect(p).toEqual(['row 1: empty cell(s): State']);
  });

  it('fails on a state word outside the four', () => {
    expect(checkReceipt(body([row('passed')]))).toEqual(['row 1: state "passed" is not one of executed, cached, skipped, unavailable']);
  });

  it('fails when a row has no commit SHA; a run number is not a SHA', () => {
    const noSha = '| `npm test` | ok | executed | https://github.com/o/r/actions/runs/19123456789 |';
    expect(checkReceipt(body([row('executed'), noSha]))).toEqual(['row 2: no commit SHA (7-40 hex characters)']);
  });

  it('fails when a row has the wrong number of cells', () => {
    expect(checkReceipt(body([`| npm test ${SHA} | ok | executed |`]))).toEqual(['row 1: 3 cells, the header has 4']);
  });
});

describe('check-pr-receipt CLI', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['scripts/check-pr-receipt.mjs'], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });

  it('skips push and other non-PR events with exit 0', () => {
    for (const ev of ['push', 'workflow_dispatch', '']) {
      const r = run({ GITHUB_EVENT_NAME: ev, PR_BODY: '' });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/skipped/);
    }
  });

  it('fails a pull request without a receipt and passes one with a receipt', () => {
    const bad = run({ GITHUB_EVENT_NAME: 'pull_request', PR_BODY: '## Checks\n- ok' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/::error title=PR receipt::no `## 검증` section/);
    const good = run({ GITHUB_EVENT_NAME: 'pull_request', PR_BODY: body([row('executed')]) });
    expect(good.status).toBe(0);
  });
});
