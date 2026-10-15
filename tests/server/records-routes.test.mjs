// 프로젝트 기록 routes (SPEC-17, ARCH-01 §5 「프로젝트 기록」, PLAN-53 T-321): over HTTP — 50 records in,
// read back with filters, chains, O/X, export and import, parts and milestones, refusals with
// their fields; a remote session reads only; an unknown project is 404; `undone` comes from the
// pointed request's executions. All sentences are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Records } from '../../src/core/records.ts';
import { recordsRoutes, requestUndone } from '../../src/server/records-routes.ts';
import { startServer } from '../../src/server/server.ts';

async function serve(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-http-'));
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
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* text answers */
    }
    return { status: response.status, json, text, type: response.headers.get('content-type') };
  };
  return { api };
}

test('over HTTP: 50 records in, filtered reads, chains, O/X, export and import', async (t) => {
  const { api } = await serve(t);
  const project = (await api('/projects', 'POST', { name: '기록 시험' })).json;
  const base = `/projects/${project.id}`;
  assert.deepEqual((await api(`${base}/records`)).json, {
    records: [],
    total: 0,
    counts: { state: {}, type: {}, source: {}, chapter: {} },
  });
  const wall = (await api(`${base}/parts`, 'POST', { name: '1층 벽', grp: '기존' })).json.part;
  const types = ['R', 'I', 'K', 'E', 'D'];
  const ids = [];
  for (let i = 0; i < 50; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    const made = await api(`${base}/records`, 'POST', {
      date: `2026-${month}-${day}`,
      type: types[i % 5],
      text: `기록 ${i} 번째 문장`,
      ...(i % 10 === 0 ? { parts: [wall.id], chapter: '보강' } : {}),
      ...(i > 0 && i % 5 === 0 ? { follows: [] } : {}),
    });
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json.record.state, 'kept');
    assert.equal(made.json.record.by, 'user');
    assert.equal(made.json.record.source, 'manual');
    ids.push(made.json.record.id);
  }
  const listed = (await api(`${base}/records`)).json;
  assert.equal(listed.total, 50);
  assert.equal(listed.records.length, 50);
  assert.deepEqual(listed.counts.type, { D: 10, E: 10, I: 10, K: 10, R: 10 });
  assert.deepEqual(listed.counts.chapter, { '': 45, 보강: 5 });
  // Filters.
  const byPart = (await api(`${base}/records?part=${wall.id}`)).json;
  assert.equal(byPart.total, 5);
  assert.equal(byPart.counts.type.R, 10, 'counts are over the whole list');
  assert.equal((await api(`${base}/records?type=R,D`)).json.total, 20);
  assert.equal((await api(`${base}/records?chapter=${encodeURIComponent('보강')}`)).json.total, 5);
  assert.equal((await api(`${base}/records?from=2026-02-01`)).json.total, 22);
  assert.equal(
    (await api(`${base}/records?q=${encodeURIComponent('기록 4')}&limit=3&offset=1`)).json.records
      .length,
    3,
  );
  assert.equal((await api(`${base}/records?type=Z`)).status, 400);
  assert.equal((await api(`${base}/records?limit=-1`)).status, 400);
  // A person names the type; '?' is refused.
  assert.equal(
    (await api(`${base}/records`, 'POST', { date: '2026-01-01', type: '?', text: 'x' })).status,
    400,
  );

  // Links and chains.
  assert.equal((await api(`${base}/records/${ids[0]}/links`, 'POST', { to: ids[1] })).status, 200);
  assert.equal((await api(`${base}/records/${ids[1]}/links`, 'POST', { to: ids[2] })).status, 200);
  const cycle = await api(`${base}/records/${ids[2]}/links`, 'POST', { to: ids[0] });
  assert.deepEqual([cycle.status, cycle.json.code], [409, 'RECORD_LINK_CYCLE']);
  const chains = (await api(`${base}/records/chains?state=kept`)).json.chains;
  assert.deepEqual(chains, [{ root: ids[0], ids: [ids[0], ids[1], ids[2]] }]);
  const one = (await api(`${base}/records/${ids[1]}`)).json.record;
  assert.deepEqual([one.follows, one.followedBy], [[ids[2]], [ids[0]]]);
  assert.equal((await api(`${base}/records/${ids[1]}/links/${ids[2]}`, 'DELETE')).status, 200);
  assert.deepEqual((await api(`${base}/records/${ids[1]}`)).json.record.follows, []);

  // Edit, correct, superseded.
  const patched = await api(`${base}/records/${ids[3]}`, 'PATCH', { text: '고친 문장' });
  assert.deepEqual(
    [patched.status, patched.json.record.text, patched.json.record.updatedBy],
    [200, '고친 문장', 'user'],
  );
  assert.equal((await api(`${base}/records/${ids[3]}`, 'PATCH', { type: '?' })).status, 400);
  const corrected = await api(`${base}/records/${ids[3]}/correct`, 'POST', { text: '정정 문장' });
  assert.equal(corrected.status, 200);
  const superseded = await api(`${base}/records/${ids[3]}`, 'PATCH', { text: '또' });
  assert.deepEqual([superseded.status, superseded.json.code], [409, 'RECORD_SUPERSEDED']);
  assert.equal(
    (await api(`${base}/records/${ids[3]}`)).json.record.supersededBy,
    corrected.json.record.id,
  );

  // O/X one and many; export and import.
  assert.equal(
    (await api(`${base}/records/${ids[4]}/state`, 'POST', { state: 'dropped' })).json.record.state,
    'dropped',
  );
  const bulk = await api(`${base}/records/state`, 'POST', {
    ids: ids.slice(10, 15),
    state: 'candidate',
  });
  assert.deepEqual(bulk.json, { changed: 5 });
  // Ten E records plus the correction of one of them (it keeps the type).
  const marks = (await api(`${base}/records/export?format=marks&type=E`)).json;
  assert.equal(marks.ids.length, 11);
  assert.match(marks.marks, /^[ox.]{11}$/);
  const jsonl = await api(`${base}/records/export?format=jsonl&state=dropped`);
  assert.match(jsonl.type, /^text\/plain/);
  assert.equal(JSON.parse(jsonl.text.trim()).id, ids[4]);
  const mismatch = await api(`${base}/records/import`, 'POST', { marks: 'oo', ids: marks.ids });
  assert.deepEqual(mismatch.json.code, 'RECORD_MARKS_MISMATCH');
  assert.deepEqual([mismatch.status, mismatch.json.expected, mismatch.json.got], [409, 11, 2]);
  const imported = await api(`${base}/records/import`, 'POST', {
    marks: 'x'.repeat(11),
    ids: marks.ids,
  });
  assert.equal(imported.status, 200);
  assert.equal(
    (await api(`${base}/records/export?format=marks&type=E`)).json.marks,
    'x'.repeat(11),
  );

  // Parts and milestones.
  const put = await api(`${base}/parts/${wall.id}`, 'PUT', { seenAt: '2026-02-01' });
  assert.equal(put.json.part.seenAt, '2026-02-01');
  assert.equal((await api(`${base}/parts/${wall.id}`, 'DELETE')).status, 200);
  assert.equal((await api(`${base}/records?part=${wall.id}`)).json.total, 0);
  assert.equal((await api(`${base}/records`)).json.total, 51, 'records stay');
  assert.equal((await api(`${base}/parts/${wall.id}`, 'DELETE')).status, 404);
  const milestone = (await api(`${base}/milestones`, 'POST', { label: '착공', date: '2026-11-01' }))
    .json.milestone;
  assert.deepEqual((await api(`${base}/milestones`)).json.milestones, [milestone]);
  assert.equal((await api(`${base}/milestones/${milestone.id}`, 'DELETE')).status, 200);
  assert.equal((await api(`${base}/milestones/${milestone.id}`, 'DELETE')).status, 404);
  // The engine wires the 끊김 check (T-325): every part is listed.
  assert.equal((await api(`${base}/parts/status`)).status, 200);

  // Unknown project and record.
  assert.equal((await api('/projects/none/records')).status, 404);
  assert.equal((await api(`${base}/records/none`)).json.code, 'RECORD_NOT_FOUND');
  assert.equal((await api(`${base}/records/none`)).status, 404);
});

