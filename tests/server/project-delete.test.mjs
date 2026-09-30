import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';

// Deleting a project in the app (the picker's 삭제 after its confirmation) removes the project and
// everything it owns, so the plugins' Link dialog (GET /api/v1/projects) no longer offers it. Files
// VIDE made in its data folder go; the user's own files and other projects' data stay.

async function open(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-project-delete-'));
  if (options.device)
    await writeFile(join(directory, 'remote-host.json'), JSON.stringify(options.device));
  const app = await startServer({
    filename: join(directory, 'workspace.sqlite'),
    remoteOptions: options.remoteOptions,
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  assert.equal(login.status, 200);
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const reply = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: reply.status, body: await reply.json() };
  };
  return { app, api, directory };
}

const input = (id, extra = {}) =>
  JSON.stringify({
    id,
    body: 'Sync',
    permission: 'review',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
    ...extra,
  });

/** Tables holding a project's rows, with how to count one project's share. */
const owned = {
  workspace_requests: 'projectId=?',
  hidden_requests: 'projectId=?',
  document_links: 'projectId=?',
  conversations: 'projectId=?',
  provider_sessions: 'conversationId IN (SELECT id FROM conversations WHERE projectId=?)',
  ledger_items: 'conversationId IN (SELECT id FROM conversations WHERE projectId=?)',
  jig_instances: 'projectId=?',
  jig_param_log: "instanceId='ji-a'",
  jig_runs: "instanceId='ji-a'",
  jig_reads: "instanceId='ji-a'",
  jig_bakes: "instanceId='ji-a'",
  jig_drafts: 'projectId=?',
  project_jigs: 'projectId=?',
  knowledge_reviews: 'projectId=?',
  knowledge_source_rules: 'projectId=?',
  project_roots: 'projectId=?',
  review_snapshots: 'projectId=?',
  review_notes: 'projectId=?',
  shared_feedback: 'projectId=?',
  publication_exports: 'projectId=?',
  table_views: 'projectId=?',
  connections: 'projectId=?',
  inputs: 'projectId=?',
  runs: 'projectId=?',
  commands: 'projectId=?',
  approvals: 'projectId=?',
};
const count = (db, table, projectId) => {
  const where = owned[table];
  const statement = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
  return Number((where.includes('?') ? statement.get(projectId) : statement.get()).n);
};

