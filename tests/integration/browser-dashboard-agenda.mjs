// 대시보드 › 오늘 (SPEC-01.14, Design SCR-20, PLAN-26 T-098): Enter adds a 할 일 with the date and
// time read from the words ('내일 3시 …' goes under 예정 at 15:00), the box finishes one into the
// '완료 n' fold, a click edits in place, ↑ and drag reorder, and everything survives a reload;
// [완료 비우기] clears the fold. A 기본 대화 turn whose AI adds and then changes a 할 일 (two writes)
// gets one notice with one [되돌리기], which stays past 9 s and takes both back. Synthetic project
// and provider only; no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { agentConnection } from '../../src/ai/agent-connection.ts';

/** A provider whose AI writes 할 일 twice in one turn: agenda_add, then agenda_set on that item. */
const writingProvider = (options) => ({
  status: async () => ({ available: true }),
  run: async () => {
    const agent = options.agent && agentConnection(options.agent);
    if (!agent?.tools.includes('agenda_add'))
      return { text: JSON.stringify({ message: '할 일 도구가 없습니다.', operations: [] }) };
    const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(agent.url), {
        requestInit: { headers: { Authorization: `Bearer ${agent.token}` } },
      }),
    );
    const call = async (name, args) =>
      JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    const { added } = await call('agenda_add', { items: [{ text: '구조 회의' }] });
    await call('agenda_set', { items: [{ id: added[0].id, text: '구조 회의 — 3층' }] });
    await client.close();
    return { text: JSON.stringify({ message: "'구조 회의 — 3층'을 넣었습니다.", operations: [] }) };
  },
});