test('a remote session reads only; duplicate sources answer with the first id', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('원격');
  const records = new Records(store, { undoneResolver: requestUndone(store) });
  const call = async (path, method, data, { remote = false, extra = {} } = {}) => {
    let sent;
    const handled = await recordsRoutes(
      new URL(`http://x/api/v1/projects/${project.id}/${path}`),
      method,
      {
        records,
        project: (id) => store.project(id),
        body: async () => data ?? {},
        send: (status, value) => (sent = { status, value }),
        deliver: (status, type, value) => (sent = { status, type, value }),
        remote,
        actor: () => '홍길동',
        ...extra,
      },
    );
    return { handled, ...sent };
  };
  const made = await call('records', 'POST', { date: '2026-10-01', type: 'D', text: '결정' });
  assert.equal(made.value.record.by, '홍길동');
  for (const [path, method, data] of [
    ['records', 'POST', { date: '2026-10-01', type: 'D', text: 'x' }],
    [`records/${made.value.record.id}`, 'PATCH', { text: 'y' }],
    [`records/${made.value.record.id}/state`, 'POST', { state: 'dropped' }],
    ['records/state', 'POST', { ids: [], state: 'kept' }],
    ['parts', 'POST', { name: 'x' }],
    ['milestones', 'POST', { label: 'x', date: '2026-01-01' }],
  ])
    await assert.rejects(call(path, method, data, { remote: true }), { code: 'FORBIDDEN' });
  const read = await call('records', 'GET', undefined, { remote: true });
  assert.equal(read.value.total, 1);
  // Other paths are not this module's.
  assert.equal((await call('objects/o1', 'GET')).handled, false);
  assert.equal((await call('objects/o1/records', 'GET')).handled, false);
  const withDeps = await call('objects/o1/records?linkId=L1', 'GET', undefined, {
    extra: {
      objectRecords: async (p, o, l) => ({ records: [], via: { p, o, l } }),
      partsStatus: async () => ({ parts: [] }),
    },
  });
  assert.deepEqual(withDeps.value.via, { p: project.id, o: 'o1', l: 'L1' });
  assert.deepEqual(
    (
      await call('parts/status', 'GET', undefined, {
        extra: { partsStatus: async () => ({ parts: [] }) },
      })
    ).value,
    { parts: [] },
  );
  // Duplicate source (an automatic candidate path, through the store).
  const first = records.add(
    project.id,
    { text: '요청' },
    { by: 'ai', source: 'request', sourceKey: 'request:r1' },
  );
  assert.throws(
    () =>
      records.add(
        project.id,
        { text: '요청' },
        { by: 'ai', source: 'request', sourceKey: 'request:r1' },
      ),
    (error) => error.code === 'RECORD_SOURCE_DUPLICATE' && error.details.existingId === first.id,
  );
  await assert.rejects(
    recordsRoutes(new URL('http://x/api/v1/projects/nope/records'), 'GET', {
      records,
      project: (id) => store.project(id),
      body: async () => ({}),
      send: () => undefined,
      deliver: () => undefined,
      remote: false,
    }),
    { code: 'NOT_FOUND' },
  );
});

