// 규모검토 통합 검수 on screen (PLAN-45 T-214, SPEC-12.1, SCR-13·SCR-18): the JIG dialog lists 사이트
// 모델링 · 법규 · 가능 매스 · 건축개요 as available official cards; 사이트 모델링 is opened by its card
// (notice → address → 가져오기 → 대상 필지 확정); the legal jig reads the site model and answers 일조
// through the fake cLAWde; a 가능 매스 instance assembled from the site model's layers (a stored Sync
// of what the site model makes; no host) reads the legal result, and the person confirms the 고른
// 대안 with the step's [확인] on screen after looking at the 대안 표; the 건축개요 card opens on both
// results, its CSV downloads and its report saves as HTML without scripts. Synthetic data only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { KEYS, P1, fakeSiteData } from '../fixtures/site-data.mjs';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';
import {
  CHAIN_OVERRIDES,
  CHAIN_PARAMS,
  SITE_LAYERS,
  siteLayerRows,
} from '../fixtures/site-massing-chain.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-site-massing-'));
const shot = process.env.VIDE_SHOT_DIR;
const fake = fakeSiteData();
let app, browser, clawde;
try {
  clawde = await startFakeClawde();
  app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector },
    siteDataOptions: { environment: { ...KEYS }, fetch: fake.fetch },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
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
  await engine('/settings/services', 'PUT', {
    clawde: { baseUrl: clawde.url, token: clawde.token },
  });

  // The four official cards of the chain, each available once.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog.locator('.jig-card').first().waitFor();
  for (const name of ['사이트 모델링', '법규 검토', '건축 가능 영역·매스', '건축개요']) {
    const cards = dialog.locator('.jig-card', { hasText: new RegExp(`^${name}사용 가능`) });
    assert.equal(await cards.count(), 1, name);
    assert.equal(await cards.first().getAttribute('data-status'), 'available', name);
  }
  const cardOf = (name) => dialog.locator('.jig-card', { hasText: new RegExp(`^${name}`) }).first();
  const rail = (panel, id, state) =>
    panel.locator(`.kit-rail li[data-step="${id}"]${state ? `[data-state="${state}"]` : ''}`);

  // 1. 사이트 모델링 on screen: notice, address (one candidate), 가져오기, 대상 필지 확정.
  const siteCard = cardOf('사이트 모델링');
  await siteCard.getByRole('button', { name: '새로 열기' }).click();
  await siteCard.getByLabel('출력 레이어').fill('VIDE::대지');
  await siteCard.getByRole('button', { name: '열기', exact: true }).click();
  const sitePanel = dialog.locator('[data-jig-panel="vide/site-model"]');
  const picker = sitePanel.locator('.site-picker');
  await picker
    .getByRole('group', { name: '공공 자료 전송 안내' })
    .getByRole('button', { name: '확인하고 쓰기' })
    .click();
  await picker.getByLabel('주소·지번·PNU').fill('합성시 가나구 가나동 1');
  await picker.getByRole('button', { name: '찾기' }).click();
  await picker.locator('.site-target-list li').first().waitFor();
  assert.match(await picker.locator('.site-target-list').textContent(), new RegExp(P1));
  await picker.getByRole('button', { name: '가져오기' }).click();
  await rail(sitePanel, 'summary', 'done').waitFor();
  await picker.getByRole('button', { name: '대상 필지 확정' }).click();
  await rail(sitePanel, 'confirmTarget', 'confirmed').waitFor();
  const instances = (await engine(`/projects/${projectId}/jig-instances`)).instances;
  const site = instances.find(
    (i) => i.jigId === 'vide/site-model' || i.jig?.id === 'vide/site-model',
  );
  assert.ok(site, JSON.stringify(instances).slice(0, 300));

  // 2. 법규: the profile reads the site model; ask 일조 and send what the card lists.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'J-03' })
    .getByRole('button', { name: '열기' })
    .click();
  const legal = page.locator('.legal-jig');
  await legal.locator('.legal-status', { hasText: '연결됨' }).waitFor();
  await legal.getByRole('textbox', { name: '법규 질문' }).fill('일조 사선 제한을 받나요?');
  await legal.getByRole('button', { name: '묻기', exact: true }).click();
  const send = legal.getByRole('region', { name: '보낼 정보' });
  await send.waitFor();
  assert.match(await send.textContent(), /모델에서 읽음/);
  await send.getByRole('button', { name: '보내기', exact: true }).click();
  await legal.locator('.legal-entry[data-open="true"] .legal-answer').waitFor();

  // 3. 가능 매스 from the site model's layers: a stored Sync of what its bakes make (no host).
  const siteBase = `/projects/${projectId}/jig-instances/${site.id}`;
  const outputs = {};
  for (const step of ['frame', 'roads'])
    outputs[step] = (await engine(`${siteBase}/steps/${step}/output`)).output;
  const rows = siteLayerRows(outputs, 'VIDE::대지');
  const workspace = new Workspace(app.store);
  workspace.submit(projectId, {
    id: 'site-sync',
    body: 'Sync',
    permission: 'review',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    source: 'document',
    host: 'rhino',
  });
  workspace.update(projectId, 'site-sync', 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    verified: false,
    displayOnly: true,
    executionMode: 'sdk',
    text: 'Sync complete',
    sourceDocument: {
      instance: '42:100:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      documentId: 7,
      documentHash: 'b'.repeat(64),
      name: '대지 시험',
      capturedAt: new Date().toISOString(),
      connection: 'attached-editor',
    },
    objects: [],
    scene: rows,
  });
  const mass = await engine(`/projects/${projectId}/jig-instances`, 'POST', {
    jig: 'vide/buildable-mass',
    title: '매스 검토',
    layerRoot: 'VIDE::매스',
    params: Object.entries(CHAIN_PARAMS).map(([key, value]) => ({ key, value })),
  });
  const massBase = `/projects/${projectId}/jig-instances/${mass.id}`;
  const layers = Object.values(SITE_LAYERS).map((name) => `VIDE::대지::${name}`);
  const read = await engine(`${massBase}/reads`, 'POST', { syncId: 'site-sync', layers });
  assert.equal(read.objectCount, rows.length, JSON.stringify(read).slice(0, 300));
  for (const [role, name] of Object.entries(SITE_LAYERS))
    await engine(`${massBase}/assembly/site.${role}`, 'PUT', {
      sources: [{ readId: read.readId, layers: [`VIDE::대지::${name}`] }],
      confirm: true,
    });
  await engine(`${massBase}/overrides`, 'POST', {
    add: CHAIN_OVERRIDES.map((o, i) => ({ id: `o${i}`, origin: 'table', by: 'user', ...o })),
  });
  // The mass panel: [다시 계산] computes up to the 고른 대안 (the person's step waits), the 대안 표
  // is there, the person confirms with the rail's [확인] and computes again to hand it over.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const massCard = cardOf('건축 가능 영역·매스');
  await massCard
    .locator('li', { hasText: '매스 검토' })
    .getByRole('button', { name: '열기' })
    .click();
  const massPanel = dialog.locator('[data-jig-panel="vide/buildable-mass"]');
  await massPanel.waitFor();
  const recompute = massPanel.locator('.kit-actions').getByRole('button', { name: '다시 계산' });
  await recompute.click();
  const confirm = rail(massPanel, 'confirmChoice', 'waiting');
  await confirm.waitFor();
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  await drawer.getByRole('tab', { name: /^대안 표/ }).click();
  const table = drawer.getByRole('table', { name: '대안 표' });
  await table.waitFor();
  assert.ok((await table.locator('tbody tr').count()) >= 3, 'max · base · incentive');
  assert.match(await table.textContent(), /기준 용적률/);
  if (shot) await page.screenshot({ path: join(shot, 'site-massing-alternatives.png') });
  await confirm.getByRole('button', { name: '확인' }).click();
  // The panel's own run after a confirmation is geometry only (library steps wait for [다시 계산]).
  await confirm.waitFor({ state: 'detached' });
  await recompute.click();
  await rail(massPanel, 'confirmChoice', 'confirmed').waitFor();
  await rail(massPanel, 'handoff', 'done').waitFor();
  const regulations = (await engine(`${massBase}/steps/regulations/output`)).output;
  const sunNear = regulations.items.find((i) => i.id === 'sunNearDistance');
  assert.deepEqual([sunNear.value, sunNear.origin], [1.5, '서비스 확정']);

  // 4. 건축개요 on both results: overview, CSV download, report saved as HTML.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const summaryCard = cardOf('건축개요');
  await summaryCard.getByRole('button', { name: '새로 열기' }).click();
  await summaryCard.getByLabel('출력 레이어').fill('VIDE::개요');
  await summaryCard.getByRole('button', { name: '열기', exact: true }).click();
  const summaryPanel = dialog.locator('[data-jig-panel="vide/building-summary"]');
  await summaryPanel.waitFor();
  await rail(summaryPanel, 'check', 'done').waitFor();
  assert.match(
    await summaryPanel
      .locator('.jig-source[aria-label="고른 대안(건축 가능 영역·매스)"]')
      .textContent(),
    /매스 검토/,
  );
  assert.match(
    await summaryPanel.locator('.jig-source[aria-label="대지 요약(사이트 모델링)"]').textContent(),
    /대지/,
  );
  const overview = drawer.getByRole('table', { name: '건축개요' });
  await overview.waitFor();
  const text = await overview.textContent();
  for (const word of ['3,000.00 ㎡', '제2종일반주거지역', '600.00 ㎡', '사람 입력 필요'])
    assert.ok(text.includes(word), word);
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    drawer.getByRole('button', { name: 'CSV' }).click(),
  ]);
  const csvText = await readFile(await csv.path(), 'utf8');
  assert.ok(csvText.startsWith('﻿항목,세부,값'), csvText.slice(0, 40));
  assert.ok(csvText.includes('연면적,합계,"3,000.00 ㎡"'));
  const top = page.locator('.kit-slot[data-slot="top"]');
  assert.match(await top.locator('.kit-report h1').textContent(), /미확정 조건 4개/);
  assert.equal(await top.locator('.kit-report [data-export-refused]').count(), 0);
  // The page the report tab saves: self-contained, no script.
  const summaryId = (await engine(`/projects/${projectId}/jig-instances`)).instances.find(
    (i) => (i.jigId ?? i.jig?.id) === 'vide/building-summary',
  ).id;
  const exported = await engine(
    `/projects/${projectId}/jig-instances/${summaryId}/reports/summary`,
  );
  assert.ok(exported.html.length > 0 && !/<script/i.test(exported.html));
  if (shot) await page.screenshot({ path: join(shot, 'site-massing-summary.png') });

  assert.deepEqual(errors, []);
  console.log(
    'Chromium: 규모검토 chain — site model by its card, legal 일조 from the model, mass from the site layers with the legal values and the 고른 대안 confirmed on screen, 건축개요 CSV and HTML.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await clawde?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
