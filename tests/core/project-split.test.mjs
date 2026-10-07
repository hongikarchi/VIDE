import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../src/core/store.ts';
import { schemaVersion } from '../../src/core/migrations.ts';
import { splitProjectDatabase, appTables, projectTables } from '../../src/core/project-split.ts';

const at = '2026-10-02T00:00:00.000Z';
/** One or more rows in every table for the given project; `n` rows of requests to vary counts. */
function fill(db, p, n) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run('INSERT INTO connections VALUES(?,?,?,?,?,0)', `c-${p}`, p, 'rhino', 'i', `d-${p}`);
  run('INSERT INTO inputs VALUES(?,?,1,?)', `in-${p}`, p, '{"text":"x"}');
  run('INSERT INTO runs VALUES(?,?,1,?,?)', `r-${p}`, p, 'goal', `["c-${p}"]`);
  run(
    "INSERT INTO commands(id,projectId,runId,connectionId,revision,kind,payload,hash,state) VALUES(?,?,?,?,1,'applyCandidate','{}','h','succeeded')",
    `cmd-${p}`,
    p,
    `r-${p}`,
    `c-${p}`,
  );
  run('INSERT INTO approvals VALUES(?,?,?)', `cmd-${p}`, p, 'h');
  run(
    "INSERT INTO conversations(id,projectId,kind,title,provider,state,createdAt,updatedAt) VALUES(?,?,'chat','t','claude','open',?,?)",
    `conv-${p}`,
    p,
    at,
    at,
  );
  for (let i = 0; i < n; i++)
    run(
      'INSERT INTO workspace_requests(id,projectId,input,state,result,createdAt) VALUES(?,?,?,?,?,?)',
      `req-${p}-${i}`,
      p,
      JSON.stringify({ text: 'hi', conversationId: `conv-${p}` }),
      'succeeded',
      JSON.stringify({ scene: 'x'.repeat(5000) }),
      at,
    );
  const req = `req-${p}-0`;
  run('INSERT INTO hidden_requests VALUES(?,?,?)', p, req, at);
  run(
    'INSERT INTO document_links VALUES(?,?,?,?,?,?,?,0,?,?)',
    `l-${p}`,
    p,
    'rhino',
    'n',
    null,
    'i',
    1,
    at,
    at,
  );
  run('INSERT INTO review_snapshots VALUES(?,?,?,?,?,?)', `rs-${p}`, p, req, 't', at, '{}');
  run(
    'INSERT INTO review_notes VALUES(?,?,?,?,?,?,?)',
    `rn-${p}`,
    p,
    `rs-${p}`,
    req,
    null,
    'b',
    at,
  );
  run('INSERT INTO shared_feedback VALUES(?,?,?,?,?,?)', `sf-${p}`, p, req, `id-${p}`, 'o', at);
  run('INSERT INTO publication_exports VALUES(?,?,?,?,?)', `pe-${p}`, p, req, 'm', 's');
  run('INSERT INTO table_views VALUES(?,?,?,?,1,?)', `tv-${p}`, p, 'n', 'q', at);
  run(
    'INSERT INTO provider_sessions(conversationId,provider,accountProfileId,sessionId,promptMode,cliVersion,state) VALUES(?,?,?,?,?,?,?)',
    `conv-${p}`,
    'claude',
    'a',
    `s-${p}`,
    'm',
    '1',
    'ok',
  );
  run(
    'INSERT INTO ledger_items VALUES(?,?,?,?,?,?,?)',
    `li-${p}`,
    `conv-${p}`,
    'k',
    'b',
    req,
    at,
    null,
  );
  run('INSERT INTO project_jigs VALUES(?,?,?,?)', p, 'sync', '1.0.0', at);
  run('INSERT INTO jig_drafts VALUES(?,?,?,?,?,?,?)', `jd-${p}`, p, null, 'path', 'open', at, at);
  run(
    'INSERT INTO jig_instances VALUES(?,?,?,?,?,?,?,?,?)',
    `ji-${p}`,
    p,
    'sync',
    '1.0.0',
    't',
    '{}',
    'ok',
    at,
    at,
  );
  run(
    'INSERT INTO jig_param_log VALUES(?,1,?,?,?,?,?,?,?)',
    `ji-${p}`,
    'k',
    null,
    'v',
    'user',
    null,
    null,
    at,
  );
  run(
    'INSERT INTO jig_runs VALUES(?,?,?,?,?,?,?,?)',
    `ji-${p}`,
    'step',
    'h',
    null,
    1,
    'ok',
    null,
    at,
  );
  run(
    'INSERT INTO jig_reads VALUES(?,?,?,?,?,0,?,?,?)',
    `jr-${p}`,
    `ji-${p}`,
    `l-${p}`,
    'r',
    '[]',
    'p',
    'ref',
    at,
  );
  run(
    'INSERT INTO jig_bakes VALUES(?,?,?,?,?,?,?,?,?)',
    `jb-${p}`,
    `ji-${p}`,
    'b',
    `l-${p}`,
    req,
    'run',
    '[]',
    null,
    null,
  );
  run(
    "INSERT INTO knowledge_reviews VALUES(?,1,'confirmed',?,?,?,?,?)",
    p,
    null,
    null,
    null,
    'user',
    at,
  );
  run('INSERT INTO knowledge_source_rules VALUES(?,?,?)', p, '*.tmp', null);
  run('INSERT INTO project_roots VALUES(?,?,?)', p, null, 'C:/x');
  run("INSERT INTO project_folders VALUES(?,?,'project',?)", p, `C:/p/${p}`, at);
  run(
    "INSERT INTO agenda_items(id,projectId,text,ord,source,revision,createdAt,updatedAt) VALUES(?,?,?,1,'user',1,?,?)",
    `ag-${p}`,
    p,
    't',
    at,
    at,
  );
  run(
    "INSERT INTO day_log VALUES(?,?,'2026-10-06','day-end','2026-10-06 · 완료 0','{\"done\":[]}',?,?)",
    `day-${p}`,
    p,
    at,
    at,
  );
  run(
    "INSERT INTO finish_rooms VALUES(?,?,0,'1층','101','합성 실','[\"F0001\"]','[]','[]')",
    `room-${p}`,
    p,
  );
  run('INSERT INTO finish_sheets VALUES(?,?,?)', p, '{}', at);
  run("INSERT INTO drawing_reads VALUES(?,'c:\\a.dwg','C:\\a.dwg',1,?,'h',?,'{}')", p, at, at);
  run("INSERT INTO drawing_layer_maps VALUES(?,'c:\\a.dwg','C:\\a.dwg','[]','h',1,?)", p, at);
  run(
    "INSERT INTO object_versions VALUES(?,?,'object','{}',?,3)",
    p,
    `v-${p}`,
    new Uint8Array([1, 2, 3]),
  );
  run('INSERT INTO sync_manifests VALUES(?,?,?,?,1,1,0,?)', req, p, null, 1, at);
  run("INSERT INTO sync_manifest_items VALUES(?,?,'object','k',0,?,1)", req, p, `v-${p}`);
  run("INSERT INTO sync_manifest_removed VALUES(?,'object','gone',1)", req);
}

