// Isolated HTTP + React regression. No real CLI or host operations.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { savedReviews } from './browser-support.mjs';
import { soleDb } from '../fixtures/store.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-react-'));
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
    route.fulfill({
      json: [
        { id: 'claude-cli', available: false },
        { id: 'codex-cli', available: false },
      ],
    }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const first = await page.locator('#project-picker').inputValue();
  for (const text of ['first', 'second']) {
    await page.locator('#body').fill(text);
    await page.locator('#add-request').click();
  }
  await page.getByLabel('요청 2', { exact: true }).fill('edited');
  assert.equal(
    await page
      .getByLabel('요청 2', { exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByLabel('요청 1 삭제', { exact: true }).click();
  assert.equal(await page.getByLabel('요청 1', { exact: true }).inputValue(), 'edited');
  assert.equal(await page.locator('#request-count').textContent(), '1');
  const second = await page.evaluate(
    async () =>
      (
        await (
          await fetch('/api/v1/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Second' }),
          })
        ).json()
      ).id,
  );
  await page.reload();
  await page.locator('#project-picker').selectOption(second);
  await page.waitForFunction(
    (id) => document.querySelector('#project-picker')?.value === id,
    second,
  );
  assert.equal(await page.locator('#pending-requests textarea').count(), 0);
  await page.locator('#project-picker').selectOption(first);
  await page.waitForFunction(
    () => document.querySelector('#pending-requests textarea')?.value === 'edited',
  );
  // Open host documents, offered by the apply dialog below.
  await page.route('**/api/v1/host/documents', (route) =>
    route.fulfill({
      json: {
        instance: '1:2',
        documents: [
          { id: 1, name: 'A', units: 'Meters', objectCount: 2, modified: false },
          { id: 2, name: 'B', units: 'Meters', objectCount: 3, modified: true },
        ],
      },
    }),
  );
  const fixtureInput = {
    id: 'inspector-fixture',
    body: 'Inspector fixture',
    pins: [],
    sketches: [],
    files: [],
    provider: 'codex-cli',
    model: 'codex-cli',
    effort: 'default',
    permission: 'review',
    host: 'rhino',
  };
  const fixtureResult = {
    hostExecuted: true,
    host: 'rhino',
    objects: [{ id: 'object-1', name: 'Fixture object', kind: 'native', origin: [0, 0, 0] }],
    scene: [
      {
        id: 'object-1',
        vertices: [0, 0, 0, 2, 0, 0, 0, 3, 0],
        indices: [0, 1, 2],
        boundsSize: [2, 3, 4],
        area: 12.5,
        volume: 24,
        nativeType: 'Brep',
        attributes64: [
          [
            Buffer.from('Literal').toString('base64'),
            Buffer.from('<script>window.injected=true</script>').toString('base64'),
          ],
        ],
        attributesComplete: false,
      },
    ],
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      fixtureInput.id,
      first,
      JSON.stringify(fixtureInput),
      'succeeded',
      JSON.stringify(fixtureResult),
      new Date().toISOString(),
    );
  await page.reload();
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#objects .layer-row'));
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  await page.locator('#inspector-toggle').click();
  await page.getByText('표시 속성을 요청에 첨부', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.injected === true), false);
  assert.match(await page.locator('#inspector-content').textContent(), /<script>/);
  assert.match(await page.locator('#context').textContent(), /속성/);
  await page.locator('[data-inspect="geometry"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#inspector-content').textContent.includes('12.5 m²'),
  );
  assert.match(await page.locator('#inspector-content').textContent(), /24 m³/);
  assert.equal(await page.locator('#inspector-content').evaluate((node) => node.scrollTop), 0);
  await page.screenshot({ path: join(directory, 'react-inspector.png') });
  await page.locator('[data-inspect="history"]').click();
  await page.waitForFunction(() =>
    document.querySelector('#inspector-content').textContent.includes('Inspector fixture'),
  );
  await page.locator('[data-inspect="relations"]').click();
  await page.waitForFunction(() =>
    document
      .querySelector('#inspector-content')
      .textContent.includes('연결된 이전 후보나 객체 입력이 없습니다'),
  );
  await page.locator('[data-inspect="properties"]').click();
  await page.getByRole('button', { name: '이 객체 수량표', exact: true }).click();
  const quantities = page.getByRole('dialog', { name: '후보 수량표', exact: true });
  await quantities.waitFor();
  assert.equal(await quantities.getByLabel('집계 객체', { exact: true }).inputValue(), 'object-1');
  await quantities.getByLabel('그룹 기준', { exact: true }).selectOption('type');
  await quantities.getByText('표 구성', { exact: true }).click();
  await quantities.getByLabel('표 구성 이름', { exact: true }).fill('Fixture layout');
  await quantities.getByRole('button', { name: '구성 저장', exact: true }).click();
  await quantities.getByRole('status').filter({ hasText: '표 구성을 저장했습니다.' }).waitFor();
  const view = await page.evaluate(
    async (id) => (await (await fetch(`/api/v1/projects/${id}/table-views`)).json())[0],
    first,
  );
  assert.equal(view.query.objectId, 'object-1');
  assert.equal(view.query.groupBy, 'type');
  await quantities.getByLabel('객체 검색', { exact: true }).fill('missing');
  await quantities.getByLabel('객체 검색', { exact: true }).press('Enter');
  await quantities.getByRole('status').filter({ hasText: '0 / 1개 객체' }).waitFor();
  assert.match(
    await quantities.getByRole('link', { name: 'CSV 내려받기', exact: true }).getAttribute('href'),
    /search=missing/,
  );
  await page.route('**/api/v1/projects/*/requests/*/quantities?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('search') === 'failure')
      await route.fulfill({ status: 500, json: { code: 'TEST_FAILURE' } });
    else await route.continue();
  });
  await quantities.getByLabel('객체 검색', { exact: true }).fill('failure');
  await quantities.getByLabel('객체 검색', { exact: true }).press('Enter');
  await quantities
    .getByRole('status')
    .filter({ hasText: '마지막 성공 표를 유지합니다.' })
    .waitFor();
  assert.match(
    await quantities.getByRole('link', { name: 'CSV 내려받기', exact: true }).getAttribute('href'),
    /search=missing/,
  );
  await quantities.getByLabel('저장한 표 구성', { exact: true }).selectOption('');
  await quantities.getByLabel('저장한 표 구성', { exact: true }).selectOption(view.id);
  await quantities.getByRole('status').filter({ hasText: '1 / 1개 객체' }).waitFor();
  await quantities.getByRole('button', { name: '구성 삭제', exact: true }).click();
  await quantities.getByRole('status').filter({ hasText: '표 구성을 삭제했습니다.' }).waitFor();
  assert.equal(
    await page.evaluate(
      async (id) => (await (await fetch(`/api/v1/projects/${id}/table-views`)).json()).length,
      first,
    ),
    0,
  );
  await page.screenshot({ path: join(directory, 'react-quantities.png') });
  await quantities.getByRole('button', { name: '닫기', exact: true }).click();
  // Sketch (Grease Pencil style): swatches show their colours, the top view draws on the XY
  // plane, and switching to the select tool keeps the strokes by attaching them.
  await page.locator('[data-tool="sketch"]').click();
  assert.equal(
    await page
      .locator('.swatch[data-color="#3c6fd0"]')
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    'rgb(60, 111, 208)',
  );
  assert.equal(await page.locator('#placement').count(), 0);
  assert.equal(await page.locator('#point-u').count(), 0);
  assert.equal(await page.locator('#line-role').count(), 0);
  await page.locator('[data-view="plan"]').click();
  await page.locator('#brush-surface').click();
  assert.equal(await page.locator('#brush-surface').getAttribute('aria-pressed'), 'false');
  await page.locator('.swatch[data-color="#3c6fd0"]').click();
  const brushBox = await page.locator('#canvas canvas').boundingBox();
  const bx = brushBox.x + brushBox.width / 2,
    by = brushBox.y + brushBox.height / 2;
  await page.mouse.move(bx - 80, by);
  await page.mouse.down();
  await page.mouse.move(bx + 80, by + 40, { steps: 12 });
  await page.mouse.up();
  assert.equal(await page.locator('#finish-sketch').isDisabled(), false);
  await page.keyboard.press('e');
  assert.equal(await page.locator('#brush-eraser').getAttribute('aria-pressed'), 'true');
  await page.keyboard.press('e');
  await page.locator('[data-tool="select"]').click();
  assert.equal(await page.locator('#sketch-tools').isHidden(), true);
  const brushSketch = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id + ':default')).sketches.at(-1),
    first,
  );
  assert.equal(brushSketch.placement, 'view');
  assert.equal(brushSketch.role, undefined);
  assert.equal(brushSketch.strokes.length, 1);
  assert.equal(brushSketch.strokes[0].color, '#3c6fd0');
  assert.ok(brushSketch.strokes[0].points.length >= 3);
  const z = brushSketch.strokes[0].points[0][2];
  assert.ok(brushSketch.strokes[0].points.every((point) => Math.abs(point[2] - z) < 1e-6));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('button[data-mobile="input"]').click();
  assert.equal(await page.getByLabel('요청 1', { exact: true }).inputValue(), 'edited');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const failed = {
    ...fixtureInput,
    id: 'failed-history',
    body: 'Restore exact original',
    baseRequestId: null,
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      failed.id,
      second,
      JSON.stringify(failed),
      'failed',
      JSON.stringify({ code: 'PROVIDER_FAILED' }),
      new Date().toISOString(),
    );
  const unknown = {
    ...fixtureInput,
    id: 'unknown-history',
    body: 'Uncertain host action',
    permission: 'candidate',
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      unknown.id,
      second,
      JSON.stringify(unknown),
      'unknown',
      JSON.stringify({ code: 'HOST_RESULT_UNKNOWN' }),
      new Date().toISOString(),
    );
  // T-109: a request's attachments show in its work view (the history has no 참고 자료 list).
  const attached = {
    ...fixtureInput,
    id: 'attachment-history',
    body: 'Attachment history',
    files: [
      {
        id: 'a'.repeat(24),
        name: 'plan.png',
        size: 2048,
        type: 'image/png',
        kind: 'image',
        path: 'attachments/plan.png',
        copied: true,
      },
      {
        id: 'b'.repeat(24),
        name: 'spec.pdf',
        size: 3 * 1024 * 1024,
        type: 'application/pdf',
        kind: 'pdf',
        path: 'attachments/spec.pdf',
        copied: true,
      },
    ],
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      attached.id,
      second,
      JSON.stringify(attached),
      'failed',
      JSON.stringify({ code: 'PROVIDER_FAILED' }),
      new Date().toISOString(),
    );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(app.origin + '/?project=' + second);
  // The work history lists requests; a row opens that work on the right.
  const openWork = async (id) => {
    await page.locator('button[data-section="task-list"]').click();
    await page.locator(`[data-task-id="${id}"] .task-open`).click();
  };

  await openWork('attachment-history');
  const attachments = page.locator(
    '.work-view[data-request-id="attachment-history"] .work-attachments',
  );
  await attachments.waitFor();
  const image = attachments.getByRole('link', { name: 'plan.png', exact: true });
  assert.equal(
    await image.getAttribute('href'),
    `api/v1/projects/${second}/attachments/${'a'.repeat(24)}`,
  );
  assert.equal(await image.getAttribute('target'), '_blank');
  assert.equal(await attachments.getByRole('link').count(), 1);
  assert.match(await attachments.textContent(), /spec.pdf · 3.0MB/);
  assert.equal(await page.locator('#reference-list').count(), 0);

  await openWork('unknown-history');
  const unknownCard = page.locator('.work-view[data-request-id="unknown-history"]');
  await unknownCard.waitFor();
  assert.match(await unknownCard.textContent(), /호스트 결과 확인 필요/);
  assert.equal(
    await page.getByRole('button', { name: '입력을 초안으로 복원', exact: true }).count(),
    0,
  );
  await openWork('failed-history');
  const restore = page.getByRole('button', { name: '입력을 초안으로 복원', exact: true });
  await restore.waitFor();
  assert.equal(await restore.count(), 1);
  assert.equal(await page.getByRole('button', { name: '중단', exact: true }).count(), 0);
  await restore.click();
  await page.waitForFunction(
    () => document.querySelector('#body').value === 'Restore exact original',
  );
  const restored = await page.evaluate(
    (id) => JSON.parse(localStorage.getItem('vide:draft:' + id + ':default')),
    second,
  );
  assert.equal(restored.body, failed.body);
  // The mode is the page's 계획/자동 toggle (default 자동), not part of the restored input.
  assert.equal(restored.permission, 'candidate');
  assert.deepEqual(restored.pins, []);
  const applicable = { ...fixtureInput, id: 'application-fixture', body: 'Apply fixture' };
  const applicableResult = {
    ...fixtureResult,
    objects: [
      { id: 'object-1', name: 'Fixture box', kind: 'box', origin: [0, 0, 0], size: [2, 3, 4] },
    ],
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      applicable.id,
      second,
      JSON.stringify(applicable),
      'succeeded',
      JSON.stringify(applicableResult),
      new Date().toISOString(),
    );
  let previews = 0,
    applies = 0,
    previewTarget;
  await page.route('**/api/v1/projects/*/applications', async (route) => {
    previews++;
    previewTarget = route.request().postDataJSON();
    await route.fulfill({
      json: {
        id: 'preview-' + previews,
        documentId: previewTarget.documentId,
        added: 1,
        updated: 0,
        removed: 0,
      },
    });
  });
  let finishApply;
  const pendingApply = new Promise((resolve) => {
    finishApply = resolve;
  });
  await page.route('**/api/v1/projects/*/applications/preview-*', async (route) => {
    applies++;
    await pendingApply;
    await route.fulfill({
      json: {
        id: 'preview-' + previews,
        state: 'unknown',
        result: { code: 'HOST_RESULT_UNKNOWN' },
      },
    });
  });
  await page.reload();
  await page.getByRole('button', { name: '문서에 적용', exact: true }).click();
  const application = page.getByRole('dialog', { name: '호스트 원본 적용', exact: true });
  await application.getByRole('button', { name: '영향 검토', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.application-dialog button:last-child').disabled,
  );
  await application.getByLabel('적용할 호스트 문서', { exact: true }).selectOption('2');
  assert.equal(
    await application.getByRole('button', { name: '검토한 변경 적용', exact: true }).isDisabled(),
    true,
  );
  await application.getByRole('button', { name: '영향 검토', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.application-dialog button:last-child').disabled,
  );
  assert.equal(previewTarget.documentId, 2);
  assert.equal(previewTarget.instance, '1:2');
  assert.equal(previewTarget.requestId, applicable.id);
  await application.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  assert.equal(
    await application.getByRole('button', { name: '닫기', exact: true }).isDisabled(),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(await application.isVisible(), true);
  finishApply();
  await application.getByRole('status').filter({ hasText: '결과 미확인' }).waitFor();
  assert.equal(applies, 1);
  assert.equal(previews, 2);
  assert.equal(
    await application.getByRole('button', { name: '검토한 변경 적용', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await application.getByRole('button', { name: '영향 검토', exact: true }).isDisabled(),
    true,
  );
  await application.getByRole('button', { name: '닫기', exact: true }).click();
  assert.match(
    await page.locator('.work-view[data-request-id="application-fixture"]').textContent(),
    /원본 적용 결과 미확인/,
  );
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await openWork('application-fixture');
  await page.locator('.work-view .more-actions > summary').click();
  await page.getByRole('button', { name: '검토본 저장', exact: true }).click();
  const saveReview = page.getByRole('dialog', { name: '검토본 저장', exact: true });
  await saveReview.getByLabel('검토본 제목', { exact: true }).fill('Fixture review');
  await saveReview.getByRole('button', { name: '검토본 저장', exact: true }).click();
  const savedReview = page.getByRole('dialog', { name: '저장한 검토본', exact: true });
  await savedReview.waitFor();
  assert.equal(await savedReview.locator('iframe').getAttribute('sandbox'), '');
  await savedReview.locator('summary').click();
  await savedReview.getByLabel('검토 의견 본문', { exact: true }).fill('Preserve this evidence');
  await savedReview.getByLabel('의견 대상', { exact: true }).selectOption('object-1');
  const notesSent = [];
  await page.route('**/api/v1/projects/*/reviews/*/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    notesSent.push(route.request().postDataJSON());
    if (notesSent.length === 1) {
      await route.fetch();
      await route.fulfill({ status: 502, json: { code: 'TEST_NOTE_RESPONSE_LOST' } });
    } else await route.continue();
  });
  await savedReview.getByRole('button', { name: '의견 저장', exact: true }).click();
  await savedReview
    .getByRole('status')
    .filter({ hasText: '같은 의견을 다시 확인할 수 있습니다.' })
    .waitFor();
  await savedReview.getByRole('button', { name: '닫기', exact: true }).click();
  // T-109: the work view and the request's history row link the 검토본 made from it.
  await page
    .locator('.work-view[data-request-id="application-fixture"] .work-reviews')
    .getByRole('button', { name: 'Fixture review', exact: true })
    .waitFor();
  await page.locator('button[data-section="task-list"]').click();
  const madeHere = page.locator('[data-task-id="application-fixture"] .task-review');
  assert.equal(await madeHere.textContent(), '이 작업으로 만든 검토본');
  await madeHere.click();
  await savedReview.waitFor();
  await savedReview.getByRole('button', { name: '닫기', exact: true }).click();
  await (await savedReviews(page))
    .getByRole('button', { name: 'Fixture review', exact: true })
    .click();
  await savedReview.locator('summary').click();
  await savedReview.getByRole('button', { name: '동일 의견 다시 확인', exact: true }).waitFor();
  assert.equal(
    await savedReview.getByLabel('검토 의견 본문', { exact: true }).inputValue(),
    'Preserve this evidence',
  );
  assert.equal(await savedReview.getByLabel('검토 의견 본문', { exact: true }).isDisabled(), true);
  await savedReview.getByRole('button', { name: '동일 의견 다시 확인', exact: true }).click();
  await savedReview.getByRole('status').filter({ hasText: '의견을 저장했습니다.' }).waitFor();
  assert.deepEqual(notesSent[0], notesSent[1]);
  assert.equal(
    soleDb(app.store)
      .prepare('SELECT count(*) AS n FROM review_notes WHERE projectId=?')
      .get(second).n,
    1,
  );
  await savedReview.getByRole('button', { name: '요청 초안에 첨부', exact: true }).click();
  await savedReview.getByRole('status').filter({ hasText: '다른 후보를 보고 있습니다.' }).waitFor();
  await savedReview.getByRole('button', { name: '닫기', exact: true }).click();
  await page.locator('#body').fill('');
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await (await savedReviews(page))
    .getByRole('button', { name: 'Fixture review', exact: true })
    .click();
  await savedReview.locator('summary').click();
  await savedReview.getByRole('button', { name: '요청 초안에 첨부', exact: true }).click();
  await savedReview.waitFor({ state: 'hidden' });
  assert.match(await page.locator('#context').textContent(), /검토 의견 · Fixture review/);
  const nextInput = {
    ...applicable,
    id: 'comparison-fixture',
    body: 'Comparison fixture',
    baseRequestId: applicable.id,
  };
  const nextResult = {
    ...applicableResult,
    baseRequestId: applicable.id,
    objects: [{ ...applicableResult.objects[0], size: [2, 3, 5] }],
    scene: [{ ...applicableResult.scene[0], volume: 30 }],
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      nextInput.id,
      second,
      JSON.stringify(nextInput),
      'succeeded',
      JSON.stringify(nextResult),
      new Date().toISOString(),
    );
  const firstReview = soleDb(app.store)
    .prepare('SELECT * FROM review_snapshots WHERE projectId=?')
    .get(second);
  const snapshot = JSON.parse(firstReview.payload);
  const nextReview = await page.evaluate(
    async ({ projectId, requestId, image }) =>
      await (
        await fetch(`/api/v1/projects/${projectId}/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, title: 'Changed review', image, query: {} }),
        })
      ).json(),
    { projectId: second, requestId: nextInput.id, image: snapshot.image },
  );
  assert.ok(nextReview.id);
  await page.reload();
  await savedReviews(page);
  await page.getByRole('button', { name: '검토본 비교', exact: true }).click();
  const comparison = page.getByRole('dialog', { name: '검토본 비교', exact: true });
  await comparison.getByRole('status').filter({ hasText: '체적 +6 m³' }).waitFor();
  assert.equal(await comparison.locator('iframe').count(), 2);
  assert.equal(await comparison.locator('iframe').first().getAttribute('sandbox'), '');
  await comparison.getByLabel('검토본 A', { exact: true }).selectOption(nextReview.id);
  assert.equal(await comparison.locator('iframe').count(), 0);
  await comparison.getByRole('button', { name: '비교', exact: true }).click();
  await comparison.getByRole('status').filter({ hasText: '표시·속성 동일' }).waitFor();
  await comparison.getByRole('button', { name: '닫기', exact: true }).click();
  await openWork('comparison-fixture');
  const nextCard = page.locator('.work-view[data-request-id="comparison-fixture"]');
  await nextCard.locator('.more-actions > summary').click();
  await nextCard.getByRole('button', { name: '수량표', exact: true }).click();
  await quantities.getByLabel('비교할 이전 후보', { exact: true }).selectOption(applicable.id);
  await quantities.getByRole('button', { name: '현재 후보와 비교', exact: true }).click();
  await quantities.locator('.comparison-result').filter({ hasText: '체적 +6 m³' }).waitFor();
  await quantities.getByRole('button', { name: '닫기', exact: true }).click();
  // T-109: a second 검토본 from the same request: the history row shows the count and opens the
  // newest; × stays on the row's first line and the link wraps below it.
  const newer = await page.evaluate(
    async ({ projectId, requestId, image }) =>
      await (
        await fetch(`/api/v1/projects/${projectId}/reviews`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, title: 'Newer review', image, query: {} }),
        })
      ).json(),
    { projectId: second, requestId: applicable.id, image: snapshot.image },
  );
  assert.ok(newer.id);
  await page.reload();
  await page.locator('button[data-section="task-list"]').click();
  const twoMade = page.locator('[data-task-id="application-fixture"] .task-review');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-task-id="application-fixture"] .task-review')?.textContent ===
      '이 작업으로 만든 검토본 2',
  );
  const box = async (selector) =>
    await page.locator(`[data-task-id="application-fixture"] ${selector}`).boundingBox();
  const [openBox, removeBox, linkBox] = [
    await box('.task-open'),
    await box('.task-remove'),
    await box('.task-review'),
  ];
  assert.ok(removeBox.x > openBox.x + openBox.width - 1, '× at the right of the title');
  assert.ok(removeBox.y < openBox.y + openBox.height, '× on the first line');
  assert.ok(linkBox.y > openBox.y + openBox.height / 2, 'the link below the title');
  await twoMade.click();
  await savedReview.getByRole('heading', { name: 'Newer review', exact: true }).waitFor();
  await savedReview.getByRole('button', { name: '닫기', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      requestEditing: true,
      projectIsolation: true,
      documentRaceGuard: true,
      inspectorTabs: true,
      literalAttributes: true,
      quantityViews: true,
      failedQueryPreservesCsv: true,
      sketchCoordinates: true,
      historyRestore: true,
      applicationTargetGuard: true,
      applicationUnknownNoReplay: true,
      reviewNoteRecovery: true,
      reviewComparison: true,
      candidateComparison: true,
      unknownNoReplay: true,
      mobileDraft: true,
    }),
  );
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) console.error(await failedPage.locator('[role=status]').allTextContents());
  throw error;
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
