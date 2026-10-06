import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { ProjectFolders } from '../../src/core/project-folders.ts';
import { startServer } from '../../src/server/server.ts';
import { WorkFolderGate, readOnlySqlite } from '../../src/server/project-files.ts';
import { workFolderRule } from '../../src/ai/agent-connection.ts';

// One DB per project (ADR-032, PLAN-28 T-124 phase 2): app.sqlite for what no project owns and
// projects/<id>/project.sqlite for each project's rows; the old vide.sqlite is split once at start.

const input = (id) => ({
  id,
  body: 'Sync',
  permission: 'review',
  provider: 'claude-cli',
  pins: [],
  sketches: [],
  files: [],
  host: 'rhino',
});

// Removed after every test has closed its engine and stores (a hook per test would run first).
const made = [];
after(() => Promise.all(made.map((directory) => rm(directory, { recursive: true, force: true }))));
async function folder() {
  const directory = await mkdtemp(join(tmpdir(), 'vide-project-db-'));
  made.push(directory);
  return directory;
}
async function open(directory, options = {}) {
  const app = await startServer({ filename: join(directory, 'vide.sqlite'), ...options });
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
  return { app, api };
}
/** The engine's diagnostics lines of an event. */
const logged = (directory, event) =>
  readdirSync(join(directory, 'logs'))
    .flatMap((name) => readFileSync(join(directory, 'logs', name), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((line) => line.event === event);
/** An old single-DB data folder with two projects and their requests. */
function oldFolder(directory) {
  const store = new Store(join(directory, 'vide.sqlite'));
  const workspace = new Workspace(store);
  const a = store.createProject('가');
  const b = store.createProject('나');
  workspace.submit(a.id, input('a-1'));
  workspace.submit(a.id, input('a-2'));
  workspace.submit(b.id, input('b-1'));
  store.close();
  return { a, b };
}

test('a new data folder starts split: app.sqlite and one project.sqlite per project', async (t) => {
  const directory = await folder(t);
  const { app, api } = await open(directory);
  t.after(() => app.close());
  assert.equal(app.store.layout, 'split');
  const project = (await api('/projects', 'POST', { name: '새 프로젝트' })).body;
  assert.ok(existsSync(join(directory, 'app.sqlite')));
  assert.ok(existsSync(join(directory, 'projects', project.id, 'project.sqlite')));
  assert.equal(existsSync(join(directory, 'vide.sqlite')), false);
  // Its rows are in its own DB; the shared DB keeps only the project's name.
  new Workspace(app.store).submit(project.id, input('r-1'));
  assert.equal(
    app.store.db(project.id).prepare('SELECT count(*) AS n FROM workspace_requests').get().n,
    1,
  );
  assert.equal(app.store.app.prepare('SELECT count(*) AS n FROM workspace_requests').get().n, 0);
  assert.equal(app.store.projectOfRequest('r-1'), project.id);
  assert.equal((await api(`/projects/${project.id}/requests`)).body.length, 1);
});

test('an old vide.sqlite is split at start and the same requests are served', async (t) => {
  const directory = await folder(t);
  const { a, b } = oldFolder(directory);
  let { app, api } = await open(directory);
  assert.equal(app.store.layout, 'split');
  assert.ok(existsSync(join(directory, 'vide.sqlite.migrated')));
  assert.equal(existsSync(join(directory, 'vide.sqlite')), false);
  for (const id of [a.id, b.id])
    assert.ok(existsSync(join(directory, 'projects', id, 'project.sqlite')), id);
  const ids = async (project) =>
    (await api(`/projects/${project.id}/requests`)).body.map((row) => row.id).sort();
  assert.deepEqual(await ids(a), ['a-1', 'a-2']);
  assert.deepEqual(await ids(b), ['b-1']);
  const [line] = logged(directory, 'db-split');
  assert.equal(line.projects, 2);
  assert.equal(line.layout, 'split');
  // A second start opens the split folder as it is.
  await app.close();
  ({ app, api } = await open(directory));
  t.after(() => app.close());
  assert.equal(app.store.layout, 'split');
  assert.deepEqual(await ids(a), ['a-1', 'a-2']);
  assert.equal(logged(directory, 'db-split').length, 1);
});

test('a split that fails leaves the engine on the old DB, as before, and logs why', async (t) => {
  const directory = await folder(t);
  const { a } = oldFolder(directory);
  const { app, api } = await open(directory, {
    storeSplit: async () => {
      throw Object.assign(new Error('SPLIT_VERIFY_FAILED: synthetic'), {
        code: 'SPLIT_VERIFY_FAILED',
      });
    },
  });
  t.after(() => app.close());
  assert.equal(app.store.layout, 'single');
  assert.equal(existsSync(join(directory, 'app.sqlite')), false);
  assert.ok(existsSync(join(directory, 'vide.sqlite')));
  assert.equal((await api(`/projects/${a.id}/requests`)).body.length, 2);
  // Work goes on in the old DB.
  const project = (await api('/projects', 'POST', { name: '그대로' })).body;
  assert.equal(existsSync(join(directory, 'projects', project.id)), false);
  new Workspace(app.store).submit(project.id, input('c-1'));
  assert.equal(app.store.projectOfRequest('c-1'), project.id);
  const [line] = logged(directory, 'db-split-failed');
  assert.equal(line.code, 'SPLIT_VERIFY_FAILED');
  assert.equal(line.layout, 'single');
});

test('checks across projects hold with one DB per project', async (t) => {
  const directory = await folder(t);
  const store = new Store({ directory });
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const a = store.createProject('A');
  const b = store.createProject('B');
  assert.notEqual(store.db(a.id), store.db(b.id));

  // A request id is unique across projects (the request index in app.sqlite).
  workspace.submit(a.id, input('same'));
  assert.equal(workspace.submit(a.id, input('same')).created, false);
  assert.throws(() => workspace.submit(b.id, input('same')), { code: 'REVISION_CONFLICT' });
  assert.equal(store.projectOfRequest('same'), a.id);
  // A row written straight into a project DB is still found by its id, and indexed then.
  store
    .db(b.id)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run('direct', b.id, JSON.stringify(input('direct')), 'succeeded', null, '2026-10-06');
  assert.equal(store.projectOfRequest('direct'), b.id);
  assert.equal(
    store.app.prepare('SELECT projectId FROM request_index WHERE id=?').get('direct').projectId,
    b.id,
  );

  // One open document is connected to one project at a time.
  const document = { host: 'rhino', instanceId: 'rhino-1', documentId: 'doc-1' };
  const first = store.registerConnection(a.id, document);
  assert.throws(() => store.registerConnection(b.id, document), {
    code: 'DOCUMENT_ALREADY_CONNECTED',
  });
  assert.equal(store.connectedDocument('rhino', 'rhino-1', 'doc-1').projectId, a.id);

  // A write whose outcome is unknown in project A holds the same document in project B.
  const run = store.createRun(a.id, { goal: 'g', targets: [first.id] });
  const command = {
    id: 'cmd-1',
    runId: run.id,
    connectionId: first.id,
    revision: run.revision,
    kind: 'createCandidate',
    payload: {},
  };
  store.enqueue(a.id, command);
  assert.equal(store.lease(first.id).state, 'running');
  store.disconnect(first.id);
  const second = store.registerConnection(b.id, document);
  assert.equal(store.hasUncertainWrite(second.id), true);
  // A command id is unique across projects.
  const other = store.createRun(b.id, { goal: 'g', targets: [second.id] });
  assert.throws(
    () =>
      store.enqueue(b.id, {
        ...command,
        runId: other.id,
        connectionId: second.id,
        revision: other.revision,
      }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  assert.equal(store.enqueue(a.id, command).id, 'cmd-1');

  // The index survives a restart (it is rebuilt from the project DBs).
  store.close();
  const again = new Store({ directory });
  t.after(() => again.close());
  assert.equal(again.projectOfRequest('same'), a.id);
  assert.equal(again.projectOfRequest('direct'), b.id);
  assert.equal(again.projectOfRequest('none'), undefined);
});

test('removing a project closes its DB and removes its data folder', async (t) => {
  const directory = await folder(t);
  const store = new Store({ directory });
  t.after(() => store.close());
  const workspace = new Workspace(store);
  const gone = store.createProject('지움');
  const kept = store.createProject('남김');
  workspace.submit(gone.id, input('g-1'));
  const db = store.db(gone.id);
  store.db(gone.id).prepare("UPDATE workspace_requests SET state='running'").run();
  assert.throws(() => store.deleteProject(gone.id), { code: 'PROJECT_BUSY' });
  store.db(gone.id).prepare("UPDATE workspace_requests SET state='succeeded'").run();
  store.deleteProject(gone.id);
  assert.equal(db.isOpen, false);
  assert.equal(existsSync(join(directory, 'projects', gone.id)), false);
  assert.ok(existsSync(join(directory, 'projects', kept.id, 'project.sqlite')));
  assert.throws(() => store.db(gone.id), { code: 'NOT_FOUND' });
  assert.equal(store.projectOfRequest('g-1'), undefined);
  assert.deepEqual(
    store.listProjects().map((project) => project.id),
    [kept.id],
  );
});

test("an AI turn reads its own project's records without a question and nothing else of VIDE", async (t) => {
  const root = await folder(t);
  const data = join(root, 'data');
  const work = join(root, 'work');
  const own = join(data, 'projects', 'p1');
  const otherProject = join(data, 'projects', 'p2');
  for (const path of [own, otherProject, work]) await mkdir(path, { recursive: true });
  for (const path of [
    join(data, 'app.sqlite'),
    join(own, 'project.sqlite'),
    join(own, 'knowledge.sqlite'),
    join(otherProject, 'project.sqlite'),
    join(data, 'launch.json'),
  ])
    await writeFile(path, 'db');
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.ensureProject('p1', '합성');
  const folders = new ProjectFolders(store);
  folders.add('p1', work, 'project');
  const asked = [];
  const used = [];
  const gate = (context = { dataDirectory: data, home: root }) =>
    new WorkFolderGate({
      folders,
      projectId: 'p1',
      context,
      ask: async (...args) => {
        asked.push(args);
        return 'once';
      },
      onUse: (text) => used.push(text),
    });
  const signal = new AbortController().signal;
  const decide = (request, g = gate()) => g.decide(request, signal);
  const file = join(own, 'project.sqlite');
  const node = (options, sql = 'SELECT count(*) AS n FROM workspace_requests') =>
    `node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync('${file.replaceAll('\\', '/')}'${options}); console.log(db.prepare('${sql}').get())"`;

  for (const request of [
    { tool: 'Read', input: { file_path: file } },
    { tool: 'Read', input: { file_path: join(own, 'knowledge.sqlite') } },
    { tool: 'Grep', input: { pattern: 'x', path: own } },
    { tool: 'Bash', input: { command: node(', { readOnly: true }') } },
    { tool: 'Bash', input: { command: `sqlite3 -readonly "${file}" "SELECT 1"` } },
  ])
    assert.deepEqual(await decide(request), { allow: true }, JSON.stringify(request));
  assert.ok(used.some((line) => line.startsWith('프로젝트 기록 읽기')));

  // Never written, never changed by a command, never another project or the shared DB: no question.
  for (const request of [
    { tool: 'Write', input: { file_path: join(own, 'note.txt'), content: 'x' } },
    { tool: 'Edit', input: { file_path: file } },
    { tool: 'Bash', input: { command: node('') } },
    { tool: 'Bash', input: { command: node(', { readOnly: true }', 'DELETE FROM agenda_items') } },
    { tool: 'Bash', input: { command: `del "${file}"` } },
    { tool: 'Read', input: { file_path: join(otherProject, 'project.sqlite') } },
    { tool: 'Read', input: { file_path: join(data, 'app.sqlite') } },
    { tool: 'Read', input: { file_path: join(data, 'launch.json') } },
  ]) {
    const answer = await decide(request);
    assert.equal(answer.allow, false, JSON.stringify(request));
    assert.match(answer.message, /FILE_FORBIDDEN/);
  }
  assert.equal(asked.length, 0);

  // Before the split (one vide.sqlite), the data folder stays closed as a whole.
  await rm(join(data, 'app.sqlite'));
  assert.equal((await decide({ tool: 'Read', input: { file_path: file } })).allow, false);
  assert.equal(asked.length, 0);
});

test('read-only SQLite commands and the turn rule that names the records folder', () => {
  const f = 'C:/data/projects/p1/project.sqlite';
  assert.equal(
    readOnlySqlite(`node -e "new DatabaseSync('${f}', { readOnly: true }).prepare('SELECT 1')"`),
    true,
  );
  assert.equal(readOnlySqlite(`sqlite3.exe -readonly ${f} "SELECT createdAt FROM x"`), true);
  assert.equal(readOnlySqlite(`sqlite3 "file:${f}?mode=ro" "SELECT 1"`), true);
  assert.equal(readOnlySqlite(`node -e "new DatabaseSync('${f}')"`), false);
  // Two opens, one of them writable.
  assert.equal(
    readOnlySqlite(
      `node -e "new DatabaseSync('${f}', { readOnly: true }); new DatabaseSync('${f}')"`,
    ),
    false,
  );
  for (const change of ['UPDATE x SET a=1', 'VACUUM', 'PRAGMA journal_mode = DELETE', '.output y'])
    assert.equal(readOnlySqlite(`sqlite3 -readonly ${f} "${change}"`), false, change);
  assert.equal(readOnlySqlite(`type ${f}`), false);
  const rule = workFolderRule({ dirs: [], attachments: [], records: 'C:\\data\\projects\\p1' });
  assert.match(rule, /own records are readable without a question/);
  assert.match(rule, /VIDE's other data are never read/);
});
