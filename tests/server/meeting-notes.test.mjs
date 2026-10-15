// 회의록·일정의 운영 폴더 사본과 '폴더에서 바뀜' (SPEC-10.9·10.10, SPEC-10.5 4, ARCH-01 「작업 폴더
// (PLAN-52)」 산출물 경로, PLAN-54 T-356): a 회의록 → `01_운영/회의록/<만든 날>-<제목>.md`; the 일정 →
// `01_운영/일정/<YYYY-MM>.md` after 할 일 changes; a copy the person changed is left alone and
// shown as 'changed-in-folder' until [버리기]; a copy that cannot be written is 'not-written'; a
// note removed on the site keeps its copy, marked; a waiting [퇴근하기] line reaches the 일지 copy
// at once. Synthetic folders and made-up sentences only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTemplate, templateToPaths } from '../../src/core/workspace-template.ts';
import { minuteOf, WorkspaceOutputs } from '../../src/server/workspace-outputs.ts';
import { SharedNotes } from '../../src/server/shared-notes.ts';
import { folderCopyRoutes } from '../../src/server/folder-copy-routes.ts';
import { Store } from '../../src/core/store.ts';
import { Agenda, onAgendaChange } from '../../src/core/agenda.ts';
import { scheduleMarkdown } from '../../src/core/agenda-month.ts';
import { attachRecordSources } from '../../src/server/record-sources.ts';
import { Records } from '../../src/core/records.ts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const NOW = new Date(2026, 9, 15, 14, 5, 0);
const MEETING = '2b0c1d2e-3f40-4152-8637-48495a6b7c8d';

