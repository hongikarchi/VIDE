// Routes without the AI in the composer (SPEC-02.17 2·3, PLAN-24 T-049) and the conversation mount
// points (T-061·T-062): a jig, Sync or a T2 app action is proposed on a card, every
// notice keeps 'AI 작업으로 보내기' (which records the reversal), and ask/document go to the AI.
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
  // Sending to the AI is only recorded (no CLI runs here).
  await page.route(/\/requests$/, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posted.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 409, json: { code: 'PROJECT_BUSY' } });
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
  };
  await page.route(/\/route$/, (route) =>
    route.fulfill({
      json: answers[JSON.parse(route.request().postData()).body] ?? { target: null },
    }),
  );
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  // Mount points are in the right column; empty ones take no room.
  assert.equal(await page.locator('#right #conversation-chips').count(), 1);
  assert.equal(await page.locator('#right #question-cards').count(), 1);
  assert.ok(await page.locator('#route-card').isHidden());
  const send = async (text) => {
    await page.locator('#body').fill(text);
    await page.locator('#request').click();
  };
  // A jig is proposed on a card; nothing goes to the AI until chosen.
  await send('구조 검토 열어줘');
  await page.locator('#route-card').waitFor();
  assert.match(await page.locator('#route-card').textContent(), /'구조 검토' jig를 열까요\?/);
  assert.equal(await page.locator('#route-card button').filter({ hasText: '열기' }).count(), 1);
  assert.deepEqual(posted, []);
  // 'AI 작업으로 보내기' sends the same words and records the route it undid, not the words.
  await page.locator('#route-card button').filter({ hasText: 'AI 작업으로 보내기' }).click();
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
  // Without a chosen conversation the request belongs to the project's default one.
  assert.equal(posted[0].conversationId, undefined);
  assert.deepEqual(errors, []);
  console.log('browser conversations: route cards, AI fallback and mount points pass');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
