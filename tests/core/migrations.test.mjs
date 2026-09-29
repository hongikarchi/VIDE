import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/core/store.ts';
import { baselineSchema, migrateDatabase } from '../../src/core/migrations.ts';
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
    assert.equal(store.db.prepare('SELECT version FROM schema_version').get().version, 4);
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
  assert.equal(memory.db.prepare('SELECT version FROM schema_version').get().version, 4);
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
    path: 'C:\p\m.3dm',
    instance: '1:2:x',
    documentId: 1,
  };
  const first = links.link(a, model);
  // Linking the same file again (another Rhino session) updates the link instead of adding one.
  const again = links.link(a, { ...model, path: 'c:\P\m.3dm', instance: '9:9:y', documentId: 3 });
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
