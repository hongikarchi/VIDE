// Routes without the AI in the composer (SPEC-02.17 2·3, PLAN-24 T-049) and the conversation mount
// points (T-061·T-062): a jig, Sync or a T2 app action is proposed on a card, every
// notice keeps 'AI 작업으로 보내기' (which records the reversal), and ask/document go to the AI.
// T-088: conversations are tabs whose AI is fixed at the first turn; the composer's model follows
// the chosen tab, and another model sends the request to a new conversation (its tab is chosen).
// T-097: [+] opens an empty '새 대화' tab at once (no form), the composer takes the cursor, and the
// first request names the tab.
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
  const served = {};
  await page.route(/\/requests(\/[^/]+)?$/, (route) => {
    const [, id] = /\/requests(?:\/([^/]+))?$/.exec(new URL(route.request().url()).pathname);
    if (route.request().method() !== 'POST')
      return id && served[id] ? route.fulfill({ json: served[id] }) : route.continue();
    if (id) return route.continue();
    const input = JSON.parse(route.request().postData());
    posted.push(input);
    // The first request of a tab [+] opened: the server names the tab after it (T-097).
    if (input.conversationId === 'c-plus') {
      conversationsState['c-plus'] = {
        ...conversationsState['c-plus'],
        title: input.body,
        pending: false,
        requests: 1,
      };
      served[input.id] = { id: input.id, state: 'queued', input, result: null };
      return route.fulfill({ status: 202, json: served[input.id] });
    }
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
    served['r-moved'] = moved;
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
    '보 간격 검토해줘': { target: 'document', by: 'jev' },
  };
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: answers[JSON.parse(route.request().postData()).body] ?? { target: null },
    }),
  );
  // A conversation with the server's hand-over state (T-062): a session past the length setting
  // (a suggestion). The chip reads it; the button posts the hand-over. An account limit is no
  // server card any more (ADR-025: not sent again, change the account in AccountSwitch); its
  // notice is read from the stopped request (tests/core/conversations-ui.test.mjs).
  const handedOver = [],
    created = [];
  const sends = { ledgerItems: 2, recentTurns: 1, files: 0 };
  const entry = (id, title, handover) => ({
    id,
    kind: 'ask',
    title,
    provider: 'claude-cli',
    model: null,
    effort: null,
    accountProfileId: null,
    mode: 'session',
    targets: null,
    state: 'open',
    requests: 1,
    session: null,
    handover,
  });
  const conversationsState = {
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
    // [+]: an empty general conversation whose first turn chooses its AI.
    if (route.request().method() === 'POST' && !id) {
      created.push(JSON.parse(route.request().postData() || '{}'));
      const made = created.length === 1 ? 'c-plus' : `c-plus-${created.length}`;
      conversationsState[made] = {
        ...entry(made, '대화', null),
        kind: 'general',
        requests: 0,
        pending: true,
      };
      return route.fulfill({ status: 201, json: conversationsState[made] });
    }
    if (route.request().method() === 'POST' && action) {
      handedOver.push({ id, action, body: JSON.parse(route.request().postData() || '{}') });
      conversationsState[id] = {
        ...conversationsState[id],
        handover: null,
        ...(action === 'close' ? { state: 'closed' } : {}),
      };
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
  assert.equal(await tabs.count(), 2);
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
  // Signing in is done outside VIDE (ADR-025): a notice that says where; nothing runs.
  await send('Codex 로그인');
  await page.waitForFunction(() =>
    /Codex 로그인은 터미널이나 AccountSwitch에서 합니다/.test(
      document.querySelector('#message')?.textContent ?? '',
    ),
  );
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
  // Past the length setting a new session is suggested, not forced.
  await page.locator('[data-conversation="c-long"]').click();
  const lengthCard = page.locator('section[aria-label="대화 길이"]');
  await lengthCard.waitFor();
  assert.match(await lengthCard.textContent(), /12턴 · 누적 15\.2만 토큰/);
  await lengthCard.locator('button').filter({ hasText: '새 세션으로 이어가기' }).click();
  await lengthCard.waitFor({ state: 'detached' });
  assert.deepEqual(handedOver, [{ id: 'c-long', action: 'renew', body: {} }]);
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
  // [+] opens a new tab at once: no form, nothing asked, the tab is chosen and the cursor is in
  // the composer (T-097).
  await page.locator('#conversation-chips .conv-add').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-conversation="c-plus"]')?.getAttribute('aria-selected') ===
      'true',
  );
  assert.deepEqual(created, [{ kind: 'general' }]);
  assert.equal(await page.locator('#conversation-chips form').count(), 0);
  assert.equal(await page.locator('#conversation-chips select:not(.conv-more)').count(), 0);
  assert.equal(await page.locator('[data-conversation="c-plus"]').textContent(), '새 대화');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'body');
  await page.waitForFunction(
    () =>
      document.querySelector('#conversation-chips .conv-ai')?.textContent ===
      '첫 요청 때 AI를 정합니다',
  );
  // Its first request goes to it and names it.
  posted.length = 0;
  await page.keyboard.type('보 간격 검토해줘');
  await page.locator('#request').click();
  for (let i = 0; i < 40 && !posted.length; i++) await page.waitForTimeout(50);
  assert.deepEqual(
    posted.map((input) => [input.conversationId, input.body]),
    [['c-plus', '보 간격 검토해줘']],
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-conversation="c-plus"] .conv-label')?.textContent ===
      '보 간격 검토해줘',
  );
  // A '새 대화' tab [+] opened by mistake closes from its ⋯ menu before any request; the hand-over
  // waits for the AI its first turn fixes.
  await page.locator('#conversation-chips .conv-add').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-conversation="c-plus-2"]')?.getAttribute('aria-selected') ===
      'true',
  );
  await page.locator('#conversation-chips .conv-menu summary').click();
  const menu = page.locator('#conversation-chips .conv-menu');
  assert.equal(await menu.locator('button').filter({ hasText: '다른 AI로 이어 가기' }).count(), 0);
  handedOver.length = 0;
  await menu.locator('button').filter({ hasText: '대화 닫기' }).click();
  await page.locator('[data-conversation="c-plus-2"]').waitFor({ state: 'detached' });
  assert.deepEqual(handedOver, [{ id: 'c-plus-2', action: 'close', body: {} }]);
  assert.deepEqual(errors, []);
  console.log(
    'browser conversations: route cards, AI fallback, tabs with a fixed AI, a model change to a new tab, hand-over cards, [+] opening a tab at once and closing it before a request pass',
  );
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
