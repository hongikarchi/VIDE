// 대시보드 › 프로젝트 폴더 › 도면 관계 (SPEC-01.11 11, Design SCR-20, PLAN-43 T-200): a folder of
// synthetic drawings is added, [다시 읽기] shows the tree (roots, nested references, missing,
// cycle and duplicate marks, the stored path as the tooltip), [모델에 반영] on the parent links it
// and the drawings it shows (5 files, 4 placed by their insert). The engine runs a fake xref reader;
// no ZWCAD, no real drawing.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { fakeXrefReader, writeSyntheticDrawings } from '../fixtures/xref.mjs';
import { installBrowserSupport } from './browser-support.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-xref-browser-'));
const folder = join(directory, '2601 합성 도면');
await mkdir(folder);
await writeSyntheticDrawings(folder);
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    xrefReader: fakeXrefReader({ delay: 60 }),
    collectOptions: { dwgReader: null },
  });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
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
  const projectId = await page.locator('#project-picker').inputValue();
  await page.locator('.rail [data-workspace-target="dashboard"]').click();
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  await board.locator('details.dash-more, section[aria-label="프로젝트 폴더"]').first().waitFor({
    state: 'attached',
  });
  const more = board.locator('details.dash-more:not([open]) > summary');
  if (await more.count()) await more.click();
  const section = board.getByRole('region', { name: '프로젝트 폴더' });
  // No folder, no 도면 관계.
  await section.getByText('프로젝트 폴더를 정하면 AI가').waitFor();
  assert.equal(await section.getByRole('group', { name: '도면 관계' }).count(), 0);

  await section.getByRole('button', { name: '폴더 추가' }).click();
  await section.getByRole('textbox', { name: '폴더 경로' }).fill(folder);
  await section.getByRole('button', { name: '추가', exact: true }).click();
  const xref = section.getByRole('group', { name: '도면 관계' });
  await xref.getByText('외부 참조(xref)를 읽어').waitFor();
  await xref.getByRole('button', { name: '다시 읽기' }).click();
  await xref
    .getByRole('status')
    .getByText(/도면 읽는 중/)
    .waitFor();
  await xref.getByText(/마지막 읽기 \d+\/\d+ \d\d:\d\d/).waitFor({ timeout: 20000 });
  await xref.getByText('관계 있는 도면 2 · 관계 없는 도면 1').waitFor();
  const tree = xref.getByRole('tree', { name: '도면 관계 트리' });
  const roots = tree.locator(':scope > li');
  assert.deepEqual(await roots.evaluateAll((items) => items.map((li) => li.ariaLabel)), [
    'loop-a.dwg',
    'parent.dwg',
  ]);
  const parent = tree.getByRole('treeitem', { name: 'parent.dwg', exact: true });
  const children = parent.locator(':scope > ul > li');
  assert.deepEqual(await children.evaluateAll((items) => items.map((li) => li.ariaLabel)), [
    'child.dwg',
    'child.dwg',
    'grand.dwg',
    'beam.dwg',
    'missing.dwg',
  ]);
  const missing = parent.getByRole('treeitem', { name: 'missing.dwg' });
  await missing.getByText('누락', { exact: true }).waitFor();
  assert.match(
    await missing.locator('.dash-xref-name').getAttribute('title'),
    /저장된 경로: Z:\\없는 폴더\\missing\.dwg/,
  );
  await parent.locator(':scope > ul > li').nth(1).getByText('중복', { exact: true }).waitFor();
  await parent.getByRole('treeitem', { name: 'grand.dwg' }).getByText('오버레이').waitFor();
  assert.match(
    await parent
      .getByRole('treeitem', { name: 'beam.dwg' })
      .locator('.dash-xref-name')
      .getAttribute('title'),
    /상위 도면과 같은 폴더/,
  );
  await parent.getByRole('treeitem', { name: 'nested.dwg' }).first().waitFor();
  await tree
    .getByRole('treeitem', { name: 'loop-a.dwg', exact: true })
    .getByText('순환', { exact: true })
    .waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-xref-tree.png') });

  // [모델에 반영] on the parent: it and the drawings it shows become linked files.
  await xref.getByRole('button', { name: 'parent.dwg 모델에 반영' }).click();
  await xref.getByText('모델에 반영함 · parent.dwg 포함 연결 파일 5개').waitFor({ timeout: 20000 });
  const links = await page.evaluate(
    async (id) => (await fetch(`/api/v1/projects/${id}/links`)).json(),
    projectId,
  );
  assert.equal(links.length, 5);
  assert.equal(links.filter((link) => link.placement).length, 4);
  assert.equal(links.filter((link) => link.lastSync).length, 5);
  // The dashboard's 연결 파일 shows them.
  const linked = board.getByRole('region', { name: '연결 파일', exact: true });
  for (const name of ['parent.dwg', 'child.dwg', 'nested.dwg', 'grand.dwg', 'beam.dwg'])
    await linked.getByText(name, { exact: true }).waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-xref-applied.png') });

  // The viewport draws a placed file in the root's coordinates (display only): child's line
  // (0,0)–(0.5,0) m lands on (1,0)–(1,1) m; a click there picks it.
  const child = links.find((link) => link.name === 'child.dwg');
  const view = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  view.on('pageerror', (error) => errors.push(error.message));
  await installBrowserSupport(view, { fixtures: true });
  await view.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await view.goto(app.launchUrl);
  await view.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const at = await view.evaluate(async (placement) => {
    const { createViewport } = await import('/__test__/fixture.mjs');
    const container = document.createElement('div');
    Object.assign(container.style, { position: 'fixed', inset: '50px', zIndex: '10000' });
    document.body.append(container);
    const picks = [];
    const viewport = createViewport(
      container,
      [],
      (ids) => picks.push(ids),
      () => {},
    );
    window.xrefPicks = picks;
    const line = { line: [0, 0, 0, 0.5, 0, 0], vertices: [], indices: [] };
    viewport.replace([
      { id: 'root', line: [0, 0, 0, 2, 0, 0], vertices: [], indices: [] },
      { id: 'placed', ...line, placement },
    ]);
    return viewport.screenOf([1, 0.75, 0]);
  }, child.placement);
  await view.mouse.click(at.x, at.y);
  assert.deepEqual(await view.evaluate(() => window.xrefPicks.at(-1)), ['placed']);
  await view.close();

  assert.deepEqual(errors, []);
  console.log('xref browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
