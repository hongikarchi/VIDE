// 대시보드 › 할 일 · 일정 (SPEC-01.14, Design SCR-20, PLAN-26 T-098·T-110, PLAN-30 T-135~T-137,
// PLAN-39 T-180~T-183, PLAN-42 T-192): the large month on the left, a '할 일' column on the right
// whose width a handle changes (kept after a reload), with 연결 파일 and 프로젝트 폴더 under it; the
// AI column's width handle shows on the dashboard; times in 15-minute steps; no 'AI' mark. The
// '할 일' column (오늘 with n/m, Enter adds with the
// date, time and range read from the words, the box finishes into '완료 n', a click edits in place,
// ↑ and drag reorder, '예정 n' folded) beside the large month (a day's [+] opens the 일정 form:
// 협의 with a time range, 위치 and 참석자; an item over several days is a bar, dragged it keeps its
// period; an item opens the same form to change, take the date off or remove it; a 할 일 row
// dragged onto a day moves there). No add box, 날짜 없음 box or day list under the month. The AI
// column opens folded on the dashboard and keeps its fold apart from the model screen; opened, the
// 할 일 도우미 sends a hostless 기본 대화 turn. A 기본 대화 turn whose AI adds and then changes a 할 일
// gets one notice with one [되돌리기]. [글·파일에서 할 일 만들기]: a text file dropped on the panel
// goes as a hostless turn whose AI adds three items in two writes; one [되돌리기] takes all back,
// and no second notice shows. When today's items are done (a 협의 has no check and never blocks),
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
import { setAgendaActor } from '../../src/core/agenda.ts';
import { agentConnection } from '../../src/ai/agent-connection.ts';

