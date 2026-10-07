// 법규 답의 대상 칩 in Chromium (SPEC-13.8, PLAN-46 T-220): a synthetic site model (the official
// `vide/site-model` jig on the synthetic public-data service) fills the legal profile as '모델에서
// 읽음'; the 일조 answer of the fake cLAWde server names 대지 and 인접 대지; 대지 resolves to the objects
// the site model made in the linked Rhino file (Link ID) and pressing it selects and frames them in
// the viewport, while 인접 대지 (not made) shows '모델에 없음' and cannot be pressed. No host: the
// linked file and its Sync are played by the test as in browser-attached-sync.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { soleDb } from '../fixtures/store.mjs';
import { KEYS, P1, fakeSiteData } from '../fixtures/site-data.mjs';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-legal-targets-'));
const shot = process.env.VIDE_SHOT_DIR;
let app, browser, clawde;
try {
  clawde = await startFakeClawde();
  const siteData = fakeSiteData();
  app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector },
    siteDataOptions: { environment: { ...KEYS }, fetch: siteData.fetch },
  });
  const workspace = new Workspace(app.store);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  // A linked Rhino file, open and live (the test engine has no host).
  const instance = '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const document = {
    instance,
    id: 7,
    name: '대지 시험',
    units: 'Meters',
    objectCount: 3,
    modified: false,
    host: 'rhino',
    connection: 'attached-editor',
    live: true,
    hostBusy: false,
    generation: 0,
  };
  await page.route('**/api/v1/host/attached-documents', (route) =>
    route.fulfill({ json: { instance, documents: [document] } }),
  );
  await page.route(/\/api\/v1\/projects\/[^/]+\/links(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row) => ({
        ...row,
        connection: {
          instance,
          documentId: 7,
          live: true,
          generation: 0,
          objectCount: 3,
          units: 'Meters',
          modified: false,
          hostBusy: false,
        },
        sync: { state: 'idle', at: new Date().toISOString() },
      })),
    });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const engine = (path, method = 'GET', data) =>
    page.evaluate(
      async ({ path, method, data }) => {
        const response = await fetch(`/api/v1${path}`, {
          method,
          headers: data ? { 'Content-Type': 'application/json' } : {},
          body: data ? JSON.stringify(data) : undefined,
        });
        return response.json();
      },
      { path, method, data },
    );

  // The linked file and its Sync: the site model's outline and target lot, and one other object.
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-a', projectId, 'rhino', '대지 시험', null, instance, 7, now, now);
  workspace.submit(projectId, {
    id: 'engine-sync',
    linkId: 'link-a',
    body: 'Sync',
    permission: 'review',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    source: 'document',
    host: 'rhino',
  });
  workspace.update(projectId, 'engine-sync', 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    verified: false,
    displayOnly: true,
    executionMode: 'sdk',
    text: 'Sync complete',
    sourceDocument: {
      instance,
      documentId: 7,
      documentHash: 'a'.repeat(64),
      name: '대지 시험',
      capturedAt: now,
      connection: 'attached-editor',
    },
    objects: [
      { id: 'g-outline', name: '대지 경계', kind: 'box', origin: [0, 0, 0], size: [20, 30, 0.1] },
      { id: 'g-target', name: '대상 필지', kind: 'box', origin: [0, 0, 0], size: [20, 30, 0.2] },
      { id: 'g-other', name: '다른 객체', kind: 'box', origin: [40, 0, 0], size: [5, 5, 5] },
    ],
    scene: [],
  });
  await page.waitForFunction(() => !document.querySelector('#viewport-empty')?.checkVisibility());

  // A computed site model of the synthetic lot (notice confirmed, target set, collected, run).
  await engine(`/projects/${projectId}/site-data/notice`, 'PUT', { confirm: true });
  const site = await engine(`/projects/${projectId}/jig-instances`, 'POST', {
    jig: 'vide/site-model',
    title: '대지',
    layerRoot: 'VIDE::대지',
  });
  const siteBase = `/projects/${projectId}/jig-instances/${site.id}`;
  await engine(`${siteBase}/site-data/site/targets`, 'PUT', { pnus: [P1] });
  await engine(`${siteBase}/site-data/site/collect`, 'POST', {});
  const run = await engine(`${siteBase}/run`, 'POST', { mode: 'confirmed' });
  assert.equal(run.steps.find((s) => s.id === 'summary').status, 'done');
  // Its Rhino에 만들기 made the outline and the target lot in the linked file (the host's record).
  const jigs = new JigStore(app.store);
  for (const [bakeId, nativeId] of [
    ['outline', 'g-outline'],
    ['targets', 'g-target'],
  ]) {
    const record = jigs.addBake(site.id, {
      bakeId,
      linkId: 'link-a',
      requestId: `req-${bakeId}`,
      runId: 'run-1',
      items: { [`${bakeId}:0`]: { nativeId, state: 'jig', runId: 'run-1' } },
    });
    jigs.updateBake(site.id, record.id, { appliedAt: now });
  }

  // The legal jig: the profile shows the site model's values as '모델에서 읽음'.
  await engine('/settings/services', 'PUT', {
    clawde: { baseUrl: clawde.url, token: clawde.token },
  });
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const card = dialog.locator('.jig-card[data-status="available"]', { hasText: 'J-03' });
  await card.getByRole('button', { name: '열기' }).click();
  const jig = page.locator('.legal-jig');
  await jig.locator('.legal-status', { hasText: '연결됨' }).waitFor();
  const profile = await engine(`/projects/${projectId}/legal/profile`);
  const area = profile.items.find((i) => i.key === 'site.area');
  assert.deepEqual([area.value, area.source], [600, 'model']);

  // Ask 일조: the send card lists the model's values; then the answer card has its target chips.
  await jig.getByRole('textbox', { name: '법규 질문' }).fill('일조 사선 제한을 받나요?');
  await jig.getByRole('button', { name: '묻기', exact: true }).click();
  const send = jig.getByRole('region', { name: '보낼 정보' });
  await send.waitFor();
  assert.match(await send.textContent(), /PNU.*모델에서 읽음/);
  await send.getByRole('button', { name: '보내기', exact: true }).click();
  const answer = jig.locator('.legal-entry[data-open="true"] .legal-answer');
  await answer.waitFor();
  const chips = answer.getByRole('group', { name: '대상' });
  const siteChip = chips.getByRole('button', { name: '대지', exact: true });
  const adjacentChip = chips.getByRole('button', { name: /인접 대지/ });
  assert.equal(await siteChip.isEnabled(), true);
  assert.equal(await adjacentChip.isDisabled(), true);
  assert.equal(await adjacentChip.textContent(), '인접 대지 · 모델에 없음');
  if (shot) await page.screenshot({ path: join(shot, 'legal-target-chips.png') });

  // Pressing 대지 selects its two objects in the viewport (the other object stays unselected).
  await siteChip.click();
  await page.waitForFunction(
    () => document.querySelector('#selection')?.textContent === '2개 객체 선택',
  );
  if (shot) await page.screenshot({ path: join(shot, 'legal-target-selected.png') });

  assert.deepEqual(errors, []);
  console.log(
    'Chromium: legal target chips — site model fills the profile, 대지 selects its objects by Link ID, 인접 대지 shows 모델에 없음.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await clawde?.close();
  await rm(directory, { recursive: true, force: true });
}
