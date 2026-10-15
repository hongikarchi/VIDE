// '이 객체의 기록' (PLAN-53 T-324, SPEC-17.1·17.5, SPEC-03.8): picking an object in the model tab
// lists, under the inspector, the records of the requests that changed it in time order; the first
// row opens that request's work card (the request sentence) — two clicks from the object. No
// internal words show. A synthetic project; no host, no real CLI. When this engine has no objects →
// records route yet, the route is answered here from the same records table (ARCH-01 §5 shape).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';
import { soleDb } from '../fixtures/store.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /SPEC-|PLAN-|record|candidate|kept|dropped|chain|토큰|세션|JSON|노드|그래프|이벤트|requestId|undefined|null/i;
const directory = await mkdtemp(join(tmpdir(), 'vide-object-records-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: false }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();

  // Two requests that changed the same wall (made-up sentences).
  const input = (id, body) => ({
    id,
    body,
    pins: [],
    sketches: [],
    files: [],
    provider: 'codex-cli',
    model: 'codex-cli',
    effort: 'default',
    permission: 'review',
    host: 'rhino',
  });
  const shown = (changes) => ({
    hostExecuted: true,
    host: 'rhino',
    changes,
    objects: [{ id: 'wall-1', name: '남측 벽', kind: 'native', origin: [0, 0, 0] }],
    scene: [
      {
        id: 'wall-1',
        vertices: [0, 0, 0, 4, 0, 0, 0, 3, 0],
        indices: [0, 1, 2],
        boundsSize: [4, 0.3, 3],
        nativeType: 'Brep',
      },
    ],
  });
  const db = soleDb(app.store, projectId);
  const insert = db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)');
  const requests = [
    [
      'records-request-a',
      '남측 벽 끝을 대지 기준선까지 늘려 줘',
      { added: [], removed: [], modified: [mod('wall-1')] },
      '2026-09-01T01:00:00.000Z',
    ],
    [
      'records-request-b',
      '남측 벽 두께를 0.3 m로 바꿔 줘',
      { added: [], removed: [], modified: [mod('wall-1')] },
      '2026-09-10T01:00:00.000Z',
    ],
  ];
  for (const [id, body, changes, at] of requests)
    insert.run(
      id,
      projectId,
      JSON.stringify(input(id, body)),
      'succeeded',
      JSON.stringify(shown(changes)),
      at,
    );

  // Three records pointing at those requests: a requirement, an AI suggestion, a decision.
  const records = new Records(app.store);
  records.add(
    projectId,
    {
      date: '2026-09-01',
      type: 'R',
      text: '건축주가 남측 벽을 대지 기준선까지 늘려 달라고 함',
      attachments: { requestId: 'records-request-a' },
    },
    { by: '김설계' },
  );
  records.add(
    projectId,
    {
      date: '2026-09-02',
      type: 'D',
      text: '남측 벽 끝을 대지 기준선까지 늘림',
      attachments: { requestId: 'records-request-a' },
    },
    { by: 'ai', source: 'request', sourceKey: 'request:records-request-a' },
  );
  records.add(
    projectId,
    {
      date: '2026-09-10',
      type: 'D',
      text: '남측 벽 두께를 0.3 m로 정함',
      attachments: { requestId: 'records-request-b' },
    },
    { by: '김설계' },
  );
  // A dropped record of the same request stays out of the list.
  const dropped = records.add(
    projectId,
    {
      date: '2026-09-03',
      type: 'I',
      text: '뺀 기록',
      attachments: { requestId: 'records-request-a' },
    },
    { by: '김설계' },
  );
  records.setState(projectId, dropped.id, 'dropped', '김설계');

  // The engine's own route when it has one; otherwise the same answer from the table.
  let served = 'engine';
  const asked = [];
  await page.route('**/api/v1/projects/*/objects/*/records*', async (route) => {
    const url = new URL(route.request().url());
    asked.push(decodeURIComponent(url.pathname.split('/').at(-2)));
    const response = await route.fetch();
    if (response.status() !== 404) return route.fulfill({ response });
    served = 'stand-in';
    const ids = ['records-request-a', 'records-request-b'];
    const rows = records
      .list(projectId)
      .records.filter((row) => ids.includes(row.attachments?.requestId));
    await route.fulfill({ json: { records: rows, via: { requestIds: ids, partIds: [] } } });
  });

  await page.reload();
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).last().click();
  await page.waitForFunction(() => document.querySelector('#objects .layer-row'));
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  if ((await page.locator('#inspector-toggle').getAttribute('aria-expanded')) !== 'true')
    await page.locator('#inspector-toggle').click();

  const section = page
    .locator('#inspector-content')
    .getByRole('region', { name: '이 객체의 기록' });
  await section.waitFor();
  const rows = section.locator('.object-records-list > li');
  await page.waitForFunction(
    () => document.querySelectorAll('.object-records-list > li').length === 3,
  );
  const texts = await rows.allInnerTexts();
  assert.match(texts[0], /2026-09-01[\s\S]*R[\s\S]*건축주가 남측 벽[\s\S]*요청/);
  assert.match(texts[1], /2026-09-02[\s\S]*D[\s\S]*AI 제안/);
  assert.match(texts[2], /2026-09-10[\s\S]*남측 벽 두께/);
  assert.ok(!texts.join('\n').includes('뺀 기록'));
  assert.equal(
    await section.getByRole('button', { name: '이 객체의 기록' }).getAttribute('aria-expanded'),
    'true',
  );
  assert.ok(asked.includes('wall-1'), 'asked with the object’s own id');
  const visible = await section.innerText();
  assert.doesNotMatch(visible, FORBIDDEN);
  await section.scrollIntoViewIfNeeded();
  if (shot) await page.screenshot({ path: join(shot, 'object-records.png') });

  // The first row opens the request card of request A: its sentence is on the right.
  await rows.first().getByRole('button').click();
  const card = page.locator('.work-view[data-request-id="records-request-a"]');
  await card.waitFor();
  assert.match(await card.innerText(), /남측 벽 끝을 대지 기준선까지 늘려 줘/);

  // Folding keeps the section folded for the next pick.
  await section.getByRole('button', { name: '이 객체의 기록' }).click();
  assert.equal(await rows.count(), 0);
  await section.getByRole('button', { name: '이 객체의 기록' }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.object-records-list > li').length === 3,
  );
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ objectRecords: 3, opened: 'request card', served }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}

function mod(id) {
  return { id, geometry: true, attributes: false, nativeIdentity: false };
}