async function workspace(t, counts = [3, 1, 2]) {
  const root = await mkdtemp(join(tmpdir(), 'vide-split-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'data');
  await mkdir(data);
  const store = new Store(join(data, 'vide.sqlite'));
  const ids = counts.map((_, i) => store.createProject(`project ${i}`).id);
  store.app.exec('PRAGMA foreign_keys=ON');
  store.app.prepare('INSERT INTO ai_settings VALUES(1,1,?)').run('{}');
  store.app.prepare('INSERT INTO extension_registrations VALUES(?,?,1,1)').run('ext', '1');
  store.app
    .prepare('INSERT INTO jig_packages VALUES(?,?,?,?,?,?,?,?,?)')
    .run('sync', '1.0.0', 'stable', 'builtin', 'd', null, 'p', '[]', at);
  store.tx(store.app, () => ids.forEach((id, i) => fill(store.app, id, counts[i])));
  store.close();
  return { root, data, ids };
}
/** Files of a folder, without the empty -wal/-shm a read-only SQLite open leaves behind. */
const files = async (folder) =>
  (await readdir(folder)).filter((name) => !/-(wal|shm)$/.test(name)).sort();
const count = (file, table, where = '') => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number(db.prepare(`SELECT count(*) AS n FROM ${table} ${where}`).get().n);
  } finally {
    db.close();
  }
};

test('every table of the current schema is classified as app or project', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'vide-split-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'vide.sqlite'));
  const names = store.app
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);
  store.close();
  for (const name of names)
    assert.ok(name === 'schema_version' || appTables.includes(name) || name in projectTables, name);
  assert.equal(names.length, 1 + appTables.length + Object.keys(projectTables).length);
});

