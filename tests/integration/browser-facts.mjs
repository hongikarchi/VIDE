// 자료 workspace tab (PLAN-22 T-065, Design SCR-19): the tab opens over the centre, shows the KPI
// strip and the status report, opens an issue note, searches (a 2-letter and a 3-letter word), shows
// a statement's excerpt in the drawer, records 확정 and 오염 with a reason, leaves excluded statements
// out until '제외된 n건 보기' (asked with `status=excluded`), leaves a whole source file out through
// POST /facts/rules, and a basis chip (`data-fact-statement`) opens the fact window with a way to the
// tab. The facts routes are answered here with synthetic data, so the test does not depend on a
// crawler DB; every answer is parsed with the engine's reply schemas (src/contracts/facts.ts).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import {
  factEvidenceSchema,
  factIssueSchema,
  factRulesSchema,
  factSearchSchema,
  factSummarySchema,
  recordedReviewSchema,
} from '../../src/contracts/facts.ts';

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-facts-'));

const statement = (id, content, extra = {}) => ({
  id,
  kind: 'decision',
  party: '구조팀',
  subject: '경간',
  content,
  saidOn: '2026-09-01',
  quote: content.slice(0, 6),
  sourceId: id * 10,
  path: `회의록/회의-${id}.txt`,
  locator: 'p1',
  ref: `S${id}`,
  state: 'unconfirmed',
  excluded: false,
  reason: null,
  review: null,
  ...extra,
});
/** A statement as the engine sends it after the review layer and the source rules. */
const layered = (s) => {
  const verdict = s.review?.verdict;
  const ruled = rules.some((rule) => rule.pattern === s.path);
  const state =
    verdict === 'confirmed' || verdict === 'corrected'
      ? 'confirmed'
      : verdict === 'rejected' || verdict === 'contaminated'
        ? verdict
        : ruled
          ? 'excluded-source'
          : 'unconfirmed';
  return {
    ...s,
    state,
    excluded: ['rejected', 'contaminated', 'excluded-source'].includes(state),
    reason: s.review?.reason ?? (ruled ? '합성 규칙' : null),
  };
};
const statements = [
  statement(11, '기둥 경간은 9 m로 한다.'),
  statement(12, '보 춤은 700 mm 이하로 한다.'),
  statement(13, '다른 현장의 하중 조건 메모', { kind: 'info' }),
];
const excludedStatement = statement(14, '철회된 경간 안', {
  review: {
    verdict: 'rejected',
    reason: '이후 회의에서 철회',
    correction: null,
    supersededBy: null,
    by: 'user',
    at: '2026-09-02',
  },
});
const all = () => [...statements, excludedStatement].map(layered);
const count = (verdict) => all().filter((s) => s.review?.verdict === verdict).length;
const summary = () => ({
  available: true,
  builtAt: '2026-09-20T00:00:00Z',
  sizeBytes: 4096,
  brief: {
    overview: '합성 자료의 현황 요약입니다.',
    asOf: '2026-09-20',
    since: '2026-09-10',
    decided: [{ text: '경간 9 m 확정', issue: 1, cite: [11] }],
    blocked: [{ text: '보 춤 확인 대기', issue: 1, cite: [12], waiting: '구조팀' }],
    changed: [],
  },
  counts: { files: 3, excerpts: 3, statements: 4, issues: 1, mails: 0 },
  disciplines: [
    {
      key: 'structure',
      label: '구조',
      brief: { state: '경간 정리 중', decided: [], blocked: [], changed: [] },
      issues: [
        {
          id: 1,
          discipline: 'structure',
          title: '경간과 보 춤',
          status: 'open',
          summary: '요약',
          statements: 2,
          open: 1,
        },
      ],
    },
  ],
  reviews: {
    confirmed: count('confirmed'),
    rejected: count('rejected'),
    contaminated: count('contaminated'),
    superseded: 0,
    corrected: 0,
    rules: rules.length,
  },
});
const rules = [];
const posted = [];
const searches = [];
const searchPage = (items, excluded) => ({
  items,
  total: items.length,
  offset: 0,
  nextOffset: null,
  excluded,
  capped: false,
  plan: { fts: true, words: [] },
});

