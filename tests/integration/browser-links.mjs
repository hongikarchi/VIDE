// Linked files (SPEC-01.11): several files in one space, visibility, target file, pins by the file's
// own id, removal, and the first Sync of a newly linked file. No real host or AI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const directory = await mkdtemp(join(tmpdir(), 'vide-links-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
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
  const b64 = (text) => Buffer.from(text).toString('base64');
  const now = Date.now();
  const at = (s) => new Date(now - s * 1000).toISOString();
  const link = (id, host, name, s) =>
    app.store.db
      .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
      .run(id, projectId, host, name, 'C:\\p\\' + name, '1:2', 1, at(s), at(s));
  const sync = (id, linkId, host, name, ids, s) => {
    const scene = ids.map((objectId, i) => ({
      id: objectId,
      nativeId: objectId.replace('cad-', ''),
      nativeType: host === 'zwcad' ? 'Line' : 'Curve',
      segments: [i, 0, 0, i + 1, 0, 0],
      layer64: b64(host === 'zwcad' ? 'S-BEAM' : 'girder'),
    }));
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      id,
      projectId,
      JSON.stringify({
        id,
        linkId,
        provider: 'codex-cli',
        host,
        source: 'document',
        permission: 'candidate',
        body: name + ' 가져오기',
        pins: [],
        sketches: [],
        files: [],
      }),
      'succeeded',
      JSON.stringify({
        hostExecuted: true,
        executionMode: 'sdk',
        host,
        displayOnly: true,
        objects: scene.map((item) => ({
          id: item.id,
          name: name + ' ' + item.nativeId,
          kind: 'native',
          nativeId: item.nativeId,
        })),
        scene,
        sourceDocument: { name, capturedAt: at(s), instance: '1:2', documentId: 1 },
      }),
      at(s),
    );
  };
  link('link-rhino', 'rhino', 'model.3dm', 50);
  link('link-plan-1', 'zwcad', 'plan-1.dwg', 40);
  link('link-plan-2', 'zwcad', 'plan-2.dwg', 30);
  sync('sync-rhino', 'link-rhino', 'rhino', 'model.3dm', ['r-1'], 45);
  // Both drawings use the same handle: they must stay apart on screen.
  sync('sync-plan-1', 'link-plan-1', 'zwcad', 'plan-1.dwg', ['cad-20', 'cad-21'], 35);
  sync('sync-plan-2', 'link-plan-2', 'zwcad', 'plan-2.dwg', ['cad-20'], 25);

  const links = await page.evaluate(
    async (id) => (await fetch(`/api/v1/projects/${id}/links`)).json(),
    projectId,
  );
  assert.deepEqual(
    links.map((row) => [row.name, row.lastSync?.requestId, row.connection]),
    [
      ['model.3dm', 'sync-rhino', null],
      ['plan-1.dwg', 'sync-plan-1', null],
      ['plan-2.dwg', 'sync-plan-2', null],
    ],
  );
  await page.reload();
  await page.locator('.link-row').nth(2).waitFor();
  assert.match(await page.locator('.link-row').first().textContent(), /model\.3dm.*닫힘.*Sync/);
  // Every visible file is drawn together; the object tree groups by file.
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('4개 객체'),
  );
  // Each file's name heads its own layers.
  const files = await page.locator('#objects .layer-file').allTextContents();
  assert.deepEqual(files, ['model.3dm', 'plan-1.dwg', 'plan-2.dwg']);
  const layers = await page
    .locator('#objects .layer')
    .evaluateAll((nodes) =>
      nodes.map(
        (node) =>
          node.previousElementSibling?.className +
          '|' +
          node.querySelector('.layer-name').textContent,
      ),
    );
  assert.ok(layers.some((row) => row.endsWith('|girder')));
  assert.equal(layers.filter((row) => row.endsWith('|S-BEAM')).length, 2);
  // A layer row opens its objects.
  for (const row of await page.locator('#objects .layer-row').all()) await row.click();
  // Hiding a file removes it from the space and is kept for the project.
  await page.getByRole('button', { name: 'plan-2.dwg 숨기기' }).click();
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('3개 객체'),
  );
  await page.waitForFunction(
    async (id) =>
      (await (await fetch(`/api/v1/projects/${id}/links`)).json()).find(
        (row) => row.name === 'plan-2.dwg',
      ).hidden === true,
    projectId,
  );
  // Picking an object of a file makes that file the request target; pins use the file's own id.
  await page.locator('#objects .object').filter({ hasText: 'plan-1.dwg 20' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.link-row[aria-current="true"]')?.dataset.linkId === 'link-plan-1',
  );
  await page.locator('#body').fill('이 보를 옮겨줘 ');
  await page.locator('#attach-menu summary').click();
  await page.locator('#pin').click();
  await page.locator('#context .target-file').filter({ hasText: 'plan-1.dwg' }).waitFor();
  const draft = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)),
    projectId,
  );
  assert.equal(draft.baseRequestId, 'sync-plan-1');
  assert.equal(draft.host, 'zwcad');
  assert.deepEqual(
    draft.pins.map((pin) => [pin.id, pin.basis, pin.role]),
    [['cad-20', 'sync-plan-1', 'target']],
  );
  // An object of another file joins as a reference.
  await page.locator('#objects .object').filter({ hasText: 'model.3dm r-1' }).click();
  await page.locator('#attach-menu summary').click();
  await page.locator('#pin').click();
  const withReference = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)),
    projectId,
  );
  assert.deepEqual(
    withReference.pins.map((pin) => [pin.id, pin.basis, pin.role]),
    [
      ['cad-20', 'sync-plan-1', 'target'],
      ['r-1', 'sync-rhino', 'reference'],
    ],
  );
  await page.screenshot({ path: join(directory, 'links.png') });
  // Removing a file deletes its Sync record (SPEC-01.11 9) and drops the pin that used it.
  await page.getByRole('button', { name: 'model.3dm 연결 해제' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.link-row').length === 2);
  await page.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem('vide:draft:' + id)).pins.every(
        (pin) => pin.basis !== 'sync-rhino',
      ),
    projectId,
  );
  assert.equal(
    app.store.db.prepare("SELECT count(*) AS n FROM workspace_requests WHERE id='sync-rhino'").get()
      .n,
    0,
  );

  // A newly linked open file gets its first Sync without any click.
  let captured;
  const newLink = {
    id: 'link-new',
    host: 'rhino',
    name: 'new.3dm',
    path: 'C:\\p\\new.3dm',
    hidden: false,
    connection: {
      instance: '7:8',
      documentId: 3,
      live: true,
      generation: 1,
      objectCount: 1,
      units: 'Meters',
      modified: false,
      hostBusy: false,
    },
    lastSync: null,
  };
  await page.route('**/api/v1/projects/*/links', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const real = await (await route.fetch()).json();
    await route.fulfill({
      json: [
        ...real,
        captured ? { ...newLink, lastSync: { requestId: captured.id, at: at(0) } } : newLink,
      ],
    });
  });
  await page.route('**/api/v1/projects/*/capture', async (route) => {
    captured = route.request().postDataJSON();
    const input = {
      id: captured.id,
      linkId: captured.linkId,
      provider: 'codex-cli',
      host: 'rhino',
      source: 'document',
      permission: 'candidate',
      body: 'new.3dm 가져오기',
      pins: [],
      sketches: [],
      files: [],
    };
    await route.fulfill({
      json: {
        id: captured.id,
        input,
        state: 'succeeded',
        createdAt: at(0),
        result: {
          hostExecuted: true,
          executionMode: 'sdk',
          host: 'rhino',
          displayOnly: true,
          objects: [{ id: 'n-1', name: 'new 1', kind: 'native', nativeId: 'n-1' }],
          scene: [
            { id: 'n-1', nativeId: 'n-1', nativeType: 'Curve', segments: [0, 1, 0, 1, 1, 0] },
          ],
          sourceDocument: { name: 'new.3dm', capturedAt: at(0), instance: '7:8', documentId: 3 },
        },
      },
    });
  });
  await page.locator('.link-row[data-link-id="link-new"]').waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.link-row[data-link-id="link-new"]')?.textContent.includes('Live'),
  );
  await page.waitForFunction(() =>
    document.querySelector('#objects')?.textContent.includes('new.3dm'),
  );
  assert.equal(captured.linkId, 'link-new');
  assert.equal(captured.instance, '7:8');
  assert.equal(captured.documentId, 3);
  assert.deepEqual(errors, []);
  console.log('Linked files checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