test('splits every row into app.sqlite and one project.sqlite per project, then is a no-op', async (t) => {
  const { data, ids } = await workspace(t);
  await mkdir(join(data, 'knowledge'));
  const knowledge = new DatabaseSync(join(data, 'knowledge', ids[0] + '.sqlite'));
  knowledge.exec(
    "CREATE TABLE statements(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO statements(body) VALUES('a'),('b')",
  );
  knowledge.close();
  const stray = new DatabaseSync(
    join(data, 'knowledge', '00000000-0000-0000-0000-000000000000.sqlite'),
  );
  stray.exec('CREATE TABLE t(x)');
  stray.close();

  const dry = await splitProjectDatabase(data, { dryRun: true, stagingRoot: data });
  assert.equal(dry.status, 'dry-run');
  assert.deepEqual(await files(data), ['knowledge', 'vide.sqlite', 'vide.sqlite.controller']);

  const report = await splitProjectDatabase(data);
  assert.equal(report.status, 'split');
  assert.deepEqual(report.app.rows, {
    projects: 3,
    ai_settings: 1,
    extension_registrations: 1,
    jig_packages: 1,
  });
  assert.equal(
    count(join(data, 'app.sqlite'), 'schema_version', `WHERE version=${schemaVersion}`),
    1,
  );
  for (const [i, id] of ids.entries()) {
    const file = join(data, 'projects', id, 'project.sqlite');
    assert.equal(count(file, 'projects'), 1);
    assert.equal(count(file, 'workspace_requests'), [3, 1, 2][i]);
    assert.equal(
      count(file, 'workspace_requests', `WHERE conversationId='conv-${id}'`),
      [3, 1, 2][i],
    );
    for (const table of Object.keys(projectTables)) {
      if (table === 'workspace_requests') continue;
      assert.equal(count(file, table), 1, `${id} ${table}`);
    }
    assert.equal(count(file, 'ai_settings'), 0);
    const db = new DatabaseSync(file, { readOnly: true });
    assert.equal(Object.values(db.prepare('PRAGMA integrity_check').get())[0], 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  }
  assert.equal(count(join(data, 'projects', ids[0], 'knowledge.sqlite'), 'statements'), 2);
  assert.ok(existsSync(join(data, 'knowledge', ids[0] + '.sqlite.migrated')));
  assert.equal(report.skippedKnowledge.length, 1);
  assert.ok(existsSync(join(data, 'vide.sqlite.migrated')));
  assert.ok(!existsSync(join(data, 'vide.sqlite')));
  assert.ok(existsSync(report.backup));
  assert.ok(!(await readdir(data)).some((name) => name.startsWith('.project-split-')));

  assert.equal((await splitProjectDatabase(data)).status, 'already-split');
});

for (const [name, step, act, expected] of [
  [
    'a disk error mid-copy',
    'copy',
    (detail) => detail.table === 'jig_runs' && Error('SQLITE_IOERR'),
    /SQLITE_IOERR/,
  ],
  [
    'a row count mismatch',
    'verify',
    (detail) => {
      if (detail.file.endsWith('project.sqlite')) detail.db.exec('DELETE FROM agenda_items');
    },
    { code: 'SPLIT_ROWS_MISMATCH' },
  ],
  ['a failure while moving into place', 'retire', () => Error('EBUSY'), /EBUSY/],
])
  test(`${name} leaves the old DB untouched and no partial files`, async (t) => {
    const { data, ids } = await workspace(t);
    await mkdir(join(data, 'knowledge'));
    const k = new DatabaseSync(join(data, 'knowledge', ids[1] + '.sqlite'));
    k.exec('CREATE TABLE t(x); INSERT INTO t VALUES(1)');
    k.close();
    const before = await readFile(join(data, 'vide.sqlite'));
    const listing = await files(data);
    await assert.rejects(
      splitProjectDatabase(data, {
        onStep: (current, detail) => {
          if (current !== step) return;
          const error = act(detail);
          if (error) throw error;
        },
      }),
      expected,
    );
    assert.deepEqual(await readFile(join(data, 'vide.sqlite')), before);
    assert.deepEqual(await files(data), [...listing, 'vide.sqlite.backups'].sort());
    assert.deepEqual(await readdir(join(data, 'vide.sqlite.backups')), []);
    assert.deepEqual(await files(join(data, 'knowledge')), [ids[1] + '.sqlite']);
    // The old DB still opens in the engine.
    new Store(join(data, 'vide.sqlite')).close();
  });

test('refuses while the engine holds the lock, and reads uncheckpointed WAL pages', async (t) => {
  const { root, data, ids } = await workspace(t, [1, 1, 1]);
  const store = new Store(join(data, 'vide.sqlite'));
  await assert.rejects(splitProjectDatabase(data), { code: 'CONTROLLER_BUSY' });
  // Rows written after the last checkpoint, then the files copied as a killed engine leaves them.
  store.app.exec('PRAGMA wal_autocheckpoint=0');
  store.app
    .prepare('INSERT INTO workspace_requests(id,projectId,input,state,createdAt) VALUES(?,?,?,?,?)')
    .run('late', ids[2], '{}', 'succeeded', at);
  const copy = join(root, 'copy');
  await mkdir(copy);
  for (const suffix of ['', '-wal'])
    await copyFile(join(data, 'vide.sqlite' + suffix), join(copy, 'vide.sqlite' + suffix));
  store.close();
  assert.ok((await readFile(join(copy, 'vide.sqlite-wal'))).length > 0);
  const report = await splitProjectDatabase(copy);
  assert.equal(report.status, 'split');
  assert.equal(count(join(copy, 'projects', ids[2], 'project.sqlite'), 'workspace_requests'), 2);
  assert.ok(existsSync(join(copy, 'vide.sqlite.migrated-wal')));
});
