// 모델 위 타임라인 (PLAN-53 T-333·T-334, Design SCR-46): with a 부위 사전 the model tab shows a band
// under the 3D view — one row per part, the 남김 records as glyphs, milestones and 검토본 days on the
// axis. Moving the cursor lights the parts with a record up to that day and fades the rest in the
// viewport (그 밖 further), within 100 ms; an episode lights only its parts; [분리] moves the 기존
// group aside (display only); [전부 보기] lights every part; a glyph highlights its part's objects
// and opens a card that leads to the 기록 tab; picking an object marks its part's row; [접기] puts
// the model back. No internal words. The model is a made-up Sync (no host), every sentence made up.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Records } from '../../src/core/records.ts';
import { soleDb } from '../fixtures/store.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /record|candidate|kept|dropped|chain|\bpart\b|JSON|세션|토큰|이벤트|타임스탬프|노드|그래프|매핑|스키마|SPEC-|PLAN-|undefined|null|NaN/;
const LAYERS = [
  '구조::지붕',
  '구조::계단',
  '외피::창호',
  '구조::슬래브',
  '기존::옹벽',
  '기존::기초',
  'zz::기타',
  '구조::지붕::난간',
];
const PARTS = [
  ['지붕 트러스', '신설'],
  ['북측 계단실', '신설'],
  ['남측 창호', '신설'],
  ['2층 슬래브', '신설'],
  ['동측 옹벽', '기존'],
  ['기초', '기존'],
];
const OBJECTS = 64; // 8 per layer: 6 mapped layers, one unmapped, one sub-layer (그 밖)
const UNMAPPED = 16;
const instance = '42:100:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const nativeId = (i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const box = (i) => {
  const x = (i % 16) * 2,
    y = Math.floor(i / 16) * 2;
  return {
    object: {
      id: nativeId(i),
      nativeId: nativeId(i),
      kind: 'native',
      name: `부재-${String(i).padStart(3, '0')}`,
    },
    scene: {
      id: nativeId(i),
      nativeId: nativeId(i),
      nativeType: 'Brep',
      geometryHash: `h${i}`,
      name64: '',
      origin: [x, y, 0],
      boundsSize: [1, 1, 1],
      vertices: [x, y, 0, x + 1, y, 0, x, y + 1, 0, x, y, 1],
      indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
      line: [],
      area: null,
      volume: null,
      length: null,
      layer64: Buffer.from(LAYERS[i % 8]).toString('base64'),
      attributes64: [],
      attributesComplete: true,
      valid: true,
    },
  };
};
const two = (n) => String(n).padStart(2, '0');
/** Day d after 2026-03-01 as 'YYYY-MM-DD'. */
const dayDate = (d) => {
  const at = new Date(Date.UTC(2026, 2, 1 + d));
  return `${at.getUTCFullYear()}-${two(at.getUTCMonth() + 1)}-${two(at.getUTCDate())}`;
};
/** Record i is on part i % 6, on day 3i: part p first shows on day 3p. */
const litAt = (day) => Math.min(6, Math.floor(day / 3) + 1);
const fadedAt = (lit) => UNMAPPED + 8 * (6 - lit);