async function temp(t, prefix = 'vide-meeting-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function workFolder(t) {
  const root = await temp(t);
  await writeFile(
    join(root, 'project.config.json'),
    JSON.stringify({
      schema: 'vide-workspace/1',
      project_id: 'test-2601',
      title: '시험 프로젝트',
      paths: templateToPaths(defaultTemplate()),
      vide: { projectId: PROJECT, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
    }),
  );
  return root;
}
function writer(roots, dataDirectory) {
  return new WorkspaceOutputs({
    folders: {
      list: (projectId) =>
        projectId === PROJECT ? roots.map((path) => ({ path, kind: 'project', addedAt: '' })) : [],
    },
    isProject: (id) => id === PROJECT,
    now: () => NOW,
    dataDirectory,
  });
}
const meeting = (over = {}) => ({
  id: MEETING,
  kind: 'meeting',
  title: '10월 15일 회의',
  createdAt: NOW.getTime(),
  ...over,
});
const BODY =
  '## 날짜\n\n2026-10-15\n\n## 참석\n\n김 소장, 박 대리\n\n## 결정\n\n남측 캐노피 폭 1.2 m\n\n## 할 일\n\n- [ ] 설비 협의';

test('a 회의록 → 01_운영/회의록/<만든 날>-<제목>.md with the copy marker and the body', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  const path = await outputs.writeNote(PROJECT, meeting(), BODY);
  const day = minuteOf(NOW).slice(0, 10);
  assert.equal(path, join(root, '01_운영', '회의록', `${day}-10월 15일 회의.md`));
  const text = await readFile(path, 'utf8');
  assert.match(text.split('\n')[0], /vide-copy:note:2b0c1d2e-3f40-4152-8637-48495a6b7c8d -->$/);
  assert.match(text, /## 결정\n\n남측 캐노피 폭 1\.2 m/);
  assert.deepEqual(
    (await outputs.folderCopies(PROJECT)).map(({ key, state }) => ({ key, state })),
    [{ key: `note:${MEETING}`, state: 'written' }],
  );
});

test('a copy changed in the folder is not overwritten, shows changed-in-folder, [버리기] restores it', async (t) => {
  const root = await workFolder(t);
  const data = await temp(t, 'vide-data-');
  const outputs = writer([root], data);
  const path = await outputs.writeNote(PROJECT, meeting(), BODY);
  const edited = (await readFile(path, 'utf8')) + '\n사람이 폴더에서 덧붙인 줄\n';
  await writeFile(path, edited);
  // The source changes; the next copy leaves the person's file as it is.
  assert.equal(await outputs.writeNote(PROJECT, meeting(), BODY + '\n\n추가 결정'), null);
  assert.equal(await readFile(path, 'utf8'), edited);
  const state = async (o) =>
    (await o.folderCopies(PROJECT)).find((c) => c.key === `note:${MEETING}`);
  assert.equal((await state(outputs)).state, 'changed-in-folder');
  // A restarted engine still tells (the hashes are in <데이터>/projects/<id>/folder-copies.json).
  assert.ok(existsSync(join(data, 'projects', PROJECT, 'folder-copies.json')));
  const restarted = writer([root], data);
  assert.equal((await state(restarted)).state, 'changed-in-folder');
  // [버리기] after a restart: the source is asked to write it again, past the check.
  let asked = '';
  const copy = await restarted.discardFolderCopy(PROJECT, `note:${MEETING}`, async (key) => {
    asked = key;
    await restarted.writeNote(PROJECT, meeting(), BODY + '\n\n추가 결정');
  });
  assert.equal(asked, `note:${MEETING}`);
  assert.equal(copy.state, 'written');
  const back = await readFile(path, 'utf8');
  assert.doesNotMatch(back, /사람이 폴더에서/);
  assert.match(back, /추가 결정/);
  // In the same run [버리기] uses the last write asked for.
  await writeFile(path, back + '\n또 고침\n');
  assert.equal((await state(restarted)).state, 'changed-in-folder');
  assert.equal((await restarted.discardFolderCopy(PROJECT, `note:${MEETING}`)).state, 'written');
  assert.doesNotMatch(await readFile(path, 'utf8'), /또 고침/);
  await assert.rejects(restarted.discardFolderCopy(PROJECT, 'note:unknown'), {
    code: 'COPY_NOT_FOUND',
  });
});

test('a copy that cannot be written is not-written, and written on the next try', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  // 회의록 is taken by a file: the folder cannot be made (the same as a locked or lost share).
  await mkdir(join(root, '01_운영'), { recursive: true });
  await writeFile(join(root, '01_운영', '회의록'), '막힘');
  assert.equal(await outputs.writeNote(PROJECT, meeting(), BODY), null);
  assert.deepEqual(
    (await outputs.folderCopies(PROJECT)).map(({ key, state }) => ({ key, state })),
    [{ key: `note:${MEETING}`, state: 'not-written' }],
  );
  await rm(join(root, '01_운영', '회의록'));
  assert.ok(await outputs.writeNote(PROJECT, meeting(), BODY));
  assert.equal((await outputs.folderCopies(PROJECT))[0].state, 'written');
});

test('no work folder: nothing is written and the states answer NO_WORKSPACE', async (t) => {
  const outputs = writer([], await temp(t, 'vide-data-'));
  assert.equal(await outputs.writeNote(PROJECT, meeting(), BODY), null);
  await assert.rejects(outputs.folderCopies(PROJECT), { code: 'NO_WORKSPACE' });
  await assert.rejects(outputs.discardFolderCopy(PROJECT, `note:${MEETING}`), {
    code: 'NO_WORKSPACE',
  });
});

