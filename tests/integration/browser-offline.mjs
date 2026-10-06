// PLAN-20 in the VIDE window: the per-project switch for the saved view on the account site and
// the inbox of requests left there ("작성기로" puts the text in the composer; nothing is sent).
// PLAN-33: the switch for 할 일 and the work history summary on the site (on by default).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-offline-ui-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [],
    calls = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const link = new DocumentLinks(app.store).link(projectId, {
    host: 'zwcad',
    name: 'plan.dwg',
    path: 'C:/work/plan.dwg',
    instance: '1:1',
    documentId: 1,
  });
  // The PC is signed in to the account (the site itself is covered by tests/sharing/offline.mjs).
  const item = {
    id: '6f1d0c52-8a55-4a55-9d4b-1a1a1a1a1a1a',
    projectId,
    linkId: link.id,
    body: 'X3열 보를 H-400으로 바꿔줘',
    createdAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
  };
  let status = {
    enabled: false,
    linked: true,
    files: [
      {
        linkId: link.id,
        name: 'plan.dwg',
        uploadedAt: null,
        size: null,
        upToDate: false,
        synced: true,
        error: null,
      },
    ],
    inbox: [item],
  };
  await page.route('**/offline-view**', async (route) => {
    const request = route.request();
    calls.push(`${request.method()} ${new URL(request.url()).pathname.split('/offline-view')[1]}`);
    if (request.method() === 'PUT' && 'summary' in request.postDataJSON())
      status = { ...status, summary: request.postDataJSON().summary };
    else if (request.method() === 'PUT') {
      const enabled = request.postDataJSON().enabled;
      status = {
        ...status,
        enabled,
        files: status.files.map((file) => ({
          ...file,
          uploadedAt: enabled ? new Date().toISOString() : null,
          size: enabled ? 2_300_000 : null,
          upToDate: enabled,
        })),
      };
    }
    if (request.url().endsWith('/dismiss')) status = { ...status, inbox: [] };
    await route.fulfill({ json: status });
  });
  await page.reload();
  const panel = page.locator('#host-document-controls');
  await panel.getByText('사이트에서 남긴 요청 1').waitFor();
  await panel.getByText('X3열 보를 H-400으로 바꿔줘').waitFor();
  // The switch: off by default, on stores the saved view (state shown next to it).
  const toggle = panel.getByLabel('PC가 꺼져도 사이트에서 보기');
  assert.equal(await toggle.isChecked(), false);
  await toggle.check();
  await panel.getByText('1개 저장 · 2.2 MB').waitFor();
  // PLAN-33: 할 일 and the history summary go to the site unless turned off for the project.
  const summary = panel.getByLabel('할 일·작업 이력 요약을 사이트에 올리기');
  assert.equal(await summary.isChecked(), true);
  await summary.uncheck();
  assert.equal(await summary.isChecked(), false);
  // "작성기로": the request text goes to the composer for the user to read and send.
  await panel.getByRole('button', { name: '작성기로' }).click();
  await page.waitForFunction(
    () => document.querySelector('#body').value === 'X3열 보를 H-400으로 바꿔줘',
  );
  await panel.getByText('사이트에서 남긴 요청').waitFor({ state: 'detached' });
  assert.equal(calls.filter((call) => call === 'PUT ').length, 2, calls.join(','));
  assert.equal(status.summary, false);
  assert.ok(calls.some((call) => call.endsWith('/dismiss')));
  if (process.env.VIDE_SHOT) await page.screenshot({ path: process.env.VIDE_SHOT });
  assert.deepEqual(errors, []);
  console.log('Offline view panel checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
