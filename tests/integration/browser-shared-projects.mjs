// SPEC-04.11, Design SCR-24 (PLAN-35 T-162): a project shared with this PC's account shows in the
// project picker under '공유받은 프로젝트'; choosing it opens the remote project page with its
// notice (the project runs on another member's PC), the site's 할 일·작업 이력 요약·노트, and the AI
// instructions that any member saves. The engine's shared-project routes are answered here (the
// site side is tests/sharing/shared-layer.mjs); everything else is the real engine.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-shared-projects-'));
const SHARED = 'bbbbbbbb-2222-4222-8222-222222222222';
const shared = {
  id: SHARED,
  name: '공유 현장',
  role: 'viewer',
  ownerName: 'bob',
  hostId: 'h-bob',
  hostName: 'Bob PC',
  hostOnline: false,
  here: false,
  updatedAt: 1,
};

let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(15000);
  await installBrowserSupport(page);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/shared-projects', (route) =>
    route.fulfill({ json: { linked: true, online: true, projects: [shared] } }),
  );
  const saves = [];
  await page.route(`**/api/v1/shared-projects/${SHARED}/instructions`, async (route) => {
    const body = route.request().postDataJSON();
    saves.push(body);
    await route.fulfill({
      json: { text: body.text, revision: 2, shared: 'synced', updatedByName: 'studio' },
    });
  });
  await page.route(`**/api/v1/shared-projects/${SHARED}`, (route) =>
    route.fulfill({
      json: {
        project: shared,
        online: true,
        agenda: {
          items: [{ id: 'a1', text: '구조 회의', date: '2026-10-07', done: false, pending: true }],
        },
        history: {
          items: [
            {
              id: 'r1',
              body: '기둥 배치를 바꿔줘',
              answer: '바꿨습니다.',
              state: 'succeeded',
              files: [],
              createdAt: '2026-10-06T01:00:00.000Z',
            },
          ],
        },
        notes: { notes: [{ id: 'n1', title: '설비 협의', kind: 'discussion' }] },
        snapshots: { snapshots: [] },
        knowledge: {
          revision: 1,
          builtAt: '2026-10-05T03:00:00Z',
          counts: { files: 12, excerpts: 40 },
        },
        instructions: { text: '치수는 mm.', revision: 1, shared: 'synced', updatedByName: 'bob' },
        site: 'https://sharing.example',
      },
    }),
  );

  // The picker lists the shared project in its own group.
  await page.goto(app.launchUrl);
  await page.waitForFunction(() =>
    document.querySelector('#project-picker optgroup[label="공유받은 프로젝트"] option'),
  );
  const groups = await page.$$eval('#project-picker optgroup', (nodes) =>
    nodes.map((node) => [
      node.label,
      [...node.querySelectorAll('option')].map((o) => o.textContent),
    ]),
  );
  assert.equal(groups.length, 2);
  assert.equal(groups[0][0], '이 PC의 프로젝트');
  assert.deepEqual(groups[1], ['공유받은 프로젝트', ['공유 현장 · bob (PC 꺼짐)']]);

  // Choosing it opens the remote project page with its notice.
  await page.selectOption('#project-picker', SHARED);
  await page.waitForURL(`**/?project=${SHARED}`);
  const main = page.getByRole('main', { name: '원격 프로젝트' });
  await main.waitFor();
  await main
    .getByText('이 프로젝트는 bob의 PC(Bob PC)에서 돌아갑니다. 모델·Sync·AI 작업은 그 PC에서만', {
      exact: false,
    })
    .waitFor();
  await main.getByText('지금 그 PC는 꺼져 있습니다.', { exact: false }).waitFor();
  await main.getByText('구조 회의').waitFor();
  await main.getByText('PC 반영 대기', { exact: false }).waitFor();
  await main.getByText('기둥 배치를 바꿔줘').waitFor();
  await main.getByText('설비 협의').waitFor();
  await main.getByText('파일 12', { exact: false }).waitFor();
  assert.equal(await page.title(), '공유 현장 · VIDE');
  // No composer or model of this PC's work screen is reachable on it.
  assert.equal(await main.locator('textarea#body').count(), 0);

  // Any member saves the project's AI instructions.
  const editor = main.getByRole('textbox', { name: '프로젝트 AI 지시' });
  assert.equal(await editor.inputValue(), '치수는 mm.');
  await editor.fill('치수는 mm. 레이어는 STR::');
  await main.getByRole('button', { name: '지침 저장' }).click();
  await main.getByText('저장했습니다. 프로젝트를 돌리는 PC가 다음 연결 때 받습니다.').waitFor();
  assert.deepEqual(saves, [{ text: '치수는 mm. 레이어는 STR::' }]);

  // Back to this PC's project from the page's own picker.
  const own = await page.$eval(
    '#remote-project-picker optgroup[label="이 PC의 프로젝트"] option',
    (option) => option.value,
  );
  await page.selectOption('#remote-project-picker', own);
  await page.waitForURL(`**/?project=${own}`);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  assert.equal(await page.locator('#remote-project').count(), 0);
  assert.deepEqual(errors, []);
  console.log('shared project picker and remote project page checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