const directory = await mkdtemp(join(tmpdir(), 'vide-records-timeline-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  const workspace = new Workspace(app.store);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'ChatGPT', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  for (const path of ['capture', 'live-sync'])
    await page.route(`**/api/v1/projects/*/${path}`, (route) =>
      route.fulfill({ status: 500, json: { code: 'UNEXPECTED' } }),
    );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const projectId = await page.locator('#project-picker').inputValue();

  // One linked file, open, with one Sync of 64 objects.
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-t', projectId, 'rhino', '시험동.3dm', null, instance, 7, now, now);
  await page.route('**/api/v1/projects/*/links*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || !url.pathname.endsWith('/links'))
      return route.continue();
    const rows = await (await route.fetch()).json();
    await route.fulfill({
      json: rows.map((row) => ({
        ...row,
        connection: {
          instance,
          documentId: 7,
          live: false,
          generation: 0,
          objectCount: OBJECTS,
          units: 'Meters',
          modified: false,
          hostBusy: false,
        },
      })),
    });
  });
  const boxes = Array.from({ length: OBJECTS }, (_, i) => box(i));
  const syncId = randomUUID();
  workspace.submit(projectId, {
    id: syncId,
    linkId: 'link-t',
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
  workspace.update(projectId, syncId, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    verified: false,
    displayOnly: true,
    executionMode: 'sdk',
    text: 'Sync complete',
    sourceDocument: {
      instance,
      documentId: 7,
      documentHash: '0'.repeat(64),
      revision: 1,
      name: '시험동.3dm',
      capturedAt: now,
      connection: 'attached-editor',
    },
    objects: boxes.map((b) => b.object),
    scene: boxes.map((b) => b.scene),
  });
  // Two 검토본 on the axis (the list route answers made-up rows).
  await page.route('**/api/v1/projects/*/reviews', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: [
            { id: 'rv-1', requestId: syncId, title: 'A안', createdAt: '2026-04-10T12:00:00.000Z' },
            { id: 'rv-2', requestId: syncId, title: 'B안', createdAt: '2026-05-15T12:00:00.000Z' },
          ],
        })
      : route.continue(),
  );

  // 부위 사전 (6 parts on 6 layers), 2 milestones, 40 남김 records over 117 days.
  const records = new Records(app.store);
  const partIds = PARTS.map(
    ([name, grp], i) =>
      records.addPart(projectId, {
        name,
        grp,
        mapping: [{ kind: 'layer', linkId: 'link-t', layer: LAYERS[i] }],
      }).id,
  );
  records.addMilestone(projectId, { label: '당선', date: '2026-03-20' });
  records.addMilestone(projectId, { label: '납품', date: '2026-05-30' });
  const ids = [];
  for (let i = 0; i < 40; i++)
    ids.push(
      records.add(
        projectId,
        {
          date: dayDate(3 * i),
          type: ['R', 'I', 'K', 'E', 'D'][i % 5],
          text: `${PARTS[i % 6][0]} 검토 ${i + 1} — 두께 다시 보기`,
          parts: [partIds[i % 6]],
          chapter: i < 20 ? '계획' : '설계',
        },
        { by: '설계자', state: 'kept', source: 'note' },
      ).id,
    );
  // One story over parts 0 → 1 → 2.
  records.link(projectId, ids[0], ids[7]);
  records.link(projectId, ids[7], ids[14]);

  await page.reload();
  await page.waitForFunction(
    (n) => document.querySelector('.object-summary')?.textContent?.startsWith(`${n}개 객체`),
    OBJECTS,
  );
  const band = page.locator('.records-timeline');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.records-timeline:not([hidden]) .records-timeline-item').length ===
      40,
  );
  assert.equal(await band.locator('.records-timeline-name').count(), 6);
  assert.equal(await band.locator('.records-timeline-group').count(), 2);
  assert.equal(await band.locator('.records-timeline-milestone').count(), 2);
  assert.equal(await band.locator('.records-timeline-moment-review').count(), 2);
  assert.equal(await band.locator('.records-glyph-root').count(), 1);
  const head = band.locator('.records-timeline-band');
  assert.equal(await head.getAttribute('data-found'), '6');
  // The basis line (records-moment.ts) shows with the band: one line over the 3D view.
  const basis = page.locator('.viewport-area .records-moment-basis');
  await basis.waitFor();
  assert.equal(await page.locator('.viewport-area .records-moment-basis').count(), 1);
  assert.match(await basis.locator('span').innerText(), /기준$|^현재 모델 · 부위만 표시$/);
  const height = await head.evaluate((node) => node.getBoundingClientRect().height);
  assert.equal(Math.round(height), 160);

  /** Moves the cursor to day d and measures until the viewport's fade shows it (ms). */
  const moveTo = (d, faded) =>
    page.evaluate(
      async ({ d, faded }) => {
        const input = document.querySelector('.records-timeline-range');
        const t = new Date(2026, 2, 1 + d).getTime();
        const began = performance.now();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          input,
          String(t),
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        for (let k = 0; k < 120; k++) {
          if (window.videViewport.fadeInfo().faded === faded) return performance.now() - began;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return -1;
      },
      { d, faded },
    );
  /** data-lit follows the cursor a render later (the glyphs draw from the deferred cursor). */
  const lit = (n) =>
    page
      .waitForFunction(
        (n) => document.querySelector('.records-timeline-band')?.dataset.lit === String(n),
        n,
        { timeout: 3000 },
      )
      .then(
        () => n,
        () => head.getAttribute('data-lit').then(Number),
      );
  const times = [];
  for (const day of [0, 4, 7, 10, 13, 16, 60, 2, 9]) {
    const ms = await moveTo(day, fadedAt(litAt(day)));
    assert.ok(ms >= 0, `day ${day}: the fade never matched`);
    times.push(ms);
    await page.waitForFunction(
      (n) => document.querySelector('.records-timeline-band')?.dataset.lit === String(n),
      litAt(day),
    );
    assert.equal(await head.getAttribute('data-cursor'), dayDate(day));
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`cursor → fade: median ${median.toFixed(1)} ms (max ${times.at(-1).toFixed(1)} ms)`);
  assert.ok(median <= 100, `cursor response ${median} ms`);
  // Labels only near the cursor (day 9: records up to day 69).
  const labels = await band.locator('.records-timeline-item .chart-label').count();
  assert.ok(labels > 0 && labels < 40, `labels ${labels}`);

  // Episode: the story of parts 0 → 1 → 2 lights those three whatever the cursor.
  await moveTo(0, fadedAt(1));
  await band.locator('.records-timeline-chip').click();
  const options = band.locator('.records-timeline-episode-list [role="option"]');
  assert.equal(await options.count(), 3);
  assert.deepEqual(
    (await options.allInnerTexts()).map((text) => text.split('\n')[0]),
    ['계획', '설계', '이야기 · 지붕 트러스 검토 1 …'],
  );
  await options.nth(2).click();
  await page.waitForFunction(
    () => document.querySelector('.records-timeline-band')?.dataset.lit === '3',
  );
  await page.waitForFunction((n) => window.videViewport.fadeInfo().faded === n, fadedAt(3));
  assert.equal(await band.locator('.records-timeline-item.chart-faded').count(), 37);
  assert.equal(await band.locator('.chart-link-on').count(), 2);
  // ▶ steps to the story's next record: cursor on its day, its card open.
  await band.getByRole('button', { name: '다음 기록' }).click();
  await page.waitForFunction(() => document.querySelector('.records-timeline-card'));
  await band.getByRole('button', { name: '다음 기록' }).click();
  await page.waitForFunction(
    (date) => document.querySelector('.records-timeline-band')?.dataset.cursor === date,
    dayDate(21),
  );
  await page.keyboard.press('Escape'); // the card
  await page.keyboard.press('Escape'); // the episode
  await page.waitForFunction(
    () => document.querySelector('.records-timeline-band')?.dataset.episode === '0',
  );
  assert.equal(await lit(litAt(21)), litAt(21));

  // [전부 보기]: every part on; only 그 밖 stays faded.
  await band.getByRole('button', { name: '전부 보기' }).click();
  await page.waitForFunction((n) => window.videViewport.fadeInfo().faded === n, UNMAPPED);
  assert.equal(await lit(6), 6);
  await band.getByRole('button', { name: '전부 보기' }).click();

  // [분리]: the 기존 group (2 parts × 8 objects) moves aside; off puts it back.
  await band.getByRole('button', { name: '분리' }).click();
  await page.waitForFunction(() => window.videViewport.fadeInfo().offset === 16);
  const moved = await page.evaluate(() => window.videViewport.modelBounds());
  assert.ok(moved.max[0] > 40, JSON.stringify(moved));
  await band.getByRole('button', { name: '분리' }).click();
  await page.waitForFunction(() => window.videViewport.fadeInfo().offset === 0);

  // A glyph: its part's 8 objects highlighted, a card with the way to the 기록 tab.
  await moveTo(60, fadedAt(6));
  await band.locator(`.records-timeline-item[data-record-id="${ids[3]}"] .chart-hit`).click();
  await page.waitForFunction(() => window.videViewport.fadeInfo().highlighted === 8);
  const card = band.locator('.records-timeline-card');
  await card.waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'records-timeline.png') });
  assert.match(await card.innerText(), /2026-03-10 · 2층 슬래브 · 근거/);
  assert.match(await card.innerText(), /2층 슬래브 검토 4/);
  for (const text of [
    await band.innerText(),
    ...(await page.$$eval(
      '.records-timeline [aria-label], .records-timeline [title], .records-moment-basis',
      (nodes) =>
        nodes.flatMap((node) => [
          node.getAttribute('aria-label') ?? '',
          node.getAttribute('title') ?? '',
          node.classList.contains('records-moment-basis') ? node.textContent : '',
        ]),
    )),
    ...(await page.$$eval('.records-timeline svg text, .records-timeline svg title', (nodes) =>
      nodes.map((node) => node.textContent),
    )),
  ])
    assert.doesNotMatch(text ?? '', FORBIDDEN, text);
  await card.getByRole('button', { name: '기록 탭에서 보기' }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'records');
  await page.waitForFunction(
    (text) => document.querySelector('.records-workspace')?.innerText.includes(text),
    '2층 슬래브 검토 4',
  );
  // Leaving the model tab puts the model back as it is.
  await page.waitForFunction(() => {
    const info = window.videViewport.fadeInfo();
    return info.faded === 0 && info.highlighted === 0;
  });
  await page.locator('.rail [data-workspace-target="model"]').click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'model');
  await page.waitForFunction((n) => window.videViewport.fadeInfo().faded === n, fadedAt(6));

  // Picking an object in the list marks its part's row.
  await page.waitForFunction(() => document.querySelector('#objects .layer-row'));
  for (let round = 0; round < 4; round++) {
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('#objects .layer-row[aria-expanded="false"]'))
        row.click();
    });
    await page.waitForTimeout(150);
  }
  await page.locator('#objects .object', { hasText: '부재-002' }).first().click(); // layer 외피::창호
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.records-timeline-name[data-picked="1"]')].some(
      (node) => node.textContent === '남측 창호',
    ),
  );

  // [접기]: 28px, the model as it is; [펼치기] draws the same day again.
  await band.getByRole('button', { name: '접기' }).click();
  await page.waitForFunction(() => {
    const info = window.videViewport.fadeInfo();
    return info.faded === 0 && info.highlighted === 0 && info.offset === 0;
  });
  assert.equal(Math.round(await head.evaluate((node) => node.getBoundingClientRect().height)), 28);
  // Folded: the model of today again and no basis line (Design SCR-46 「띠의 틀」).
  await page.waitForFunction(() => !document.querySelector('.records-moment-basis'));
  assert.equal(await page.evaluate(() => window.videRecordsMoment.state().past), false);
  await band.getByRole('button', { name: '펼치기' }).click();
  await page.waitForFunction((n) => window.videViewport.fadeInfo().faded === n, fadedAt(6));

  // A 검토본 tick moves the cursor to its day.
  await band.locator('.records-timeline-moment-review').first().dispatchEvent('click');
  await page.waitForFunction(
    () => document.querySelector('.records-timeline-band')?.dataset.cursor === '2026-04-10',
  );
  assert.equal(await lit(litAt(40)), litAt(40));
  // …and the model of that day: the 검토본 of the file's only Sync, drawn as it is.
  await page.waitForFunction(
    () =>
      document.querySelector('.records-moment-basis span')?.textContent ===
      '2026-04-10 검토본 기준',
  );
  assert.deepEqual(await page.evaluate(() => window.videRecordsMoment.state().overrides), {});

  // Remembered: folded state and cursor day come back after a reload.
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.records-timeline:not([hidden]) .records-timeline-item').length ===
      40,
  );
  assert.equal(
    await page.locator('.records-timeline-band').getAttribute('data-cursor'),
    '2026-04-10',
  );

  assert.deepEqual(errors, []);
  console.log('records timeline browser test passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
