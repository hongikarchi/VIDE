// 대시보드 › 할 일 · 일정 (SPEC-01.14, Design SCR-20, PLAN-26 T-098·T-110, PLAN-30 T-135~T-137):
// two areas over one list — '할 일' (오늘 with n/m, Enter adds with the date and time read from
// the words, the box finishes into '완료 n', a click edits in place, ↑ and drag reorder, '예정 n'
// folded) and '일정' (the month: a day's click prefills its own add box, a drag moves only the
// date, a 할 일 row dragged onto a day too, the 날짜 없음 box takes and gives dates). A 기본 대화
// turn whose AI adds and then changes a 할 일 gets one notice with one [되돌리기]. [글·파일에서 할 일
// 만들기]: a text file dropped on the panel goes as a hostless turn whose AI adds three items in two
// writes; one [되돌리기] takes all back, and no second notice shows. When today's items are done,
// [퇴근하기] takes the finished ones off into the day log and shows tomorrow's. Synthetic project
// and provider only; no real CLI or host.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { agentConnection } from '../../src/ai/agent-connection.ts';

/** What the extraction turn's AI read from the attached file (the path in its context). */
const readFiles = [];
/**
 * A provider whose AI writes 할 일: a composer turn adds and then changes one item (two writes);
 * a 글·파일 turn reads the attached file and adds its lines in two agenda_add calls.
 */