test('undone: every execution of the pointed request is undone', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-records-undone-'));
  const store = new Store(join(directory, 'data.sqlite'));
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = store.createProject('되돌림');
  const insert = store
    .db(project.id)
    .prepare(
      "INSERT INTO workspace_requests(id,projectId,input,state,result,createdAt) VALUES(?,?,'{}','succeeded',?,'2026-10-15T00:00:00Z')",
    );
  insert.run(
    'r-undone',
    project.id,
    JSON.stringify({ executions: [{ state: 'undone' }, { state: 'undone' }] }),
  );
  insert.run(
    'r-mixed',
    project.id,
    JSON.stringify({ executions: [{ state: 'undone' }, { state: 'applied' }] }),
  );
  insert.run('r-none', project.id, JSON.stringify({ text: 'read only' }));
  const undone = requestUndone(store);
  assert.deepEqual(
    ['r-undone', 'r-mixed', 'r-none', 'r-missing'].map((id) => undone(project.id, id)),
    [true, false, false, false],
  );
  const records = new Records(store, { undoneResolver: undone });
  const row = records.add(
    project.id,
    { text: '되돌린 요청', attachments: { requestId: 'r-undone' } },
    { by: 'ai', source: 'request', sourceKey: 'request:r-undone' },
  );
  assert.equal(row.undone, true);
});
