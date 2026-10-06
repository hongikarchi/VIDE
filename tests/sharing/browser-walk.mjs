// Walk mode on the account site's model viewer (PLAN-37 T-173): the shared Model component alone,
// served by vite, with a synthetic scene. 걷기 shows the bar, keys move the eye, a click still
// selects and places a pin, Escape returns to 원근.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../..', import.meta.url));
// Inside the repo (node_modules/.cache, ignored) so the harness resolves the repo's packages.
const root = await mkdtemp(join(repo, 'node_modules/.cache/vide-site-walk-'));
const model = join(repo, 'src/sharing/web/model.tsx').replaceAll('\\', '/');
await writeFile(
  join(root, 'index.html'),
  '<!doctype html><meta charset="utf-8"><div id="root" style="position:fixed;inset:0;display:flex"></div><script type="module" src="./main.tsx"></script>',
);
await writeFile(
  join(root, 'main.tsx'),
  `import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Model } from '/@fs/${model}';
import '/@fs/${model.replace('model.tsx', 'style.css')}';
const box = (id, [x0, y0, z0], [x1, y1, z1]) => ({
  id,
  geometry: {
    type: 'mesh',
    positions: [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1],
    indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  },
});
const scene = {
  format: 'vide-public-scene-v1',
  unit: 'm',
  objects: [box('ground', [-10, -10, -0.2], [10, 10, 0]), box('wall', [4, -10, 0], [4.2, 10, 3])],
};
window.events = [];
function App() {
  const [selected, setSelected] = useState(null);
  return (
    <Model
      model={scene}
      selected={selected}
      editable
      onSelect={(id) => {
        window.events.push(['select', id]);
        setSelected(id);
      }}
      onPin={(pin, id) => window.events.push(['pin', id])}
    />
  );
}
createRoot(document.getElementById('root')).render(<App />);
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
    resolve: { dedupe: ['react', 'react-dom', 'three'] },
    optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(20000);
  await page.goto(url);
  await page.locator('canvas').waitFor();
  await page.getByRole('button', { name: '걷기', exact: true }).click();
  await page.locator('.model-area .walk-bar').waitFor();
  assert.equal(await page.locator('canvas').getAttribute('data-walk'), 'true');
  // While walking a click on the ground ahead still selects it and, with 핀, pins it.
  await page.getByRole('button', { name: '핀', exact: true }).click();
  const rect = await page.locator('canvas').boundingBox();
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height * 0.8);
  await page.waitForFunction(() => window.events.some(([kind]) => kind === 'pin'));
  // Keys walk; Escape leaves walk mode for 원근.
  await page.locator('canvas').focus();
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.keyboard.press('Escape');
  await page.locator('.model-area .walk-bar').waitFor({ state: 'detached' });
  assert.equal(
    await page.getByRole('button', { name: '원근', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  const events = await page.evaluate(() => window.events);
  console.log(JSON.stringify(events));
  assert.ok(events.some(([kind]) => kind === 'select'));
  assert.deepEqual(errors, []);
  console.log('sharing browser-walk: ok');
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
