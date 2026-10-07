// 법규 검토 jig in Chromium (SPEC-13.3·13.5·13.6·13.7·13.9, Design SCR-29, PLAN-46 T-221·T-222)
// against the fake cLAWde server run as its own process (standalone mode, `POST /__control`):
// the first question shows the '보낼 정보' card and nothing is answered before [보내기]; answer cards
// in the fixed order with provenance labels and the figure as an <img>; every verdict, the
// conclusion without citations shown as '판단 불가(근거 없음)', '근거 미확인' and '원문 없음';
// back-question cards answered with [권장값으로 진행] (가정) and not asked again; the stage checklist
// (current stage, '다른 단계 n개', permit-phase filter without a call, stage change kept, an item
// opens its cached answer); verified prose and a failed prose check; the service stopped: answers
// and the checklist shown '오프라인', a new question refused with [다시 시도]. Synthetic only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { testProtector } from '../fixtures/fake-clawde/protector.mjs';

const TOKEN = 'browser-legal-token';
const shot = process.env.VIDE_SHOT_DIR;

/** The fake service as its own process; resolves with its address. */
function startFake() {
  const child = spawn(
    process.execPath,
    ['tests/fixtures/fake-clawde/server.mjs', '--port', '0', '--token', TOKEN],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((resolve, reject) => {
    let out = '';
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`fake cLAWde exited ${code}`)));
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve({ child, url: JSON.parse(line).url });
    });
  });
}

