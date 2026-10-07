// 되돌려 보내기 in Chromium (SPEC-13.10, PLAN-46 T-224) against the fake cLAWde server: the legal
// jig's [cLAWde로 보내기] tab lists every profile value with nothing ticked; assumptions and AI
// estimates show greyed and cannot be ticked; [보내기] sends only the ticked items; a partial refusal
// shows the refused item with its reason and the accepted one as '보냄'. Synthetic only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { startFakeClawde } from '../fixtures/fake-clawde/server.mjs';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-legal-contribute-'));
let app, browser, fake;
try {
  fake = await startFakeClawde();
  app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    serviceOptions: { protector: testProtector },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const engine = (path, method = 'GET', data) =>
    page.evaluate(
      async ({ path, method, data }) => {
        const response = await fetch(`/api/v1${path}`, {
          method,
          headers: data ? { 'Content-Type': 'application/json' } : {},
          body: data ? JSON.stringify(data) : undefined,
        });
        return response.json();
      },
      { path, method, data },
    );
  const legalBase = `/projects/${projectId}/legal`;
  await engine('/settings/services', 'PUT', { clawde: { baseUrl: fake.url, token: fake.token } });
  await engine(`${legalBase}/profile`, 'PUT', {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'site.area': { value: 420, unit: '㎡' },
      'plan.mainUse': { value: '업무시설' },
      'plan.floorsAbove': { value: 5, assumed: true },
    },
  });
  fake.control({ rejectKeys: ['plan.mainUse'] });

  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  // By its code: the official 건축 가능 영역·매스 card also mentions 법규 검토 (T-207 lists it).
  const card = dialog.locator('.jig-card[data-status="available"]', { hasText: 'J-03' });
  await card.getByRole('button', { name: '열기' }).click();
  const jig = page.locator('.legal-jig');
  await jig.locator('.legal-status', { hasText: '연결됨' }).waitFor();
  await jig.getByRole('tab', { name: 'cLAWde로 보내기' }).click();
  const panel = jig.getByRole('region', { name: 'cLAWde로 보내기' });
  const box = (name) => panel.getByRole('checkbox', { name: `${name} 보내기` });
  await box('용도지역').waitFor();

  // Nothing ticked; the assumption cannot be ticked.
  for (const name of ['용도지역', '대지 면적', '주용도']) {
    assert.equal(await box(name).isChecked(), false, name);
    assert.equal(await box(name).isDisabled(), false, name);
  }
  assert.equal(await box('지상 층수').isDisabled(), true, 'an assumption');
  assert.match(await panel.textContent(), /가정 · 보낼 수 없음/);
  const send = panel.getByRole('button', { name: /^보내기/ });
  assert.equal(await send.isDisabled(), true, 'nothing ticked');
  assert.equal(fake.received.filter((r) => r.path === '/v1/contributions').length, 0);

  await box('대지 면적').check();
  await box('주용도').check();
  if (shot) await page.screenshot({ path: join(shot, 'legal-contribute.png') });
  await send.click();
  const result = panel.getByRole('status');
  await result.waitFor();
  assert.match(await result.textContent(), /받음 1개 · 거절 1개/);
  assert.match(await result.textContent(), /주용도.*rejected by service review/);
  const posted = fake.received.filter((r) => r.path === '/v1/contributions');
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body.items.map((i) => i.key).sort(), ['plan.mainUse', 'site.area']);
  assert.equal(await box('대지 면적').isDisabled(), true, '보냄');
  assert.match(await panel.locator('li[data-sent]').textContent(), /보냄 · 접수 fake-receipt-1/);
  assert.equal(await box('주용도').isDisabled(), false, 'refused: may go again');
  if (shot) await page.screenshot({ path: join(shot, 'legal-contribute-result.png') });
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: legal jig cLAWde로 보내기 — nothing ticked, assumptions greyed, only ticked items sent, partial refusal and 보냄.',
  );
} finally {
  await browser?.close();
  await app?.close();
  await fake?.close();
  await rm(directory, { recursive: true, force: true });
}