function seed(db, a, data, outside) {
  const t = '2026-09-30T00:00:00.000Z';
  const run = (sql, ...values) => db.prepare(sql).run(...values);
  run(
    'INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)',
    'r-a1',
    a,
    input('r-a1', { conversationId: 'c-a' }),
    'succeeded',
    JSON.stringify({
      workerDirectory: join(data, 'work', 'r-a1'),
      filename: join(outside, 'user.3dm'),
    }),
    t,
  );
  run(
    'INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)',
    'r-a2',
    a,
    input('r-a2'),
    'succeeded',
    JSON.stringify({ filename: join(data, 'shared', 'model.3dm') }),
    t,
  );
  run('INSERT INTO hidden_requests VALUES(?,?,?)', a, 'r-a2', t);
  run(
    'INSERT INTO document_links VALUES(?,?,?,?,?,?,?,?,?,?)',
    'l-a',
    a,
    'rhino',
    'user.3dm',
    join(outside, 'user.3dm'),
    'inst',
    1,
    0,
    t,
    t,
  );
  run(
    `INSERT INTO conversations(id,projectId,kind,title,provider,state,createdAt,updatedAt)
     VALUES('c-a',?,'work','대화','claude-cli','open',?,?)`,
    a,
    t,
    t,
  );
  run(
    `INSERT INTO provider_sessions(conversationId,provider,accountProfileId,sessionId,promptMode,cliVersion,state)
     VALUES('c-a','claude-cli','default','s1','append','1','active')`,
  );
  run(`INSERT INTO ledger_items VALUES('li-a','c-a','answer','{}','r-a1',?,NULL)`, t);
  run(
    `INSERT INTO jig_instances VALUES('ji-a',?,'project/x','0.1.0','지그','{}','open',?,?)`,
    a,
    t,
    t,
  );
  run(`INSERT INTO jig_param_log VALUES('ji-a',1,'k',NULL,'1','user',NULL,NULL,?)`, t);
  run(`INSERT INTO jig_runs VALUES('ji-a','step','h',NULL,1,'ok',NULL,?)`, t);
  run(`INSERT INTO jig_reads VALUES('rd-a','ji-a','l-a','rev','[]',0,'p','ref',?)`, t);
  run(`INSERT INTO jig_bakes VALUES('bk-a','ji-a','b','l-a','r-a1','run','[]',NULL,NULL)`);
  run(
    `INSERT INTO jig_drafts VALUES('d-a',?,'c-a',?,'open',?,?)`,
    a,
    join(data, 'jig-drafts', 'd-a'),
    t,
    t,
  );
  run(`INSERT INTO project_jigs VALUES(?,'project/x','0.1.0',?)`, a, t);
  run(`INSERT INTO knowledge_reviews VALUES(?,1,'confirmed',NULL,NULL,NULL,'user',?)`, a, t);
  run(`INSERT INTO knowledge_source_rules VALUES(?,'*.tmp',NULL)`, a);
  run('INSERT INTO project_roots VALUES(?,?,?)', a, join(outside, 'kdb'), join(outside, 'kdb'));
  run(`INSERT INTO review_snapshots VALUES('rv-a',?,'r-a1','검토',?,'{}')`, a, t);
  run(`INSERT INTO review_notes VALUES('rn-a',?,'rv-a','r-a1',NULL,'메모',?)`, a, t);
  run(`INSERT INTO shared_feedback VALUES('sf-a',?,'r-a1','ident-a','{}',?)`, a, t);
  run(`INSERT INTO publication_exports VALUES('pe-a',?,'r-a1','m','s')`, a);
  run(`INSERT INTO table_views VALUES('tv-a',?,'보기','{}',1,?)`, a, t);
  run(`INSERT INTO connections VALUES('cn-a',?,'rhino','i','d',1)`, a);
  run(`INSERT INTO inputs VALUES('in-a',?,1,'{}')`, a);
  run(`INSERT INTO runs VALUES('ru-a',?,1,'goal','[]')`, a);
  run(
    `INSERT INTO commands(id,projectId,runId,connectionId,revision,kind,payload,hash,state)
     VALUES('cm-a',?,'ru-a','cn-a',1,'k','{}','h','done')`,
    a,
  );
  run(`INSERT INTO approvals VALUES('cm-a',?,'h')`, a);
}