let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({ json: [{ id: 'codex-cli', available: true }] }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [{ id: 'codex-cli', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    }),
  );
  await page.route(/\/api\/v1\/projects\/[^/]+\/facts(\/.*)?(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/facts/, '');
    const method = route.request().method();
    if (method === 'GET' && path === '')
      return route.fulfill({ json: factSummarySchema.parse(summary()) });
    if (method === 'GET' && path === '/search') {
      const q = url.searchParams.get('q') ?? '';
      searches.push(Object.fromEntries(url.searchParams));
      const found = all().filter((s) => s.content.includes(q));
      const hidden = found.filter((s) => s.excluded);
      const items =
        url.searchParams.get('status') === 'excluded' ? hidden : found.filter((s) => !s.excluded);
      return route.fulfill({ json: factSearchSchema.parse(searchPage(items, hidden.length)) });
    }
    const issue = /^\/issues\/(\d+)$/.exec(path);
    if (method === 'GET' && issue)
      return route.fulfill({
        json: factIssueSchema.parse({
          id: 1,
          discipline: 'structure',
          title: '경간과 보 춤',
          label: '구조',
          status: 'open',
          summary: '경간 9 m, 보 춤 확인 중',
          note: {
            conclusions: [{ text: '경간은 9 m', cite: [11] }],
            open: [{ text: '보 춤 상한 확인', cite: [12] }],
            conditions: [],
            history: [],
          },
          statements: all().slice(0, 2),
          excluded: 0,
        }),
      });
    const one = /^\/statements\/(\d+)$/.exec(path);
    if (method === 'GET' && one) {
      const found = all().find((s) => s.id === Number(one[1]));
      if (!found) return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
      return route.fulfill({
        json: factEvidenceSchema.parse({
          ...found,
          text: `회의 발췌: ${found.content} 이상.`,
          issue: { id: 1, discipline: 'structure' },
          root: null,
        }),
      });
    }
    const review = /^\/statements\/(\d+)\/review$/.exec(path);
    if (method === 'POST' && review) {
      const body = route.request().postDataJSON();
      posted.push({ review: Number(review[1]), ...body });
      const target = statements.find((s) => s.id === Number(review[1]));
      target.review = {
        verdict: body.verdict,
        reason: body.reason ?? null,
        correction: null,
        supersededBy: null,
        by: 'user',
        at: '2026-09-30T00:00:00Z',
      };
      return route.fulfill({
        json: recordedReviewSchema.parse({
          projectId: 'p',
          statementId: target.id,
          ...target.review,
        }),
      });
    }
    if (method === 'POST' && path === '/rules') {
      const body = route.request().postDataJSON();
      posted.push({ rule: body.sourceId, ...body });
      const source = statements.find((s) => s.sourceId === body.sourceId);
      rules.push({ pattern: source.path, reason: body.reason ?? null });
      return route.fulfill({ json: factRulesSchema.parse({ rules }) });
    }
    return route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } });
  });

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);

  // The rail's 자료 takes the centre; the 3D view is hidden, the conversation column stays.
  const tab = page.locator('.rail [data-workspace-target="data"]');
  await tab.click();
  assert.equal(await page.evaluate(() => document.body.dataset.workspace), 'data');
  const screen = page.locator('.facts-workspace');
  await screen.locator('.kit-kpis').waitFor();
  assert.ok(!(await page.locator('.workspace > .viewport-area').isVisible()));
  assert.ok(await page.locator('#right').isVisible());
  assert.match(await screen.locator('.knowledge-report').textContent(), /경간 9 m 확정/);
  assert.match(await screen.locator('[data-kpi="진술"]').textContent(), /4/);

  // 보기 → 막힌 것 only; 분야 → the issue list; an issue note with its basis.
  await screen.getByRole('button', { name: /막힌 것/ }).click();
  assert.equal(await screen.locator('.knowledge-section[data-list="decided"]').count(), 0);
  await screen.locator('.facts-nav[aria-label="분야"] button', { hasText: '구조' }).click();
  await screen.locator('.facts-issues button', { hasText: '경간과 보 춤' }).click();
  const note = screen.locator('.knowledge-note');
  await note.waitFor();
  await note.locator('.fact-cite').first().click();
  await note.getByRole('button', { name: '근거 원문' }).first().click();
  const drawer = screen.locator('.facts-drawer');
  await drawer.locator('.knowledge-evidence mark').waitFor();
  assert.match(await drawer.locator('.knowledge-evidence').textContent(), /회의 발췌/);
  assert.match(await drawer.locator('.fact-standing').textContent(), /미확정/);

  // 확정 records at once (a person's action); the chip turns 확정.
  await drawer.getByRole('button', { name: '확정', exact: true }).click();
  await drawer.locator('.fact-standing[data-standing="confirmed"]').waitFor();
  assert.deepEqual(posted.at(-1), { review: 11, verdict: 'confirmed' });

  // Search: a 2-letter and a 3-letter word; excluded ones only on request.
  const search = screen.getByLabel('자료 검색');
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  await page.keyboard.press('/');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    '자료 검색',
  );
  await search.fill('경간');
  await search.press('Enter');
  const results = screen.locator('.facts-results');
  await results.waitFor();
  assert.match(await results.locator('h3').textContent(), /검색 결과 1개/);
  await results.getByRole('button', { name: '제외된 1건 보기' }).click();
  await results.locator('h3', { hasText: '제외된 진술' }).waitFor();
  assert.match(await results.textContent(), /이후 회의에서 철회/);
  // Only the left-out ones: `status=excluded` (the engine's `excluded=1` would list them all).
  assert.equal(searches.at(-1).status, 'excluded');
  assert.equal(searches.at(-1).excluded, undefined);
  await search.fill('하중 조건');
  await search.press('Enter');
  await results.locator('h3', { hasText: '검색 결과 1개' }).waitFor();

  // 오염 표시 needs a reason; with the box ticked the whole file is left out too.
  await results.getByRole('button', { name: '근거 원문' }).click();
  await drawer.locator('.fact-detail[data-statement="13"] .knowledge-evidence').waitFor();
  await drawer.getByRole('button', { name: '오염 표시' }).click();
  const record = drawer.getByRole('button', { name: '오염 표시 기록' });
  assert.ok(await record.isDisabled(), 'a reason first');
  await drawer.getByLabel('오염 표시 이유').fill('다른 프로젝트 폴더의 파일');
  await drawer.getByRole('checkbox').check();
  await record.click();
  await drawer.locator('.fact-standing[data-standing="excluded"]').waitFor();
  assert.deepEqual(
    posted.slice(-2).map((entry) => entry.review ?? `rule:${entry.rule}`),
    [13, 'rule:130'],
  );
  assert.equal(posted.at(-2).reason, '다른 프로젝트 폴더의 파일');

  // The summary now counts the rule; a status filter narrows the results.
  await screen.getByText('제외 규칙 1개 적용 중').waitFor();
  await screen
    .getByRole('group', { name: '상태 필터' })
    .getByRole('button', { name: '확정', exact: true })
    .click();
  await results.locator('h3', { hasText: '검색 결과 0개' }).waitFor();

  // A basis chip anywhere opens the fact window; 자료 탭에서 보기 brings the statement to the drawer.
  await page.locator('.rail [data-workspace-target="model"]').click();
  await page.evaluate(() => {
    const chip = document.createElement('span');
    chip.className = 'kit-fact';
    chip.dataset.factStatement = '12';
    chip.textContent = '프로젝트 자료';
    chip.id = 'test-basis-chip';
    document.body.append(chip);
  });
  await page.locator('#test-basis-chip').click();
  const window = page.getByRole('dialog', { name: '진술 12' });
  await window.locator('.knowledge-evidence').waitFor();
  assert.match(await window.textContent(), /보 춤은 700 mm 이하/);
  await page.keyboard.press('Escape');
  await window.waitFor({ state: 'detached' });
  await page.locator('#test-basis-chip').click();
  await window.getByRole('button', { name: '자료 탭에서 보기' }).click();
  await page.waitForFunction(() => document.body.dataset.workspace === 'data');
  await drawer.locator('.fact-detail[data-statement="12"]').waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'facts-tab.png') });

  assert.deepEqual(errors, []);
  console.log('Facts tab checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