const directory = await mkdtemp(join(tmpdir(), 'vide-legal-ui-'));
let app, browser, fake;
try {
  fake = await startFake();
  const control = (patch) =>
    fetch(`${fake.url}/__control`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then((r) => r.json());
  await control({ delayMs: 0 });
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
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
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
  await engine('/settings/services', 'PUT', { clawde: { baseUrl: fake.url, token: TOKEN } });
  await engine(`${legalBase}/profile`, 'PUT', {
    values: {
      'site.zoning': { value: '제2종일반주거지역' },
      'site.area': { value: 420, unit: '㎡' },
    },
  });

  // Open the jig from the JIG list: J-03 is available.
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'JIG', exact: true });
  // By its code: the official 건축 가능 영역·매스 card also mentions 법규 검토 (T-207 lists it).
  const card = dialog.locator('.jig-card[data-status="available"]', { hasText: 'J-03' });
  await card.getByRole('button', { name: '열기' }).click();
  const jig = page.locator('.legal-jig');
  await jig.locator('.legal-status', { hasText: '연결됨' }).waitFor();
  const box = jig.getByRole('textbox', { name: '법규 질문' });
  const askNow = async (text) => {
    await box.fill(text);
    await jig.getByRole('button', { name: '묻기', exact: true }).click();
  };
  const openAnswer = () => jig.locator('.legal-entry[data-open="true"] .legal-answer');
  const answersCount = async () => (await engine(`${legalBase}/answers`)).answers.length;

  // 1. The send card first: items, values, sources; nothing answered before [보내기].
  await askNow('일조 사선 제한을 받나요?');
  const send = jig.getByRole('region', { name: '보낼 정보' });
  await send.waitFor();
  assert.match(await send.textContent(), /용도지역.*제2종일반주거지역.*사용자 확정/);
  assert.match(await send.textContent(), /대지 면적.*420 ㎡/);
  assert.equal(await answersCount(), 0, 'nothing sent before the card');
  if (shot) await page.screenshot({ path: join(shot, 'legal-send-card.png') });
  await send.getByRole('button', { name: '보내기', exact: true }).click();
  await openAnswer().waitFor();
  assert.equal(await send.count(), 0);

  // 2. The answer card: the fixed order, provenance labels, the figure as an image only.
  const first = openAnswer();
  assert.equal(await first.locator('.legal-verdict').first().textContent(), '적용');
  const parts = await first
    .locator('.legal-part > h4')
    .evaluateAll((hs) => hs.map((h) => h.firstChild.textContent));
  assert.deepEqual(parts, ['결론', '이유', '근거 조항', '그림', '해석', '쓴 정보']);
  const labels = await first
    .locator('.legal-prov')
    .evaluateAll((ps) => ps.map((p) => p.textContent));
  for (const label of ['원문', '서비스 확정', '서비스 해석', '프로젝트 정보'])
    assert.ok(
      labels.some((l) => l.startsWith(label)),
      `label ${label}`,
    );
  const citation = first.locator('.legal-citations li').first();
  assert.match(await citation.textContent(), /건축법 제61조 제1항.*시행 \d{4}-\d{2}-\d{2}/);
  assert.ok(await citation.locator('a', { hasText: '원문 보기' }).getAttribute('href'));
  assert.ok((await citation.locator('.legal-excerpt').textContent()).length > 0);
  const img = first.locator('.legal-figure img');
  assert.match(await img.getAttribute('src'), /^data:image\/svg\+xml;base64,/);
  assert.equal(await first.locator('svg').count(), 0, 'no inline SVG from the service');
  // No site model in this project: the target chips say '모델에 없음' and cannot be pressed (T-220).
  const targets = first.getByRole('group', { name: '대상' }).getByRole('button');
  assert.deepEqual(await targets.allTextContents(), [
    '대지 · 모델에 없음',
    '인접 대지 · 모델에 없음',
  ]);
  assert.equal(await targets.first().isDisabled(), true);
  await first.getByRole('button', { name: '보낸 정보' }).click();
  assert.match(await first.getByRole('list', { name: '보낸 정보' }).textContent(), /규모검토/);
  if (shot) await page.screenshot({ path: join(shot, 'legal-answer.png') });

  // 3. Every verdict; the unchanged send list asks without a card.
  const expectVerdict = async (question, verdict) => {
    await askNow(question);
    await page.waitForFunction(
      ([q, v]) => {
        const entry = document.querySelector('.legal-entry[data-open="true"]');
        return (
          entry?.querySelector('.legal-row-q')?.textContent === q &&
          entry.querySelector('.legal-answer .legal-verdict')?.textContent === v
        );
      },
      [question, verdict],
    );
    assert.equal(await send.count(), 0, 'no card while the send list is unchanged');
  };
  await expectVerdict('대지 안의 공지를 띄워야 하나요?', '적용 안 됨');
  assert.match(await openAnswer().textContent(), /확인 필요 사항/);
  await expectVerdict('조례로 정한 기준이 있나요?', '판단 불가');
  await expectVerdict('근거 없음 표본입니다', '판단 불가(근거 없음)');
  assert.match(
    await openAnswer().textContent(),
    /원문이 확인된 근거 조항이 없는 결론이라 판단 불가로 보입니다/,
  );
  // Its only citation has no excerpt or link: '원문 없음', so the conclusion has no usable citation.
  await expectVerdict('조경 면적을 둬야 하나요?', '판단 불가(근거 없음)');
  assert.equal(await openAnswer().locator('.legal-mark', { hasText: '근거 미확인' }).count(), 1);
  assert.match(await openAnswer().textContent(), /원문 없음/);

  // 4. Back-question: the cards, [권장값으로 진행] = 가정, then not asked again.
  await expectVerdict('부설주차장은 몇 대인가요?', '조건부');
  const needs = openAnswer().getByRole('region', { name: '되묻기' });
  await needs.getByText('주용도가 무엇인가요?').waitFor();
  assert.equal(await needs.locator('.qcard').count(), 1);
  if (shot) await page.screenshot({ path: join(shot, 'legal-back-question.png') });
  const before = await answersCount();
  await needs.getByRole('button', { name: '권장값으로 진행 · 가정으로 기록' }).click();
  await page.waitForFunction(
    (n) =>
      document.querySelector('.legal-entry[data-open="true"] .legal-ref')?.textContent === `L${n}`,
    before + 1,
  );
  assert.equal(await openAnswer().getByRole('region', { name: '되묻기' }).count(), 0);
  assert.match(
    await openAnswer().getByRole('region', { name: '쓴 정보' }).textContent(),
    /주용도업무시설가정/,
  );
  const profile = await engine(`${legalBase}/profile`);
  assert.equal(profile.items.find((i) => i.key === 'plan.mainUse').source, 'assumed');

  // 5. The stage checklist: 규모검토 items, the rest folded, the phase filter, stage kept.
  await jig.getByRole('tab', { name: '단계별 법령' }).click();
  const current = jig.getByRole('list', { name: '규모검토 항목' });
  await current.waitFor();
  assert.deepEqual(await current.locator('.legal-check-top strong').allTextContents(), [
    '일조 사선',
    '주차',
    '대지 안의 공지',
  ]);
  const others = jig.locator('.legal-others');
  assert.equal(await others.locator('summary').textContent(), '다른 단계 3개');
  await others.locator('summary').click();
  assert.match(await others.textContent(), /기본설계BF 인증/);
  const phases = jig.getByRole('group', { name: '인허가 시점' });
  await phases.getByRole('button', { name: '허가', exact: true }).click();
  assert.deepEqual(await current.locator('.legal-check-top strong').allTextContents(), [
    '일조 사선',
    '주차',
  ]);
  await phases.getByRole('button', { name: '착공', exact: true }).click();
  await jig.getByText('이 인허가 시점에 걸리는 이 단계 항목이 없습니다.').waitFor();
  await phases.getByRole('button', { name: '전체', exact: true }).click();
  if (shot) await page.screenshot({ path: join(shot, 'legal-checklist.png') });
  // An item opens its answer: the parking answer kept for this send list, no new question.
  const count = await answersCount();
  await jig.getByRole('tab', { name: /^답/ }).click();
  await jig.locator('.legal-entry').first().locator('.legal-row').click();
  await jig.getByRole('tab', { name: '단계별 법령' }).click();
  await current.getByRole('button', { name: /주차/ }).click();
  await page.waitForFunction(
    (ref) =>
      document.querySelector('.legal-entry[data-open="true"] .legal-ref')?.textContent === ref,
    `L${count}`,
  );
  assert.equal(await answersCount(), count, 'the cached answer, no new question');
  // Another stage: the list follows and the stage stays in the profile.
  await jig.getByRole('tab', { name: '단계별 법령' }).click();
  await jig
    .getByRole('group', { name: '설계 단계' })
    .getByRole('button', { name: '기본설계' })
    .click();
  const dd = jig.getByRole('list', { name: '기본설계 항목' });
  await dd.waitFor();
  assert.deepEqual(await dd.locator('.legal-check-top strong').allTextContents(), ['BF 인증']);
  assert.equal((await engine(`${legalBase}/profile`)).stage, 'design-development');
  assert.equal(
    await jig.getByRole('combobox', { name: '설계 단계' }).inputValue(),
    'design-development',
  );

  // 6. Prose (T-236 fields when present): verified prose and a failed check.
  await page.route('**/legal/answers', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    const [newest, second] = json.answers;
    newest.prose = {
      conclusion: '[시험 문구] 검증된 문장으로 쓴 결론입니다.',
      reasons: [],
      interpretation: [],
      recipe: { id: 'answer-prose', version: '1.1.0' },
      writer: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' },
    };
    newest.proseStatus = 'verified';
    second.proseStatus = 'failed';
    second.proseFailures = [{ code: 'REF_OUTSIDE', message: 'ref outside the evidence' }];
    await route.fulfill({ response, json });
  });
  await jig.getByRole('tab', { name: /^답/ }).click();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await page.getByRole('button', { name: 'JIG', exact: true }).click();
  await card.getByRole('button', { name: '열기' }).click();
  await openAnswer().waitFor();
  assert.match(await openAnswer().textContent(), /검증된 문장으로 쓴 결론/);
  assert.match(
    await openAnswer().locator('.legal-prov[data-prov="ai-verified"]').first().textContent(),
    /AI 문장\(검증됨\).*1\.1\.0.*claude-opus-5-5/,
  );
  await jig.locator('.legal-entry').nth(1).locator('.legal-row').click();
  assert.match(await openAnswer().textContent(), /문장 생성 검증 실패/);
  assert.equal(await openAnswer().getByRole('button', { name: '다시 쓰기' }).count(), 1);
  await page.unroute('**/legal/answers');

  // 7. The service stops: a new question is refused with [다시 시도]; cached answers and the
  // checklist show '오프라인'.
  fake.child.kill();
  await new Promise((resolve) => fake.child.once('exit', resolve));
  fake = undefined;
  await askNow('건폐율은 얼마인가요?');
  const alert = jig.getByRole('alert');
  await alert.getByText('서비스에 닿지 않음').waitFor();
  assert.equal(await alert.getByRole('button', { name: '다시 시도' }).count(), 1);
  await jig.locator('.legal-row .legal-mark[data-mark="offline"]').first().waitFor();
  assert.match(
    await jig.locator('.legal-row .legal-mark[data-mark="offline"]').first().textContent(),
    /오프라인 · 오늘 조회/,
  );
  await jig.getByRole('tab', { name: '단계별 법령' }).click();
  await jig.locator('.legal-list-meta .legal-mark[data-mark="offline"]').waitFor();
  assert.deepEqual(
    await jig.getByRole('list', { name: '기본설계 항목' }).locator('strong').allTextContents(),
    ['BF 인증'],
  );
  if (shot) await page.screenshot({ path: join(shot, 'legal-offline.png') });

  const bounds = await jig.boundingBox();
  assert.ok(bounds.width > 300 && bounds.x >= 0);
  assert.deepEqual(errors, []);
  console.log(
    'Chromium: legal jig — send card first, answer card order and labels, every verdict, downgrade and unverified refs, back-question as 가정, stage checklist with phase filter, prose states, offline.',
  );
} finally {
  await browser?.close();
  await app?.close();
  fake?.child.kill();
  await rm(directory, { recursive: true, force: true });
}
