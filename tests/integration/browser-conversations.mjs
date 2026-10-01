// Routes without the AI in the composer (SPEC-02.17 2·3, PLAN-24 T-049) and the conversation mount
// points (T-061·T-062): a jig, Sync or a T2 app action is proposed on a card, every
// notice keeps 'AI 작업으로 보내기' (which records the reversal), and ask/document go to the AI.
// T-088: conversations are tabs whose AI is fixed at the first turn; the composer's model follows
// the chosen tab, and another model sends the request to a new conversation (its tab is chosen).
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = await mkdtemp(join(tmpdir(), 'vide-conversations-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [],
    posted = [],
    reverted = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) =>
    route.fulfill({
      json: [
        { id: 'claude-cli', available: true },
        { id: 'codex-cli', available: false },
      ],
    }),
  );
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: [
        { id: 'auto', name: '자동 (Jev)', provider: 'claude-cli', efforts: ['default'] },
        { id: 'sonnet', name: 'Sonnet', provider: 'claude-cli', efforts: ['default', 'low'] },
        { id: 'opus', name: 'Opus', provider: 'claude-cli', efforts: ['default', 'low'] },
      ],
    }),
  );
  // Sending to the AI is only recorded (no CLI runs here). One request comes back moved to a new
  // conversation, the way the server answers another model than the conversation's.
  let moved;
  await page.route(/\/requests(\/r-moved)?$/, (route) => {
    if (route.request().method() !== 'POST')
      return moved && /r-moved$/.test(route.request().url())
        ? route.fulfill({ json: moved })
        : route.continue();
    const input = JSON.parse(route.request().postData());
    posted.push(input);
    if (input.body !== '다른 모델로 이어서')
      return route.fulfill({ status: 409, json: { code: 'PROJECT_BUSY' } });
    conversationsState['c-new'] = {
      ...entry('c-new', '다른 모델로 이어서', null),
      model: 'opus',
    };
    moved = {
      id: 'r-moved',
      state: 'queued',
      input: { ...input, id: 'r-moved', conversationId: 'c-new' },
      result: null,
    };
    return route.fulfill({ status: 202, json: moved });
  });
  await page.route(/\/route\/revert$/, (route) => {
    reverted.push(JSON.parse(route.request().postData()));
    return route.fulfill({ json: { ok: true } });
  });
  // The server's /route answers, scripted per request text.
  const answers = {
    '구조 검토 열어줘': { target: 'jig', by: 'rules', jig: 'structure', jigName: '구조 검토' },
    'Codex 로그인': { target: 'app', by: 'rules', app: 'login', provider: 'codex-cli' },
    'Claude 로그인': { target: 'app', by: 'rules', app: 'login', provider: 'claude-cli' },
    '이 프로젝트 결정 사항 알려줘': { target: 'ask', by: 'jev' },
    // Jev judges a request complex (RouteDecision.task): in 자동 the composer suggests '계획부터'.
    '두 도면 기둥 번호를 모두 맞춰줘': {
      target: 'document',
      by: 'jev',
      task: 'complex',
      ai: true,
      confidence: 0.9,
      ms: 5,
    },
    '다른 모델로 이어서': { target: 'document', by: 'jev' },
  };
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: answers[JSON.parse(route.request().postData()).body] ?? { target: null },
    }),
  );
  // Conversations with a server hand-over state (T-062): an account limit (T2) and a session past
  // the length setting (a suggestion). The chips read them; the buttons post the hand-over.
  const handedOver = [];
  const sends = { ledgerItems: 2, recentTurns: 1, files: 0 };
  const entry = (id, title, handover) => ({
    id,
    kind: 'ask',
    title,
    provider: 'claude-cli',
    model: null,
    effort: null,
    accountProfileId: 'default',
    mode: 'session',
    targets: null,
    state: 'open',
    requests: 1,
    session: null,
    handover,
  });
  const conversationsState = {
    'c-limit': entry('c-limit', '한도 대화', {
      kind: 'limit',
      grade: 'T2',
      requestId: 'r1',
      from: { provider: 'claude-cli', accountProfileId: 'default' },
      sends,
    }),
    'c-long': entry('c-long', '긴 대화', {
      kind: 'length',
      grade: 'T1',
      turns: 12,
      inputTokens: 152000,
      limits: { maxTurns: 12, maxInputTokens: 150000 },
      sends,
    }),
  };
  // The default conversation's first turn already fixed it on Sonnet.
  const defaultEntry = { ...entry(null, '기본 대화', null), kind: 'general', model: 'sonnet' };
  await page.route(/\/api\/v1\/projects\/[^/]+\/conversations(\/.*)?$/, (route) => {
    const [, rest = ''] = /\/conversations(\/.*)?$/.exec(new URL(route.request().url()).pathname);
    const [, id, action] = rest.split('/');
    if (route.request().method() === 'POST' && action) {
      handedOver.push({ id, action, body: JSON.parse(route.request().postData() || '{}') });
      conversationsState[id] = { ...conversationsState[id], handover: null };
      return route.fulfill({ json: conversationsState[id] });
    }
    if (!id) return route.fulfill({ json: [defaultEntry, ...Object.values(conversationsState)] });
    const found = id === 'default' ? defaultEntry : conversationsState[id];
    return route.fulfill({ json: { ...found, ledger: [], sessions: [] } });
  });
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // Mount points are in the right column; empty ones take no room.
  assert.equal(await page.locator('#right #conversation-chips').count(), 1);
  assert.equal(await page.locator('#right #question-cards').count(), 1);
  assert.ok(await page.locator('#route-card').isHidden());
  // Conversations read as tabs; the default one is chosen and shows the AI its first turn fixed,
  // and the composer's model follows it.
  const tabs = page.locator('#conversation-chips [role="tab"]');
  await tabs.first().waitFor();
  assert.equal(await tabs.count(), 3);
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  await page.waitForFunction(
    () => document.querySelector('#conversation-chips .conv-ai')?.textContent === 'Claude · Sonnet',
  );
  await page.waitForFunction(() => document.querySelector('#model').value === 'sonnet');
  const send = async (text) => {
    await page.locator('#body').fill(text);
    await page.locator('#request').click();
  };
  // A jig opens at once (ADR-026 4): the route row says so and keeps [일반 대화로]; the older
  // structure screen only opens, so nothing goes to the AI.
  await send('구조 검토 열어줘');
  await page.locator('#route-card').waitFor();
  await page.waitForFunction(() =>
    /열었습니다/.test(document.querySelector('#route-card').textContent),
  );
  assert.match(await page.locator('#route-card').textContent(), /jig · .+로 진행/);
  assert.equal(await page.locator('#route-card button').filter({ hasText: '열기' }).count(), 0);
  assert.deepEqual(posted, []);
  // [일반 대화로] sends the same words and records the route it undid, not the words.
  await page.locator('#route-card button').filter({ hasText: '일반 대화로' }).click();
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    posted.map((input) => input.body),
    ['구조 검토 열어줘'],
  );
  assert.deepEqual(reverted, [{ target: 'jig', by: 'rules' }]);
  assert.ok(await page.locator('#route-card').isHidden());
  // Login is T2: a confirmation card whose button starts it; nothing runs by itself.
  await send('Codex 로그인');
  await page.locator('#route-card').waitFor();
  assert.match(await page.locator('#route-card').textContent(), /Codex 로그인을 시작할까요/);
  await page.locator('#route-card button').filter({ hasText: '닫기' }).click();
  assert.ok(await page.locator('#route-card').isHidden());
  assert.equal(await page.locator('#body').inputValue(), 'Codex 로그인');
  // Already signed in: a notice, still with the way to the AI.
  await send('Claude 로그인');
  await page.waitForFunction(() =>
    document.querySelector('#message')?.textContent.includes('이미 로그인돼 있습니다'),
  );
  assert.equal(
    await page
      .locator('#message .message-action')
      .filter({ hasText: 'AI 작업으로 보내기' })
      .count(),
    1,
  );
  // A question on the records goes to the AI as before.
  posted.length = 0;
  await send('이 프로젝트 결정 사항 알려줘');
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    posted.map((input) => input.body),
    ['이 프로젝트 결정 사항 알려줘'],
  );
  // Without a chosen conversation the request goes to the project's default one, on its model.
  assert.equal(posted[0].conversationId, 'default');
  assert.equal(posted[0].model, 'sonnet');
  assert.equal(posted[0].mode, 'auto');
  // '계획부터 할까요?': [계획부터] sends this one request in 계획; the toggle stays on 자동.
  posted.length = 0;
  await send('두 도면 기둥 번호를 모두 맞춰줘');
  await page.locator('#route-card').waitFor();
  assert.match(await page.locator('#route-card').textContent(), /계획부터 할까요\?/);
  assert.deepEqual(posted, []);
  await page.locator('#route-card button').filter({ hasText: '계획부터' }).click();
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    posted.map((input) => [input.body, input.mode, input.permission]),
    [['두 도면 기둥 번호를 모두 맞춰줘', 'plan', 'review']],
  );
  assert.equal(
    await page.locator('#mode-toggle [data-mode="auto"]').getAttribute('aria-checked'),
    'true',
  );
  // The account-limit card comes from the server's state; [새 세션으로 이어가기] posts the
  // hand-over (the server picks the spare account) and the card goes.
  await page.locator('[data-conversation="c-limit"]').click();
  const limitCard = page.locator('section[aria-label="계정 한도"]');
  await limitCard.waitFor();
  assert.match(await limitCard.textContent(), /원장 2개 · 최근 턴 1개/);
  assert.equal(
    await limitCard.locator('button').filter({ hasText: '다른 AI로 이어 가기' }).count(),
    1,
  );
  await limitCard.locator('button').filter({ hasText: '새 세션으로 이어가기' }).click();
  await limitCard.waitFor({ state: 'detached' });
  assert.deepEqual(handedOver, [{ id: 'c-limit', action: 'account', body: {} }]);
  // Past the length setting a new session is suggested, not forced.
  await page.locator('[data-conversation="c-long"]').click();
  const lengthCard = page.locator('section[aria-label="대화 길이"]');
  await lengthCard.waitFor();
  assert.match(await lengthCard.textContent(), /12턴 · 누적 15\.2만 토큰/);
  await lengthCard.locator('button').filter({ hasText: '새 세션으로 이어가기' }).click();
  await lengthCard.waitFor({ state: 'detached' });
  assert.deepEqual(handedOver.at(-1), { id: 'c-long', action: 'renew', body: {} });
  // Another model in the composer: the server sends the request to a new conversation, whose tab
  // is chosen, and the composer says what happened.
  await page.locator('[data-conversation="default"]').click();
  await page.waitForFunction(() => document.querySelector('#model').value === 'sonnet');
  await page.locator('#model').selectOption('opus');
  posted.length = 0;
  await send('다른 모델로 이어서');
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    posted.map((input) => [input.conversationId, input.model]),
    [['default', 'opus']],
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-conversation="c-new"]')?.getAttribute('aria-selected') ===
      'true',
  );
  assert.match(
    await page.locator('#message').textContent(),
    /모델이 달라 새 대화로 이어서 보냈습니다 · Opus/,
  );
  assert.deepEqual(errors, []);
  console.log(
    'browser conversations: route cards, AI fallback, tabs with a fixed AI, a model change to a new tab and hand-over cards pass',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