test('일정: a 할 일 change → 01_운영/일정/<YYYY-MM>.md for each month; an emptied month says so', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const projectId = store.createProject('일정 시험').id;
  const agenda = new Agenda(store, { now: () => NOW });
  const heard = [];
  const stop = onAgendaChange(store, (p) => heard.push(p));
  const october = agenda.add(projectId, {
    text: '설비 협의',
    kind: 'meeting',
    date: '2026-10-21',
    time: '10:00',
    endTime: '11:00',
    location: '현장 사무실',
    attendees: '김 대리',
  });
  const november = agenda.add(projectId, {
    text: '허가 접수',
    kind: 'receipt',
    date: '2026-11-03',
  });
  agenda.add(projectId, { text: '날짜 없는 할 일' });
  assert.deepEqual(heard, [projectId, projectId, projectId]);
  stop();
  const items = agenda.list(projectId);
  const written = await outputs.writeSchedule(PROJECT, items);
  const dir = join(root, '01_운영', '일정');
  assert.deepEqual(written, [join(dir, '2026-10.md'), join(dir, '2026-11.md')]);
  const oct = await readFile(join(dir, '2026-10.md'), 'utf8');
  assert.match(oct.split('\n')[0], /vide-copy:schedule:2026-10 -->$/);
  assert.match(oct, /# 2026년 10월 일정/);
  assert.match(
    oct,
    /## 10월 21일 \(수\)\n\n- 10:00~11:00 \[협의\] 설비 협의 · 장소 현장 사무실 · 참석 김 대리/,
  );
  assert.doesNotMatch(oct, /날짜 없는 할 일/);
  // The November item moves to October: November is written again, empty.
  agenda.set(projectId, november.id, { revision: november.revision, date: '2026-10-30' });
  await outputs.writeSchedule(PROJECT, agenda.list(projectId));
  assert.match(
    await readFile(join(dir, '2026-11.md'), 'utf8'),
    /이 달에 날짜가 있는 할 일·일정이 없습니다/,
  );
  assert.match(await readFile(join(dir, '2026-10.md'), 'utf8'), /\[접수\] 허가 접수/);
  assert.ok(october.id);
  assert.equal(
    scheduleMarkdown([], '2026-12'),
    '# 2026년 12월 일정\n\n이 달에 날짜가 있는 할 일·일정이 없습니다.\n',
  );
});

/** A site whose note list is `notes()`; journal appends fail when `down`. */
function site(notes, state = { down: false }) {
  return {
    site: 'https://site.example',
    deviceFetch: async (path, method = 'GET') => {
      if (state.down) throw new TypeError('fetch failed');
      if (method === 'GET' && path.startsWith(`/projects/${PROJECT}/notes`))
        return Response.json({ notes: notes() });
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
    },
  };
}
const siteMeeting = {
  id: MEETING,
  projectId: PROJECT,
  title: '10월 15일 회의',
  kind: 'meeting',
  journalDate: null,
  createdAt: NOW.getTime(),
  updatedAt: NOW.getTime(),
  updatedBy: 'u1',
  revision: 2,
  snapshot: BODY,
};

test('a 회의록 written on the site is copied on the next list; removed there, its copy stays marked', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  let listed = [siteMeeting];
  const notes = new SharedNotes({
    remote: site(() => listed),
    dataDirectory: await temp(t, 'vide-notes-'),
    agenda: { list: () => [], add: () => ({}) },
    onCopy: (projectId, note, markdown) => void outputs.writeNote(projectId, note, markdown),
  });
  t.after(() => notes.close());
  await notes.list(PROJECT);
  await outputs.idle();
  const dir = join(root, '01_운영', '회의록');
  const [name] = await readdir(dir);
  const first = await readFile(join(dir, name), 'utf8');
  assert.match(first, /VIDE 공유 노트 · 회의록 · id/);
  assert.doesNotMatch(first, /사이트에서 지워짐/);
  listed = [];
  await notes.list(PROJECT);
  await outputs.idle();
  assert.deepEqual(await readdir(dir), [name], 'the folder copy is not removed');
  const marked = await readFile(join(dir, name), 'utf8');
  assert.match(marked.split('\n')[1], /^> 사이트에서 지워짐/);
  assert.match(marked, /남측 캐노피 폭 1\.2 m/);
});

