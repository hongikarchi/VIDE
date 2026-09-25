import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-linked-followup-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const input = {
    body: 'Keep the wall and finish the roof',
    provider: 'codex-cli',
    model: 'codex-cli',
    effort: 'default',
    permission: 'candidate',
    host: 'rhino',
    pins: [],
    sketches: [],
    files: [],
  };
  const result = {
    host: 'rhino',
    hostExecuted: true,
    executionMode: 'sdk',
    objects: [
      { id: 'wall', nativeId: 'native-wall', name: 'Wall', kind: 'native', origin: [0, 0, 0] },
    ],
    scene: [{ id: 'wall', nativeType: 'Point', origin: [0, 0, 0] }],
  };
  const make = (id, basis) => ({
    id,
    state: 'succeeded',
    input: {
      ...input,
      id,
      ...(basis ? { baseRequestId: basis, parentRequestId: 'parent' } : {}),
    },
    result,
  });
  const requests = [
    make('base-a'),
    make('base-b'),
    make('child-a', 'base-a'),
    make('child-b', 'base-b'),
  ];
  requests.push({
    id: 'parent',
    state: 'failed',
    input: {
      ...input,
      id: 'parent',
      linkedTargets: [
        { baseRequestId: 'base-a', host: 'rhino' },
        { baseRequestId: 'base-b', host: 'rhino' },
      ],
      coordinateBasis: 'shared-metre-axes',
      pins: [{ id: 'wall', basis: 'base-a', role: 'preserve' }],
      files: [{ name: 'rules', text: 'height 4 m' }],
    },
    result: {
      hostExecuted: false,
      targetResults: [
        { requestId: 'child-a', host: 'rhino', state: 'succeeded', candidate: true },
        { requestId: 'child-b', host: 'rhino', state: 'unknown', candidate: false },
      ],
    },
  });
  if (process.argv.includes('--intervention')) {
    const parent = requests.at(-1);
    requests.push({
      id: 'held',
      state: 'interrupted',
      input: {
        ...structuredClone(parent.input),
        id: 'held',
        supersedesRequestId: parent.id,
        body: parent.input.body + '\nUse height 4.5 m',
      },
      result: { code: 'INTERVENTION_REVIEW_REQUIRED' },
    });
  }
  let submitted;
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/host', (route) =>
    route.fulfill({ json: { available: true, mode: 'sdk' } }),
  );
  await page.route('**/requests', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: requests });
    submitted = route.request().postDataJSON();
    return route.fulfill({
      json: { id: submitted.id, input: submitted, state: 'succeeded', result: { text: 'fixture' } },
    });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.getByRole('button', { name: '확인된 후보에서 이어가기' }).last().click();
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('#body')?.value.includes('Keep the wall'),
  );
  assert.match(await page.locator('#body').inputValue(), /Keep the wall and finish the roof/);
  assert.equal(submitted, undefined, 'Preparing a follow-up must not execute it');
  await page.locator('#request').click();
  await page.waitForFunction(() => document.querySelector('#body').value === '');
  if (process.argv.includes('--intervention')) assert.match(submitted.body, /Use height 4.5 m/);
  assert.equal(submitted.supersedesRequestId, undefined);
  assert.equal(submitted.baseRequestId, null);
  assert.deepEqual(
    submitted.linkedTargets.map((t) => t.baseRequestId),
    ['child-a', 'child-b'],
  );
  assert.equal(submitted.pins[0].basis, 'child-a');
  assert.equal(submitted.pins[0].role, 'preserve');
  assert.equal(submitted.files[0].text, 'height 4 m');
  assert.deepEqual(errors, []);
  console.log(
    'Linked verified candidates, persisted follow-up draft, no automatic execution and explicit submission passed.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
