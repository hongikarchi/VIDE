// Playwright-only helpers. No test endpoint or source export is added to VIDE.
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
let fixture;
export async function installBrowserSupport(page, {fixtures = false} = {}) {
  await page.addInitScript(() => {
    window.testApi = async (path, method = 'GET', data) => {
      const response = await fetch('/api/v1' + path, {
        method, headers: data === undefined ? {} : {'Content-Type': 'application/json'},
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.code || 'REQUEST_FAILED'), {code: result.code || 'REQUEST_FAILED'});
      return result;
    };
  });
  if (!fixtures) return;
  fixture ??= build({configFile:false,logLevel:'error',build:{write:false,minify:false,lib:{
    entry:fileURLToPath(new URL('./browser-fixture.mjs',import.meta.url)),formats:['es'],fileName:'fixture',
  },rollupOptions:{output:{codeSplitting:false}}}}).then(result => {
    const output = (Array.isArray(result) ? result[0] : result).output;
    const entry = output.find(item => item.type === 'chunk' && item.isEntry);
    if (!entry) throw new Error('Missing browser fixture bundle');
    return entry.code;
  });
  const code = await fixture;
  await page.route('**/__test__/fixture.mjs', route => route.fulfill({contentType:'text/javascript',body:code}));
}
