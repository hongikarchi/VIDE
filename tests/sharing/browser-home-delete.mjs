// The account home's delete (T-365, SPEC-01.1 프로젝트 삭제): the menu says '이 PC에서 삭제', and its
// confirm step shows what goes (this PC's project data) and what stays (the site's shared material,
// the work folder's files) before the DELETE is sent. The Home component alone, served by vite.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = await mkdtemp(join(repo, 'node_modules/.cache/vide-site-home-'));
const home = join(repo, 'src/sharing/web/home.tsx').replaceAll('\\', '/');
await writeFile(
  join(root, 'index.html'),
  '<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="./main.tsx"></script>',
);
await writeFile(
  join(root, 'main.tsx'),
  `import { createRoot } from 'react-dom/client';
import { Home } from '/@fs/${home}';
import '/@fs/${home.replace('home.tsx', 'style.css')}';
const project = { id: 'p1', name: '시험 프로젝트', role: 'owner', host_id: null, created_at: Date.now(), updated_at: Date.now(), has_thumbnail: false };
window.refreshed = 0;
const noop = () => {};
createRoot(document.getElementById('root')).render(
  <Home projects={[project]} hosts={[]} thisPc="" refresh={async () => { window.refreshed++; }}
    review={noop} offline={noop} notes={noop} conversations={noop} />,
);
`,
);
let server, browser;
try {
  server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    server: { port: 0, fs: { allow: [repo, root] } },
    resolve: { dedupe: ['react', 'react-dom'] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', 'zod'] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } }),
    errors = [],
    deletes = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.route('**/api/projects/p1', async (route) => {
    deletes.push(route.request().method());
    await route.fulfill({ json: { deleted: true } });
  });
  await page.goto(url);
  await page.getByRole('button', { name: '시험 프로젝트 메뉴', exact: true }).click();
  assert.equal(await page.getByText('목록에서 삭제').count(), 0);
  await page.getByRole('menuitem', { name: '이 PC에서 삭제…', exact: true }).click();
  const note = page.locator('.card-menu-note');
  assert.equal(
    await note.innerText(),
    '지우는 것: 이 PC의 프로젝트 데이터·자료 DB·기록\n남는 것: 사이트의 공유 자료·구성원 노트, 작업 폴더의 파일',
  );
  assert.deepEqual(deletes, [], 'nothing is deleted before the confirm');
  await page.getByRole('menuitem', { name: '이 PC에서 삭제 확인', exact: true }).click();
  await page.waitForFunction(() => window.refreshed === 1);
  assert.deepEqual(deletes, ['DELETE']);
  assert.deepEqual(errors, []);
  console.log('sharing browser-home-delete: ok');
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
