import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/core/store.ts';
import {
  baselineSchema,
  migrateDatabase,
  migrations,
  schemaVersion,
} from '../../src/core/migrations.ts';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'model.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1);' +
      baselineSchema,
  );
  db.exec(
    `INSERT INTO projects VALUES('p','existing'); INSERT INTO workspace_requests VALUES('w','p','{}','draft',NULL,'today'); INSERT INTO publication_exports VALUES('e','p','w','manifest','source');`,
  );
  return { file, db };
}
test('migration backs up committed WAL data and preserves records and relationships on repeated open', (t) => {
  const { file, db } = fixture(t);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec("UPDATE projects SET name='committed WAL'");
  migrateDatabase(db, file, 1);
  db.close();
  const backup = readdirSync(file + '.backups');
  assert.equal(backup.length, 1);
  const copy = new DatabaseSync(join(file + '.backups', backup[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 1);
  assert.equal(copy.prepare('SELECT name FROM projects').get().name, 'committed WAL');
  copy.close();
  for (let i = 0; i < 2; i++) {
    const store = new Store(file);
    assert.equal(
      store.db.prepare('SELECT version FROM schema_version').get().version,
      schemaVersion,
    );
    assert.equal(
      store.db.prepare('SELECT requestId FROM publication_exports').get().requestId,
      'w',
    );
    store.close();
  }
  assert.equal(readdirSync(file + '.backups').length, 1);
});
test('partial migration rolls back schema and data and retains a readable backup', (t) => {
  const { file, db } = fixture(t);
  assert.throws(
    () =>
      migrateDatabase(db, file, 1, [
        {
          version: 2,
          sql: "UPDATE projects SET name='changed'; CREATE TABLE partial(id); SELECT * FROM missing_table;",
        },
      ]),
    { code: 'DATABASE_MIGRATION_FAILED' },
  );
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 1);
  assert.equal(db.prepare('SELECT name FROM projects').get().name, 'existing');
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
  db.close();
  assert.equal(readdirSync(file + '.backups').length, 1);
});
test('backup failure aborts before modification and fresh database creates the current schema', (t) => {
  const { file, db } = fixture(t);
  writeFileSync(file + '.backups', 'block directory');
  assert.throws(() => migrateDatabase(db, file, 1), { code: 'DATABASE_BACKUP_FAILED' });
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 1);
  db.close();
  const memory = new Store(':memory:');
  assert.equal(
    memory.db.prepare('SELECT version FROM schema_version').get().version,
    schemaVersion,
  );
  memory.close();
});

test('schema 3 keeps hidden conversation entries without deleting requests', async () => {
  const { Workspace } = await import('../../src/core/workspace.ts');
  const store = new Store(':memory:');
  try {
    const workspace = new Workspace(store),
      project = store.createProject('hide');
    const input = {
      id: 'r1',
      body: 'hello',
      permission: 'review',
      provider: 'codex-cli',
      pins: [],
      sketches: [],
      files: [],
    };
    workspace.submit(project.id, input);
    assert.throws(() => workspace.hide(project.id, 'r1'), { code: 'PROJECT_BUSY' });
    workspace.update(project.id, 'r1', 'succeeded', { text: 'hi' });
    workspace.hide(project.id, 'r1');
    workspace.hide(project.id, 'r1');
    assert.deepEqual([...workspace.hiddenIds(project.id)], ['r1']);
    assert.equal(workspace.get(project.id, 'r1').state, 'succeeded');
  } finally {
    store.close();
  }
});

