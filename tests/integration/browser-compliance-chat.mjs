// 법규 체크 opened from the chat (PLAN-51 T-271·T-272, SPEC-15.1 1·2, SPEC-02.17 2): the router
// opens `vide/compliance-check`, the AI turn after the start is answered 'succeeded' by a routed
// fake, and the route row leaves 'AI가 요약하는 중' for the turn's end and the work copy's state
// ('응답 완료 · 작업본 … 열림 · '법규 체크' 전'). The screen shows the labelled [법규 체크] at its
// top and in the empty result, '규제 조건 없음 — …' with no 건축 가능 영역·매스 work copy, and never
// asks for the classification without a document key (no 400). Real server, no host, no CLI.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-compliance-chat-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const badRoles = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (/\/compliance\/roles/.test(response.url()) && response.status() === 400)
      badRoles.push(response.url());
  });
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'claude-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'sonnet', name: 'Sonnet', provider: 'claude-cli', efforts: ['default'] }],
    }),
  );
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: { target: 'jig', by: 'rules', jig: 'vide/compliance-check', jigName: '법규 체크' },
    }),
  );
  // The AI turn after the start: accepted, read once as running, then succeeded (no summary card).
  const served = {};
  await page.route(/\/requests(\/[^/?]+)?(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const [, id] = /\/requests(?:\/([^/]+))?$/.exec(url.pathname);
    if (route.request().method() === 'POST' && !id) {
      const input = JSON.parse(route.request().postData());
      served[input.id] = { id: input.id, state: 'queued', input, result: null, reads: 0 };
      return route.fulfill({ status: 202, json: served[input.id] });
    }
    const request = id && served[id];
    if (!request || route.request().method() !== 'GET') return route.continue();
    request.reads++;
    request.state = request.reads < 2 ? 'running' : 'succeeded';
    return route.fulfill({ json: request });
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page
    .locator('#body')
    .fill('법규검토하고, 지금 우리 건물 설계에서 법규 위반 사항 없는지 확인해줘');
  await page.locator('#request').click();

  const panel = page.locator('[data-jig-panel="vide/compliance-check"]');
  await panel.waitFor();
  // T-271: the labelled [법규 체크] at the top and in the empty result.
  // The state cells and the result drawer sit in the stage beside the jig column.
  await page.locator('[data-check-button="top"]').waitFor();
  await page.locator('.cmp-drawer [data-check-button="empty"]').waitFor();
  assert.equal((await page.locator('[data-check-button="top"]').textContent()).trim(), '법규 체크');
  // No 건축 가능 영역·매스 work copy in this project: said before any check (SPEC-15.5 3).
  await page
    .locator('[data-limits-missing]')
    .first()
    .getByText('규제 조건 없음 — 사람 입력 또는 건축 가능 영역·매스 계산 필요')
    .waitFor();

  // T-272: the turn ended — the route row settles, no spinner after '응답 완료'.
  const card = page.locator('#route-card');
  await page.waitForFunction(() =>
    /응답 완료 · 작업본 .+ 열림/.test(document.querySelector('#route-card')?.textContent ?? ''),
  );
  const text = await card.textContent();
  assert.doesNotMatch(text, /요약하는 중/);
  assert.match(text, /'법규 체크' 전/);
  assert.ok(Object.keys(served).length >= 1, 'the AI turn was sent');

  assert.deepEqual(badRoles, [], 'roles never asked for without a document key');
  assert.deepEqual(errors, []);
  console.log('browser-compliance-chat: ok');
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
