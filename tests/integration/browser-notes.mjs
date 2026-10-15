// 노트·일지 — 회의록·일정·폴더에서 바뀜 (PLAN-54 T-356, SPEC-10.9·10.10, Design SCR-23): [새 노트] beside
// [새 회의록]; a new 회의록 opens with its '<날짜> 회의' title and 날짜·참석·결정·할 일 sections; rows
// carry '퇴근 기록'·'회의록'·'일정'; the pinned '프로젝트 일정' row opens the month calendar with the
// project's 할 일·일정 items; a copy changed in the folder shows '폴더에서 바뀜' and [버리기] asks
// once. The account site is stubbed (no real site, no real notes); every sentence is made up.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { Agenda } from '../../src/core/agenda.ts';
import { ensureFirstBlock } from '../../src/contracts/note-doc.ts';
import { toBase64 } from '../../src/contracts/note-sync.ts';

const shot = process.env.VIDE_SHOT_DIR;
const FORBIDDEN =
  /meeting|schedule|journal|changed-in-folder|not-written|undefined|null|SPEC-|PLAN-/;
const MEETING = '2b0c1d2e-3f40-4152-8637-48495a6b7c8d';
const JOURNAL = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const NEW = '5d6e7f80-9102-4a3b-8c4d-5e6f708192a3';

