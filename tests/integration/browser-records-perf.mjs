// PLAN-53 T-337 (ARCH-01 §5 「성능 측정」 1·2·3·5·6): 5,000 kept records on 30 parts in six chapters,
// read and drawn in the browser — the list API as the page calls it, the 기록 tab's first list, the
// chart's first draw — and, over a made-up Sync of 20,000 objects on the parts' 30 layers, the model
// tab's timeline band (first draw of 5,000 glyphs) and the viewport's fade after the band shows, a
// cursor move and [전부 보기]. Three runs (a fresh page each), median printed as a table; the bounds
// asserted are the criteria (API ≤1,000 ms loose, drawing ≤2,000 ms, cursor ≤100 ms). Run after
// `npm run build:web`. Synthetic data only: no host.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Records } from '../../src/core/records.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { soleDb } from '../fixtures/store.mjs';

const RECORDS = 5000,
  PARTS = 30,
  OBJECTS = 20000,
  RUNS = 3;
const instance = '42:100:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const layerName = (i) => (i < PARTS ? `구조::L${String(i + 1).padStart(2, '0')}` : '기타');
const FORBIDDEN =
  /record|candidate|kept|dropped|chain|\bpart\b|JSON|세션|토큰|이벤트|타임스탬프|노드|그래프|매핑|스키마|SPEC-|PLAN-|undefined|null|NaN/;
