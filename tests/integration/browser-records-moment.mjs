// 시점 형상 (PLAN-53 T-335, ARCH-01 §5 「시점 형상」·「검토본과 함께 기록」, Design SCR-46 구현 기준): a
// linked file with three Syncs (1, 2, 3 objects) and three 검토본 — two of older Syncs, one of an AI
// result (a tick only). The time axis ticks; a cursor date draws that date's Sync in the file's place
// with the basis line '○ 검토본 기준'; before any moment '현재 모델 · 부위만 표시'; [현재로] brings the
// latest Sync back. Then the 검토본 save dialog keeps a decision record with the 검토본. Synthetic
// data only: no host, no real CLI. The timeline is not needed: the module's test hook drives it.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Reviews } from '../../src/core/reviews.ts';
import { Records } from '../../src/core/records.ts';
import { soleDb } from '../fixtures/store.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /record|candidate|kept|dropped|chain|\bpart\b|JSON|세션|토큰|이벤트|타임스탬프|노드|그래프|매핑|스키마|SPEC-|PLAN-|undefined|null/;
const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const instance = '42:100:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const box = (n, x) => ({
  object: {
    id: `m-${n}`,
    nativeId: `m-${n}`,
    kind: 'native',
    name: '매스 ' + n,
    origin: [x, 0, 0],
  },
  scene: {
    id: `m-${n}`,
    nativeId: `m-${n}`,
    nativeType: 'Brep',
    geometryHash: `h${n}`,
    origin: [x, 0, 0],
    boundsSize: [1, 1, 1],
    vertices: [x, 0, 0, x + 1, 0, 0, x, 1, 0],
    indices: [0, 1, 2],
    layer64: Buffer.from('매스').toString('base64'),
    valid: true,
  },
});
const directory = await mkdtemp(join(tmpdir(), 'vide-records-moment-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  const workspace = new Workspace(app.store);
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
  const db = soleDb(app.store, projectId);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)').run(
    'link-m',
    projectId,
    'rhino',
    '시점 시험',
    null,
    instance,
    7,
    now,
    now,
  );

  // Three Syncs of the linked file: 1, 2 and 3 objects (09-01, 09-10, 09-20).
  const days = ['2026-09-01', '2026-09-10', '2026-09-20'];
  for (let k = 0; k < 3; k++) {
    const id = `sync-${k + 1}`;
    const boxes = Array.from({ length: k + 1 }, (_, n) => box(n + 1, n * 3));
    workspace.submit(projectId, {
      id,
      linkId: 'link-m',
      body: 'Sync',
      permission: 'candidate',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
      source: 'document',
      host: 'rhino',
      sourceDocument: { instance, documentId: 7 },
    });
    workspace.update(projectId, id, 'succeeded', {
      host: 'rhino',
      hostExecuted: true,
      verified: false,
      displayOnly: true,
      executionMode: 'sdk',
      text: 'Sync complete',
      sourceDocument: {
        instance,
        documentId: 7,
        documentHash: String(k + 1).padStart(64, '0'),
        revision: k + 1,
        name: '시점 시험',
        capturedAt: `${days[k]}T12:00:00.000Z`,
        connection: 'attached-editor',
      },
      objects: boxes.map((b) => b.object),
      scene: boxes.map((b) => b.scene),
    });
    db.prepare('UPDATE workspace_requests SET createdAt=? WHERE id=?').run(
      `${days[k]}T12:00:00.000Z`,
      id,
    );
  }
  // An AI result of no linked file (its 검토본 is a tick only).
  db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'ai-result',
    projectId,
    JSON.stringify({
      id: 'ai-result',
      body: '남측 매스를 한 층 올려 줘',
      pins: [],
      sketches: [],
      files: [],
      provider: 'codex-cli',
      model: 'codex-cli',
      effort: 'default',
      permission: 'review',
      host: 'rhino',
    }),
    'succeeded',
    JSON.stringify({
      hostExecuted: true,
      host: 'rhino',
      changes: { added: [], removed: [], modified: [] },
      objects: [box(9, 0).object],
      scene: [box(9, 0).scene],
    }),
    '2026-09-14T12:00:00.000Z',
  );
  const reviews = new Reviews(app.store);
  for (const [requestId, title, day] of [
    ['sync-1', 'A안', '2026-09-02'],
    ['sync-2', 'B안', '2026-09-12'],
    ['ai-result', 'C안', '2026-09-15'],
  ]) {
    const made = reviews.create(
      projectId,
      { title, image: IMAGE },
      { ...workspace.get(projectId, requestId), applications: [] },
    );
    db.prepare('UPDATE review_snapshots SET createdAt=? WHERE id=?').run(
      `${day}T12:00:00.000Z`,
      made.id,
    );
  }

  await page.reload();
  await page.waitForFunction(() => window.videRecordsMoment && window.videViewport);
  const count = () => page.evaluate(() => window.videViewport.visibleIds().length);
  const waitCount = async (n, label) => {
    await page
      .waitForFunction((n) => window.videViewport.visibleIds().length === n, n)
      .catch(() => {});
    assert.equal(await count(), n, label);
  };
  await waitCount(3, 'the latest Sync is drawn');

  // Ticks: one per day; 검토본 days are 검토본 ticks with their hover lines.
  const ticks = await page.evaluate(() => window.videRecordsMoment.ticks());
  assert.deepEqual(
    ticks.map((t) => `${t.date}:${t.kind}`),
    [
      '2026-09-01:sync',
      '2026-09-02:review',
      '2026-09-10:sync',
      '2026-09-12:review',
      '2026-09-15:review',
      '2026-09-20:sync',
    ],
  );
  assert.deepEqual(ticks[1].lines, ['09-02 검토본 · A안']);
  assert.deepEqual(ticks[0].lines, ['09-01 동기화 · 시점 시험']);

  const basis = page.locator('.viewport-area .records-moment-basis');
  const now_ = basis.getByRole('button', { name: '현재로', exact: true });
  const pick = (date) => page.evaluate((date) => window.videRecordsMoment.pick(date), date);
  const waitBasis = async (text) => {
    await page
      .waitForFunction(
        (text) => document.querySelector('.records-moment-basis span')?.textContent === text,
        text,
      )
      .catch(() => {});
    assert.equal(await basis.locator('span').textContent(), text);
  };

  // 09-05: the 09-02 검토본's Sync (1 object) in the file's place.
  const displayed = () => page.evaluate(() => window.videRecordsMoment.displayed());
  assert.equal(await displayed(), 'sync-3', 'the composer starts on the latest Sync');
  await pick('2026-09-05');
  await waitBasis('2026-09-02 검토본 기준');
  await waitCount(1, '09-02 검토본 moment');
  assert.ok(await now_.isVisible());
  // Seen only: a request made now still starts from the latest Sync.
  assert.equal(await displayed(), 'sync-3', 'a past moment never becomes the request basis');
  if (shot) await page.screenshot({ path: join(shot, 'records-moment.png') });

  // 09-16: the 09-12 검토본 (2 objects); the AI result's 검토본 changes nothing.
  await pick('2026-09-16');
  await waitBasis('2026-09-12 검토본 기준');
  await waitCount(2, '09-12 검토본 moment');

  // Before every moment: the current model, parts only.
  await pick('2026-08-01');
  await waitBasis('현재 모델 · 부위만 표시');
  await waitCount(3, 'no moment: current');
  assert.ok(!(await now_.isVisible()));

  // 09-21: the latest Sync itself — no override.
  await pick('2026-09-21');
  await waitBasis('2026-09-20 동기화 기준');
  await waitCount(3, 'latest Sync');
  assert.equal(
    Object.keys(await page.evaluate(() => window.videRecordsMoment.state().overrides)).length,
    0,
  );

  // [현재로] from a past moment.
  await pick('2026-09-05');
  await waitCount(1, 'past again');
  await now_.click();
  await waitCount(3, '[현재로]');
  await waitBasis('2026-09-20 동기화 기준');
  assert.ok(!(await now_.isVisible()));
  assert.doesNotMatch(await basis.innerText(), FORBIDDEN);

  // Folded (null): the line goes away.
  await pick(null);
  assert.equal(await basis.count(), 0);

  // The band drives it (T-334 ↔ T-335): with a part and two kept records the model tab shows the
  // timeline; its 검토본 tick draws that day's model, [접기] lets it go, [펼치기] draws it again.
  const records = new Records(app.store);
  const part = records.addPart(projectId, {
    name: '남측 매스',
    grp: '신설',
    mapping: [{ kind: 'layer', linkId: 'link-m', layer: '매스' }],
  }).id;
  for (const [date, text] of [
    ['2026-09-01', '남측 매스 처음 놓음'],
    ['2026-09-20', '남측 매스 높이 확정'],
  ])
    records.add(
      projectId,
      { date, type: 'D', text, parts: [part] },
      { by: '설계자', state: 'kept', source: 'note' },
    );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.records-timeline:not([hidden]) .records-timeline-item').length ===
      2,
  );
  await waitCount(3, 'the band opens on the current model');
  const band = page.locator('.records-timeline-band');
  await band.locator('.records-timeline-moment[data-date="2026-09-02"]').dispatchEvent('click');
  await waitBasis('2026-09-02 검토본 기준');
  await waitCount(1, 'the band picked the 09-02 검토본');
  assert.equal(await page.evaluate(() => window.videRecordsMoment.state().past), true);
  assert.equal(await displayed(), 'sync-3', 'the band never moves the request basis');
  await band.getByRole('button', { name: '접기', exact: true }).click();
  await waitCount(3, 'folded: the current model');
  await page.waitForFunction(() => !document.querySelector('.records-moment-basis'));
  await band.getByRole('button', { name: '펼치기', exact: true }).click();
  await waitCount(1, 'unfolded: the same day again');
  await band.getByRole('button', { name: '접기', exact: true }).click();
  await waitCount(3, 'folded again');

  // The 검토본 save dialog keeps a decision record with the 검토본.
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).last().click();
  const work = page.locator('.work-view[data-request-id="ai-result"]');
  if (!(await work.isVisible())) {
    await page.locator('button[data-section="task-list"]').click();
    await page.locator('[data-task-id="ai-result"] .task-open').click();
  }
  await work.locator('.more-actions > summary').click();
  await work.getByRole('button', { name: '검토본 저장', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '검토본 저장', exact: true });
  await dialog.getByLabel('검토본 제목').fill('D안');
  const keep = dialog.getByLabel('이 검토본을 기록으로도 남기기');
  assert.equal(await keep.isChecked(), false);
  assert.equal(await dialog.getByLabel('기록 내용').count(), 0);
  await keep.check();
  assert.equal(await dialog.getByRole('radio', { name: '결정' }).isChecked(), true);
  await dialog.getByRole('radio', { name: '근거' }).check();
  await dialog.getByLabel('기록 내용').fill('남측 일조 검토 결과');
  assert.doesNotMatch(await dialog.innerText(), FORBIDDEN);
  await dialog.getByRole('button', { name: '검토본 저장', exact: true }).click();
  await page.getByRole('dialog', { name: '저장한 검토본', exact: true }).waitFor();
  const kept = new Records(app.store)
    .list(projectId)
    .records.filter((row) => row.sourceKey?.startsWith('review:'));
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, 'E');
  assert.equal(kept[0].text, '남측 일조 검토 결과');
  assert.equal(kept[0].state, 'kept');
  assert.equal(kept[0].attachments.reviewId, kept[0].sourceKey.slice('review:'.length));

  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ ticks: ticks.length, moments: ['09-02', '09-12', 'current'], record: 'E' }),
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
