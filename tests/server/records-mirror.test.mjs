// 기록의 작업 폴더 사본 (PLAN-53 T-331, SPEC-17.6, ARCH-01 §5 「프로젝트 기록」 '사본 쓰기와 되들이기'):
// `<ops>/기록/YYYY-MM.jsonl`·`README.md` are written from the DB and read back the same; a change
// starts one write after the debounce; a copy the person changed is left alone and shown as changed;
// [폴더 내용 들이기] takes its lines in line by line, [VIDE 기록으로 다시 쓰기] writes over it; no work
// folder writes nothing; a remote session only reads the state. Synthetic folders and sentences only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Records, onRecordsChanged } from '../../src/core/records.ts';
import { defaultTemplate, templateToPaths } from '../../src/core/workspace-template.ts';
import { WorkspaceOutputs, recordsCopyMarker } from '../../src/server/workspace-outputs.ts';
import { RecordsMirror, recordsReadme } from '../../src/server/records-mirror.ts';
import { recordsRoutes } from '../../src/server/records-routes.ts';
import { workFolderRule } from '../../src/ai/agent-connection.ts';

async function setup(t, { folder = true, delayMs = 5000 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-mirror-'));
  const store = new Store(join(directory, 'data.sqlite'));
  const project = store.createProject('기록 사본 시험');
  let root = null;
  if (folder) {
    root = await mkdtemp(join(tmpdir(), 'vide-records-work-'));
    await writeFile(
      join(root, 'project.config.json'),
      JSON.stringify({
        schema: 'vide-workspace/1',
        project_id: 'test-2610',
        title: '시험 프로젝트',
        paths: templateToPaths(defaultTemplate()),
        vide: { projectId: project.id, createdBy: 'user', createdAt: '2026-10-15T00:00:00.000Z' },
      }),
    );
  }
  const outputs = new WorkspaceOutputs({
    folders: {
      list: (id) =>
        id === project.id && root ? [{ path: root, kind: 'project', addedAt: '' }] : [],
    },
    isProject: (id) => id === project.id,
    dataDirectory: directory,
  });
  const records = new Records(store);
  const logged = [];
  const mirror = new RecordsMirror({
    records,
    outputs,
    delayMs,
    log: (event, fields) => logged.push({ event, ...fields }),
  });
  t.after(async () => {
    mirror.stop();
    await mirror.idle();
    store.close();
    await rm(directory, { recursive: true, force: true });
    if (root) await rm(root, { recursive: true, force: true });
  });
  const dir = root ? join(root, '01_운영', '기록') : null;
  return { store, project, root, dir, outputs, records, mirror, logged, p: project.id };
}
const lines = async (path) =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('every write of Records tells the listeners once it stands', async (t) => {
  const { store, records, p } = await setup(t, { folder: false });
  let calls = 0;
  const off = onRecordsChanged(store, (projectId) => {
    assert.equal(projectId, p);
    calls++;
    throw new Error('a listener never fails the write');
  });
  const part = records.addPart(p, { name: '지붕' });
  const a = records.add(
    p,
    { date: '2026-10-01', type: 'D', text: '지붕을 평지붕으로' },
    { by: '홍길동' },
  );
  const b = records.add(p, { date: '2026-10-02', type: 'E', text: '구조 검토' }, { by: '홍길동' });
  const steps = [
    () => records.patch(p, a.id, { parts: [part.id] }, '홍길동'),
    () => records.setStates(p, [a.id], 'dropped', '홍길동'),
    () => records.link(p, a.id, b.id),
    () => records.unlink(p, a.id, b.id),
    () => records.correct(p, b.id, { text: '구조 검토(정정)' }, '홍길동'),
    () => records.setPart(p, part.id, { grp: '신설' }),
    () => records.addMilestone(p, { label: '계획설계', date: '2026-10-10' }),
    () => records.importMarks(p, [a.id], 'o', '홍길동'),
    () => records.addMany(p, [{ input: { text: '여러 건 한 번에' } }], { by: '홍길동' }),
  ];
  const before = calls;
  for (const step of steps) step();
  assert.ok(calls - before >= steps.length, `${calls - before}`);
  const milestone = records.milestones(p)[0];
  const n = calls;
  records.removeMilestone(p, milestone.id);
  records.removePart(p, part.id);
  assert.equal(calls, n + 2);
  // A refused write tells nobody; nor a state change that changes nothing.
  assert.throws(() => records.link(p, a.id, a.id), { code: 'RECORD_LINK_CYCLE' });
  records.setStates(p, [a.id], 'kept', '홍길동');
  assert.equal(calls, n + 2);
  off();
  records.add(p, { text: '구독 해제 뒤' }, { by: 'ai' });
  assert.equal(calls, n + 2);
});

test('JSONL by month and README are written and read back the same', async (t) => {
  const { records, mirror, dir, p, root } = await setup(t);
  const roof = records.addPart(p, {
    name: '지붕',
    grp: '신설',
    roleFrom: '비를 막는다',
    roleTo: '옥상 정원',
    chapter: '2장',
    mapping: [{ kind: 'layer', linkId: 'L1', layer: '지붕' }],
  });
  records.addMilestone(p, { label: '계획설계', date: '2026-10-10' });
  records.add(p, { date: '2026-09-30', type: 'R', text: '건축주: 옥상 사용' }, { by: '홍길동' });
  records.add(
    p,
    {
      date: '2026-10-01',
      time: '10:00',
      type: 'D',
      text: '평지붕 | 방수',
      parts: [roof.id],
      chapter: '2장',
    },
    { by: '홍길동' },
  );
  records.add(p, { date: '2026-10-02', text: '후보 문장' }, { by: 'ai' });
  assert.equal(await mirror.flush(p), true);
  const september = await lines(join(dir, '2026-09.jsonl'));
  const october = await lines(join(dir, '2026-10.jsonl'));
  assert.equal(
    (await readFile(join(dir, '2026-10.jsonl'), 'utf8')).split('\n')[0],
    recordsCopyMarker('2026-10'),
  );
  assert.match(recordsCopyMarker('2026-10'), /vide-copy:records:2026-10/);
  assert.deepEqual(
    september.slice(1),
    records.list(p, { from: '2026-09-01', to: '2026-09-30' }).records,
  );
  assert.deepEqual(
    october.slice(1),
    records.list(p, { from: '2026-10-01', to: '2026-10-31' }).records,
  );
  assert.deepEqual(
    october.slice(1).map((row) => row.state),
    ['kept', 'candidate'],
  );
  const readme = await readFile(join(dir, 'README.md'), 'utf8');
  assert.match(readme.split('\n')[0], /vide-copy:records:readme/);
  assert.match(readme, /\| 지붕 \| 신설 \| 비를 막는다 → 옥상 정원 \| 2장 \| 1 \|/);
  assert.match(readme, /\| 2026-10-10 \| 계획설계 \|/);
  assert.match(readme, /- 2장 \(기록 1건\)/);
  assert.ok(!/SPEC-|PLAN-|stale|handoff/.test(readme));
  const status = await mirror.status(p);
  assert.equal(status.written, true);
  assert.equal(status.changed, false);
  assert.equal(status.path, '01_운영/기록');
  assert.ok(status.lastWrittenAt);
  assert.ok(root);
  // A month whose records are gone keeps only the marker line.
  for (const row of records.list(p, { from: '2026-09-01', to: '2026-09-30' }).records)
    records.patch(p, row.id, { date: '2026-10-03' }, '홍길동');
  await mirror.flush(p);
  assert.equal(
    await readFile(join(dir, '2026-09.jsonl'), 'utf8'),
    recordsCopyMarker('2026-09') + '\n',
  );
  assert.equal((await lines(join(dir, '2026-10.jsonl'))).length, 4);
});

test('changes start one write after the debounce; an unchanged project writes nothing', async (t) => {
  const { store, records, mirror, outputs, dir, p } = await setup(t, { delayMs: 60 });
  let writes = 0;
  const write = outputs.writeRecordsCopy.bind(outputs);
  outputs.writeRecordsCopy = (...args) => {
    writes++;
    return write(...args);
  };
  mirror.listen(store);
  records.add(p, { date: '2026-10-01', type: 'D', text: '첫 결정' }, { by: '홍길동' });
  await sleep(20);
  records.add(p, { date: '2026-10-02', type: 'E', text: '근거' }, { by: '홍길동' });
  await sleep(20);
  records.add(p, { date: '2026-10-03', type: 'K', text: '앎' }, { by: '홍길동' });
  assert.equal(mirror.pending(p), true);
  assert.equal(writes, 0, 'nothing within the request');
  await sleep(150);
  await mirror.idle();
  assert.equal(writes, 1);
  assert.equal((await lines(join(dir, '2026-10.jsonl'))).length, 4);
  await mirror.flush(p);
  assert.equal(writes, 1, 'the same month is not handed again');
  mirror.stop();
  records.add(p, { date: '2026-10-04', type: 'K', text: '멈춘 뒤' }, { by: '홍길동' });
  assert.equal(mirror.pending(p), false);
});

test('a copy changed in the folder is kept, shown as changed, taken in line by line, then rewritten', async (t) => {
  const { records, mirror, dir, p } = await setup(t);
  const roof = records.addPart(p, { name: '지붕' });
  const a = records.add(p, { date: '2026-10-01', type: 'D', text: '평지붕' }, { by: '홍길동' });
  const b = records.add(p, { date: '2026-10-02', type: 'E', text: '방수 검토' }, { by: '홍길동' });
  const c = records.add(p, { date: '2026-10-03', type: 'I', text: '옥상 정원' }, { by: '홍길동' });
  const d = records.add(p, { date: '2026-10-04', type: 'K', text: '옛 문장' }, { by: '홍길동' });
  records.correct(p, d.id, { text: '고친 문장' }, '홍길동');
  const e = records.add(p, { date: '2026-10-05', type: 'R', text: '주차 대수' }, { by: '홍길동' });
  await mirror.flush(p);
  const path = join(dir, '2026-10.jsonl');
  const rows = await lines(path);
  const byId = new Map(rows.slice(1).map((row) => [row.id, row]));
  const edited = [
    rows[0],
    { ...byId.get(a.id), state: 'dropped' },
    { ...byId.get(b.id), text: '방수 검토 — 2중 방수', parts: [roof.id, 'no-such-part'] },
    { ...byId.get(c.id), type: '?' },
    { ...byId.get(d.id), text: '정정된 기록을 또 고침' },
    byId.get(e.id),
    { date: '2026-10-06', type: 'D', text: '폴더에서 적은 결정', state: 'candidate' },
  ];
  await writeFile(
    path,
    edited.map((row) => JSON.stringify(row)).join('\n') + '\n이건 JSON이 아님\n',
    'utf8',
  );
  // A later write leaves the person's file as it is.
  records.add(p, { date: '2026-10-07', type: 'K', text: '그 뒤 기록' }, { by: '홍길동' });
  await mirror.flush(p);
  assert.match(await readFile(path, 'utf8'), /이건 JSON이 아님/);
  assert.equal((await mirror.status(p)).changed, true);

  const result = await mirror.importFolder(p, '김사람');
  assert.equal(result.changed, 2);
  assert.equal(result.added, 1);
  assert.deepEqual(
    result.skipped.map((skip) => [skip.file, skip.line, skip.reason]),
    [
      ['2026-10.jsonl', 4, 'INVALID_INPUT'],
      ['2026-10.jsonl', 5, 'RECORD_SUPERSEDED'],
      ['2026-10.jsonl', 8, 'json'],
    ],
  );
  assert.equal(records.get(p, a.id).state, 'dropped');
  assert.equal(records.get(p, a.id).updatedBy, '김사람');
  assert.equal(records.get(p, b.id).text, '방수 검토 — 2중 방수');
  assert.deepEqual(records.get(p, b.id).parts, [roof.id]);
  assert.equal(records.get(p, c.id).type, 'I');
  const added = records.list(p, { q: '폴더에서 적은 결정' }).records;
  assert.equal(added.length, 1);
  assert.equal(added[0].source, 'manual');
  assert.equal(added[0].state, 'candidate');
  assert.equal(added[0].by, '김사람');
  // The copy is VIDE's again: the DB as it is now, the later record included.
  const status = await mirror.status(p);
  assert.equal(status.changed, false);
  assert.equal(status.written, true);
  const after = await lines(path);
  assert.deepEqual(
    after.slice(1),
    records.list(p, { from: '2026-10-01', to: '2026-10-31' }).records,
  );
  assert.ok(after.some((row) => row.text === '그 뒤 기록'));
});

test('taking a copy in keeps what VIDE changed after the copy went stale (only the person’s fields)', async (t) => {
  const { records, mirror, dir, p } = await setup(t);
  const a = records.add(p, { date: '2026-10-01', type: 'D', text: '평지붕' }, { by: '홍길동' });
  const b = records.add(p, { date: '2026-10-02', type: 'E', text: '방수 검토' }, { by: '홍길동' });
  await mirror.flush(p);
  const path = join(dir, '2026-10.jsonl');
  const rows = await lines(path);
  // The person changes only b's text in the file …
  const edited = rows.map((row) => (row.id === b.id ? { ...row, text: '방수 검토 — 2중' } : row));
  await writeFile(path, edited.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  // … then VIDE sorts a out and rewords it; the stale copy is not written.
  records.setStates(p, [a.id], 'dropped', '홍길동');
  records.patch(p, a.id, { text: '평지붕(보류)' }, '홍길동');
  // b's state changes in VIDE too, while the person changed only its text.
  records.setStates(p, [b.id], 'dropped', '홍길동');
  await mirror.flush(p);
  assert.equal((await mirror.status(p)).changed, true);
  const result = await mirror.importFolder(p, '김사람');
  assert.deepEqual([result.changed, result.added, result.skipped], [1, 0, []]);
  assert.equal(records.get(p, a.id).state, 'dropped');
  assert.equal(records.get(p, a.id).text, '평지붕(보류)');
  assert.equal(records.get(p, b.id).text, '방수 검토 — 2중');
  assert.equal(records.get(p, b.id).state, 'dropped');
});

test('KakaoTalk and mail candidates stay out of the copy until sorted', async (t) => {
  const { records, mirror, dir, p } = await setup(t);
  const { added } = records.addMany(
    p,
    [
      { input: { date: '2026-10-01', text: '가나다: 지붕 언제 봐요?' }, sourceKey: 'kakao:x:1' },
      { input: { date: '2026-10-01', text: '회의 일정\n다음 주' }, sourceKey: 'mail:<m1@x>' },
    ],
    { by: '홍길동', state: 'candidate', source: 'kakao' },
  );
  records.add(p, { date: '2026-10-02', text: '직접 적은 후보' }, { by: 'ai' });
  await mirror.flush(p);
  const path = join(dir, '2026-10.jsonl');
  const texts = () => lines(path).then((rows) => rows.slice(1).map((row) => row.text));
  assert.deepEqual(await texts(), ['직접 적은 후보']);
  records.setStates(p, [added[0]], 'kept', '홍길동');
  await mirror.flush(p);
  assert.deepEqual(await texts(), ['가나다: 지붕 언제 봐요?', '직접 적은 후보']);
  assert.ok(!(await readFile(path, 'utf8')).includes('회의 일정'));
});

test('[VIDE 기록으로 다시 쓰기] writes over the person’s change; README too', async (t) => {
  const { records, mirror, dir, p } = await setup(t);
  records.add(p, { date: '2026-10-01', type: 'D', text: '평지붕' }, { by: '홍길동' });
  await mirror.flush(p);
  // The person keeps the first (marker) line and changes the rest.
  const mark = async (path) => (await readFile(path, 'utf8')).split('\n')[0];
  const jsonl = (await mark(join(dir, '2026-10.jsonl'))) + '\n{"text":"사람이 고침"}\n';
  const readme = (await mark(join(dir, 'README.md'))) + '\n# 사람이 고친 README\n';
  await writeFile(join(dir, '2026-10.jsonl'), jsonl, 'utf8');
  await writeFile(join(dir, 'README.md'), readme, 'utf8');
  records.add(p, { date: '2026-10-02', type: 'K', text: '그 뒤 기록' }, { by: '홍길동' });
  records.addPart(p, { name: '외벽' });
  await mirror.flush(p);
  assert.equal(await readFile(join(dir, 'README.md'), 'utf8'), readme);
  assert.equal(await readFile(join(dir, '2026-10.jsonl'), 'utf8'), jsonl);
  assert.equal((await mirror.status(p)).changed, true);
  assert.deepEqual(await mirror.rewrite(p), { written: true });
  assert.equal((await mirror.status(p)).changed, false);
  assert.deepEqual((await lines(join(dir, '2026-10.jsonl'))).slice(1), records.list(p).records);
  assert.match(await readFile(join(dir, 'README.md'), 'utf8'), /vide-copy:records:readme/);
});

test('a folder copied from another PC is not overwritten: its lines can be taken in', async (t) => {
  const { records, mirror, dir, p } = await setup(t);
  await mkdir(dir, { recursive: true });
  const elsewhere = {
    id: 'from-other-pc',
    date: '2026-10-01',
    time: null,
    type: 'D',
    text: '다른 PC에서 남긴 결정',
    state: 'kept',
    parts: [],
    chapter: null,
  };
  const path = join(dir, '2026-10.jsonl');
  const text = recordsCopyMarker('2026-10') + '\n' + JSON.stringify(elsewhere) + '\n';
  await writeFile(path, text, 'utf8');
  records.add(p, { date: '2026-10-02', type: 'K', text: '이 PC의 기록' }, { by: '홍길동' });
  await mirror.flush(p);
  assert.equal(await readFile(path, 'utf8'), text);
  assert.equal((await mirror.status(p)).changed, true);
  const result = await mirror.importFolder(p, '홍길동');
  assert.deepEqual([result.added, result.changed, result.skipped], [1, 0, []]);
  assert.deepEqual(
    (await lines(path)).slice(1).map((row) => row.text),
    ['다른 PC에서 남긴 결정', '이 PC의 기록'],
  );
});

test('no work folder: nothing written, the state says so, the POSTs are NO_WORKSPACE', async (t) => {
  const { records, mirror, p } = await setup(t, { folder: false });
  records.add(p, { date: '2026-10-01', type: 'D', text: '결정' }, { by: '홍길동' });
  assert.equal(await mirror.flush(p), false);
  assert.deepEqual(await mirror.status(p, { flush: true }), { written: false, changed: false });
  await assert.rejects(mirror.importFolder(p, '홍길동'), { code: 'NO_WORKSPACE' });
  await assert.rejects(mirror.rewrite(p), { code: 'NO_WORKSPACE' });
});

test('routes: GET …/records/mirror reads (also remotely); the POSTs are not for a remote session', async (t) => {
  const { store, records, mirror, dir, p } = await setup(t);
  records.add(p, { date: '2026-10-01', type: 'D', text: '평지붕' }, { by: '홍길동' });
  const call = async (path, method, remote = false) => {
    let sent;
    const handled = await recordsRoutes(new URL(`http://x/api/v1/projects/${p}/${path}`), method, {
      records,
      project: (id) => store.project(id),
      body: async () => ({}),
      send: (status, value) => (sent = { status, value }),
      deliver: () => {},
      remote,
      actor: () => '홍길동',
      mirror,
    });
    return { handled, ...sent };
  };
  // Remotely the state is read, never written first.
  const remote = await call('records/mirror', 'GET', true);
  assert.deepEqual(remote.value, { written: false, path: '01_운영/기록', changed: false });
  assert.equal(existsSync(join(dir, '2026-10.jsonl')), false);
  const local = await call('records/mirror', 'GET');
  assert.equal(local.value.written, true);
  assert.equal(existsSync(join(dir, '2026-10.jsonl')), true);
  for (const path of ['records/mirror/import', 'records/mirror/rewrite'])
    await assert.rejects(call(path, 'POST', true), { code: 'FORBIDDEN' });
  assert.deepEqual((await call('records/mirror/rewrite', 'POST')).value, { written: true });
  assert.deepEqual((await call('records/mirror/import', 'POST')).value, {
    changed: 0,
    added: 0,
    skipped: [],
  });
  await assert.rejects(call('records/mirror/other', 'POST'), { code: 'NOT_FOUND' });
});

test('raw imports stay out of the AI: the work-folder rule says so', () => {
  const rule = workFolderRule({ dirs: [], attachments: [], records: 'C:\\data\\projects\\p1' });
  assert.match(rule, /기록\/원문/);
  assert.match(rule, /'kakao' or 'mail'/);
  assert.equal(recordsReadme([], [], {}).includes('아직 부위가 없습니다.'), true);
});
