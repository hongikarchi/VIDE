import { installBrowserSupport } from './browser-support.mjs';
// Verify real CLI status and reversible path settings; no model requests or host writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch] = process.argv.slice(2),
  { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
let original, saved, page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await installBrowserSupport(page);
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  original = await page.evaluate(async () => {
    const api = window.testApi;
    return api('/settings/ai');
  });
  assert.ok(original.resolved['codex-cli']);
  await page.getByLabel('초안 메뉴').click();
  await page.getByRole('button', { name: 'AI 연결 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 연결 설정', exact: true });
  await dialog.waitFor();
  await dialog.getByLabel('Codex · ChatGPT 실행 경로').fill(original.resolved['codex-cli']);
  await dialog.getByRole('button', { name: '설정 저장', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '설정을 저장했습니다.' }).waitFor();
  saved = await page.evaluate(async () => {
    const api = window.testApi;
    return api('/settings/ai');
  });
  assert.equal(saved.revision, original.revision + 1);
  assert.ok(saved.paths['codex-cli']);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.getByLabel('초안 메뉴').click();
  await page.getByRole('button', { name: 'AI 연결 설정', exact: true }).click();
  await dialog.waitFor();
  assert.equal(
    await dialog.getByLabel('Codex · ChatGPT 실행 경로').inputValue(),
    saved.paths['codex-cli'],
  );
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('dialog.ai-settings button')).find(
        (button) => button.textContent === '연결 확인',
      ).disabled,
  );
  const statusRows = await page.evaluate(() => window.testApi('/providers'));
  assert.equal(
    await dialog.getByText('구독 로그인 확인됨', { exact: true }).count(),
    statusRows.filter((row) => row.available).length,
  );
  await page.screenshot({ path: 'docs/assets/native-workspace/ai-settings.png' });
  await dialog.getByLabel('Codex · ChatGPT 실행 경로').fill('C:/VIDE-nonexistent/codex.exe');
  await dialog.getByRole('button', { name: '설정 저장', exact: true }).click();
  await dialog
    .getByRole('status')
    .filter({ hasText: '해당 경로에 실행 파일이 없습니다.' })
    .waitFor();
  const after = await page.evaluate(async () => {
    const api = window.testApi;
    return api('/settings/ai');
  });
  assert.equal(after.revision, saved.revision);
  assert.deepEqual(after.paths, saved.paths);
  const providers = await page.evaluate(async () => {
    const api = window.testApi;
    return api('/providers');
  });
  assert.equal(providers.length, 2);
  console.log(
    JSON.stringify({
      persisted: true,
      invalidPathPreserved: true,
      providers: providers.map(({ id, available }) => ({ id, available })),
    }),
  );
} finally {
  if (saved && page)
    await page.evaluate(
      async ({ original, saved }) => {
        const api = window.testApi;
        const current = await api('/settings/ai');
        if (current.revision === saved.revision)
          await api('/settings/ai', 'PUT', { revision: current.revision, paths: original.paths });
      },
      { original, saved },
    );
  await browser.close();
}
