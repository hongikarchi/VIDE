// Request routing (SPEC-02.17): Jev decides at send time whether a request only changes the VIDE
// view (done here, nothing sent) or goes to the AI; a view-only result can still be sent to the AI.
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
    posted = [],
    asked = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', available: true },
        { id: 'codex-cli', available: true },
      ],
    }),
  );
  // Sending to the AI is only recorded here (no CLI runs in this test).
  await page.route(/\/requests$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(JSON.parse(route.request().postData()).body);
    return route.fulfill({ status: 409, json: { code: 'PROJECT_BUSY' } });
  });
  // Jev's judgement (the server's /route), scripted per request text; null = leave it to the rules.
  const jev = {
    '텍스트만 남기고 숨겨줘': { target: 'view', action: 'isolate', subject: 'kind:문자' },
    '해치 지워줘': { target: 'document' },
    'A-HATCH 꺼줘': { target: 'view', action: 'hide', subject: 'layer:A-HATCH' },
  };
  await page.route('**/route', async (route) => {
    const sent = JSON.parse(route.request().postData());
    asked.push(sent);
    await route.fulfill({ json: jev[sent.body] ?? { target: null } });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() =>
    document.querySelector('.object-summary')?.textContent.startsWith('8개'),
  );
  // No route chip before sending; Jev decides when the request is sent.
  await page.locator('#body').fill('텍스트만 남기고 숨겨줘');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('#context .route-chip').count(), 0);
  await page.locator('#request').click();
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 5);
  assert.match(await page.locator('#message').textContent(), /문자 3개 만 표시 · 원본은 그대로/);
  assert.equal(await page.locator('#body').inputValue(), '');
  // Jev is shown the object groups on screen: kinds and layers.
  const ids = asked[0].subjects.map((subject) => subject.id);
  assert.ok(ids.includes('kind:문자') && ids.includes('layer:A-HATCH'), ids.join());
  // Unsure Jev (null): the rules still handle plain view words.
  await page.locator('#body').fill('모두 다시 보여줘');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 0);
  assert.deepEqual(posted, []);
  // A layer turned off: rules would have sent this to the AI ("꺼" is no view word); Jev keeps it.
  await page.locator('#body').fill('A-HATCH 꺼줘');
  await page.locator('#request').click();
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 1);
  assert.deepEqual(posted, []);
  // Wrong call? One button undoes the view change and sends the same words to the AI.
  await page.locator('#message .message-action').filter({ hasText: 'AI 작업으로 보내기' }).click();
  await page.waitForFunction(() => window.videViewport.hiddenCount() === 0);
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(posted, ['A-HATCH 꺼줘']);
  // File work goes to the AI.
  await page.locator('#body').fill('해치 지워줘');
  await page.locator('#request').click();
  for (let i = 0; i < 40 && posted.length < 2; i++) await page.waitForTimeout(50);
  assert.deepEqual(posted, ['A-HATCH 꺼줘', '해치 지워줘']);
  assert.deepEqual(errors, []);
  console.log('Request routing checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
