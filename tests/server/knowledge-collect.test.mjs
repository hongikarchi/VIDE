// 자료 정리 over HTTP (SPEC-08.9, SPEC-01.14 11, PLAN-42 T-194·T-196): no folder is refused, a run
// started from the route ends with its state, the proposals card's add (through the agenda with
// source 'ai', edits applied) and dismiss. A fake AI runner; synthetic folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { modelPlan } from '../../src/knowledge/collect/ai.ts';
import { fakeRunner } from '../fixtures/documents.mjs';

const later = (days) => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

test('collect from the project folder, then add one proposal and dismiss the other', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-http-'));
  const folder = join(directory, '합성 프로젝트');
  await mkdir(folder);
  await writeFile(
    join(folder, '회의록.md'),
    '설비 협의는 다음 주 화요일 오후 2시에 현장 사무실에서 한다.\n구조 검토서는 다음 주 금요일까지 제출한다.',
  );
  const runner = fakeRunner({
    proposals: (statements) => [
      {
        text: '설비 협의',
        kind: 'meeting',
        date: later(7),
        time: '14:00',
        location: '현장 사무실',
        cite: statements.filter((s) => s.content.includes('설비')).map((s) => s.id),
      },
      {
        text: '구조 검토서 제출',
        kind: 'receipt',
        date: later(10),
        cite: statements.filter((s) => s.content.includes('구조')).map((s) => s.id),
      },
    ],
  });
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    collectOptions: {
      runner,
      plan: async () => modelPlan(['claude-cli'], []),
      dwgReader: null,
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: '자료 정리' })).json;
  const base = `/projects/${project.id}`;
  const before = (await api(`${base}/knowledge/collect`)).json;
  assert.deepEqual([before.state, before.collected], ['idle', false]);
  // No project folder: refused with its reason.
  const none = await api(`${base}/knowledge/collect`, 'POST', {});
  assert.deepEqual([none.status, none.json.code], [409, 'NO_PROJECT_FOLDER']);

  assert.equal((await api(`${base}/folders`, 'POST', { path: folder })).status, 200);
  const started = await api(`${base}/knowledge/collect`, 'POST', {});
  assert.equal(started.status, 200);
  assert.equal(started.json.state, 'running');
  let state = started.json;
  for (let i = 0; i < 100 && state.state === 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    state = (await api(`${base}/knowledge/collect`)).json;
  }
  assert.equal(state.state, 'done', state.error ?? '');
  assert.equal(state.collected, true);
  assert.equal(state.counts.statements, 2);
  assert.equal(state.counts.proposals, 2);
  // The 자료 tab reads the same DB.
  const facts = (await api(`${base}/facts`)).json;
  assert.equal(facts.counts.statements, 2);

  const { proposals } = (await api(`${base}/agenda-proposals`)).json;
  assert.deepEqual(
    proposals.map((p) => [p.text, p.kind]),
    [
      ['설비 협의', 'meeting'],
      ['구조 검토서 제출', 'receipt'],
    ],
  );
  assert.match(proposals[0].evidence[0].content, /설비 협의는/);
  // Added with an edit: through the agenda, source 'ai'.
  const added = await api(`${base}/agenda-proposals/add`, 'POST', {
    items: [{ id: proposals[0].id, text: '설비 협의 (현장)' }],
  });
  assert.equal(added.status, 200);
  assert.equal(added.json.added, 1);
  assert.deepEqual(
    added.json.items.map((i) => [i.text, i.kind, i.date, i.time, i.location, i.source]),
    [['설비 협의 (현장)', 'meeting', later(7), '14:00', '현장 사무실', 'ai']],
  );
  assert.equal(added.json.proposals.length, 1);
  const dismissed = await api(`${base}/agenda-proposals/dismiss`, 'POST', {
    ids: [proposals[1].id],
  });
  assert.deepEqual(dismissed.json.proposals, []);
  // Adding a decided proposal again does nothing.
  const again = await api(`${base}/agenda-proposals/add`, 'POST', {
    items: [{ id: proposals[0].id }],
  });
  assert.equal(again.json.added, 0);
  assert.equal((await api(`${base}/agenda`)).json.items.length, 1);
  assert.equal((await api(`${base}/agenda-proposals/add`, 'POST', { items: [] })).status, 400);
});

test('survey before a run and folders left out (T-261)', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-collect-survey-http-'));
  const folder = join(directory, '합성 프로젝트');
  await mkdir(join(folder, '도구', '.venv'), { recursive: true });
  await mkdir(join(folder, '측량'), { recursive: true });
  await mkdir(join(folder, '참고'), { recursive: true });
  await writeFile(join(folder, '회의록.md'), '기둥 간격은 9m로 확정한다.');
  await writeFile(join(folder, '참고', '메모.md'), '외장재는 석재로 바꾼다.');
  await writeFile(join(folder, '도구', '.venv', 'pyvenv.cfg'), 'home = C:\\Python');
  await writeFile(
    join(folder, '측량', '좌표.csv'),
    ['x,y'].concat(Array.from({ length: 800 }, (_, i) => `${i}.5,${i * 2}.25`)).join('\n'),
  );
  const app = await startServer({
    filename: join(directory, 'data', 'store.sqlite'),
    collectOptions: {
      runner: fakeRunner(),
      plan: async () => modelPlan(['claude-cli'], []),
      dwgReader: null,
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: '자료 살펴보기' })).json;
  const base = `/projects/${project.id}/knowledge/collect`;
  assert.equal((await api(`${base}/survey`)).json.code, 'NO_PROJECT_FOLDER');
  assert.equal(
    (await api(`/projects/${project.id}/folders`, 'POST', { path: folder })).status,
    200,
  );
  const survey = (await api(`${base}/survey`)).json;
  assert.deepEqual(survey.read, { files: 2, byKind: { text: 2 } });
  assert.equal(survey.skipped.data, 1);
  assert.equal(survey.skipped.env, 1);
  assert.equal(survey.estimate.filterCalls, 1);
  const left = await api(`${base}/exclude`, 'POST', { exclude: ['참고'] });
  assert.equal(left.status, 200);
  assert.deepEqual(
    [left.json.exclude, left.json.read.files, left.json.skipped.excluded],
    [['참고'], 1, 1],
  );
  // Outside the project folder, or not a list: refused.
  assert.equal((await api(`${base}/exclude`, 'POST', { exclude: ['..'] })).status, 400);
  assert.equal((await api(`${base}/exclude`, 'POST', { exclude: 'x' })).status, 400);
  // The setting is kept: a run reads what the survey said.
  await api(base, 'POST', {});
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await api(base)).json;
    if (state.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(state.state, 'done', state.error ?? '');
  assert.deepEqual([state.counts.read, state.counts.data], [1, 1]);
  assert.deepEqual(state.survey.exclude, ['참고']);
  // Back in: the next survey reads it.
  const back = (await api(`${base}/exclude`, 'POST', { exclude: [] })).json;
  assert.deepEqual([back.exclude, back.read.files], [[], 1]);
});