const middle = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const directory = await mkdtemp(join(tmpdir(), 'vide-records-perf-'));
const data = join(directory, 'data');
await mkdir(data);
let app, browser;
try {
  app = await startServer({ filename: join(data, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  // A fresh browser each run: nothing remembered (the open tab, the view), so each draw is a first.
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('pageerror', (error) => errors.push(error.message));
    for (const [pattern, json] of [
      ['**/api/v1/host', { available: false }],
      ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
      [
        '**/api/v1/models',
        [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
      ],
    ])
      await page.route(pattern, (route) => route.fulfill({ json }));
    await page.route('**/api/v1/projects/*/parts/status', (route) =>
      route.fulfill({ json: { parts: [] } }),
    );
    // The linked file is open (made up): its Sync draws in the model tab.
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
    for (const path of ['capture', 'live-sync'])
      await page.route(`**/api/v1/projects/*/${path}`, (route) =>
        route.fulfill({ status: 500, json: { code: 'UNEXPECTED' } }),
      );
    await page.goto(app.launchUrl);
    await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
    return { context, page };
  };
  let { context, page } = await open();
  const projectId = await page.locator('#project-picker').inputValue();

  // One linked file with one Sync of 20,000 objects: 31 layers, the first 30 one part each.
  const now = new Date().toISOString();
  soleDb(app.store)
    .prepare('INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)')
    .run('link-p', projectId, 'rhino', '측정동.3dm', null, instance, 7, now, now);
  const objects = [],
    scene = [];
  for (let i = 0; i < OBJECTS; i++) {
    const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const x = (i % 200) * 2,
      y = Math.floor(i / 200) * 2;
    objects.push({ id, nativeId: id, kind: 'native', name: `부재-${i}` });
    scene.push({
      id,
      nativeId: id,
      nativeType: 'Brep',
      geometryHash: `h${i}`,
      origin: [x, y, 0],
      boundsSize: [1, 1, 1],
      vertices: [x, y, 0, x + 1, y, 0, x, y + 1, 0, x, y, 1],
      indices: [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3],
      layer64: Buffer.from(layerName(i % (PARTS + 1))).toString('base64'),
      valid: true,
    });
  }
  const workspace = new Workspace(app.store);
  workspace.submit(projectId, {
    id: 'sync-perf',
    linkId: 'link-p',
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
  workspace.update(projectId, 'sync-perf', 'succeeded', {
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
      name: '측정동.3dm',
      capturedAt: now,
      connection: 'attached-editor',
    },
    objects,
    scene,
  });

  const records = new Records(app.store);
  const parts = Array.from({ length: PARTS }, (_, i) =>
    records.addPart(projectId, {
      name: `부위 ${i + 1}`,
      grp: i % 2 ? '기존' : '신설',
      mapping: [{ kind: 'layer', linkId: 'link-p', layer: layerName(i) }],
    }),
  );
  for (const [label, date] of [
    ['당선', '2024-03-01'],
    ['납품', '2024-12-20'],
    ['착공', '2025-06-01'],
  ])
    records.addMilestone(projectId, { label, date });
  const day = (i) =>
    new Date(Date.UTC(2024, 0, 1) + (i % 700) * 86_400_000).toISOString().slice(0, 10);
  const { added } = records.addMany(
    projectId,
    Array.from({ length: RECORDS }, (_, i) => ({
      input: {
        date: day(i),
        time: `${String(8 + (i % 10)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        type: 'RIKED'[i % 5],
        text: `${(i % PARTS) + 1}번 부위 검토 ${i + 1} — 두께와 간격 다시 보기`,
        parts: [parts[i % PARTS].id],
        chapter: `장 ${(i % 6) + 1}`,
      },
      sourceKey: `perf:${i}`,
    })),
    { by: '설계자', state: 'kept', source: 'note' },
  );
  // Some stories of five, so the chart draws its lines too.
  for (let s = 0; s < 200; s++)
    for (let k = 0; k < 4; k++)
      records.link(projectId, added[s + k * 1000], added[s + (k + 1) * 1000]);

  const api = [],
    list = [],
    chart = [];
  for (let run = 0; run < RUNS; run++) {
    if (run) ({ context, page } = await open());
    assert.equal(await page.locator('#project-picker').inputValue(), projectId);
    assert.equal(await page.locator('.records-row').count(), 0);
    api.push(
      await page.evaluate(async (projectId) => {
        const start = performance.now();
        const response = await fetch(`/api/v1/projects/${projectId}/records`);
        const body = await response.json();
        if (body.records.length !== 5000) throw new Error(String(body.records.length));
        return performance.now() - start;
      }, projectId),
    );
    // The 기록 tab opened: until its list shows all 5,000 rows.
    list.push(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const start = performance.now();
            document.querySelector('.rail [data-workspace-target="records"]').click();
            const check = () => {
              if (document.querySelectorAll('.records-row').length >= 5000)
                resolve(performance.now() - start);
              else requestAnimationFrame(check);
            };
            check();
          }),
      ),
    );
    const tab = page.getByRole('region', { name: '기록', exact: true });
    // [차트]: until one glyph per record is drawn.
    chart.push(
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const start = performance.now();
            [...document.querySelectorAll('[role="tablist"][aria-label="기록 보기"] [role="tab"]')]
              .find((chip) => chip.textContent.trim() === '차트')
              .click();
            const check = () => {
              if (document.querySelectorAll('.records-chart-item').length >= 5000)
                resolve(performance.now() - start);
              else requestAnimationFrame(check);
            };
            check();
          }),
      ),
    );
    if (run === RUNS - 1) {
      const words = await tab.evaluate((el) =>
        [
          el.innerText,
          ...[...el.querySelectorAll('[aria-label],[title]')].map(
            (node) =>
              (node.getAttribute('aria-label') ?? '') + ' ' + (node.getAttribute('title') ?? ''),
          ),
          ...[...el.querySelectorAll('svg text, svg title')].map((node) => node.textContent),
        ].join('\n'),
      );
      assert.doesNotMatch(words, FORBIDDEN);
    }
    await context.close();
  }
  // The model tab's band over the 20,000 objects (ARCH-01 §5 성능 5·6).
  const band = [],
    firstFade = [],
    cursor = [],
    every = [];
  for (let run = 0; run < RUNS; run++) {
    ({ context, page } = await open());
    await page.waitForFunction((n) => window.videViewport?.visibleIds().length === n, OBJECTS, {
      timeout: 120000,
    });
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.records-timeline:not([hidden]) .records-timeline-item')
          .length >= 5000,
      undefined,
      { timeout: 60000 },
    );
    // From the 기록 tab back to the model tab: the band draws again and the fade comes back.
    await page.locator('.rail [data-workspace-target="records"]').click();
    await page.waitForFunction(() => window.videViewport.fadeInfo().faded === 0);
    const [drawn, faded] = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const start = performance.now();
          let drawn, faded;
          document.querySelector('.rail [data-workspace-target="model"]').click();
          const check = () => {
            const now = performance.now() - start;
            if (faded === undefined && window.videViewport.fadeInfo().faded > 0) faded = now;
            if (
              drawn === undefined &&
              document.querySelectorAll('.records-timeline:not([hidden]) .records-timeline-item')
                .length >= 5000
            )
              drawn = now;
            if (drawn !== undefined && faded !== undefined) resolve([drawn, faded]);
            else requestAnimationFrame(check);
          };
          check();
        }),
    );
    band.push(drawn);
    firstFade.push(faded);
    // Cursor moves (2024-01-01 + d: part d+1 is the last one lit), each until the fade changed.
    for (const d of [0, 10, 3, 25, 6, 29, 1]) {
      const ms = await page.evaluate(async (d) => {
        const input = document.querySelector('.records-timeline-range');
        const before = window.videViewport.fadeInfo().faded;
        const start = performance.now();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          input,
          String(new Date(2024, 0, 1 + d).getTime()),
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
        for (let k = 0; k < 600; k++) {
          if (window.videViewport.fadeInfo().faded !== before) return performance.now() - start;
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return -1;
      }, d);
      assert.ok(ms >= 0, `day ${d}: the fade never changed`);
      cursor.push(ms);
    }
    // [전부 보기] on and off.
    for (let k = 0; k < 2; k++)
      every.push(
        await page.evaluate(async () => {
          const before = window.videViewport.fadeInfo().faded;
          const start = performance.now();
          [...document.querySelectorAll('.records-timeline-toggle')]
            .find((button) => button.textContent.trim() === '전부 보기')
            .click();
          for (let k = 0; k < 600; k++) {
            if (window.videViewport.fadeInfo().faded !== before) return performance.now() - start;
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          return -1;
        }),
      );
    await context.close();
  }

  const rows = [
    ['목록 API 5,000건 (화면에서 호출)', api, 500, 1000],
    ['기록 탭 첫 목록 5,000행', list, 2000, 2000],
    ['차트 첫 그리기 5,000건·부위 30', chart, 2000, 2000],
    ['띠 첫 그리기 5,000건 (모델 탭 복귀)', band, 2000, 2000],
    ['모델 탭 복귀 → 흐림 객체 20,000', firstFade, 2000, 2000],
    ['커서 → 흐림 객체 20,000 (7걸음 × 3회)', cursor, 100, 100],
    ['[전부 보기] → 흐림 객체 20,000 (켜기·끄기 × 3회)', every, 100, 100],
  ];
  console.log('| 항목 | 3회 (ms) | 중앙값 (ms) | 기준 (ms) |');
  console.log('|---|---|---|---|');
  for (const [label, values, criterion] of rows)
    console.log(
      `| ${label} | ${values.map((v) => Math.round(v)).join(', ')} | ${Math.round(middle(values))} (최대 ${Math.round(Math.max(...values))}) | ≤${criterion} |`,
    );
  for (const [label, values, , bound] of rows)
    assert.ok(middle(values) <= bound, `${label}: ${middle(values)} ms`);
  assert.deepEqual(errors, []);
  console.log('browser records perf: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