/** What the extraction turn's AI read from the attached file (the path in its context). */
const readFiles = [];
/** The 할 일 도우미 requests the AI got. */
const helperGoals = [];
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
    if (String(context?.goal ?? '').includes('[할 일 도우미]')) {
      helperGoals.push(String(context.goal));
      await call('agenda_list', {});
      await client.close();
      return { text: JSON.stringify({ message: '오늘은 할 일이 없습니다.', operations: [] }) };
    }
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
  // PLAN-42 T-192: the month on the left, 할 일 on the right on a wide screen; no [목록 | 달력].
  assert.equal(
    await board.locator('section.dash-section').first().getAttribute('aria-label'),
    '일정',
  );
  await schedule.locator('.dash-cal-month').waitFor();
  assert.equal(await board.getByRole('button', { name: '목록', exact: true }).count(), 0);
  assert.equal(await board.getByRole('button', { name: '달력', exact: true }).count(), 0);
  const side = async () => {
    const [a, b] = [await schedule.boundingBox(), await section.boundingBox()];
    return b.x >= a.x + a.width - 1 && Math.abs(b.y - a.y) < 2;
  };
  assert.ok(await side(), 'the month and the 할 일 stand side by side');
  // The right column starts 420px wide, the month takes the rest; no jig, no recent work.
  const [todoBox, monthBox] = [await section.boundingBox(), await schedule.boundingBox()];
  assert.ok(Math.abs(todoBox.width - 420) < 2, `할 일 column ${todoBox.width}px`);
  assert.ok(monthBox.width > todoBox.width, 'the month takes the rest');
  assert.equal(await board.getByRole('region', { name: '이 프로젝트의 jig' }).count(), 0);
  assert.equal(await board.getByRole('region', { name: '최근 작업' }).count(), 0);
  // Under the 할 일, in the same column: 연결 파일 then 프로젝트 폴더, each its own titled section.
  assert.equal(await board.locator('details.dash-more').count(), 0);
  const links = board.getByRole('region', { name: '연결 파일' });
  const folders = board.getByRole('region', { name: '프로젝트 폴더' });
  await links.getByRole('heading', { name: '연결 파일' }).waitFor();
  await folders.getByRole('heading', { name: '프로젝트 폴더' }).waitFor();
  {
    const [t, l, f] = [
      await section.boundingBox(),
      await links.boundingBox(),
      await folders.boundingBox(),
    ];
    assert.ok(Math.abs(l.x - t.x) < 2 && Math.abs(f.x - t.x) < 2, 'one right column');
    assert.ok(l.y >= t.y + t.height - 1 && f.y >= l.y + l.height - 1, '할 일 → 연결 파일 → 폴더');
  }
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-layout.png') });
  // The handle between them changes the column's width; the width stays after a reload.
  const split = board.getByRole('separator', { name: '할 일 열 너비' });
  {
    const handle = await split.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 40);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 80, handle.y + 40, { steps: 4 });
    await page.mouse.up();
    const wider = (await section.boundingBox()).width;
    assert.ok(Math.abs(wider - 500) < 3, `dragged to ${wider}px`);
    await split.focus();
    await page.keyboard.press('ArrowRight');
    assert.ok(Math.abs((await section.boundingBox()).width - 484) < 3, 'ArrowRight narrows');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
    await openDashboard();
    await section.getByText('할 일이 없습니다.').waitFor();
    assert.ok(Math.abs((await section.boundingBox()).width - 484) < 3, 'kept after a reload');
    await split.focus();
    await page.keyboard.press('Home');
    assert.ok(Math.abs((await section.boundingBox()).width - 420) < 3, 'Home: the default');
  }
  // The AI column opens folded on the dashboard; the model screen keeps it open.
  const right = page.locator('#right');
  assert.equal(await right.isVisible(), false);
  // The work screens' edge toggle sits over the hidden 3D view; the dashboard has its own.
  const aiToggle = board.getByRole('button', { name: '작업 패널 접기/펼치기' });
  assert.equal(await aiToggle.getAttribute('aria-expanded'), 'false');
  const aiHandle = page.getByRole('separator', { name: '대화 패널 너비' });
  assert.equal(await aiHandle.isVisible(), false, 'folded: no AI column handle');
  const openModel = () => page.locator('.rail [data-workspace-target="model"]').click();
  await openModel();
  await right.waitFor();
  await openDashboard();
  await right.waitFor({ state: 'hidden' });

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
  // '회의' in the words makes it a 협의 (2026-10-06): a small label and no done check.
  assert.equal(await later.locator('li').first().locator('.dash-agenda-kind').innerText(), '협의');
  assert.equal(await later.locator('li').first().locator('input[type="checkbox"]').count(), 0);
  // A range in the words: the preview shows the start and end.
  await input.fill('내일 2시~4시 구조 협의');
  await section.getByText('내일 14:00~16:00 · 구조 협의').waitFor();
  await input.fill('');
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
  assert.equal(
    await section.getByRole('textbox', { name: '날짜', exact: true }).inputValue(),
    '2026-01-02',
  );
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

  // 작성자 (SPEC-01.14 12, SCR-34): this engine signed in to no account recorded none, so that row
  // has no circle and its edit says '작성자 정보 없음'. Signed in as kim, a new row ends with kim's
  // 'K' circle; changed by lee it reads '작성 kim · 고침 lee', in the row's tooltip and the edit.
  const author = (text) => today.locator('li', { hasText: text }).locator('.dash-agenda-author');
  assert.equal(await author('도면 정리 — 단면도').getByRole('img').count(), 0);
  setAgendaActor(app.store, () => ({ id: 'u-kim', name: 'kim' }));
  await input.fill('작성자 확인');
  await input.press('Enter');
  const kimCircle = author('작성자 확인').getByRole('img', { name: '계정 kim' });
  await kimCircle.waitFor();
  assert.equal(await kimCircle.innerText(), 'K');
  assert.equal(await kimCircle.getAttribute('title'), '작성 kim');
  setAgendaActor(app.store, () => ({ id: 'u-lee', name: 'lee' }));
  {
    const item = (await other('', 'GET')).items.find((entry) => entry.text === '작성자 확인');
    await other(`/${item.id}`, 'PUT', { revision: item.revision, time: '09:00' });
  }
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(
    () =>
      document.querySelector('.dash-agenda-author [role="img"]')?.getAttribute('title') ===
      '작성 kim · 고침 lee',
  );
  await today.getByRole('button', { name: '작성자 확인', exact: true }).click();
  await section.locator('.dash-agenda-byline', { hasText: '작성 kim · 고침 lee' }).waitFor();
  await page.keyboard.press('Escape');
  await today.getByRole('button', { name: '도면 정리 — 단면도', exact: true }).click();
  await section.locator('.dash-agenda-byline', { hasText: '작성자 정보 없음' }).waitFor();
  await page.keyboard.press('Escape');
  setAgendaActor(app.store, () => null);
  await today.getByRole('button', { name: '작성자 확인 빼기' }).click();
  await today.getByText('작성자 확인').waitFor({ state: 'detached' });
  assert.deepEqual(await texts(), ['도면 정리 — 단면도']);

  // The edge toggle opens the AI column on the dashboard: the 할 일 도우미 sits on top. Its quick
  // request goes to the 기본 대화 as a hostless Auto turn.
  await aiToggle.click();
  await right.waitFor();
  // Opened, the AI column's width handle shows on the dashboard too and changes its width.
  await aiHandle.waitFor();
  {
    const before = (await right.boundingBox()).width;
    await aiHandle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      (width) => document.querySelector('#right').getBoundingClientRect().width > width + 10,
      before,
    );
    await page.keyboard.press('Home');
  }
  const helper = page.getByRole('region', { name: '할 일 도우미' });
  await helper.waitFor();
  await helper.getByRole('button', { name: '오늘 브리핑' }).click();
  await page.waitForFunction(async () => {
    const project = document.querySelector('#project-picker').value;
    const list = await (await fetch(`api/v1/projects/${project}/requests`)).json();
    const row = (list.requests ?? list).find((entry) =>
      String(entry.input?.body ?? '').startsWith('[할 일 도우미]'),
    );
    return row?.state === 'succeeded';
  });
  const asked = await page.evaluate(async () => {
    const project = document.querySelector('#project-picker').value;
    const list = await (await fetch(`api/v1/projects/${project}/requests`)).json();
    return (list.requests ?? list).find((entry) =>
      String(entry.input?.body ?? '').startsWith('[할 일 도우미]'),
    )?.input;
  });
  assert.deepEqual([asked.hostUse, asked.mode], ['none', 'auto']);
  assert.match(asked.conversationId, /^default/);
  assert.equal(helperGoals.length, 1);
  await page.locator('#conversation').getByText('오늘은 할 일이 없습니다.').waitFor();
  // Opened on the dashboard, it stays open there; the model screen's own fold is apart.
  await openModel();
  assert.equal(await helper.count(), 0);
  await right.waitFor();
  await openDashboard();
  await helper.waitFor();

  // The AI writes twice in one 기본 대화 turn: one notice when the turn ends, kept past 9 s.
  await page.locator('#body').fill('구조 회의 넣어줘');
  await page.locator('#request').click();
  const notice = page.locator('#message');
  await notice.getByText("AI가 할 일을 더했습니다: '구조 회의 — 3층'").waitFor();
  await today.getByText('구조 회의 — 3층').waitFor();
  // An item the AI wrote has no 'AI' mark in its row (the record keeps `source`).
  const aiRow = today.locator('li', { hasText: '구조 회의 — 3층' });
  assert.equal(await aiRow.locator('.dash-agenda-by').count(), 0);
  assert.doesNotMatch(await aiRow.innerText(), /\bAI\b/);
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
    '협의',
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

  // 일정 (T-110, T-135, PLAN-39 T-182): the large month of this project's dated 할 일. No add box,
  // no 날짜 없음 box and no day list under it; the undated one is only in the 할 일 list.
  const iso = (at) =>
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
  const todayIso = iso(new Date());
  const calendar = schedule.locator('.dash-cal-month');
  assert.equal(await schedule.getByRole('textbox', { name: '일정 추가' }).count(), 0);
  assert.equal(await schedule.getByRole('group', { name: '날짜 없음' }).count(), 0);
  assert.equal(
    await calendar.locator('.dash-cal-item', { hasText: '도면 정리 — 단면도' }).count(),
    0,
  );
  const day = (date) => calendar.locator(`.dash-cal-day[data-date="${date}"]`);
  const chip = (text) => calendar.locator('.dash-cal-item', { hasText: text });
  const cell = await day(todayIso).boundingBox();
  assert.ok(cell.height >= 120, `a day is ${cell.height}px tall`);
  // The 협의 added at the start shows on its day with the 협의 dot.
  const tomorrowIso = iso(new Date(Date.now() + 86400000));
  if ((await day(tomorrowIso).count()) === 1)
    assert.equal(await chip('구조 회의').getAttribute('data-kind'), 'meeting');
  // A day's [+]: the 일정 form under it, for a 협의 from 10:00 to 11:00 with its place and people.
  await day(todayIso)
    .getByRole('button', { name: /일정 추가$/ })
    .click();
  const addForm = schedule.getByRole('dialog', { name: '일정 추가' });
  await addForm.waitFor();
  assert.equal(await day(todayIso).getAttribute('aria-pressed'), 'true');
  assert.equal(
    await addForm.getByRole('textbox', { name: '날짜', exact: true }).inputValue(),
    todayIso,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    '일정 제목',
  );
  await page.keyboard.type('설비 협의');
  await addForm.getByRole('combobox', { name: '종류' }).selectOption('meeting');
  await addForm.getByRole('checkbox', { name: '하루 종일' }).uncheck();
  // Times are chosen in 15-minute steps (PLAN-42 T-192).
  const startTime = addForm.getByRole('combobox', { name: '시각', exact: true });
  const times = await startTime
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value));
  assert.equal(times.length, 97);
  assert.deepEqual(times.slice(0, 4), ['', '00:00', '00:15', '00:30']);
  assert.ok(times.slice(1).every((time) => /^\d\d:(00|15|30|45)$/.test(time)));
  assert.equal(times.at(-1), '23:45');
  await startTime.selectOption('10:00');
  await addForm.getByRole('combobox', { name: '끝 시각' }).selectOption('11:00');
  await addForm.getByRole('textbox', { name: '위치' }).fill('현장 사무실');
  await addForm.getByRole('textbox', { name: '참석자' }).fill('김 대리, 설비 업체');
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-event-form.png') });
  await addForm.getByRole('button', { name: '추가' }).click();
  await addForm.waitFor({ state: 'detached' });
  await calendar.locator('.dash-cal-item[data-kind="meeting"]', { hasText: '설비 협의' }).waitFor();
  const talk = (await other('', 'GET')).items.find((item) => item.text === '설비 협의');
  assert.deepEqual(
    [talk.date, talk.time, talk.endTime, talk.kind, talk.location, talk.attendees],
    [todayIso, '10:00', '11:00', 'meeting', '현장 사무실', '김 대리, 설비 업체'],
  );
  // In the 할 일 list today: no done check, its place and its time range.
  const talkRow = today.locator('li', { hasText: '설비 협의' });
  assert.equal(await talkRow.locator('input[type="checkbox"]').count(), 0);
  assert.match(await talkRow.innerText(), /@현장 사무실/);
  assert.match(await talkRow.innerText(), /10:00~11:00/);
  // A period too: from a day over three days, all day — a bar across them.
  const days = await calendar
    .locator('.dash-cal-day')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-date')));
  const at = days.indexOf(todayIso);
  const startIso = days[at % 7 <= 4 ? at : at - 2];
  const endIso = days[days.indexOf(startIso) + 2];
  await day(startIso)
    .getByRole('button', { name: /일정 추가$/ })
    .click();
  await addForm.getByRole('textbox', { name: '일정 제목' }).fill('현장 점검');
  assert.ok(await addForm.getByRole('checkbox', { name: '하루 종일' }).isChecked());
  await addForm.getByLabel('끝 날짜').fill(endIso);
  await addForm.getByRole('button', { name: '추가' }).click();
  const bar = calendar.locator('.dash-cal-item[data-span]', { hasText: '현장 점검' });
  await bar.waitFor();
  if (shot) await page.screenshot({ path: join(shot, 'dashboard-period.png') });
  const barBox = await bar.boundingBox();
  assert.ok(barBox.width > cell.width * 2.5, `the bar spans three days (${barBox.width}px)`);
  // Dragged a week on, it keeps its three days.
  const weekOn = days[days.indexOf(startIso) + 7] ?? days[days.indexOf(startIso) - 7];
  await bar.dragTo(day(weekOn), { targetPosition: { x: 10, y: 10 } });
  const shift = (date, by) => {
    const [y, m, d] = date.split('-').map(Number);
    return iso(new Date(y, m - 1, d + by));
  };
  await page.waitForFunction(
    async ([date]) => {
      const project = document.querySelector('#project-picker').value;
      const list = await (await fetch(`api/v1/projects/${project}/agenda`)).json();
      return list.items.find((item) => item.text === '현장 점검')?.date === date;
    },
    [weekOn],
  );
  const walked = (await other('', 'GET')).items.find((item) => item.text === '현장 점검');
  assert.deepEqual([walked.date, walked.endDate], [weekOn, shift(weekOn, 2)]);
  // An item opens the same form: change its place, take its date off, or remove it.
  await chip('설비 협의').click();
  const editForm = schedule.getByRole('dialog', { name: '일정 고치기' });
  await editForm.waitFor();
  await editForm.getByRole('textbox', { name: '위치' }).fill('본사 회의실');
  await editForm.getByRole('button', { name: '저장' }).click();
  await editForm.waitFor({ state: 'detached' });
  assert.equal(
    (await other('', 'GET')).items.find((item) => item.text === '설비 협의').location,
    '본사 회의실',
  );
  await calendar.locator('.dash-cal-item[data-span]', { hasText: '현장 점검' }).first().click();
  await editForm.getByRole('button', { name: '날짜 빼기' }).click();
  await editForm.waitFor({ state: 'detached' });
  await today.getByRole('button', { name: '현장 점검', exact: true }).waitFor();
  const undated = (await other('', 'GET')).items.find((item) => item.text === '현장 점검');
  assert.deepEqual([undated.date, undated.endDate], [null, null]);
  // Esc closes the form; [삭제] removes the item.
  await day(todayIso)
    .getByRole('button', { name: /일정 추가$/ })
    .click();
  await addForm.waitFor();
  await page.keyboard.press('Escape');
  await addForm.waitFor({ state: 'detached' });
  await today.getByRole('button', { name: '현장 점검 빼기' }).click();
  await today.getByText('현장 점검').waitFor({ state: 'detached' });

  // Drag to another day: only the date is saved (the time and the kind stay).
  const otherDay = days[at + 1 < days.length ? at + 1 : at - 1];
  const meetingBefore = (await other('', 'GET')).items.find((item) => item.text === '설비 협의');
  await chip('설비 협의').dragTo(day(otherDay), { targetPosition: { x: 10, y: 10 } });
  await day(otherDay).waitFor();
  await page.waitForFunction(
    async ([date]) => {
      const project = document.querySelector('#project-picker').value;
      const list = await (await fetch(`api/v1/projects/${project}/agenda`)).json();
      return list.items.find((item) => item.text === '설비 협의')?.date === date;
    },
    [otherDay],
  );
  const meetingAfter = (await other('', 'GET')).items.find((item) => item.id === meetingBefore.id);
  assert.deepEqual(
    [meetingAfter.date, meetingAfter.time, meetingAfter.endTime, meetingAfter.kind],
    [otherDay, '10:00', '11:00', 'meeting'],
  );
  assert.equal(meetingAfter.revision, meetingBefore.revision + 1);
  // A row of the 할 일 area dragged onto a day of the month gets that date, nothing else.
  const rowBefore = (await other('', 'GET')).items.find(
    (item) => item.text === '도면 정리 — 단면도',
  );
  await today
    .locator('li', { hasText: '도면 정리 — 단면도' })
    .dragTo(day(otherDay), { targetPosition: { x: 10, y: 10 } });
  await chip('도면 정리 — 단면도').waitFor();
  const rowAfter = (await other('', 'GET')).items.find((item) => item.id === rowBefore.id);
  assert.deepEqual(
    [rowAfter.date, rowAfter.text, rowAfter.kind],
    [otherDay, rowBefore.text, rowBefore.kind],
  );
  // Back to no date for the rest of the run.
  await other(`/${rowAfter.id}`, 'PUT', { revision: rowAfter.revision, date: null });
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await chip('도면 정리 — 단면도').waitFor({ state: 'detached' });
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
    const [a, b] = [
      document.querySelector('.dash-schedule'),
      document.querySelector('.dash-side'),
    ].map((el) => el.getBoundingClientRect());
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
