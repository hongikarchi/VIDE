// T-191 (SPEC-01.1 「프로젝트 삭제」): the open project removed elsewhere (site clean-up, another
// window). The first NOT_FOUND for it re-reads the project list; the window says so, goes back to
// the project list and stops asking about the removed project (2026-10-06: 40 minutes of polling).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-project-gone-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'data', 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const engine = (path, method = 'GET', body) =>
    page.evaluate(
      async ([path, method, body]) => {
        const response = await fetch('api/v1' + path, {
          method,
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        return response.json();
      },
      [path, method, body],
    );
  const kept = await engine('/projects', 'POST', { name: '남는 프로젝트' });
  const removed = await engine('/projects', 'POST', { name: '지울 프로젝트' });
  await page.goto(new URL(`/?project=${removed.id}`, app.origin).href);
  await page.waitForFunction(
    (id) => document.querySelector('#project-picker')?.value === id,
    removed.id,
  );
  // Calls about the removed project from here on.
  const asked = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/v1/projects/${removed.id}/`)) asked.push(request.url());
  });
  // Removed elsewhere: the window's own polling meets NOT_FOUND.
  await engine(`/projects/${removed.id}`, 'DELETE');
  await page.getByText('프로젝트가 삭제되어 목록으로 돌아갑니다').first().waitFor();
  await page.waitForURL((url) => !url.search.includes(removed.id));
  await page.waitForFunction((id) => {
    const value = document.querySelector('#project-picker')?.value;
    return !!value && value !== id;
  }, removed.id);
  const afterLeave = asked.length;
  await page.waitForTimeout(4000);
  assert.equal(asked.length, afterLeave, 'the removed project is not asked about again');
  assert.ok(afterLeave < 10, `few calls before leaving (${afterLeave})`);
  const listed = await engine('/projects');
  assert.ok(listed.some((project) => project.id === kept.id));
  assert.ok(!listed.some((project) => project.id === removed.id));
  assert.deepEqual(errors, []);
  console.log('browser project gone: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
