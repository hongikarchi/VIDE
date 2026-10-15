// 카카오톡·메일 가져오기 라우트 (PLAN-53 T-329·T-330, ARCH-01 §5 「프로젝트 기록」 '가져오기'):
// POST …/records/import-file → 후보(type '?', 사람 이름), 같은 파일 다시 → 중복 409 {existingId},
// 일부 중복은 skipped, 원문은 작업 폴더 <ops>/기록/원문/에 (같은 이름 다른 내용은 ' (2)', .gitignore),
// 작업 폴더 없음은 copied:false, 원격 FORBIDDEN, 상한 INPUT_TOO_LARGE, 잘못된 입력 INVALID_INPUT.
// 합성 fixture와 임시 폴더만 쓴다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';
import { recordsRoutes } from '../../src/server/records-routes.ts';
import { recordsImportOf, RECORD_IMPORT_MAX } from '../../src/server/records-import.ts';
import { WorkspaceOutputs } from '../../src/server/workspace-outputs.ts';
import { defaultTemplate, templateToPaths } from '../../src/core/workspace-template.ts';
import { startServer } from '../../src/server/server.ts';
import { kakaoPc, mails, mbox } from '../fixtures/records-import/index.mjs';

async function temp(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { workFolder = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-import-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('가져오기');
  const records = new Records(store);
  let root = null;
  if (workFolder) {
    root = await temp(t, 'vide-records-import-ws-');
    await writeFile(
      join(root, 'project.config.json'),
      JSON.stringify({
        schema: 'vide-workspace/1',
        project_id: 'test-2601',
        title: '시험 프로젝트',
        paths: templateToPaths(defaultTemplate()),
        vide: { projectId: project.id, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
      }),
    );
  }
  const outputs = new WorkspaceOutputs({
    folders: {
      list: (id) =>
        root && id === project.id ? [{ path: root, kind: 'project', addedAt: '' }] : [],
    },
    isProject: (id) => id === project.id,
  });
  const importFile = recordsImportOf({
    records,
    writeRawCopy: (p, name, text) => outputs.writeRawCopy(p, name, text),
    now: () => new Date(2026, 9, 20, 9, 0),
  });
  const call = async (data, { remote = false } = {}) => {
    let sent;
    await recordsRoutes(
      new URL(`http://x/api/v1/projects/${project.id}/records/import-file`),
      'POST',
      {
        records,
        project: (id) => store.project(id),
        body: async () => data,
        send: (status, value) => (sent = { status, value }),
        deliver: () => {},
        remote,
        actor: () => '김설계',
        importFile,
      },
    );
    return sent;
  };
  return { store, project, records, root, call };
}

test('kakao: candidates by the person, original copied, same file again → 409 existingId', async (t) => {
  const { project, records, root, call } = await setup(t);
  const pc = kakaoPc(4, 10);
  const first = await call({ kind: 'kakao', name: '현장 대화.txt', text: pc.text });
  assert.equal(first.status, 200);
  assert.equal(first.value.added, pc.messages);
  assert.equal(first.value.skipped, 0);
  assert.equal(first.value.total, pc.messages);
  assert.equal(first.value.recordIds.length, pc.messages);
  assert.equal(first.value.copied, true);
  assert.equal(first.value.path, '01_운영/기록/원문/현장 대화.txt');
  assert.equal(await readFile(join(root, first.value.path), 'utf8'), pc.text);
  assert.equal(await readFile(join(root, '01_운영/기록/원문/.gitignore'), 'utf8'), '*\n');
  const list = records.list(project.id, { source: ['kakao'] });
  assert.equal(list.total, pc.messages);
  const row = list.records[0];
  assert.equal(row.state, 'candidate');
  assert.equal(row.type, '?');
  assert.equal(row.by, '김설계');
  assert.equal(row.source, 'kakao');
  assert.match(row.sourceKey, /^kakao:[0-9a-f]{16}:\d+$/);
  assert.deepEqual(row.attachments, {
    file: { path: '01_운영/기록/원문/현장 대화.txt', line: Number(row.sourceKey.split(':')[2]) },
  });
  assert.equal(row.parts.length, 0);

  const again = await call({ kind: 'kakao', name: '현장 대화.txt', text: pc.text });
  assert.equal(again.status, 409);
  assert.equal(again.value.code, 'RECORD_SOURCE_DUPLICATE');
  assert.equal(again.value.existingId, first.value.recordIds[0]);
  assert.equal(records.list(project.id, {}).total, pc.messages);

  // Another text under the same name: copied beside it as ' (2)'.
  const more = pc.text + '[박현장] [오후 5:00] 추가로 한 줄\r\n';
  const second = await call({ kind: 'kakao', name: '현장 대화.txt', text: more });
  assert.equal(second.status, 200);
  assert.equal(second.value.path, '01_운영/기록/원문/현장 대화 (2).txt');
  // The bytes differ, so every line is a new key (the accepted limit of ARCH-01).
  assert.equal(second.value.added, pc.messages + 1);
});

test('mail: an mbox and then its eml — the held ones are skipped, not refused', async (t) => {
  const { project, records, call } = await setup(t);
  const list = mails();
  const one = await call({ kind: 'mail', name: '첫 메일.EML', text: list[1].text });
  assert.equal(one.status, 200);
  assert.equal(one.value.added, 1);
  const box = await call({ kind: 'mail', name: '보관함.mbox', text: mbox(list) });
  assert.equal(box.status, 200);
  assert.equal(box.value.total, 20);
  assert.equal(box.value.added, 19);
  assert.equal(box.value.skipped, 1);
  const rows = records.list(project.id, { source: ['mail'] }).records;
  assert.equal(rows.length, 20);
  const reply = rows.find((row) => row.sourceKey === 'mail:m2@example.com');
  assert.deepEqual(reply.attachments.mail, {
    from: '이구조 <user2@example.com>',
    subject: '외벽 검토 2차',
    inReplyTo: 'm1@example.com',
  });
  assert.equal(reply.follows.length, 0);
  assert.ok(rows.some((row) => /^mail:[0-9a-f]{16}:20$/.test(row.sourceKey)));
});

test('no work folder: candidates only, copied:false, no file pointer', async (t) => {
  const { project, records, call } = await setup(t, { workFolder: false });
  const answer = await call({ kind: 'kakao', name: 'a.txt', text: kakaoPc(1, 5).text });
  assert.equal(answer.status, 200);
  assert.equal(answer.value.copied, false);
  assert.equal(answer.value.path, undefined);
  for (const row of records.list(project.id, {}).records) assert.deepEqual(row.attachments, {});
});

test('refusals: remote, bad kind/name/extension, nothing parsed, too many, too large', async (t) => {
  const { project, records, root, call } = await setup(t);
  const text = kakaoPc(1, 3).text;
  await assert.rejects(call({ kind: 'kakao', name: 'a.txt', text }, { remote: true }), {
    code: 'FORBIDDEN',
  });
  for (const data of [
    { kind: 'line', name: 'a.txt', text },
    { kind: 'kakao', name: 'a.pdf', text },
    { kind: 'kakao', name: '', text },
    { kind: 'kakao', name: 'x'.repeat(200) + '.txt', text },
    { kind: 'kakao', name: 'a.txt' },
    { kind: 'kakao', name: 'a.txt', text: '대화가 아닌 글' },
    { kind: 'mail', name: 'a.eml', text: '' },
  ])
    await assert.rejects(call(data), { code: 'INVALID_INPUT' }, JSON.stringify(data).slice(0, 60));
  const many = ['--------------- 2026년 10월 1일 목요일 ---------------'];
  for (let i = 0; i <= RECORD_IMPORT_MAX; i++) many.push(`[김설계] [오전 9:00] ${i}`);
  const tooMany = await call({ kind: 'kakao', name: 'many.txt', text: many.join('\n') });
  assert.deepEqual(tooMany, {
    status: 413,
    value: { code: 'INPUT_TOO_LARGE', limit: RECORD_IMPORT_MAX },
  });
  const big = await call({ kind: 'kakao', name: 'big.txt', text: '가'.repeat(7 * 1024 * 1024) });
  assert.deepEqual(big, {
    status: 413,
    value: { code: 'INPUT_TOO_LARGE', limit: 20 * 1024 * 1024 },
  });
  assert.equal(records.list(project.id, {}).total, 0);
  assert.equal(existsSync(join(root, '01_운영/기록/원문')), false);
});

test('over HTTP: the engine answers import-file and lists the candidates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-import-http-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
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
    return { status: response.status, json: await response.json() };
  };
  const project = (await api('/projects', 'POST', { name: '가져오기 HTTP' })).json;
  const answer = await api(`/projects/${project.id}/records/import-file`, 'POST', {
    kind: 'mail',
    name: 'm.mbox',
    text: mbox(),
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.json.added, 20);
  assert.equal(answer.json.copied, false);
  const listed = await api(`/projects/${project.id}/records?state=candidate&source=mail`);
  assert.equal(listed.json.total, 20);
  assert.equal(listed.json.records[0].by, 'user');
});