test('deleting a project removes it, its rows and its files in the data folder only', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'vide-project-delete-user-'));
  const { app, api, directory } = await open();
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  // Two projects with the same name: the old one is deleted, the new one stays.
  const a = (await api('/projects', 'POST', { name: '나진상가' })).body;
  const b = (await api('/projects', 'POST', { name: '나진상가' })).body;
  const db = app.store.db;
  seed(db, a.id, directory, outside);
  db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'r-b1',
    b.id,
    input('r-b1'),
    'succeeded',
    JSON.stringify({ filename: join(directory, 'shared', 'model.3dm') }),
    '2026-09-30T00:00:00.000Z',
  );
  const files = {
    work: join(directory, 'work', 'r-a1', 'out.3dm'),
    upload: join(directory, 'models', a.id, 'r-a1.upload.3dm'),
    structure: join(directory, 'structure', `${a.id}.json`),
    instructions: join(directory, 'ai-instructions', `${a.id}.json`),
    knowledge: join(directory, 'knowledge', `${a.id}.sqlite`),
    draft: join(directory, 'jig-drafts', 'd-a', 'jig.json'),
  };
  const kept = {
    user: join(outside, 'user.3dm'),
    kdb: join(outside, 'kdb', 'facts.md'),
    shared: join(directory, 'shared', 'model.3dm'),
    otherStructure: join(directory, 'structure', `${b.id}.json`),
  };
  for (const path of [...Object.values(files), ...Object.values(kept)]) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'x');
  }
  for (const table of Object.keys(owned)) assert.ok(count(db, table, a.id) > 0, table);

  const deleted = await api(`/projects/${a.id}`, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.id, a.id);

  // The Link dialog's list: only the new project.
  assert.deepEqual(
    (await api('/projects')).body.map((project) => project.id),
    [b.id],
  );
  for (const table of Object.keys(owned)) assert.equal(count(db, table, a.id), 0, table);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  for (const [name, path] of Object.entries(files)) assert.equal(existsSync(path), false, name);
  for (const [name, path] of Object.entries(kept)) assert.equal(existsSync(path), true, name);
  assert.equal((await api(`/projects/${b.id}/requests`)).body.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'removed-projects.json'), 'utf8')), [
    a.id,
  ]);
  // Gone: a second delete and its routes answer NOT_FOUND.
  assert.equal((await api(`/projects/${a.id}`, 'DELETE')).body.code, 'NOT_FOUND');
  assert.equal((await api(`/projects/${a.id}/requests`)).body.code, 'NOT_FOUND');

  // A project with work in progress is not deleted.
  const busy = (await api('/projects', 'POST', { name: '진행 중' })).body;
  db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    'r-c1',
    busy.id,
    input('r-c1'),
    'running',
    null,
    '2026-09-30T00:00:00.000Z',
  );
  assert.equal((await api(`/projects/${busy.id}`, 'DELETE')).body.code, 'PROJECT_BUSY');
  assert.ok((await api('/projects')).body.some((project) => project.id === busy.id));
});

test('the account site list neither brings back a deleted project nor keeps a site-deleted one listed', async (t) => {
  const calls = [];
  let cloud = [];
  const { app, api, directory } = await open({
    device: {
      workerOrigin: 'https://sharing.example',
      hostId: '356ff01d-b586-460c-8e2b-8c9f3c083e96',
      secret: 'a'.repeat(64),
      name: 'Studio PC',
      remote: false,
    },
    remoteOptions: {
      heartbeatMs: 3_600_000,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), method: init.method });
        if (String(url).endsWith('/heartbeat'))
          return new Response(JSON.stringify({ ok: true, projects: cloud }), { status: 200 });
        return new Response('{}', { status: 200 });
      },
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const removed = (await api('/projects', 'POST', { name: '나진상가' })).body;
  const onSite = (await api('/projects', 'POST', { name: '사이트에서 삭제' })).body;
  const current = (await api('/projects', 'POST', { name: '나진상가' })).body;
  assert.equal((await api(`/projects/${removed.id}`, 'DELETE')).status, 200);
  // The account list is told after the reply.
  const told = () =>
    calls.some(
      (call) =>
        call.method === 'DELETE' &&
        call.url === `https://sharing.example/api/hosts/device/projects/${removed.id}`,
    );
  for (let i = 0; i < 100 && !told(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(told());
  // A site that has not yet marked it deleted still lists it; the other one was deleted there.
  cloud = [
    { id: removed.id, name: '나진상가', deleted: false },
    { id: onSite.id, name: '사이트에서 삭제', deleted: true },
    { id: current.id, name: '나진상가', deleted: false },
  ];
  await app.remoteAccess.heartbeat();
  assert.deepEqual(
    (await api('/projects')).body.map((project) => project.id),
    [current.id],
  );
  assert.throws(() => app.store.project(removed.id), { code: 'NOT_FOUND' });
  // Deleted on the site: hidden here, its data kept on this PC.
  assert.equal(app.store.project(onSite.id).name, '사이트에서 삭제');
});
