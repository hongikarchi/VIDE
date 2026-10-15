// 체크아웃 · 서버에 반영 · 작업 중 (SPEC-01.13 9, Design SCR-37, PLAN-52 T-310~T-312): the dashboard's
// 프로젝트 폴더 section lists the remembered server folder's model and drawing files. [체크아웃] makes
// the local copy and the '… · 이 PC' badge; [서버에 반영] opens the dialog (summary, target path —
// empty without memory, filled from '가져온 폴더로' —, the archive line, keep/release) and writes the
// server file after keeping the previous one; drawings read '서버에서 직접 · 오늘 백업 없음'. Synthetic
// temporary folders stand in for the work folder and the server share; no host, no real share.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-workspace-checkout-ui-'));
const work = join(directory, '2601 작업 폴더');
const server = join(directory, 'server', '2601-나진상가');
for (const [file, text] of [
  ['04 모델/A-동.3dm', 'server v1'],
  ['05 도면/A-101.dwg', 'dwg v1'],
]) {
  await mkdir(join(server, file, '..'), { recursive: true });
  await writeFile(join(server, file), text);
}
await mkdir(work, { recursive: true });
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    collectOptions: { plan: async () => null, dwgReader: null },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await page.route(pattern, (route) => route.fulfill({ json }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  // The work folder's manifest remembers the server folder's model and drawing folders.
  await writeFile(
    join(work, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '나진상가',
      paths: { rhino: '03_모델', cad: '04_도면', archive: '10_아카이브' },
      server: {
        root: realpathSync.native(server),
        paths: { rhino: '04 모델', cad: '05 도면' },
        targets: {},
        checkout: { rhino: 'local', cad: 'server' },
      },
      vide: { projectId },
    }),
  );
  const folders = new ProjectFolders(app.store);
  folders.add(projectId, realpathSync.native(work), 'project');
  folders.add(projectId, realpathSync.native(server), 'project');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const section = page
    .getByRole('region', { name: '대시보드', exact: true })
    .getByRole('region', { name: '프로젝트 폴더' });
  const files = section.locator('.wsco');
  await files.getByText('A-동.3dm').waitFor();
  await files.getByText('서버에서 직접 · 오늘 백업 없음').waitFor();
  const model = files.locator('.wsco-file', { hasText: 'A-동.3dm' });
  await model.getByRole('button', { name: '체크아웃' }).click();
  await model.getByText(/ · 이 PC$/).waitFor();
  await model.getByText(/로컬 사본 · /).waitFor();
  const local = join(work, '03_모델', 'A-동.3dm');
  assert.equal(await readFile(local, 'utf8'), 'server v1');
  if (shot) await page.screenshot({ path: join(shot, 'workspace-checkout-row.png') });

  // [서버에 반영]: no memory yet — the target is asked and then remembered.
  await writeFile(local, 'edited here');
  await model.getByRole('button', { name: '서버에 반영' }).click();
  const dialog = page.getByRole('dialog', { name: '서버에 반영' });
  await dialog.getByText('서버의 이전 판은 이 PC의 아카이브에 보관됩니다.').waitFor();
  await dialog.getByText('둘 곳을 고르면 이 종류는 앞으로 여기로 기억합니다.').waitFor();
  assert.equal(await dialog.getByLabel('대상 경로').inputValue(), '');
  await dialog.getByRole('button', { name: '가져온 폴더로' }).click();
  assert.equal(await dialog.getByLabel('대상 경로').inputValue(), '04 모델');
  await dialog.getByLabel('체크아웃 풀기').check();
  if (shot) await page.screenshot({ path: join(shot, 'workspace-checkout-dialog.png') });
  const text = await dialog.innerText();
  assert.doesNotMatch(
    await files.innerText(),
    /SERVER_|NEEDS_TARGET|PLAN-|SPEC-|세션|토큰|undefined|null/,
  );
  for (const word of ['SERVER_', 'checkout', 'NEEDS_TARGET', 'PLAN-', 'SPEC-'])
    assert.ok(!text.includes(word), `${word} in ${text}`);
  await dialog.getByRole('button', { name: '반영', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await model.getByText(/서버에 반영했습니다 · 서버 판 \d\d:\d\d · 이전 판 보관됨/).waitFor();
  assert.equal(await readFile(join(server, '04 모델', 'A-동.3dm'), 'utf8'), 'edited here');
  const kept = await readdir(join(work, '10_아카이브', '서버반영'));
  assert.equal(kept.length, 1);
  assert.equal(
    await readFile(join(work, '10_아카이브', '서버반영', kept[0], '04 모델', 'A-동.3dm'), 'utf8'),
    'server v1',
  );
  const manifest = JSON.parse(await readFile(join(work, 'project.config.json'), 'utf8'));
  assert.equal(manifest.server.targets.rhino, '04 모델');
  // Released: the badge and the local row go, [체크아웃] is back.
  await model.getByRole('button', { name: '체크아웃' }).waitFor();
  assert.equal(await model.getByText(/ · 이 PC$/).count(), 0);
  assert.deepEqual(errors, []);
  console.log('browser-workspace-checkout: ok');
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(directory, { recursive: true, force: true });
}