test('schema 4 keeps linked files per project, one link per file, hidden and removal', async () => {
  const { DocumentLinks } = await import('../../src/core/document-links.ts');
  const store = new Store(':memory:');
  const links = new DocumentLinks(store.db);
  const a = store.db.prepare("INSERT INTO projects VALUES('a','A')").run() && 'a';
  store.db.prepare("INSERT INTO projects VALUES('b','B')").run();
  const model = {
    host: 'rhino',
    name: 'm.3dm',
    path: 'C:\\p\\m.3dm',
    instance: '1:2:x',
    documentId: 1,
  };
  const first = links.link(a, model);
  // Linking the same file again (another Rhino session) updates the link instead of adding one.
  const again = links.link(a, { ...model, path: 'c:\\P\\m.3dm', instance: '9:9:y', documentId: 3 });
  assert.equal(again.id, first.id);
  assert.equal(again.instance, '9:9:y');
  const drawing = links.link(a, { host: 'zwcad', name: 'd.dwg', instance: '5:6:z', documentId: 1 });
  assert.deepEqual(
    links.list(a).map((link) => link.name),
    ['m.3dm', 'd.dwg'],
  );
  assert.equal(links.list('b').length, 0);
  assert.equal(links.setHidden(a, drawing.id, true).hidden, true);
  // Linking a hidden file again shows it.
  assert.equal(
    links.link(a, { host: 'zwcad', name: 'd.dwg', instance: '5:6:z', documentId: 1 }).hidden,
    false,
  );
  assert.throws(() => links.setHidden('b', drawing.id, true), { code: 'NOT_FOUND' });
  links.remove(a, first.id);
  assert.deepEqual(
    links.list(a).map((link) => link.name),
    ['d.dwg'],
  );
  assert.throws(() =>
    links.link(a, { host: 'rhino', name: 'x', instance: '1', documentId: 1, extra: 1 }),
  );
  store.close();
});

// A schema 4 database as the previous release left it (T-045 · ARCH-03 §10).
function schema4(t) {
  const root = mkdtempSync(join(tmpdir(), 'vide-schema4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'vide.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(4);' +
      migrations
        .filter((step) => step.version <= 4)
        .map((step) => step.sql)
        .join('\n'),
  );
  db.exec("PRAGMA journal_mode=WAL; INSERT INTO projects VALUES('p','existing')");
  const insert = db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)');
  // One large Sync row (overflow pages) and ordinary requests.
  insert.run(
    'sync',
    'p',
    '{"kind":"sync"}',
    'succeeded',
    JSON.stringify({ scene: 'x'.repeat(300000) }),
    't1',
  );
  for (let i = 0; i < 20; i++)
    insert.run(
      'r' + i,
      'p',
      JSON.stringify({ body: '요청 ' + i }),
      'succeeded',
      '{"text":"ok"}',
      't2',
    );
  db.exec("INSERT INTO hidden_requests VALUES('p','r1','t3')");
  return { root, file, db };
}
const requestRows = (db) =>
  db
    .prepare(
      'SELECT id,projectId,input,state,result,createdAt,octet_length(input)+octet_length(result) AS bytes FROM workspace_requests ORDER BY rowid',
    )
    .all()
    .map((row) => ({ ...row }));
const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);

test('schema 5 migrates a schema 4 database after a backup without rewriting request rows', (t) => {
  const { file, db } = schema4(t);
  const before = requestRows(db);
  db.close();
  const store = new Store(file);
  try {
    assert.equal(
      store.db.prepare('SELECT version FROM schema_version').get().version,
      schemaVersion,
    );
    // Request rows keep their count, content and size; old requests belong to the default conversation.
    assert.deepEqual(requestRows(store.db), before);
    assert.equal(
      store.db
        .prepare('SELECT count(*) AS n FROM workspace_requests WHERE conversationId IS NULL')
        .get().n,
      21,
    );
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM hidden_requests').get().n, 1);
    for (const table of [
      'conversations',
      'provider_sessions',
      'ledger_items',
      'jig_packages',
      'project_jigs',
      'jig_drafts',
      'jig_instances',
      'jig_param_log',
      'jig_runs',
      'jig_reads',
      'jig_bakes',
      'knowledge_reviews',
      'knowledge_source_rules',
      'project_roots',
      'project_folders',
      'agenda_items',
    ])
      assert.ok(tableNames(store.db).includes(table), table);
    // conversationId is not indexed (ARCH-03 §10.1).
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='workspace_requests' AND sql IS NOT NULL",
        )
        .get().n,
      0,
    );
    // Positional inserts of six values keep working, and the conversation comes from the input.
    store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run('new', 'p', JSON.stringify({ body: 'x', conversationId: 'c1' }), 'draft', null, 't4');
    assert.equal(
      store.db.prepare("SELECT conversationId FROM workspace_requests WHERE id='new'").get()
        .conversationId,
      'c1',
    );
  } finally {
    store.close();
  }
  // The pre-migration backup is a readable schema 4 copy with the same requests.
  const [backup] = readdirSync(file + '.backups');
  assert.match(backup, /^schema-4-/);
  const copy = new DatabaseSync(join(file + '.backups', backup), { readOnly: true });
  assert.equal(copy.prepare('SELECT version FROM schema_version').get().version, 4);
  assert.deepEqual(requestRows(copy), before);
  copy.close();
});

