// 보고서 두 등급 · [보고용 만들기] on screen (PLAN-54 T-342, SPEC-07.11 두 등급, Design SCR-40):
// 산출물 → 보고서 shows a computed 건축개요 report as 검토용 with its work-folder line ('폴더에 씀
// · 05_검토/…'), [보고용] dim until one is made; [보고용 만들기] opens the range dialog with the
// frame's public sections checked and the first-page summary locked, a live paper preview and the
// save location following the title; [만들기] switches to the 보고용 page (the engine's own page in
// a frame) with the run it came from, where it was saved and the [공유] slot; that paper has no
// internal ids, no [S#], no settings controls and no 'VIDE에서 열기'; a result not computed yet has
// [보고용 만들기] off with the reason. The mass instance and the 건축개요 are seeded through the
// runtime on the same data folder (tests/fixtures/summary-chain.mjs); no host, no CLI.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { closeJigRuntime, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { dayOf } from '../../src/core/workspace-paths.ts';
import { seedMassInstance } from '../fixtures/summary-chain.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-report-tiers-'));
// The work folder lives outside the engine's data folder.
const outside = await mkdtemp(join(tmpdir(), 'vide-report-tiers-ws-'));
let app, browser, seeded;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
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
  const projectId = await page.locator('#project-picker').inputValue();

  // A computed 건축개요 and one not computed yet (same store, same data folder).
  seeded = new Workspace(app.store);
  const runtime = jigRuntimeFor(seeded, directory);
  await seedMassInstance(runtime, projectId, '매스 A');
  const summary = await runtime.createInstance(projectId, {
    jig: 'vide/building-summary',
    title: '개요 A',
    layerRoot: 'VIDE::개요',
  });
  const run = await runtime.run(projectId, summary.id, { mode: 'confirmed' });
  assert.equal(run.steps.find((s) => s.id === 'check')?.status, 'done');
  await runtime.createInstance(projectId, {
    jig: 'vide/building-summary',
    title: '개요 B',
    layerRoot: 'VIDE::개요',
  });

  // The project's work folder: 05_검토 and 06_산출물.
  const root = join(outside, '2601 작업');
  await mkdir(root);
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      title: '시험 작업',
      paths: { review: '05_검토', output: '06_산출물' },
      vide: { projectId, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  const added = await page.evaluate(
    async ({ id, path }) =>
      await fetch(`/api/v1/projects/${id}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      }).then(async (r) => ({ status: r.status, text: await r.text() })),
    { id: projectId, path: root },
  );
  assert.equal(added.status, 200, added.text);

  // 산출물 → 보고서 → 개요 A.
  await page.locator('.rail [data-workspace-target="output"]').click();
  const views = page.getByRole('tablist', { name: '산출물 종류' });
  await views.getByRole('tab', { name: '보고서', exact: true }).click();
  const screen = page.locator('.output-workspace .report-workspace');
  await screen.locator('.report-group', { hasText: '개요 A' }).getByRole('button').first().click();
  await screen.locator('.kit-report').waitFor();
  const tiers = screen.getByRole('group', { name: '보고서 등급' });
  assert.equal(
    await tiers.getByRole('button', { name: '검토용' }).getAttribute('aria-pressed'),
    'true',
  );
  const publicTier = tiers.getByRole('button', { name: '보고용' });
  assert.equal(await publicTier.isDisabled(), true);
  assert.equal(await publicTier.getAttribute('title'), '아직 만든 보고용이 없습니다');
  // The 검토용 copy's line (the copy may still be writing on the first read: read again once).
  const folderLine = screen.locator('[data-folder-line]');
  await folderLine.waitFor();
  if (!/폴더에 씀/.test(await folderLine.textContent())) {
    await screen.getByRole('button', { name: '다시 만들기' }).click();
    await screen.locator('[data-folder-line]', { hasText: '폴더에 씀' }).waitFor();
  }
  assert.match(await folderLine.textContent(), /^폴더에 씀 · 05_검토\/building-summary\/\d{4}-/);
  assert.equal(await screen.locator('#report-publish-slot').count(), 0);

  // [보고용 만들기] → the range dialog.
  await screen.getByRole('button', { name: '보고용 만들기' }).click();
  const dialog = page.getByRole('dialog', { name: '보고용 만들기' });
  await dialog.waitFor();
  const box = (name) => dialog.getByRole('checkbox', { name });
  assert.equal(await box(/첫 쪽 가정·미검토 요약/).isChecked(), true);
  assert.equal(await box(/첫 쪽 가정·미검토 요약/).isDisabled(), true);
  const boxes = dialog.locator('.report-make-list li:not([data-locked]) input');
  const states = await boxes.evaluateAll((all) => all.map((b) => b.checked));
  // overview · floors · check are public; sources is not.
  assert.deepEqual(states, [true, true, true, false]);
  const preview = dialog.frameLocator('iframe[title="보고용 미리보기"]');
  await preview.locator('h1').waitFor();
  assert.equal(await preview.locator('section').count(), 3);
  const today = dayOf(new Date());
  const saveAt = dialog.locator('[data-save-at]');
  assert.equal(await saveAt.textContent(), `저장 위치 · 06_산출물/${today}-건축개요 보고서/`);
  // Fewer sections, another title: the preview and the location follow.
  await boxes.nth(2).uncheck();
  await dialog.getByLabel('제목').fill('개요 보고');
  assert.equal(await saveAt.textContent(), `저장 위치 · 06_산출물/${today}-개요 보고/`);
  await page.waitForFunction(
    () =>
      document
        .querySelector('.report-make-preview iframe')
        ?.contentDocument?.querySelectorAll('section').length === 2,
  );
  await dialog.getByRole('button', { name: '모두' }).click();
  assert.deepEqual(await boxes.evaluateAll((all) => all.map((b) => b.checked)), [
    true,
    true,
    true,
    true,
  ]);
  await dialog.getByRole('button', { name: '공개 절만' }).click();
  await boxes.nth(2).uncheck();
  if (shot) await page.screenshot({ path: join(shot, 'report-make.png') });
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });

  // The 보고용: its head, the [공유] slot and the engine's page.
  assert.equal(await publicTier.getAttribute('aria-pressed'), 'true');
  const head = screen.locator('[data-public-head]');
  await head.waitFor();
  assert.match(
    await head.locator('.report-line').textContent(),
    new RegExp(
      `^검토용 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} 회차에서 만듦 · 06_산출물/${today}-개요 보고$`,
    ),
  );
  assert.equal(await screen.locator('#report-publish-slot').count(), 1);
  assert.ok(await head.getByRole('button', { name: '같은 범위로 다시 만들기' }).isEnabled());
  const paper = screen.frameLocator('iframe.report-public-frame');
  await paper.locator('h1').waitFor();
  const text = await paper.locator('body').innerText();
  assert.doesNotMatch(text, /VIDE에서 열기|\[S\d|조건 조정|설정값 원장|이 설정값으로 돌아가기/);
  assert.doesNotMatch(text, /claim-consistent|numbers-in-source|unchecked-listed|요청 #/);
  assert.ok(!text.includes(summary.id), 'no full instance id');
  assert.match(text, /검토하지 않은 항목/);
  assert.equal(await paper.locator('section').count(), 2);
  assert.equal(await paper.locator('button, input, select, script').count(), 0);
  if (shot) await page.screenshot({ path: join(shot, 'report-public.png') });

  // On disk: `06_산출물/<날짜>-개요 보고/` with the page, the tables and report.json.
  const folder = join(root, '06_산출물', `${today}-개요 보고`);
  const files = await readdir(folder);
  assert.ok(files.includes('index.html') && files.includes('report.json'), files.join());
  assert.ok(
    files.some((f) => f.endsWith('.csv')),
    files.join(),
  );
  const meta = JSON.parse(await readFile(join(folder, 'report.json'), 'utf8'));
  assert.deepEqual(meta.sections, ['overview', 'floors']);
  assert.equal(meta.sourceRun.instanceId, summary.id);

  // [HTML 저장] keeps that page.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    screen.getByRole('button', { name: 'HTML 저장' }).click(),
  ]);
  const html = await readFile(await download.path(), 'utf8');
  assert.doesNotMatch(html, /<script|VIDE에서 열기/);

  // 같은 범위로 다시 만들기: a second folder (-2), shown at once.
  await head.getByRole('button', { name: '같은 범위로 다시 만들기' }).click();
  await head.locator('.report-line', { hasText: `${today}-개요 보고-2` }).waitFor();
  assert.ok(existsSync(join(root, '06_산출물', `${today}-개요 보고-2`)));
  assert.equal(await screen.getByLabel('만든 보고용').locator('option').count(), 2);

  // Back to 검토용: no [공유].
  await tiers.getByRole('button', { name: '검토용' }).click();
  await screen.locator('.kit-report').waitFor();
  assert.equal(await screen.locator('#report-publish-slot').count(), 0);

  // A result not computed yet: [보고용 만들기] is off, with the reason.
  await screen.locator('.report-group', { hasText: '개요 B' }).getByRole('button').first().click();
  await screen.locator('[data-make-refused]').waitFor();
  assert.match(await screen.locator('[data-make-refused]').textContent(), /계산/);
  assert.equal(await screen.getByRole('button', { name: '보고용 만들기' }).isDisabled(), true);
  assert.equal(await publicTier.isDisabled(), true);

  // Narrow screen: no sideways scrolling.
  await page.setViewportSize({ width: 390, height: 800 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 391));

  assert.deepEqual(errors, []);
  console.log('Report tier checks passed');
} finally {
  if (seeded) await closeJigRuntime(seeded);
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  await rm(outside, { recursive: true, force: true, maxRetries: 3 });
}
