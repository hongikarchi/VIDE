// Request routing (SPEC-02.17): screen-only requests change the VIDE view without any AI or file
// work; the chip can flip the route before sending.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-route-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const setup = await browser.newPage();
  await setup.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await setup.goto(app.launchUrl);
  await setup.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await setup.locator('#project-picker').inputValue();
  await setup.close();
  const b64 = (text) => Buffer.from(text).toString('base64');
  const scene = [
    ...[0, 1, 2].map((i) => ({
      id: 'text-' + i,
      nativeId: 'T' + i,
      nativeType: 'MText',
      segments: [i, 5, 0, i + 0.5, 5, 0],
      layer64: b64('A-ANNO'),
    })),
    ...[0, 1, 2, 3].map((i) => ({
      id: 'line-' + i,
      nativeId: 'L' + i,
      nativeType: 'Line',
      segments: [i, 0, 0, i + 1, 0, 0],
      layer64: b64('S-BEAM'),
    })),
    {
      id: 'hatch-0',
      nativeId: 'H0',
      nativeType: 'Hatch',
      segments: [0, 2, 0, 3, 2, 0],
      layer64: b64('A-HATCH'),
    },
  ];
  const input = {
    id: 'sync',
    provider: 'codex-cli',
    host: 'zwcad',
    source: 'document',
    permission: 'candidate',
    body: 'plan',
    pins: [],
    sketches: [],
    files: [],
  };
  const result = {
    host: 'zwcad',
    hostExecuted: true,
    executionMode: 'sdk',
    displayOnly: true,
    objects: scene.map((item) => ({
      id: item.id,
      name: item.nativeId,
      kind: 'native',
      nativeId: item.nativeId,
    })),
    scene,
    sourceDocument: {
      name: 'plan.dwg',
      capturedAt: new Date().toISOString(),
      instance: '1:1',
      documentId: 1,
    },
  };
  app.store.db
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      input.id,
      projectId,
      JSON.stringify(input),
      'succeeded',
      JSON.stringify(result),
      new Date().toISOString(),
    );
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const errors = [],
    posted = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/requests$/.test(request.url()))
      posted.push(request.url());
  });
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', available: true },
        { id: 'codex-cli', available: true },
      ],
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('8개'),
  );
  const chip = page.locator('#context .route-chip');
  // "Keep only the text": the VIDE view only; nothing is sent and the file is untouched.
  await page.locator('#body').fill('텍스트만 남기고 숨겨줘');
  await chip.filter({ hasText: 'VIDE 화면만 · 문자 3개' }).waitFor();
  await page.locator('#request').click();
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 5);
  assert.match(await page.locator('#message').textContent(), /문자 3개 만 표시 · 원본은 그대로/);
  assert.equal(await page.locator('#body').inputValue(), '');
  await page.locator('#body').fill('모두 다시 보여줘');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 0);
  assert.equal(posted.length, 0);
  // Words that change the file send it to the file (as AI work).
  // Plain file work shows no route chip; a screen word aimed at the file shows "file work".
  await page.locator('#body').fill('해치 지워줘');
  await page.waitForTimeout(100);
  assert.equal(await chip.count(), 0);
  await page.locator('#body').fill('CAD에서 해치 숨겨줘');
  await chip.filter({ hasText: '파일 작업' }).waitFor();
  // The chip flips a screen request to file work.
  await page.locator('#body').fill('해치 숨겨줘');
  await chip.filter({ hasText: 'VIDE 화면만 · 해치 1개' }).click();
  await chip.filter({ hasText: '파일 작업' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Request routing checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
