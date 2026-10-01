// JIG tab: gallery, Sync jig run on two stored Syncs, AI review and edit requests. No real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
const directory = await mkdtemp(join(tmpdir(), 'vide-jigs-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [],
    posted = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/projects\/[^/]+\/requests$/.test(request.url()))
      posted.push(JSON.parse(request.postData()));
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
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  // The same beams: the model is offset by 125/48/3.2 m, one beam 0.8 mm off, one only in the model.
  const beams = [
    [0, 0, 6, 0],
    [0, 3, 6, 3],
    [0, 6, 6, 6.0008],
    [0, 9, 6, 9],
    [-1, -1, -1, 11.5],
  ];
  const b64 = (s) => Buffer.from(s).toString('base64');
  const rhinoScene = beams.map(([x0, y0, x1, y1], i) => ({
    id: 'r' + i,
    nativeId: '0000000' + i,
    nativeType: 'Curve',
    line: [x0 + 125, y0 + 48, 3.2, x1 + 125, y1 + 48, 3.2],
    layer64: b64(i === 4 ? 'GRID' : '구조::girder'),
  }));
  const cadScene = [beams[0], beams[1], [0, 6, 6, 6], beams[4]].map(([x0, y0, x1, y1], i) => ({
    id: 'cad-' + (20 + i),
    nativeId: String(20 + i),
    nativeType: 'Line',
    segments: [x0, y0, 0, x1, y1, 0],
    layer64: b64(i === 3 ? 'X-GRID' : 'S-BEAM'),
  }));
  const insert = (id, host, result) =>
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      id,
      projectId,
      JSON.stringify({
        id,
        body: host + ' sync',
        pins: [],
        sketches: [],
        files: [],
        provider: 'codex-cli',
        model: 'codex-cli',
        effort: 'default',
        permission: 'review',
        host,
      }),
      'succeeded',
      JSON.stringify({ hostExecuted: true, executionMode: 'sdk', host, ...result }),
      new Date().toISOString(),
    );
  insert('rhino-sync', 'rhino', {
    scene: rhinoScene,
    objects: rhinoScene.map((row, i) => ({
      id: row.id,
      name: 'B' + (i + 1),
      kind: 'native',
      nativeId: row.nativeId,
    })),
    sourceDocument: { name: 'model.3dm', capturedAt: 'test', instance: '1', documentId: 1 },
  });
  insert('cad-sync', 'zwcad', {
    scene: cadScene,
    objects: cadScene.map((row) => ({
      id: row.id,
      name: row.nativeId,
      kind: 'native',
      nativeId: row.nativeId,
    })),
    sourceUnits: 'Millimeters',
    sourceDocument: { name: 'plan.dwg', capturedAt: 'test', instance: '2', documentId: 1 },
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#task-list .task-row').length === 2);
  await page.evaluate(() => {
    const model = document.querySelector('#model');
    model.value = 'codex-cli';
    model.dispatchEvent(new Event('change'));
  });
  const projectName = (await page.locator('#project-picker option:checked').textContent()).trim();
  // A jig installed from a .vjig and pinned to this project (registry list, stood in here); its
  // [삭제] takes it off the project's list.
  let pinned = true;
  const unpinned = [];
  await page.route('**/api/v1/jigs/packages', async (route) => {
    const { jigs } = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        jigs: [
          ...jigs,
          {
            id: 'project/check-sample',
            version: '0.1.0',
            kind: 'tool',
            name: '합성 점검 jig',
            summary: '가져온 설명서로 그리는 합성 jig',
            source: 'pack',
            stage: 'project',
            capabilities: [],
          },
          {
            id: 'project/check-sample',
            version: '0.1.1',
            kind: 'tool',
            name: '합성 점검 jig',
            summary: '가져온 설명서로 그리는 합성 jig',
            source: 'ai-draft',
            stage: 'project',
            capabilities: [],
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/projects/*/jigs', (route) =>
    route.fulfill({
      json: { pinned: pinned ? [{ jigId: 'project/check-sample', version: '0.1.1' }] : [] },
    }),
  );
  await page.route('**/api/v1/projects/*/jigs/*/pin', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    unpinned.push(new URL(route.request().url()).pathname);
    pinned = false;
    return route.fulfill({ json: { unpinned: true } });
  });
  // An instance of the older version ([올리기] moves it), the [수정하기] copy draft (T-101).
  let oldVersion = '0.1.0';
  const upgraded = [],
    forks = [];
  await page.route('**/api/v1/projects/*/jig-instances', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const { instances } = await (await route.fetch()).json();
    const row = {
      id: 'inst-old',
      jigId: 'project/check-sample',
      version: oldVersion,
      title: '작업본 A',
      status: 'computed',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    // An instance on a newer version than the one pinned here (an older pack was pinned again).
    const ahead = { ...row, id: 'inst-ahead', version: '0.1.2', title: '작업본 B' };
    await route.fulfill({ json: { instances: [...instances, row, ahead] } });
  });
  await page.route('**/api/v1/projects/*/jig-instances/inst-old/upgrade', (route) => {
    upgraded.push('inst-old');
    oldVersion = '0.1.1';
    return route.fulfill({ json: { id: 'inst-old' } });
  });
  const fork = {
    id: 'fork-1',
    name: '합성 점검 jig',
    version: '0.1.2',
    state: 'open',
    conversationId: 'conv-fork',
    origin: { jigId: 'project/check-sample', version: '0.1.1', name: '합성 점검 jig' },
    manifest: {
      id: 'project/check-sample',
      version: '0.1.2',
      name: '합성 점검 jig',
      summary: '가져온 설명서로 그리는 합성 jig',
      inputs: [
        {
          key: 'site',
          title: '대지 경계',
          kind: 'assembly',
          roles: [
            { role: 'slab', title: '슬래브', required: true },
            { role: 'column', title: '기존 기둥', required: false },
          ],
        },
      ],
      params: [],
      steps: [{ id: 'check', title: '점검', kind: 'code' }],
      bake: [{ id: 'lines', template: 'vide.bake.curves@1', layer: '점검선' }],
      reports: [{ id: 'main', file: 'reports/main.json', title: '점검 보고서' }],
    },
  };
  await page.route(/\/api\/v1\/projects\/[^/]+\/jig-drafts(\/fork-1)?$/, async (route) => {
    const request = route.request();
    if (request.url().endsWith('/fork-1'))
      return route.fulfill({ json: { ...fork, files: [{ path: 'jig.json' }] } });
    if (request.method() === 'POST') {
      forks.push(request.postDataJSON());
      return route.fulfill({ status: 201, json: fork });
    }
    return route.fulfill({ json: { drafts: forks.length ? [fork] : [] } });
  });
  // The rail's JIG button opens the JIG list.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  await dialog.waitFor();
  const tabs = page.getByRole('tablist', { name: '작업공간' });
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'jig');
  assert.equal(
    await page.locator('.rail [data-workspace-target="jig"]').getAttribute('aria-pressed'),
    'true',
  );
  // The list shows the official catalogue: the working jigs and the planned ones.
  const official = dialog.locator('.jig-card[data-source="official"]');
  await official.first().waitFor();
  assert.equal(await official.count(), 11);
  assert.equal(
    await dialog.locator('.jig-card[data-source="official"][data-status="planned"]').count(),
    8,
  );
  assert.equal(await official.getByRole('button', { name: '삭제', exact: true }).count(), 0);
  const installed = dialog.locator('.jig-card[data-source="project"]', {
    hasText: '합성 점검 jig',
  });
  await installed.waitFor();
  assert.match(await installed.textContent(), /가져온 설명서로 그리는 합성 jig/);
  // Every card draws its jig's icon (PLAN-26 T-100): the default for a jig without one, the fixed
  // one of a built-in screen jig, the grid example's own.
  assert.equal(await installed.locator('.jig-card-head .jig-icon svg').count(), 1);
  const iconOf = (card) =>
    card.locator('.jig-card-head .jig-icon svg').evaluate((svg) => svg.innerHTML);
  const syncCard = dialog.locator('.jig-card', { hasText: 'Sync · 도면↔모델' });
  const gridCard = dialog.locator('.jig-card', { hasText: '격자 골조 배치 예제' });
  const syncIcon = await iconOf(syncCard);
  assert.notEqual(syncIcon, await iconOf(installed));
  assert.notEqual(await iconOf(gridCard), await iconOf(installed));

  // [수정하기] and [올리기] (PLAN-26 T-101). Two installed versions of the jig, 0.1.1 pinned here:
  // one card at the pinned version; an instance on 0.1.0 shows '이전 버전' and [올리기].
  assert.equal(await installed.count(), 1);
  assert.match(await installed.textContent(), /버전 0\.1\.1/);
  const rowsOf = installed.getByRole('list', { name: '합성 점검 jig 작업본' });
  const oldRow = rowsOf.getByRole('listitem').filter({ hasText: '작업본 A' });
  assert.match(await oldRow.textContent(), /v0\.1\.0 · 이전 버전/);
  // A row ahead of the card is no '이전 버전' and has no [올리기] (that would move it back).
  const aheadRow = rowsOf.getByRole('listitem').filter({ hasText: '작업본 B' });
  assert.doesNotMatch(await aheadRow.textContent(), /이전 버전/);
  assert.equal(await aheadRow.getByRole('button', { name: '올리기', exact: true }).count(), 0);
  await oldRow.getByRole('button', { name: '올리기', exact: true }).click();
  await installed
    .getByRole('group', { name: '올리기 확인' })
    .getByRole('button', { name: '올리기', exact: true })
    .click();
  await dialog
    .getByText('‘작업본 A’을 v0.1.1로 올렸습니다. 모든 단계를 다시 계산해야 합니다.')
    .waitFor();
  assert.deepEqual(upgraded, ['inst-old']);
  await page.waitForFunction(
    () => !document.querySelector('.jig-instances')?.textContent?.includes('이전 버전'),
  );
  // A built-in screen jig has nothing to copy: [수정하기] is off, with the reason.
  assert.equal(
    await syncCard.getByRole('button', { name: '수정하기', exact: true }).isDisabled(),
    true,
  );
  await syncCard.getByText('기본 화면 jig는 아직 수정할 수 없습니다').waitFor();
  // S-06 imports the repository's modules: a copy could not run in the compute box, so its
  // [수정하기] is off with the reason; the grid example, whose steps import only its own files, keeps it.
  const s06Card = dialog.locator('.jig-card', { hasText: 'S-06 골조 배치' });
  assert.equal(
    await s06Card.getByRole('button', { name: '수정하기', exact: true }).isDisabled(),
    true,
  );
  await s06Card.getByText('저장소에서 만든 jig는 아직 사본으로 고칠 수 없습니다').waitFor();
  assert.equal(
    await gridCard.getByRole('button', { name: '수정하기', exact: true }).isDisabled(),
    false,
  );
  // [수정하기] makes a copy draft (same id, next version) and opens it in the 만들기 screen,
  // whose outline shows what the jig takes, how it works and what it makes.
  await installed.getByRole('button', { name: '수정하기', exact: true }).click();
  const make = page.locator('.make-workspace');
  const outline = make.getByLabel('도구 설명 개요');
  await outline.getByText('수정 · 합성 점검 jig v0.1.1의 사본 → v0.1.2').waitFor();
  assert.deepEqual(forks, [{ from: { jig: 'project/check-sample', version: '0.1.1' } }]);
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'make');
  assert.equal(
    await page.locator('.rail [data-workspace-target="jig"]').getAttribute('aria-pressed'),
    'true',
  );
  await outline.getByText('대지 경계').waitFor();
  assert.match(await outline.textContent(), /입력 조립 · 슬래브, 기존 기둥\(선택\)/);
  assert.match(await outline.textContent(), /Rhino에 만들기 · 선/);
  assert.match(await outline.textContent(), /보고서 · 점검 보고서/);
  await make.getByRole('tab', { name: '흐름' }).click();
  for (const name of ['입력', '단계', '결과'])
    await make.locator('.make-flow').getByRole('region', { name, exact: true }).waitFor();
  // Back in the list, [수정하기] opens the copy being written instead of making another.
  await make.getByRole('button', { name: 'JIG 목록', exact: true }).click();
  await installed.getByRole('button', { name: '수정하기', exact: true }).click();
  await outline.getByText('수정 · 합성 점검 jig v0.1.1의 사본 → v0.1.2').waitFor();
  assert.equal(forks.length, 1);
  await make.getByRole('button', { name: 'JIG 목록', exact: true }).click();
  await installed.waitFor();
  await installed.getByRole('button', { name: '삭제', exact: true }).click();
  await installed
    .getByRole('group', { name: '합성 점검 jig 삭제 확인' })
    .getByRole('button', { name: '삭제', exact: true })
    .click();
  await dialog.getByText('‘합성 점검 jig’을 이 프로젝트의 jig에서 삭제했습니다.').waitFor();
  await installed.waitFor({ state: 'detached' });
  assert.deepEqual(unpinned, [`/api/v1/projects/${projectId}/jigs/project%2Fcheck-sample/pin`]);
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  // The jig opens in its own context tab.
  const syncTab = tabs.getByRole('tab', { name: `Sync · ${projectName}`, exact: true });
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  // The tab draws the jig's icon before its name; the name stays the tab's accessible name.
  assert.equal(
    await syncTab.locator('.workspace-tab-icon svg').evaluate((svg) => svg.innerHTML),
    syncIcon,
  );
  assert.match(
    await dialog.getByLabel('Rhino Sync').locator('option:checked').textContent(),
    /model\.3dm/,
  );
  assert.match(
    await dialog.getByLabel('ZWCAD Sync').locator('option:checked').textContent(),
    /plan\.dwg/,
  );
  await dialog.getByLabel('일치 허용 (mm)').fill('0.5');
  await dialog.getByRole('button', { name: '정렬·비교 실행' }).click();
  await dialog.locator('.jig-relation').waitFor();
  const relation = await dialog.locator('.jig-relation').textContent();
  assert.match(relation, /이동 X -125000 mm · Y -48000 mm · 높이 차 -3200 mm/);
  assert.match(relation, /오차 1 · Rhino에만 1 · CAD에만 0/);
  assert.match(relation, /구조::girder ↔ S-BEAM · 3쌍/);
  const rows = dialog.locator('.jig-table tbody tr');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /R1오차B3 · 구조::girderS-BEAM · 220\.8 mm/);
  // AI review: host-less, the table attached, only the table's rows citable.
  await dialog.getByRole('button', { name: /AI 검토/ }).click();
  await dialog.locator('.jig-sync [role=status]', { hasText: 'AI 검토를' }).waitFor();
  const review = posted.at(-1);
  assert.equal(review.permission, 'review');
  assert.equal(review.host, undefined);
  assert.equal(review.jig.kind, 'sync-review');
  assert.deepEqual(review.jig.rows, ['R1', 'R2', 'R3', 'R4', 'R5']);
  const table = JSON.parse(review.files[0].text);
  assert.equal(review.files[0].name, 'sync-jig.json');
  assert.deepEqual(table.relation.translationMm, [-125000, -48000]);
  assert.equal(table.rows[0].deviationMm, 0.8);
  // The drawing follows the model: the 0.8 mm beam moves, the missing beam is added.
  await dialog.getByLabel('R1 선택').check();
  await dialog.getByLabel('R2 선택').check();
  await dialog.getByRole('button', { name: /CAD를 Rhino에 맞춤/ }).click();
  await dialog.locator('.jig-sync [role=status]', { hasText: '반영 요청' }).waitFor();
  const cad = posted.at(-1);
  assert.equal(cad.host, 'zwcad');
  assert.equal(cad.baseRequestId, 'cad-sync');
  assert.equal(cad.permission, 'candidate');
  const edits = JSON.parse(cad.files[0].text);
  assert.deepEqual(edits[0], {
    row: 'R1',
    action: 'move-ends',
    handle: '22',
    from: [
      [0, 6000, 0],
      [6000, 6000, 0],
    ],
    to: [
      [0, 6000, 0],
      [6000, 6000.8, 0],
    ],
  });
  assert.deepEqual(edits[1], {
    row: 'R2',
    action: 'add-line',
    layer: 'S-BEAM',
    points: [
      [0, 9000, 0],
      [6000, 9000, 0],
    ],
  });
  // The model follows the drawing: the beam's end returns to the drawing, in model coordinates.
  await dialog.getByLabel('R2 선택').uncheck();
  await dialog.getByRole('button', { name: /Rhino를 CAD에 맞춤/ }).click();
  await page.waitForResponse((response) => /\/requests$/.test(response.url()));
  const rhino = posted.at(-1);
  assert.equal(rhino.host, 'rhino');
  assert.equal(rhino.baseRequestId, 'rhino-sync');
  // Direct in the open document (ADR-022): 자동 mode, not the old candidate → apply flow.
  assert.equal(rhino.mode, 'auto');
  assert.equal(rhino.applyToSource, undefined);
  assert.deepEqual(JSON.parse(rhino.files[0].text)[0], {
    row: 'R1',
    action: 'move-ends',
    id: '00000002',
    to: [
      [125, 54, 3.2],
      [131, 54, 3.2],
    ],
  });
  await page.screenshot({ path: join(directory, 'jigs.png') });
  // A row opens its object in the viewport; the panel is non-modal and stays open beside the model.
  await rows.nth(0).getByRole('button', { name: /B3/ }).click();
  await page.waitForFunction(
    () => document.querySelector('#selection-count')?.textContent === '1개 선택',
  );
  assert.equal(await page.locator('#selection').textContent(), 'B3');
  assert.ok(await dialog.isVisible(), 'the jig stays open while the model is shown');
  assert.equal(await dialog.evaluate((node) => node.matches(':modal')), false);
  const canvas = await page.locator('#canvas canvas').boundingBox();
  const panel = await dialog.boundingBox();
  // The panel docks on the left of the centre (the documents panel gives it its room).
  assert.ok(panel.x + panel.width <= canvas.x + 1, 'the 3D view sits beside the panel');
  assert.equal(await page.locator('#left').isVisible(), false);
  assert.ok(await dialog.getByLabel('R1 선택').isChecked(), 'the jig keeps its state');
  // Closing the tab goes back to the model; the rail's JIG opens the list, where the same jig
  // opens again with its state.
  await dialog.getByRole('button', { name: '닫기' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await syncTab.count(), 0);
  assert.equal(await page.locator('#left').isVisible(), true);
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await dialog
    .locator('.jig-card[data-status="available"]', { hasText: 'Sync · 도면↔모델' })
    .getByRole('button', { name: '열기', exact: true })
    .click();
  await dialog.locator('.jig-relation').waitFor();
  assert.ok(await dialog.getByLabel('R1 선택').isChecked());
  assert.equal(await syncTab.getAttribute('aria-selected'), 'true');
  assert.deepEqual(errors, []);
  console.log('JIG tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