test('a [퇴근하기] line waiting for the site goes into the 일지 copy at once; the site copy takes it over', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  const state = { down: true };
  const notes = new SharedNotes({
    remote: site(() => [], state),
    dataDirectory: await temp(t, 'vide-notes-'),
    agenda: { list: () => [], add: () => ({}) },
    today: () => '2026-10-15',
    onJournalQueued: (projectId, date, text) =>
      void outputs.appendJournalLine(projectId, date, text),
    onCopy: (projectId, note, markdown) => void outputs.writeNote(projectId, note, markdown),
  });
  t.after(() => notes.close());
  const result = await notes.appendJournal(PROJECT, '퇴근 기록 · 2층 슬래브 개구부 확인');
  assert.equal(result.state, 'queued');
  await outputs.idle();
  const path = join(root, '01_운영', '일지', '2026-10-15.md');
  assert.match(
    await readFile(path, 'utf8'),
    /퇴근 기록 · 2층 슬래브 개구부 확인 \(사이트에 아직 안 보냄\)/,
  );
  // A second waiting line goes under the first.
  await notes.appendJournal(PROJECT, '퇴근 기록 · 외벽 견본 확인');
  await outputs.idle();
  assert.match(
    await readFile(path, 'utf8'),
    /개구부 확인 \(사이트에 아직 안 보냄\)\n\n퇴근 기록 · 외벽 견본 확인/,
  );
  // The site's journal of that day arrives: the same file becomes its copy (no '-2').
  await outputs.writeNote(
    PROJECT,
    {
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      kind: 'journal',
      title: '',
      journalDate: '2026-10-15',
    },
    '퇴근 기록 · 2층 슬래브 개구부 확인\n\n퇴근 기록 · 외벽 견본 확인',
  );
  assert.deepEqual(await readdir(join(root, '01_운영', '일지')), ['2026-10-15.md']);
  const copied = await readFile(path, 'utf8');
  assert.match(copied.split('\n')[0], /vide-copy:note:9a8b7c6d/);
  assert.doesNotMatch(copied, /아직 안 보냄/);
});

test('a waiting line is not written into a copy changed in the folder', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  const path = await outputs.appendJournalLine(PROJECT, '2026-10-15', '퇴근 기록 · 첫 줄');
  await writeFile(path, (await readFile(path, 'utf8')) + '\n폴더에서 고친 줄\n');
  assert.equal(await outputs.appendJournalLine(PROJECT, '2026-10-15', '퇴근 기록 · 둘째 줄'), null);
  assert.doesNotMatch(await readFile(path, 'utf8'), /둘째 줄/);
  assert.equal((await outputs.folderCopies(PROJECT))[0].state, 'changed-in-folder');
});

test('folder-copies routes: states for everyone, [버리기] refused in a remote session', async (t) => {
  const root = await workFolder(t);
  const outputs = writer([root], await temp(t, 'vide-data-'));
  await outputs.writeNote(PROJECT, meeting(), BODY);
  const sent = [];
  const deps = (remote, input = {}) => ({
    copies: outputs,
    project: () => ({}),
    body: async () => input,
    send: (status, value) => sent.push({ status, value }),
    remote,
  });
  const at = (path) => new URL(`http://x/api/v1/projects/${PROJECT}/workspace/${path}`);
  assert.equal(await folderCopyRoutes(at('folder-copies'), 'GET', deps(true)), true);
  assert.equal(sent[0].value.copies[0].state, 'written');
  await assert.rejects(
    folderCopyRoutes(at('folder-copies/discard'), 'POST', deps(true, { key: `note:${MEETING}` })),
    { code: 'FORBIDDEN' },
  );
  assert.equal(
    await folderCopyRoutes(
      at('folder-copies/discard'),
      'POST',
      deps(false, { key: `note:${MEETING}` }),
    ),
    true,
  );
  assert.equal(sent[1].value.copy.state, 'written');
  assert.equal(await folderCopyRoutes(at('pairs'), 'GET', deps(false)), false);
});

test('a 회의록’s paragraphs are 회의록 candidates (source meeting, SPEC-17.3)', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const projectId = store.createProject('기록 시험').id;
  const records = new Records(store, { now: () => NOW });
  const sources = attachRecordSources({ records, log: () => {}, now: () => NOW });
  sources.noteCopied(
    projectId,
    { id: MEETING, kind: 'meeting', updatedAt: NOW.getTime() },
    '남측 캐노피 폭을 1.2 m로 하기로 함',
  );
  await sources.idle();
  const rows = records.list(projectId, { state: ['candidate'] }).records;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'meeting');
});
