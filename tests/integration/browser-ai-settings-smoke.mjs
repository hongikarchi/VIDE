// The AI settings dialog's project addendum editor (PLAN-24 지침 묶음): type, save, reload, read back;
// the AI가 작업 도중에 묻기 switch (T-075) and the AI 웹 검색 switch (T-105): on by default, off kept
// across a reload.
// Synthetic engine and provider; no model requests or host writes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const root = await mkdtemp(join(tmpdir(), 'vide-ai-settings-smoke-'));
let app, browser;
try {
  app = await startServer({
    filename: join(root, 'test.sqlite'),
    providerFactory: () => ({
      status: async () => ({ available: true }),
      run: async () => ({ text: '{}' }),
    }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  const open = async () => {
    await page.locator('#workspace-settings').click();
    await page.locator('[data-tab="ai"]').click();
    await page.locator('#ai-settings').click();
    const editor = page.getByRole('textbox', { name: '프로젝트 AI 지침', exact: true });
    await editor.waitFor();
    await page.waitForFunction(
      () => !document.querySelector('.ai-instructions textarea')?.disabled,
    );
    return editor;
  };
  await page.goto(app.launchUrl);
  const text = '구조 레이어는 STR:: 아래에 둔다.\n치수는 mm로 답한다.';
  let editor = await open();
  assert.equal(await editor.inputValue(), '');
  const section = page.locator('section.ai-instructions');
  const saveButton = section.getByRole('button', { name: '지침 저장', exact: true });
  assert.ok(await saveButton.isDisabled(), 'unchanged text cannot be saved');
  await editor.fill(text);
  await saveButton.click();
  await section
    .getByRole('status')
    .filter({ hasText: '저장했습니다. 다음 요청부터 적용됩니다.' })
    .waitFor();
  assert.ok(await saveButton.isDisabled(), 'saved text disables the button');
  await page.reload();
  editor = await open();
  assert.equal(await editor.inputValue(), text);
  // Over the 8 KB limit the button stays disabled.
  await editor.fill('가'.repeat(3000));
  assert.ok(await saveButton.isDisabled(), 'over-limit text cannot be saved');
  // Reference image check (SPEC-09.7 6, 09.10 1): the OpenAI notice and the project's switch.
  const reference = page.locator('section.ai-reference-images');
  assert.match(await reference.textContent(), /OpenAI로도 갑니다/);
  const imagesSwitch = reference.getByRole('checkbox', {
    name: '참고 이미지 확인에서 이미지 생성',
  });
  await page.waitForFunction(() => !document.querySelector('.ai-reference-images input')?.disabled);
  assert.ok(await imagesSwitch.isChecked(), 'on by default');
  await imagesSwitch.click();
  await reference.getByRole('status').filter({ hasText: '이미지를 만들지 않습니다' }).waitFor();
  const projectId = await page.locator('#project-picker').inputValue();
  const stored = await page.evaluate(
    async (id) => (await fetch(`api/v1/projects/${id}/reference-settings`)).json(),
    projectId,
  );
  assert.deepEqual(stored, { images: false });
  // AI가 작업 도중에 묻기 (T-075): on by default; off is kept across a reload.
  const questions = page.getByRole('checkbox', { name: 'AI가 작업 도중에 묻기', exact: true });
  await page.waitForFunction(() => !document.querySelector('.ai-questions input')?.disabled);
  assert.ok(await questions.isChecked(), 'questions are on by default');
  // A controlled switch: it changes once the engine answered the PUT.
  await questions.click();
  await page
    .locator('section.ai-questions')
    .getByRole('status')
    .filter({ hasText: '작업을 먼저 마친 뒤 질문을 남깁니다' })
    .waitFor();
  await page.reload();
  await open();
  await page.waitForFunction(() => !document.querySelector('.ai-questions input')?.disabled);
  assert.ok(!(await questions.isChecked()), 'off stays off after a reload');
  // AI 웹 검색 (ADR-028, T-105): on by default; off is kept across a reload.
  const web = page.getByRole('checkbox', { name: 'AI 웹 검색', exact: true });
  await page.waitForFunction(() => !document.querySelector('.ai-web input')?.disabled);
  assert.ok(await web.isChecked(), 'web is on by default');
  await web.click();
  await page
    .locator('section.ai-web')
    .getByRole('status')
    .filter({ hasText: 'AI는 웹을 쓰지 않습니다' })
    .waitFor();
  await page.reload();
  await open();
  await page.waitForFunction(() => !document.querySelector('.ai-web input')?.disabled);
  assert.ok(!(await web.isChecked()), 'web off stays off after a reload');
  console.log(
    JSON.stringify({
      addendumSaved: true,
      reloaded: true,
      overLimitBlocked: true,
      referenceImagesOff: true,
      questionsDefaultOn: true,
      questionsOffKept: true,
      webDefaultOn: true,
      webOffKept: true,
    }),
  );
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
