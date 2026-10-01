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
  // Picking an object of a file makes that file the starting document; pins use the file's own id.
  await page.locator('#objects .object').filter({ hasText: 'plan-1.dwg 20' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('.link-row[aria-current="true"]')?.dataset.linkId === 'link-plan-1',
  );
  await page.locator('#body').fill('이 보를 옮겨줘 ');
  await page.locator('#selection-pin').click();
  // No target-file chip: which linked files a request changes is the AI's (T-103).
  assert.equal(await page.locator('#context .target-file').count(), 0);
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
  // An object of another file is a change pin too, not a reference (SPEC-01.11 5, T-103).
  await page.locator('#objects .object').filter({ hasText: 'model.3dm r-1' }).click();
  await page.locator('#selection-pin').click();
  const withOther = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id)),
    projectId,
  );
  assert.deepEqual(
    withOther.pins.map((pin) => [pin.id, pin.basis, pin.role]),
    [
      ['cad-20', 'sync-plan-1', 'target'],
      ['r-1', 'sync-rhino', 'target'],
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
  // Hidden files leave the space on every start (SPEC-01.11 4, T-096): with no saved draft, and
  // with a draft whose basis is the Sync that was on screen when VIDE last closed.
  await hiddenStart(browser, false);
  await hiddenStart(browser, true);
  console.log('Linked files checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

async function hiddenStart(browser, draftBase) {
  const root = await mkdtemp(join(tmpdir(), 'vide-links-hidden-'));
  const server = await startServer({ filename: join(root, 'test.sqlite') });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    unhidden = [];
  try {
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/links/'))
        if (request.postDataJSON()?.hidden === false) unhidden.push(request.url());
    });
    await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
    await page.route('**/api/v1/providers', (route) =>
      route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
    );
    await page.route('**/api/v1/models', (route) =>
      route.fulfill({
        json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
      }),
    );
    await page.goto(server.launchUrl);
    await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
    const projectId = await page.locator('#project-picker').inputValue();
    const b64 = (text) => Buffer.from(text).toString('base64');
    const now = Date.now();
    const at = (s) => new Date(now - s * 1000).toISOString();
    const link = (id, name, s) =>
      server.store.db
        .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
        .run(id, projectId, 'rhino', name, 'C:\\p\\' + name, '1:2', 1, at(s), at(s));
    const sync = (id, linkId, name, ids, s) => {
      const scene = ids.map((objectId, i) => ({
        id: objectId,
        nativeId: objectId,
        nativeType: 'Curve',
        segments: [i, 0, 0, i + 1, 0, 0],
        layer64: b64('L'),
      }));
      server.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
        id,
        projectId,
        JSON.stringify({
          id,
          ...(linkId ? { linkId } : {}),
          provider: 'codex-cli',
          host: 'rhino',
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
          host: 'rhino',
          displayOnly: true,
          objects: scene.map((item) => ({
            id: item.id,
            name: name + ' ' + item.id,
            kind: 'native',
            nativeId: item.id,
          })),
          scene,
          sourceDocument: { name, capturedAt: at(s), instance: '1:2', documentId: 1 },
        }),
        at(s),
      );
    };
    // A Sync from before links existed belongs to no file.
    sync('old-capture', undefined, 'old.3dm', ['o-1', 'o-2', 'o-3'], 70);
    link('link-a', 'a.3dm', 60);
    link('link-b', 'b.3dm', 50);
    sync('sync-a', 'link-a', 'a.3dm', ['a-1'], 45);
    sync('sync-b', 'link-b', 'b.3dm', ['b-1', 'b-2'], 35);
    const summary = () => page.locator('.object-summary').textContent();
    const shows = (text) =>
      page.waitForFunction(
        (start) => document.querySelector('.object-summary')?.textContent.startsWith(start),
        text,
      );
    const empty = () =>
      page.waitForFunction(() => document.querySelector('#viewport-empty')?.hidden === false);
    const draft = () =>
      page.evaluate((id) => JSON.parse(localStorage.getItem('vide:draft:' + id)), projectId);
    const restart = async () => {
      await page.reload();
      await page.locator('.link-row').nth(1).waitFor();
    };
    if (draftBase) {
      await restart();
      await shows('3개 객체');
      assert.ok((await draft()).baseRequestId, 'the draft keeps the shown Sync as its basis');
    } else await page.evaluate((id) => localStorage.removeItem('vide:draft:' + id), projectId);
    await restart();
    await shows('3개 객체');
    assert.equal(await page.locator('.link-result').count(), 0);
    // Hiding every file empties the space.
    await page.getByRole('button', { name: 'a.3dm 숨기기' }).click();
    await page.getByRole('button', { name: 'b.3dm 숨기기' }).click();
    await empty();
    // ...and it stays empty after a restart; nothing un-hides a file on the engine.
    await restart();
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('#viewport-empty').isHidden(), false, await summary());
    assert.deepEqual(
      await page.locator('.link-row').evaluateAll((rows) => rows.map((row) => row.dataset.hidden)),
      ['true', 'true'],
    );
    assert.deepEqual(unhidden, []);
    // A newer Sync of a visible file replaces its older one; nothing is drawn twice.
    await page.getByRole('button', { name: 'b.3dm 보이기' }).click();
    await shows('2개 객체');
    sync('sync-b2', 'link-b', 'b.3dm', ['b-1'], 5);
    await shows('1개 객체');
    await page.waitForTimeout(1700);
    assert.match(await summary(), /^1개 객체/);
    // A result of no file, opened from the work history, is drawn as its own closable row.
    await page.getByRole('button', { name: 'b.3dm 숨기기' }).click();
    await empty();
    unhidden.length = 0; // the user's own 보이기 above
    await page.locator('button[data-section="task-list"]').click();
    await page.locator('[data-task-id="old-capture"] .task-open').click();
    await page
      .locator('.work-view[data-request-id="old-capture"]')
      .getByRole('button', { name: '이 모델 보기', exact: true })
      .click();
    await page.locator('button[data-section="document-tree"]').click();
    const row = page.locator('.link-result');
    await row.waitFor();
    assert.match(await row.textContent(), /작업 결과 · old\.3dm/);
    await shows('3개 객체');
    await page.getByRole('button', { name: '작업 결과 · old.3dm 닫기' }).click();
    await empty();
    assert.equal(await row.count(), 0);
    // Closed stays closed on the next start.
    await restart();
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('.link-result').count(), 0);
    assert.equal(await page.locator('#viewport-empty').isHidden(), false);
    assert.deepEqual(unhidden, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    await page.screenshot({ path: join(tmpdir(), `vide-links-hidden-${draftBase}.png`) });
    throw error;
  } finally {
    await page.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}
