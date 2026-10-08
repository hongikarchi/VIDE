// 대시보드 › 프로젝트 폴더 › 자료 정리 and 자료에서 찾은 할 일·일정 (SPEC-08.9, SPEC-01.14 11,
// Design SCR-20, PLAN-42 T-195·T-196·T-261): a folder is added, [자료 정리하기] first shows what it
// reads and skips (a number dump, a Python environment) and a folder is left out, then [시작] runs
// through its stages to a finished time and becomes [자료 업데이트]; the proposals card adds one of two items to the 할 일
// list and dismisses the other, which a later update does not bring back. The engine runs a fake
// AI runner; synthetic temporary folders only; no real CLI, host or ZWCAD.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';
import { fakeRunner } from '../fixtures/documents.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const later = (days) => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};
const directory = await mkdtemp(join(tmpdir(), 'vide-knowledge-collect-'));
const folder = join(directory, '2601 합성 프로젝트');
await mkdir(folder);
await writeFile(
  join(folder, '261006 회의록.md'),
  '설비 협의는 다음 주 화요일 오후 2시에 현장 사무실에서 한다.\n구조 검토서는 다음 주 금요일까지 제출한다.',
);
// T-261: a number dump, a tool's Python environment and a folder to leave out.
await mkdir(join(folder, '측량'));
await writeFile(
  join(folder, '측량', '좌표.txt'),
  Array.from({ length: 3000 }, (_, i) => `${1000 + i * 0.5} ${2000 - i * 0.25} 0.00`).join(' '),
);
await mkdir(join(folder, '도구', '.venv'), { recursive: true });
await writeFile(join(folder, '도구', '.venv', 'pyvenv.cfg'), 'home = C:\\Python');
await mkdir(join(folder, '참고'));
await writeFile(join(folder, '참고', '옛 메모.md'), '예전 검토 메모: 외장재 후보를 비교했다.');
let proposalRounds = 0;
const runner = fakeRunner({
  proposals: (statements) => {
    proposalRounds++;
    const cite = (word) => statements.filter((s) => s.content.includes(word)).map((s) => s.id);
    return [
      { text: '설비 협의', kind: 'meeting', date: later(7), time: '14:00', cite: cite('설비') },
      { text: '구조 검토서 제출', kind: 'receipt', date: later(10), cite: cite('구조') },
    ];
  },
});
// A run slow enough to be seen in progress.
const slow = {
  async run(call) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return runner.run(call);
  },
};
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    collectOptions: {
      runner: slow,
      plan: async () => modelPlan(['claude-cli'], []),
      dwgReader: null,
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  // The 자료 tab without a DB offers 자료 정리 right there (2026-10-08 user report); without a
  // project folder its button goes to the dashboard.
  await page.locator('.rail [data-workspace-target="data"]').click();
  await page.getByText('이 프로젝트에는 아직 자료 DB가 없습니다.').waitFor();
  const empty = page.locator('.facts-empty').getByRole('group', { name: '자료 정리' });
  await empty.getByText('프로젝트 폴더를 정하면 [자료 정리하기]를 쓸 수 있습니다.').waitFor();
  assert.equal(await page.getByText('시험판에서는 수집을 앱 밖에서').count(), 0);
  await empty.getByRole('button', { name: '대시보드에서 폴더 정하기' }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'dashboard');
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  // The folders may sit in a folded line (PLAN-39) or in their own section (PLAN-42 T-192).
  await board.locator('details.dash-more, section[aria-label="프로젝트 폴더"]').first().waitFor({
    state: 'attached',
  });
  const more = board.locator('details.dash-more:not([open]) > summary');
  if (await more.count()) await more.click();
  const section = board.getByRole('region', { name: '프로젝트 폴더' });
  // No folder: the 자료 정리 row stays and says how to start; [폴더 정하기] opens the path field.
  const collect = section.getByRole('group', { name: '자료 정리' });
  await collect.getByText('프로젝트 폴더를 정하면 [자료 정리하기]를 쓸 수 있습니다.').waitFor();
  assert.equal(await section.getByRole('button', { name: '자료 정리하기' }).count(), 0);

  await collect.getByRole('button', { name: '폴더 정하기' }).click();
  await section.getByRole('textbox', { name: '폴더 경로' }).fill(folder);
  await section.getByRole('button', { name: '추가', exact: true }).click();
  // Before the run: what it reads and skips (T-261), a folder left out, then [시작].
  await collect.getByRole('button', { name: '자료 정리하기' }).click();
  const survey = collect.getByRole('group', { name: '정리할 자료' });
  await survey.getByText('이번에 읽을 파일 2개 — 글 2').waitFor();
  await survey.getByText('건너뜀: 데이터 파일 1 · 환경·캐시 폴더 1').waitFor();
  await survey.getByText(/발췌 약 2개 · 걸러내기 AI 호출 약 1번 · 약 1분/).waitFor();
  await survey
    .getByRole('list', { name: '발췌가 많은 폴더' })
    .getByRole('button', { name: '참고 빼기' })
    .click();
  await survey
    .getByRole('list', { name: '뺀 폴더' })
    .getByRole('button', { name: '참고 다시 넣기' })
    .waitFor();
  await survey.getByText('이번에 읽을 파일 1개 — 글 1').waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-knowledge-survey.png') });
  await survey.getByRole('button', { name: '시작' }).click();
  await collect
    .getByRole('status')
    .getByText(/정리 중/)
    .waitFor();
  await collect.getByRole('button', { name: '중단' }).waitFor();
  await collect.getByText(/읽을 파일 1 · 발췌 약 1개/).waitFor();
  await collect.getByText(/마지막 정리 \d+\/\d+ \d\d:\d\d/).waitFor({ timeout: 20000 });
  await collect.getByText(/문서 1\/1 · 진술 2 · 이슈 1 · 데이터 파일 1/).waitFor();
  assert.ok(!runner.calls.some((c) => /외장재 후보|1000 2000/.test(c.prompt)));
  await collect.getByRole('button', { name: '자료 업데이트' }).waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-knowledge-collect.png') });

  // The proposals card: two found; one picked and added, the other dismissed.
  const card = board.getByRole('group', { name: '자료에서 찾은 할 일·일정' });
  await card.getByRole('button', { name: '자료에서 찾은 할 일·일정 2건' }).click();
  await card.getByRole('checkbox', { name: '설비 협의 고르기' }).check();
  await card.getByRole('button', { name: '고른 것 추가' }).click();
  await card.getByRole('button', { name: '자료에서 찾은 할 일·일정 1건' }).waitFor();
  const items = await page.evaluate(
    async (projectId) => {
      const response = await fetch(`/api/v1/projects/${projectId}/agenda`);
      return (await response.json()).items;
    },
    await page.locator('#project-picker').inputValue(),
  );
  assert.deepEqual(
    items.map((i) => [i.text, i.kind, i.date, i.time, i.source]),
    [['설비 협의', 'meeting', later(7), '14:00', 'ai']],
  );
  await card.getByRole('checkbox', { name: '구조 검토서 제출 고르기' }).check();
  await card.getByRole('button', { name: '버리기' }).click();
  await card.waitFor({ state: 'detached' });

  // An update with a new statement does not bring the dismissed one back.
  await writeFile(join(folder, '메모.md'), '설비 협의 장소는 현장 사무실로 정했다.');
  await collect.getByRole('button', { name: '자료 업데이트' }).click();
  await survey.getByText('이번에 읽을 파일 1개 — 글 1 (그대로 1개)').waitFor();
  await survey.getByRole('button', { name: '시작' }).click();
  for (let i = 0; i < 200 && proposalRounds < 2; i++) await page.waitForTimeout(100);
  assert.equal(proposalRounds, 2);
  await collect.getByRole('status').waitFor({ state: 'detached', timeout: 20000 });
  await collect.getByText(/진술 3/).waitFor();
  assert.equal(await card.count(), 0);

  // The 자료 tab now reads the DB.
  await page.locator('.rail [data-workspace-target="data"]').click();
  await page
    .getByText(/진술 3개/)
    .first()
    .waitFor();
  assert.equal(await page.locator('.facts-empty').count(), 0);

  // A failed state read does not hide the row: the reason and [다시 읽기].
  let failing = true;
  await page.route('**/knowledge/collect', (route) =>
    failing && route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { code: 'INTERNAL' } })
      : route.fallback(),
  );
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const again = board.getByRole('group', { name: '자료 정리' });
  await again.getByRole('alert').getByText('자료 정리 상태를 읽지 못했습니다.').waitFor();
  failing = false;
  await again.getByRole('button', { name: '다시 읽기' }).click();
  await again.getByRole('button', { name: '자료 업데이트' }).waitFor();

  assert.deepEqual(errors, []);
  console.log('knowledge collect browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
