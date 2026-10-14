// 사이트 모델링 jig on screen (PLAN-45 T-207, SPEC-12.3·12.4, Design SCR-13 `site-picker`): the
// official card opens an instance; the FR-18 notice comes first and nothing is sent before
// [확인하고 쓰기]; an ambiguous address becomes a question card with the candidates' small map and
// [PNU 직접 입력]; the chosen parcel is '미확정' until [대상 필지 확정]; [가져오기] fills the steps,
// KPIs and the 대지 요약 table; the project's off switch hides the public path and comes back.
// Synthetic public services (tests/fixtures/site-data.mjs) and keys; no host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { KEYS, P1, P2, fakeSiteData } from '../fixtures/site-data.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-site-model-'));
const fake = fakeSiteData();
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    siteDataOptions: { environment: { ...KEYS }, fetch: fake.fetch },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  // T-273 (SPEC-12.3의 6 ③): the sentence names no address and the project has none — the jig
  // opens with the address field first, its reason and the cursor in it; nothing is sent.
  await page.route(/\/requests$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 409, json: { code: 'PROJECT_BUSY' } });
  });
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: { target: 'jig', by: 'rules', jig: 'vide/site-model', jigName: '사이트 모델링' },
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.locator('#body').fill('지금 우리 프로젝트 주변 사이트 모델링 해줘');
  await page.locator('#request').click();
  const opened = page.locator('[data-jig-panel="vide/site-model"] .site-picker').first();
  await opened.locator('.site-ask').waitFor();
  assert.equal(
    (await opened.locator('.site-ask').textContent()).trim(),
    '대지 주소나 PNU를 넣어 주세요 — 프로젝트에 저장된 주소가 없습니다',
  );
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === '주소·지번·PNU',
  );
  assert.equal(fake.calls.length, 0, 'nothing looked up without an address');
  assert.match(await page.locator('#route-card').textContent(), /대지 주소 입력 — jig 화면 맨 위/);
  const askedFirst = await page.evaluate(() => {
    const panel = document.querySelector('[data-jig-panel="vide/site-model"]');
    const picker = panel.querySelector('.site-picker');
    const rail = panel.querySelector('.kit-rail');
    return !!(picker.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  assert.ok(askedFirst, 'the address card comes before the steps');
  await page.unroute(/\/route$/);
  // Close that tab: the rest works on an instance opened from the JIG list.
  await page.locator('button[title^="이 탭 닫기"]').click();
  await page.locator('[data-jig-panel="vide/site-model"]').waitFor({ state: 'detached' });

  // JIG → the official 사이트 모델링 card (J-01 shows once) → a new instance.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  const cards = dialog.locator('.jig-card', { hasText: '사이트 모델링' });
  await cards.first().waitFor();
  assert.equal(await cards.count(), 1, 'one card for J-01');
  const card = cards.first();
  assert.match(await card.textContent(), /공식/);
  await card.getByRole('button', { name: '새로 열기' }).click();
  await card.getByLabel('출력 레이어').fill('VIDE::대지');
  await card.locator('.jig-new').getByRole('button', { name: '열기', exact: true }).click();
  const panel = dialog.locator('[data-jig-panel="vide/site-model"]');
  await panel.waitFor();
  const picker = panel.locator('.site-picker');
  const rail = (id, state) =>
    panel.locator(`.kit-rail li[data-step="${id}"]${state ? `[data-state="${state}"]` : ''}`);
  assert.deepEqual(
    await panel.locator('.kit-rail li').evaluateAll((rows) => rows.map((r) => r.dataset.step)),
    [
      'candidates',
      'confirmTarget',
      'collect',
      'frame',
      'roads',
      'terrain',
      'buildings',
      'summary',
      'make',
    ],
  );

  // The send notice first; an address typed before it is kept and nothing is sent.
  const notice = picker.getByRole('group', { name: '공공 자료 전송 안내' });
  await notice.waitFor();
  assert.match(await notice.textContent(), /api\.vworld\.kr/);
  assert.match(await notice.textContent(), /개인정보는 요청하지 않습니다/);
  await picker.getByLabel('주소·지번·PNU').fill('합성시 가나구 가나로 10');
  await picker.getByRole('button', { name: '찾기' }).click();
  await picker.getByText('공공 자료원에 보내기 전에 아래 안내를 확인하세요.').waitFor();
  assert.equal(fake.calls.length, 0, 'nothing sent before the notice');
  assert.equal(await picker.locator('.qcard').count(), 0, 'nothing asked before a search');
  await notice.getByRole('button', { name: '확인하고 쓰기' }).click();
  await notice.waitFor({ state: 'detached' });

  // Several candidates: a question card with a small map; no candidate is chosen for the person.
  await picker.getByRole('button', { name: '찾기' }).click();
  const question = picker.locator('.qcard', { hasText: '후보 2개' });
  await question.waitFor();
  assert.match(await question.textContent(), /후보 2개/);
  assert.equal(await question.locator('.qcard-option').count(), 2);
  assert.equal(await question.locator('.qcard-tag').count(), 0, 'no recommendation');
  assert.equal(await picker.locator('svg.site-map circle').count(), 2);
  assert.equal(
    await question.locator('.qcard-free').getAttribute('placeholder'),
    'PNU 직접 입력 (19자리)',
  );
  await question.locator('.qcard-option').first().click();
  await picker.getByRole('button', { name: '이 필지로' }).click();
  await picker.locator('.site-target-list li').first().waitFor();
  assert.match(await picker.locator('.site-target-list').textContent(), new RegExp(P1));
  assert.match(await picker.getByRole('status').first().textContent(), /대상 필지 미확정/);

  // Collect: the steps compute while unconfirmed; Rhino에 만들기 waits for the person.
  await picker.getByRole('button', { name: '가져오기' }).click();
  await rail('summary', 'done').waitFor();
  await rail('confirmTarget', 'waiting').waitFor();
  const top = page.locator('.kit-slot[data-slot="top"]');
  const kpi = (label) => top.locator(`.kit-kpi[data-kpi="${label}"] .kit-kpi-value`).textContent();
  assert.equal(await kpi('대지면적(계산)'), '600.0m²');
  assert.equal(await kpi('주변 건물'), '2동');
  const drawer = page.locator('.kit-slot[data-slot="drawer"]');
  const summary = drawer.getByRole('table', { name: '대지 요약' });
  await summary.waitFor();
  assert.match(await summary.textContent(), /제2종일반주거지역/);
  assert.match(await summary.textContent(), /원본에서 읽음/);
  assert.match(await summary.textContent(), /도구로 계산함/);
  await drawer.getByRole('tab', { name: /^건물/ }).click();
  assert.match(await drawer.getByRole('table', { name: '건물' }).textContent(), /건물 정보/);

  // [대상 필지 확정] → confirmed; the bake waits no more on the target.
  if (process.env.VIDE_SHOT_DIR)
    await page.screenshot({ path: join(process.env.VIDE_SHOT_DIR, 'site-model.png') });
  await picker.getByRole('button', { name: '대상 필지 확정' }).click();
  await picker.getByText('대상 필지를 확정했습니다.').waitFor();
  await rail('confirmTarget', 'confirmed').waitFor();
  assert.ok(await picker.getByRole('button', { name: '다시 가져오기' }).isVisible());
  // The bake card offers this jig's site bakes only (not the frame jig's members).
  const bakeCard = panel.locator('[data-part="bake-card"]');
  await bakeCard.getByRole('button', { name: '만들기', exact: true }).waitFor();
  assert.equal(await bakeCard.getByRole('button', { name: '부재 만들기' }).count(), 0);

  // The project's off switch: public data off, then on again (the confirmation stays).
  await picker.getByLabel(/이 프로젝트에서 공공 자료 끄기/).click();
  await picker.getByText('이 프로젝트는 공공 자료를 쓰지 않습니다. 넣은 SHP만 씁니다.').waitFor();
  assert.ok(await picker.getByRole('button', { name: '다시 가져오기' }).isDisabled());
  await picker.getByRole('button', { name: '다시 켜기' }).click();
  await picker.getByLabel(/이 프로젝트에서 공공 자료 끄기/).waitFor();

  // T-288 (SPEC-07.18 3.6·SPEC-12.3의 3): a jig started from a request computes up to 대상 필지
  // 확정; once the person confirms it, the panel runs on up to Rhino에 만들기 (R3 R1-B: 4~7단계가
  // '계산 전'에 머묾). The open instance is started again from a request; a changed parcel list asks
  // again.
  const runs = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/jig-instances\/[^/]+\/run$/.test(request.url()))
      runs.push(request.postDataJSON());
  });
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: { target: 'jig', by: 'rules', jig: 'vide/site-model', jigName: '사이트 모델링' },
    }),
  );
  await page.locator('#body').fill('지금 우리 프로젝트 주변 사이트 모델링 해줘');
  await page.locator('#request').click();
  const tab = page.locator('[data-jig-panel="vide/site-model"]').first();
  const tabPicker = tab.locator('.site-picker');
  const tabRail = (id, state) =>
    tab.locator(`.kit-rail li[data-step="${id}"][data-state="${state}"]`);
  await tabRail('confirmTarget', 'confirmed').waitFor();
  await page.unroute(/\/route$/);
  await tabPicker.getByLabel('필지 더하기 (PNU)').fill(P2);
  await tabPicker.getByRole('button', { name: '더하기' }).click();
  await tabRail('confirmTarget', 'reconfirm').waitFor();
  // While the parcels wait for the person again, the started run stops there.
  const waited = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/jig-instances\/[^/]+\/run$/.test(response.url()),
  );
  await tabPicker.getByRole('button', { name: '다시 가져오기' }).click();
  await waited;
  assert.equal(runs.at(-1)?.until, 'confirmTarget', 'stops at the person step while it waits');
  // T-295 (SPEC-02.17 2): the route row follows this run, not the start's first one.
  await page.waitForFunction(() =>
    /사람 확인 대기: 대상 필지 확정/.test(document.querySelector('#route-card')?.textContent ?? ''),
  );
  const ranAfter = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/jig-instances\/[^/]+\/run$/.test(response.url()),
  );
  await tabPicker.getByRole('button', { name: '대상 필지 확정' }).click();
  await ranAfter;
  await tabPicker.getByText('대상 필지를 확정했습니다.').waitFor();
  assert.equal(runs.at(-1).until, undefined, 'runs on past the confirmed step');
  for (const id of ['collect', 'frame', 'roads', 'terrain', 'buildings'])
    await tabRail(id, 'done').waitFor();
  await tabRail('summary', 'done').waitFor();
  await tabRail('make', 'waiting').waitFor();
  // T-295 (SPEC-02.17 2): the route row follows the latest run — no '사람 확인 대기: 대상 필지
  // 확정' or '멈춘 단계' once every step before Rhino에 만들기 has computed.
  await page.waitForFunction(() => {
    const text = document.querySelector('#route-card')?.textContent ?? '';
    return /사이트 모델링/.test(text) && !/사람 확인 대기|멈춘 단계/.test(text);
  });
  // T-295 (R4 R1-B, SPEC-12.3의 3): a new work copy, one parcel found and chosen, the notice
  // confirmed in this project — [대상 필지 확정] alone runs on to Rhino에 만들기: the first copy is
  // fetched with it, so 수집 is never left '막힘' waiting for [가져오기].
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const again = dialog.locator('.jig-card', { hasText: '사이트 모델링' }).first();
  await again.getByRole('button', { name: '새로 열기' }).click();
  await again.getByLabel('출력 레이어').fill('VIDE::대지2');
  await again.locator('.jig-new').getByRole('button', { name: '열기', exact: true }).click();
  const fresh = dialog.locator('[data-jig-panel="vide/site-model"]', { hasText: 'VIDE::대지2' });
  await fresh.waitFor();
  const freshPicker = fresh.locator('.site-picker');
  const freshRail = (id, state) =>
    fresh.locator(`.kit-rail li[data-step="${id}"][data-state="${state}"]`);
  await freshPicker.getByLabel('주소·지번·PNU').fill('합성시 가나구 가나동 3');
  await freshPicker.getByRole('button', { name: '찾기' }).click();
  const one = freshPicker.locator('.qcard');
  await one.waitFor();
  await one.locator('.qcard-option').first().click();
  await freshPicker.getByRole('button', { name: '이 필지로' }).click();
  await freshPicker.locator('.site-target-list li').first().waitFor();
  await freshRail('confirmTarget', 'waiting').waitFor();
  const collectsBefore = fake.calls.length;
  // T-295 (R5 R1-B): hold the fetch the confirmation starts — while it runs the rail says
  // '수집 중…' (not '막힘 · … 가져오세요'), [가져오기] is greyed as '가져오는 중…', and a second
  // press sends no second collect.
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let collectPosts = 0;
  const collectRoute = /\/site-data\/[^/]+\/collect$/;
  await page.route(collectRoute, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    collectPosts += 1;
    await held;
    return route.continue();
  });
  await freshPicker.getByRole('button', { name: '대상 필지 확정' }).click();
  await freshPicker.getByText('대상 필지를 확정했습니다.').waitFor();
  const fetchingRow = freshRail('collect', 'running');
  await fetchingRow.waitFor();
  assert.match(await fetchingRow.locator('.kit-rail-meta').textContent(), /^수집 중…/);
  assert.equal(await fetchingRow.locator('.kit-rail-why').count(), 0, 'no blocked reason');
  assert.doesNotMatch(await fresh.locator('.kit-rail').textContent(), /막힘|가져오세요/);
  const fetchButton = freshPicker.getByRole('button', { name: '가져오는 중…' });
  assert.ok(await fetchButton.isDisabled(), 'the fetch button is greyed while it runs');
  await fetchButton.click({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  assert.equal(collectPosts, 1, 'one collect while the first one runs');
  release();
  await freshRail('collect', 'done').waitFor();
  await page.unroute(collectRoute);
  assert.equal(collectPosts, 1, 'no second collect after the first one ends');
  await freshRail('summary', 'done').waitFor();
  await freshRail('make', 'waiting').waitFor();
  assert.ok(fake.calls.length > collectsBefore, 'the first copy was fetched with the confirmation');
  assert.ok(await freshPicker.getByRole('button', { name: '다시 가져오기' }).isVisible());
  // The AI turn after the T-273 start is refused by the stub above (409); nothing else may fail.
  assert.deepEqual(
    errors.filter((e) => !/status of 409/.test(e)),
    [],
  );
  console.log(
    JSON.stringify({
      askedForAddress: true,
      noticeFirst: true,
      question: true,
      unconfirmedThenConfirmed: true,
      collected: true,
      offSwitch: true,
      continuesAfterConfirm: true,
      fetchingNotBlocked: true,
      calls: fake.calls.length,
    }),
  );
} finally {
  await browser?.close();
  await app?.close?.();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