const shot = process.env.VIDE_SHOT_DIR;
const directory = await mkdtemp(join(tmpdir(), 'vide-dashboard-agenda-'));
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'data', 'test.sqlite'),
    host: { status: async () => ({ available: true }) },
    providerFactory: writingProvider,
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const openDashboard = () => page.locator('.rail [data-workspace-target="dashboard"]').click();
  await openDashboard();
  const board = page.getByRole('region', { name: '대시보드', exact: true });
  const section = board.getByRole('region', { name: '오늘', exact: true });
  await section.getByText('할 일이 없습니다.').waitFor();
  // The 오늘 section is the first section of the dashboard.
  assert.equal(
    await board.locator('section.dash-section').first().getAttribute('aria-label'),
    '오늘',
  );

  const input = section.getByRole('textbox', { name: '할 일 추가' });
  // The words give the date and time: tomorrow 15:00, under 예정.
  await input.fill('내일 3시 구조 회의');
  await section.getByText('내일 15:00 · 구조 회의').waitFor();
  await input.press('Enter');
  const later = section.getByRole('list', { name: '예정' });
  await later.getByRole('button', { name: '구조 회의', exact: true }).waitFor();
  assert.match(await later.locator('li').first().innerText(), /15:00\s*내일/);
  assert.equal(await input.inputValue(), '');
  // The box keeps the focus after Enter, also while a slow save is on its way (a remote
  // session): the next 할 일 is typed straight away.
  const slow = async (route) => {
    if (route.request().method() === 'POST') await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  };
  await page.route('**/api/v1/projects/*/agenda', slow);
  for (const text of ['도면 정리', '회의록 검토', '현장 사진 분류']) {
    await page.keyboard.type(text);
    await page.keyboard.press('Enter');
    await section.getByRole('list', { name: '오늘 할 일' }).getByText(text).waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      '할 일 추가',
    );
  }
  await page.unroute('**/api/v1/projects/*/agenda', slow);
  const today = section.getByRole('list', { name: '오늘 할 일' });
  const texts = () => today.locator('.dash-agenda-text').allInnerTexts();
  assert.deepEqual(await texts(), ['도면 정리', '회의록 검토', '현장 사진 분류']);

  // ↑ moves one up; a drag moves another to the top.
  await today.getByRole('button', { name: '회의록 검토 위로' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="오늘 할 일"] .dash-agenda-text')?.textContent ===
      '회의록 검토',
  );
  await today
    .locator('li', { hasText: '현장 사진 분류' })
    .dragTo(today.locator('li', { hasText: '회의록 검토' }));
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="오늘 할 일"] .dash-agenda-text')?.textContent ===
      '현장 사진 분류',
  );
  assert.deepEqual(await texts(), ['현장 사진 분류', '회의록 검토', '도면 정리']);

  // A click edits in place; Enter saves.
  await today.getByRole('button', { name: '도면 정리', exact: true }).click();
  const edit = section.getByRole('textbox', { name: '할 일 고치기' });
  await edit.fill('도면 정리 — 평면도');
  await edit.press('Enter');
  await today.getByRole('button', { name: '도면 정리 — 평면도', exact: true }).waitFor();
  assert.equal(await edit.count(), 0);

  // An edit open while another screen changes the item: the list is read again on focus, the
  // save is refused (REVISION_CONFLICT) instead of writing the old date over the new one, and the
  // form keeps the user's words over the newer date; Enter again saves them.
  const other = (path, method, data) =>
    page.evaluate(
      async ([path, method, data]) => {
        const project = document.querySelector('#project-picker').value;
        const response = await fetch(`api/v1/projects/${project}/agenda${path}`, {
          method,
          headers: data ? { 'Content-Type': 'application/json' } : {},
          body: data ? JSON.stringify(data) : undefined,
        });
        return response.json();
      },
      [path, method, data],
    );
  await today.getByRole('button', { name: '도면 정리 — 평면도', exact: true }).click();
  const target = (await other('', 'GET')).items.find((item) => item.text === '도면 정리 — 평면도');
  await other(`/${target.id}`, 'PUT', { revision: target.revision, date: '2026-01-02' });
  const reread = () =>
    page.waitForResponse(
      (response) => /\/agenda$/.test(response.url()) && response.request().method() === 'GET',
    );
  const reading = reread();
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await reading;
  await edit.fill('도면 정리 — 단면도');
  await edit.press('Enter');
  await section.getByRole('alert').getByText('다른 화면에서 바뀌어').waitFor();
  const kept = (await other('', 'GET')).items.find((item) => item.id === target.id);
  assert.deepEqual([kept.text, kept.date], ['도면 정리 — 평면도', '2026-01-02']);
  assert.equal(await section.getByRole('textbox', { name: '날짜' }).inputValue(), '2026-01-02');
  assert.equal(await edit.inputValue(), '도면 정리 — 단면도');
  await edit.press('Enter');
  await today.getByRole('button', { name: '도면 정리 — 단면도', exact: true }).waitFor();
  const saved = (await other('', 'GET')).items.find((item) => item.id === target.id);
  assert.deepEqual([saved.text, saved.date], ['도면 정리 — 단면도', '2026-01-02']);
  // Back to no date, so the rest of the run sees it in 오늘 as before.
  await other(`/${target.id}`, 'PUT', { revision: saved.revision, date: null });
  await page.evaluate(() => dispatchEvent(new Event('focus')));

  // The box finishes one: it leaves the list for the '완료 1' fold.
  await today.getByRole('checkbox', { name: '회의록 검토 완료' }).click();
  const fold = section.getByRole('button', { name: '완료 1' });
  await fold.waitFor();
  assert.deepEqual(await texts(), ['현장 사진 분류', '도면 정리 — 단면도']);
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-agenda.png') });

  // Everything is kept: a reload shows the same order, the edit and the fold.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await openDashboard();
  await today.getByText('현장 사진 분류').waitFor();
  assert.deepEqual(await texts(), ['현장 사진 분류', '도면 정리 — 단면도']);
  await later.getByRole('button', { name: '구조 회의', exact: true }).waitFor();
  await fold.click();
  const doneList = section.getByRole('list', { name: '완료한 할 일' });
  await doneList.getByText('회의록 검토').waitFor();
  await section.getByRole('button', { name: '완료 비우기' }).click();
  await fold.waitFor({ state: 'detached' });
  // [빼기] removes one.
  await today.getByRole('button', { name: '현장 사진 분류 빼기' }).click();
  await today.getByText('현장 사진 분류').waitFor({ state: 'detached' });
  assert.deepEqual(await texts(), ['도면 정리 — 단면도']);

  // The AI writes twice in one 기본 대화 turn: one notice when the turn ends, kept past 9 s.
  await page.locator('#body').fill('구조 회의 넣어줘');
  await page.locator('#request').click();
  const notice = page.locator('#message');
  await notice.getByText("AI가 할 일을 더했습니다: '구조 회의 — 3층'").waitFor();
  await today.getByText('구조 회의 — 3층').waitFor();
  await page.waitForTimeout(9500);
  assert.ok(await notice.isVisible());
  // [되돌리기] takes back both writes of the turn: the item is gone.
  await notice.getByRole('button', { name: '되돌리기' }).click();
  await notice.getByText('되돌렸습니다.').waitFor();
  await today.getByText('구조 회의 — 3층').waitFor({ state: 'detached' });
  assert.deepEqual(await texts(), ['도면 정리 — 단면도']);

  assert.deepEqual(errors, []);
  console.log('dashboard agenda browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