test('an interrupted schema 5 migration leaves schema 4 and its requests, and the backup migrates later', (t) => {
  const { root, file, db } = schema4(t);
  const before = requestRows(db);
  const failing = migrations.map((step) =>
    step.version === 5 ? { ...step, sql: step.sql + '\nSELECT * FROM missing_table;' } : step,
  );
  assert.throws(() => migrateDatabase(db, file, 4, failing), { code: 'DATABASE_MIGRATION_FAILED' });
  assert.equal(db.prepare('SELECT version FROM schema_version').get().version, 4);
  assert.deepEqual(requestRows(db), before);
  assert.ok(!tableNames(db).includes('conversations'));
  assert.ok(
    !db
      .prepare('PRAGMA table_xinfo(workspace_requests)')
      .all()
      .some((column) => column.name === 'conversationId'),
  );
  db.close();
  // Recovery: a copy of the retained backup opens and migrates normally.
  const [backup] = readdirSync(file + '.backups');
  const restored = join(root, 'restored.sqlite');
  copyFileSync(join(file + '.backups', backup), restored);
  const store = new Store(restored);
  try {
    assert.equal(
      store.db.prepare('SELECT version FROM schema_version').get().version,
      schemaVersion,
    );
    assert.deepEqual(requestRows(store.db), before);
  } finally {
    store.close();
  }
});

test('a database newer than this code is refused unchanged, as an older release refuses schema 5', (t) => {
  const { file, db } = schema4(t);
  db.close();
  new Store(file).close();
  const newer = new DatabaseSync(file);
  newer.exec(`PRAGMA journal_mode=DELETE; UPDATE schema_version SET version=${schemaVersion + 1}`);
  newer.close();
  const bytes = readFileSync(file);
  assert.throws(() => new Store(file), { code: 'UNSUPPORTED_SCHEMA' });
  assert.deepEqual(readFileSync(file), bytes);
});

test('schema 8 gives the 할 일 of a schema 7 database the kind task and refuses an unknown kind', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-schema7-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'vide.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(7);' +
      migrations
        .filter((step) => step.version <= 7)
        .map((step) => step.sql)
        .join('\n'),
  );
  db.exec("INSERT INTO projects VALUES('p','existing')");
  db.prepare('INSERT INTO agenda_items VALUES(?,?,?,?,?,NULL,?,?,1,?,?)').run(
    'a1',
    'p',
    '보고서',
    '2026-10-09',
    null,
    1,
    'user',
    't1',
    't1',
  );
  db.close();
  const store = new Store(file);
  try {
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version, 8);
    assert.equal(
      store.db.prepare("SELECT kind FROM agenda_items WHERE id='a1'").get().kind,
      'task',
    );
    assert.throws(() => store.db.prepare("UPDATE agenda_items SET kind='party'").run());
  } finally {
    store.close();
  }
  const [backup] = readdirSync(file + '.backups');
  assert.match(backup, /^schema-7-/);
});