const directory = await mkdtemp(join(tmpdir(), 'vide-notes-'));
const data = join(directory, 'data');
await mkdir(data);
let app, browser;
try {
  app = await startServer({ filename: join(data, 'test.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  for (const [pattern, json] of [
    ['**/api/v1/host', { available: false }],
    ['**/api/v1/providers', [{ id: 'codex-cli', available: true }]],
    [
      '**/api/v1/models',
      [{ id: 'test', name: 'Test', provider: 'codex-cli', efforts: ['default'] }],
    ],
  ])
    await page.route(pattern, (route) => route.fulfill({ json }));

  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const today = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const iso = `${today.getFullYear()}-${two(today.getMonth() + 1)}-${two(today.getDate())}`;
  new Agenda(app.store).add(projectId, {
    text: '설비 협의 일정',
    kind: 'meeting',
    date: iso,
    time: '10:00',
  });

  // The engine's notes (stubbed site): one 회의록, one journal; POST makes a 회의록.
  const at = Date.now() - 60_000;
  const row = (id, kind, title, journalDate = null) => ({
    id,
    projectId,
    title,
    kind,
    journalDate,
    createdAt: at,
    updatedAt: at,
    updatedBy: 'u1',
    updatedByName: '김 소장',
    revision: 1,
    excerpt: '',
  });
  const notes = [row(MEETING, 'meeting', '10월 1일 회의'), row(JOURNAL, 'journal', '', iso)];
  const created = [];
  await page.route('**/api/v1/projects/*/notes', async (route) => {
    if (route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      created.push(input);
      const note = row(NEW, input.kind, input.title);
      notes.unshift(note);
      return route.fulfill({ json: note });
    }
    return route.fulfill({ json: { notes, online: true, user: '김 소장' } });
  });
  // The replica stream: the server's first empty paragraph, then 'synced'.
  const server = new Y.Doc();
  ensureFirstBlock(server, 'init');
  const sync = {
    type: 'sync',
    state: toBase64(Y.encodeStateAsUpdate(server)),
    vector: toBase64(Y.encodeStateVector(server)),
  };
  const status = { type: 'status', status: { connected: true, synced: true, pending: false } };
  await page.route('**/api/v1/projects/*/notes/*/stream*', (route) =>
    route.fulfill({
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: `retry: 600000\ndata: ${JSON.stringify(sync)}\n\ndata: ${JSON.stringify(status)}\n\n`,
    }),
  );
  const posted = [];
  await page.route('**/api/v1/projects/*/notes/*/updates', (route) => {
    posted.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  // The work folder copies: the old 회의록 was changed in the folder.
  const discarded = [];
  await page.route('**/api/v1/projects/*/workspace/folder-copies', (route) =>
    route.fulfill({
      json: {
        copies: [
          {
            key: `note:${MEETING}`,
            path: 'C:/작업/01_운영/회의록/2026-10-01-10월 1일 회의.md',
            state: discarded.length ? 'written' : 'changed-in-folder',
            writtenAt: new Date(at).toISOString(),
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/projects/*/workspace/folder-copies/discard', (route) => {
    discarded.push(route.request().postDataJSON().key);
    return route.fulfill({ json: { copy: { key: `note:${MEETING}`, state: 'written' } } });
  });

  await page.locator('.rail [data-workspace-target="notes"]').click();
  const side = page.getByRole('complementary', { name: '노트 목록' });
  await side.getByRole('button', { name: '새 회의록' }).waitFor();
  assert.ok(await side.getByRole('button', { name: '새 노트' }).isVisible());
  // Kind marks; the 일정 row is first.
  const rows = side.locator('.notes-list > li');
  await side.getByText('10월 1일 회의').waitFor();
  assert.match(await rows.first().innerText(), /프로젝트 일정\s*일정/);
  assert.match(
    await side.locator('li', { hasText: '10월 1일 회의' }).innerText(),
    /회의록\s*폴더에서 바뀜/,
  );
  assert.match(await side.locator('li', { hasText: '일지' }).innerText(), /퇴근 기록/);

  // The changed 회의록: the warning line, [버리기] asks once.
  await side.getByText('10월 1일 회의').click();
  const main = page.locator('.notes-main');
  await main
    .getByText('폴더의 사본이 이 노트와 다릅니다. 폴더에서 고친 글은 여기로 들어오지 않습니다.')
    .waitFor();
  await main.getByRole('button', { name: '버리기' }).click();
  await main.getByText('폴더 사본을 이 노트 내용으로 다시 씁니다').waitFor();
  assert.deepEqual(discarded, []);
  await main.locator('.note-folder').getByRole('button', { name: '버리기' }).click();
  await page.waitForFunction(() => !document.querySelector('.note-folder'));
  assert.deepEqual(discarded, [`note:${MEETING}`]);

  // [새 회의록]: kind and '<날짜> 회의' title go to the site; the four sections are put in once.
  await side.getByRole('button', { name: '새 회의록' }).click();
  await main.getByRole('heading', { name: '결정' }).waitFor();
  const [m, d] = [today.getMonth() + 1, today.getDate()];
  assert.deepEqual(created, [{ kind: 'meeting', title: `${m}월 ${d}일 회의` }]);
  const editor = main.locator('.ProseMirror');
  for (const name of ['날짜', '참석', '결정', '할 일'])
    assert.equal(await editor.getByRole('heading', { name, exact: true }).count(), 1, name);
  assert.match(await editor.innerText(), new RegExp(iso));
  assert.equal(await editor.locator('ul[data-type="taskList"] li').count(), 1);
  // Edits go to the engine in small batches (40 ms).
  for (let i = 0; i < 100 && !posted.some((p) => p.update); i++) await page.waitForTimeout(50);
  assert.ok(
    posted.some((p) => p.update),
    'the template went to the engine',
  );
  assert.match(await main.locator('.note-meta').innerText(), /회의록/);
  if (shot) await page.screenshot({ path: join(shot, 'notes-meeting.png') });

  // The 일정 row: the dashboard's month calendar with the project's items; no 서식 줄 or 할 일 단추.
  await rows.first().getByRole('button').click();
  const schedule = page.getByRole('region', { name: '일정', exact: true });
  await schedule.getByText('설비 협의 일정').waitFor();
  assert.equal(await page.locator('.notes-main .note-toolbar').count(), 0);
  assert.equal(
    await page.locator('.notes-main').getByRole('button', { name: '할 일로 보내기' }).count(),
    0,
  );
  if (shot) await page.screenshot({ path: join(shot, 'notes-schedule.png') });

  assert.doesNotMatch(await page.locator('.notes-workspace').innerText(), FORBIDDEN);
  assert.deepEqual(errors, []);
  console.log('browser notes: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