const writingProvider = (options) => ({
  status: async () => ({ available: true }),
  run: async (context) => {
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
    if (String(context?.goal ?? '').includes('[글·파일에서 할 일 만들기]')) {
      // The CLI reads the kept attachment by its path, as its own Read tool would.
      const path = /"path":"([^"]+\.txt)"/.exec(JSON.stringify(context.items))?.[1];
      const text = path ? await readFile(path.replace(/\\\\/g, '\\'), 'utf8') : '';
      readFiles.push(text);
      const lines = text.split(/\r?\n/).filter((line) => line.trim());
      const item = (line) => ({ text: line, ...(/회의/.test(line) ? { kind: 'meeting' } : {}) });
      await call('agenda_add', { items: lines.slice(0, 2).map(item) });
      await call('agenda_add', { items: lines.slice(2).map(item) });
      await client.close();
      return {
        text: JSON.stringify({
          status: 'done',
          text: `${lines.length}개를 넣었습니다.`,
          questions: [],
          reference: null,
        }),
      };
    }
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
  const section = board.getByRole('region', { name: '할 일', exact: true });
  const schedule = board.getByRole('region', { name: '일정', exact: true });
  await section.getByText('할 일이 없습니다.').waitFor();
  // Two areas, 할 일 first and 일정 beside it on a wide screen; no [목록 | 달력] switch.
  assert.equal(
    await board.locator('section.dash-section').first().getAttribute('aria-label'),
    '할 일',
  );
  await schedule.locator('.dash-cal-month').waitFor();
  assert.equal(await board.getByRole('button', { name: '목록', exact: true }).count(), 0);
  assert.equal(await board.getByRole('button', { name: '달력', exact: true }).count(), 0);
  const side = async () => {
    const [a, b] = [await section.boundingBox(), await schedule.boundingBox()];
    return b.x >= a.x + a.width - 1 && Math.abs(b.y - a.y) < 2;
  };
  assert.ok(await side(), 'the two areas stand side by side');

  const input = section.getByRole('textbox', { name: '할 일 추가' });
  // The words give the date and time: tomorrow 15:00, under the folded 예정.
  await input.fill('내일 3시 구조 회의');
  await section.getByText('내일 15:00 · 구조 회의').waitFor();
  await input.press('Enter');
  const laterFold = section.getByRole('button', { name: /^예정 \d+$/ });
  await laterFold.waitFor();
  assert.equal(await laterFold.getAttribute('aria-expanded'), 'false');
  await laterFold.click();
  const later = section.getByRole('list', { name: '예정' });
  await later.getByRole('button', { name: '구조 회의', exact: true }).waitFor();
  assert.match(await later.locator('li').first().innerText(), /15:00\s*내일/);
  // '회의' in the words makes it a 회의: a small label on the row.
  assert.equal(await later.locator('li').first().locator('.dash-agenda-kind').innerText(), '회의');
  assert.equal(await input.inputValue(), '');
  // The box keeps the focus after Enter, also while a slow save is on its way (a remote
  // session): the next 할 일 is typed straight away.
  const slow = async (route) => {
    if (route.request().method() === 'POST') await new Promise((done) => setTimeout(done, 300));
    await route.continue();
  };
  await input.focus();
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
  await laterFold.click();
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

  // [글·파일에서 할 일 만들기] (T-136): a text file dropped on the panel; the hostless turn's AI
  // reads it and adds three items in two writes; they show at once, with one [되돌리기].
  await section.getByRole('button', { name: '글·파일에서 할 일 만들기' }).click();
  const panel = section.getByRole('group', { name: '글·파일에서 할 일 만들기' });
  const make = panel.getByRole('button', { name: '할 일 만들기' });
  assert.ok(await make.isDisabled());
  const notes = '다음 주 화요일 설비 회의\n도면 제출 — 김 대리\n현장 사진 정리\n';
  const dropped = await page.evaluateHandle((text) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], '회의록.txt', { type: 'text/plain' }));
    return transfer;
  }, notes);
  await panel.dispatchEvent('drop', { dataTransfer: dropped });
  await panel.getByText('회의록.txt').waitFor();
  await make.click();
  const status = section.getByRole('status', { name: '글·파일에서 할 일 만들기' });
  await status.getByText('3개를 더했습니다.').waitFor();
  for (const text of ['다음 주 화요일 설비 회의', '도면 제출 — 김 대리', '현장 사진 정리'])
    await today.getByRole('button', { name: text, exact: true }).waitFor();
  assert.deepEqual(readFiles, [notes]);
  assert.equal(
    await today
      .locator('li', { hasText: '다음 주 화요일 설비 회의' })
      .locator('.dash-agenda-kind')
      .innerText(),
    '회의',
  );
  // The turn went to the 기본 대화 without a host, in Auto mode.
  const sent = await page.evaluate(async () => {
    const project = document.querySelector('#project-picker').value;
    const list = await (await fetch(`api/v1/projects/${project}/requests`)).json();
    return (list.requests ?? list).find((row) =>
      String(row.input?.body ?? '').startsWith('[글·파일에서 할 일 만들기]'),
    )?.input;
  });
  assert.deepEqual([sent.hostUse, sent.mode, sent.files.length], ['none', 'auto', 1]);
  // The conversation's own notice is not shown again for this turn.
  await page.waitForTimeout(1500);
  assert.ok(!(await notice.innerText()).includes('설비 회의'));
  await status.getByRole('button', { name: '되돌리기' }).click();
  await status.getByText('되돌렸습니다.').waitFor();
  await today.getByText('현장 사진 정리').waitFor({ state: 'detached' });
  assert.deepEqual(await texts(), ['도면 정리 — 단면도']);
  await status.getByRole('button', { name: '닫기' }).click();
  await section.getByRole('button', { name: '글·파일에서 할 일 만들기' }).waitFor();

  // 일정 (T-110, T-135): the month of this project's 할 일; the undated one sits in 날짜 없음.
  const iso = (at) =>
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const todayIso = iso(new Date());
  const calendar = schedule.locator('.dash-cal-month');
  const undatedBox = schedule.getByRole('group', { name: '날짜 없음' });
  await undatedBox.getByText('도면 정리 — 단면도').waitFor();
  const day = (date) => calendar.locator(`[data-date="${date}"]`);
  // The 회의 added at the start shows on its day with the 회의 dot.
  const tomorrowIso = iso(new Date(Date.now() + 86400000));
  if ((await day(tomorrowIso).count()) === 1)
    assert.equal(
      await day(tomorrowIso)
        .locator('.dash-cal-item', { hasText: '구조 회의' })
        .getAttribute('data-kind'),
      'meeting',
    );
  // A click on today: that day's list below, and the 일정 box starts with its date.
  const planInput = schedule.getByRole('textbox', { name: '일정 추가' });
  await day(todayIso).click();
  assert.equal(await day(todayIso).getAttribute('aria-pressed'), 'true');
  assert.equal(await planInput.inputValue(), `${todayIso} `);
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    '일정 추가',
  );
  await page.keyboard.type('설비 미팅');
  await page.keyboard.press('Enter');
  const dayList = schedule.getByRole('list', { name: /할 일$/ }).last();
  await dayList.getByRole('button', { name: '설비 미팅', exact: true }).waitFor();
  assert.equal(await dayList.locator('.dash-agenda-kind').first().innerText(), '회의');
  await day(todayIso)
    .locator('.dash-cal-item[data-kind="meeting"]', { hasText: '설비 미팅' })
    .waitFor();
  // The box starts again with the picked day.
  assert.equal(await planInput.inputValue(), `${todayIso} `);
  // '까지' is read as a 마감 (shown in the preview), not dropped.
  await planInput.fill('금요일까지 보고서');
  await schedule.locator('.dash-agenda-hint .dash-agenda-kind', { hasText: '마감' }).waitFor();
  await planInput.fill('');

  // Drag to another day: only the date is saved (the time and the kind stay).
  const days = await calendar
    .locator('[data-date]')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-date')));
  const at = days.indexOf(todayIso);
  const otherDay = days[at + 1 < days.length ? at + 1 : at - 1];
  const meetingBefore = (await other('', 'GET')).items.find((item) => item.text === '설비 미팅');
  await other(`/${meetingBefore.id}`, 'PUT', { revision: meetingBefore.revision, time: '10:00' });
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await day(todayIso).locator('.dash-cal-item', { hasText: '10:00' }).waitFor();
  await day(todayIso).locator('.dash-cal-item', { hasText: '설비 미팅' }).dragTo(day(otherDay));
  await day(otherDay).locator('.dash-cal-item', { hasText: '설비 미팅' }).waitFor();
  const meetingAfter = (await other('', 'GET')).items.find((item) => item.id === meetingBefore.id);
  assert.deepEqual(
    [meetingAfter.date, meetingAfter.time, meetingAfter.kind, meetingAfter.revision],
    [otherDay, '10:00', 'meeting', meetingBefore.revision + 2],
  );
  // The undated one onto a day gets that date; back onto 날짜 없음 loses it again.
  await undatedBox
    .locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' })
    .dragTo(day(todayIso));
  await day(todayIso).locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' }).waitFor();
  assert.equal(
    (await other('', 'GET')).items.find((item) => item.text === '도면 정리 — 단면도').date,
    todayIso,
  );
  await day(todayIso)
    .locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' })
    .dragTo(undatedBox);
  await undatedBox.locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' }).waitFor();
  assert.equal(
    (await other('', 'GET')).items.find((item) => item.text === '도면 정리 — 단면도').date,
    null,
  );
  // A row of the 할 일 area dragged onto a day of the month gets that date, nothing else.
  const rowBefore = (await other('', 'GET')).items.find(
    (item) => item.text === '도면 정리 — 단면도',
  );
  await today.locator('li', { hasText: '도면 정리 — 단면도' }).dragTo(day(otherDay));
  await day(otherDay).locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' }).waitFor();
  const rowAfter = (await other('', 'GET')).items.find((item) => item.id === rowBefore.id);
  assert.deepEqual(
    [rowAfter.date, rowAfter.text, rowAfter.kind],
    [otherDay, rowBefore.text, rowBefore.kind],
  );
  await day(otherDay)
    .locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' })
    .dragTo(undatedBox);
  await undatedBox.locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' }).waitFor();
  // Months move; [이번 달] comes back.
  const label = await calendar.locator('.dash-cal-label').innerText();
  await calendar.getByRole('button', { name: '다음 달' }).click();
  assert.notEqual(await calendar.locator('.dash-cal-label').innerText(), label);
  await calendar.getByRole('button', { name: '이번 달' }).click();
  assert.equal(await calendar.locator('.dash-cal-label').innerText(), label);
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-calendar.png') });

  // 오늘 n/m and 퇴근하기 (T-137): a 할 일 for today; when every item due today or earlier is done,
  // the calm box offers [퇴근하기] although an undated one is still open.
  await input.fill('오늘 현장 확인');
  await input.press('Enter');
  await today.getByRole('button', { name: '현장 확인', exact: true }).waitFor();
  const progress = section.getByLabel('오늘 진행');
  assert.match(await progress.innerText(), /^0\/\d+/);
  for (;;) {
    const due = today.locator('li[data-when="today"], li[data-when="overdue"]');
    if (!(await due.count())) break;
    const name = await due.first().locator('input[type="checkbox"]').getAttribute('aria-label');
    await due.first().locator('input[type="checkbox"]').click();
    await today.getByRole('checkbox', { name }).waitFor({ state: 'detached' });
  }
  const leave = section.getByRole('status', { name: '퇴근' });
  await leave.getByText('오늘 할 일을 다 했습니다.').waitFor();
  assert.match(await progress.innerText(), /^(\d+)\/\1/);
  await today.getByText('도면 정리 — 단면도').waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-day-end.png') });
  await leave.getByRole('button', { name: '퇴근하기' }).click();
  await leave.getByText('퇴근했습니다').waitFor();
  await leave.getByRole('list', { name: '내일 할 일' }).getByText('구조 회의').waitFor();
  // Today's finished items left the list for the day log; the undated one stays.
  const after = (await other('', 'GET')).items;
  assert.ok(!after.some((item) => item.text === '현장 확인'));
  assert.ok(after.some((item) => item.text === '도면 정리 — 단면도' && !item.done));
  const log = await other(`/log?from=${todayIso}&to=${todayIso}`, 'GET');
  assert.equal(log.entries.length, 1);
  assert.match(log.entries[0].text, new RegExp(`^${todayIso} · 완료 \\d+ · .*현장 확인`));
  // A reload still shows the day as ended.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  await openDashboard();
  await leave.getByText('퇴근했습니다').waitFor();

  // Narrow: the two areas stack.
  await page.setViewportSize({ width: 700, height: 900 });
  await page.waitForFunction(() => {
    const [a, b] = [...document.querySelectorAll('.dash-agenda-pair > section')].map((el) =>
      el.getBoundingClientRect(),
    );
    return b && b.top >= a.bottom - 1;
  });
  assert.ok(!(await side()));

  assert.deepEqual(errors, []);
  console.log('dashboard agenda browser checks passed');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
