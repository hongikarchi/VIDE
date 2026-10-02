// Playwright-only helpers. No test endpoint or source export is added to VIDE.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
let fixture;
export async function installBrowserSupport(page, { fixtures = false } = {}) {
  await page.addInitScript(() => {
    window.testApi = async (path, method = 'GET', data) => {
      const response = await fetch('/api/v1' + path, {
        method,
        headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(result.code || 'REQUEST_FAILED'), {
          code: result.code || 'REQUEST_FAILED',
        });
      return result;
    };
  });
  if (!fixtures) return;
  fixture ??= build({
    configFile: false,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL('./browser-fixture.mjs', import.meta.url)),
        formats: ['es'],
        fileName: 'fixture',
      },
      rollupOptions: { output: { codeSplitting: false } },
    },
  }).then((result) => {
    const output = (Array.isArray(result) ? result[0] : result).output;
    const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
    if (!entry) throw new Error('Missing browser fixture bundle');
    return entry.code;
  });
  const code = await fixture;
  await page.route('**/__test__/fixture.mjs', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: code }),
  );
}
/**
 * The saved 검토본 list (T-109): it lives in 산출물 › 검토본, not in the work history. Opens that
 * view and returns the list.
 */
export async function savedReviews(page) {
  await page.locator('.rail [data-workspace-target="output"]').click();
  await page
    .getByRole('tablist', { name: '산출물 종류' })
    .getByRole('tab', { name: '검토본', exact: true })
    .click();
  const list = page.locator('.output-pane-review');
  await list.waitFor();
  return list;
}
