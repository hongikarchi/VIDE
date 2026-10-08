// Splits the single workspace DB `<data>/vide.sqlite` into a shared `<data>/app.sqlite` and one
// `<data>/projects/<projectId>/project.sqlite` per project, and moves the project knowledge DB
// `<data>/knowledge/<projectId>.sqlite` to `<data>/projects/<projectId>/knowledge.sqlite`
// (ADR-032, PLAN-28 T-124 phase 1). Not wired into the engine yet: tools/db/split.mjs runs it by hand.
//
// Order: lock → snapshot (VACUUM INTO, includes WAL pages) → build every output in a staging folder
// from the snapshot → verify (quick_check, foreign_key_check, row counts per table per project) →
// move the outputs into place → rename the old files to `*.migrated`. Any failure before the last
// step removes the staging folder and leaves the old DB as it was. Nothing is ever deleted: the old
// DB and knowledge files stay as `*.migrated`, and the snapshot stays in `vide.sqlite.backups`.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { migrateDatabase, schemaVersion } from './migrations.ts';
import { checkDatabase } from './database-check.ts';

/** Shared by every project (one copy in app.sqlite). `projects` is also kept as each project DB's own row. */
export const appTables = ['projects', 'ai_settings', 'extension_registrations', 'jig_packages'];
/** Derived data made on first use, not copied: [다시 읽기] rebuilds it (xref-store.ts). */
export const derivedTables = ['xref_files', 'xref_placements'];

/**
 * Where each project table's rows belong: its own `projectId`, or the project of a parent row.
 * Every table of the current schema must be listed here or in `appTables` (checked at run time).
 */
export const projectTables: Record<string, string> = {
  connections: 'projectId=?',
  inputs: 'projectId=?',
  runs: 'projectId=?',
  commands: 'projectId=?',
  approvals: 'projectId=?',
  workspace_requests: 'projectId=?',
  hidden_requests: 'projectId=?',
  document_links: 'projectId=?',
  review_snapshots: 'projectId=?',
  review_notes: 'projectId=?',
  shared_feedback: 'projectId=?',
  publication_exports: 'projectId=?',
  table_views: 'projectId=?',
  conversations: 'projectId=?',
  provider_sessions: 'conversationId IN (SELECT id FROM src.conversations WHERE projectId=?)',
  ledger_items: 'conversationId IN (SELECT id FROM src.conversations WHERE projectId=?)',
  project_jigs: 'projectId=?',
  jig_drafts: 'projectId=?',
  jig_instances: 'projectId=?',
  jig_param_log: 'instanceId IN (SELECT id FROM src.jig_instances WHERE projectId=?)',
  jig_runs: 'instanceId IN (SELECT id FROM src.jig_instances WHERE projectId=?)',
  jig_reads: 'instanceId IN (SELECT id FROM src.jig_instances WHERE projectId=?)',
  jig_bakes: 'instanceId IN (SELECT id FROM src.jig_instances WHERE projectId=?)',
  knowledge_reviews: 'projectId=?',
  knowledge_source_rules: 'projectId=?',
  project_roots: 'projectId=?',
  project_folders: 'projectId=?',
  agenda_items: 'projectId=?',
  day_log: 'projectId=?',
  finish_rooms: 'projectId=?',
  finish_sheets: 'projectId=?',
  drawing_reads: 'projectId=?',
  drawing_layer_maps: 'projectId=?',
  legal_profile: 'projectId=?',
  legal_answers: 'projectId=?',
  legal_articles: 'projectId=?',
  legal_contributions: 'projectId=?',
  compliance_roles: 'projectId=?',
  compliance_proposals: 'projectId=?',
  compliance_roles_version: 'projectId=?',
  drawing_backflow_baselines: 'projectId=?',
  object_versions: 'projectId=?',
  sync_manifests: 'projectId=?',
  sync_manifest_items: 'projectId=?',
  sync_manifest_removed:
    'requestId IN (SELECT requestId FROM src.sync_manifests WHERE projectId=?)',
};

export type SplitStatus = 'split' | 'dry-run' | 'already-split' | 'no-source' | 'conflict';
export interface SplitReport {
  status: SplitStatus;
  reason?: string;
  ms: number;
  sourceBytes?: number;
  backup?: string;
  app?: { file: string; bytes: number; rows: Record<string, number> };
  projects: {
    id: string;
    name: string;
    file: string;
    bytes: number;
    rows: Record<string, number>;
    knowledge?: { from: string; file: string; bytes: number };
  }[];
  /** Knowledge files whose project is not in the DB: left where they are. */
  skippedKnowledge: string[];
}
export interface SplitOptions {
  /** Build and verify in a temporary folder, then remove it. Changes nothing in the data folder. */
  dryRun?: boolean;
  /** Where a dry run builds (default: the OS temp folder). */
  stagingRoot?: string;
  /** Test hook, called at each step; throwing there fails the split. */
  onStep?: (step: string, detail: { file?: string; table?: string; db?: DatabaseSync }) => void;
}

function fail(code: string, detail?: string): never {
  throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
}
const value = (db: DatabaseSync, sql: string, ...args: (string | number)[]) =>
  Object.values(db.prepare(sql).get(...args) ?? {})[0];
const quoted = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const safeId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);
const exists = (path: string) => existsSync(path);
const size = (path: string) => (exists(path) ? statSync(path).size : 0);

function checked(db: DatabaseSync, file: string) {
  const quick = db.prepare('PRAGMA quick_check').all();
  if (quick.length !== 1 || Object.values(quick[0])[0] !== 'ok') fail('SPLIT_VERIFY_FAILED', file);
  if (db.prepare('PRAGMA foreign_key_check').all().length)
    fail('SPLIT_VERIFY_FAILED', `${file} foreign keys`);
}
function tableNames(db: DatabaseSync, schema = 'main') {
  return db
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`,
    )
    .all()
    .map((row) => String(row.name));
}
/** Stored columns (generated columns such as workspace_requests.conversationId are left out). */
function columns(db: DatabaseSync, table: string) {
  return db
    .prepare(`SELECT name FROM pragma_table_xinfo(?) WHERE hidden=0 ORDER BY cid`)
    .all(table)
    .map((row) => quoted(String(row.name)))
    .join(',');
}
const withoutRowid = (db: DatabaseSync, table: string) =>
  Number(value(db, `SELECT wr FROM pragma_table_list WHERE schema='main' AND name=?`, table)) === 1;

/** A new DB at the current schema (same migrations as the engine), filled from the snapshot. */
function build(
  file: string,
  snapshot: string,
  tables: { name: string; where?: string }[],
  projectId: string | undefined,
  onStep: SplitOptions['onStep'],
) {
  const db = new DatabaseSync(file);
  try {
    migrateDatabase(db, file, 0);
    db.exec('PRAGMA foreign_keys=OFF');
    db.prepare('ATTACH DATABASE ? AS src').run(snapshot);
    db.exec('BEGIN');
    try {
      for (const { name, where } of tables) {
        onStep?.('copy', { file, table: name, db });
        const list = columns(db, name),
          order = withoutRowid(db, name) ? '' : ' ORDER BY rowid';
        const sql = `INSERT INTO main.${quoted(name)}(${list}) SELECT ${list} FROM src.${quoted(name)}`;
        if (where) db.prepare(`${sql} WHERE ${where}${order}`).run(projectId!);
        else db.exec(sql + order);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.exec('DETACH DATABASE src');
    db.exec('PRAGMA foreign_keys=ON');
    onStep?.('verify', { file, db });
    checked(db, file);
    const rows: Record<string, number> = {};
    for (const { name } of tables)
      rows[name] = Number(value(db, `SELECT count(*) FROM ${quoted(name)}`));
    return rows;
  } finally {
    db.close();
  }
}

function rowCounts(db: DatabaseSync) {
  const rows: Record<string, number> = {};
  for (const name of tableNames(db))
    rows[name] = Number(value(db, `SELECT count(*) FROM ${quoted(name)}`));
  return rows;
}

/** Snapshot of a DB (WAL pages included) checked with quick_check; the source is opened read-only. */
function snapshotOf(source: string, target: string) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    if (Object.values(copy.prepare('PRAGMA quick_check').get()!)[0] !== 'ok')
      fail('SPLIT_BACKUP_FAILED', target);
  } finally {
    copy.close();
  }
}

/** Moves a file and its `-wal`/`-shm` companions; returns the moves made, for undo. */
async function moveDb(from: string, to: string, done: [string, string][]) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (!exists(from + suffix)) continue;
    if (exists(to + suffix)) fail('SPLIT_TARGET_EXISTS', to + suffix);
    await rename(from + suffix, to + suffix);
    done.push([from + suffix, to + suffix]);
  }
}

export async function splitProjectDatabase(
  dataDirectory: string,
  options: SplitOptions = {},
): Promise<SplitReport> {
  const started = performance.now();
  const source = join(dataDirectory, 'vide.sqlite'),
    appFile = join(dataDirectory, 'app.sqlite'),
    projectsRoot = join(dataDirectory, 'projects'),
    knowledgeRoot = join(dataDirectory, 'knowledge');
  const report = (status: SplitStatus, reason?: string): SplitReport => ({
    status,
    reason,
    ms: Math.round(performance.now() - started),
    projects: [],
    skippedKnowledge: [],
  });
  // Idempotent: once app.sqlite is in place and vide.sqlite is renamed, a second run does nothing.
  if (exists(appFile))
    return exists(source)
      ? report('conflict', 'app.sqlite and vide.sqlite both exist; nothing was changed')
      : report('already-split');
  if (!exists(source) || size(source) === 0) return report('no-source');

  // Same lock as the engine (Store) and backupWorkspace: refuse while VIDE is running on this folder.
  let controller: DatabaseSync | undefined;
  if (!options.dryRun) {
    controller = new DatabaseSync(source + '.controller');
    try {
      controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    } catch {
      controller.close();
      fail('CONTROLLER_BUSY');
    }
  }
  const staging = options.dryRun
    ? join(options.stagingRoot ?? tmpdir(), `vide-split-${randomUUID()}`)
    : join(dataDirectory, `.project-split-${randomUUID()}`);
  let backup: string | undefined;
  const moved: [string, string][] = [];
  let createdProjectsRoot = false;
  try {
    const version = checkDatabase(source);
    if (version !== schemaVersion)
      fail(
        'SPLIT_SCHEMA_MISMATCH',
        `schema ${version}, expected ${schemaVersion}; open it once in VIDE first`,
      );
    await mkdir(staging, { recursive: true });
    if (options.dryRun) backup = join(staging, 'snapshot.sqlite');
    else {
      await mkdir(source + '.backups', { recursive: true });
      backup = join(
        source + '.backups',
        `split-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`,
      );
    }
    options.onStep?.('backup', { file: backup });
    snapshotOf(source, backup);

    // What the snapshot holds, read once.
    const snap = new DatabaseSync(backup, { readOnly: true });
    let projects: { id: string; name: string }[], sourceRows: Record<string, number>;
    try {
      const names = tableNames(snap);
      const unknown = names.filter(
        (name) =>
          name !== 'schema_version' &&
          !appTables.includes(name) &&
          !derivedTables.includes(name) &&
          !(name in projectTables),
      );
      if (unknown.length) fail('SPLIT_UNCLASSIFIED_TABLE', unknown.join(','));
      projects = snap
        .prepare('SELECT id, name FROM projects ORDER BY rowid')
        .all()
        .map((row) => ({ id: String(row.id), name: String(row.name) }));
      sourceRows = rowCounts(snap);
    } finally {
      snap.close();
    }
    for (const project of projects) {
      if (!safeId(project.id)) fail('SPLIT_PROJECT_ID_INVALID', project.id);
      if (exists(join(projectsRoot, project.id)))
        fail('SPLIT_TARGET_EXISTS', join(projectsRoot, project.id));
    }

    const result: SplitReport = {
      ...report(options.dryRun ? 'dry-run' : 'split'),
      sourceBytes: size(source) + size(source + '-wal'),
      backup: options.dryRun ? undefined : backup,
    };
    const stagedApp = join(staging, 'app.sqlite');
    const appRows = build(
      stagedApp,
      backup,
      appTables.map((name) => ({ name })),
      undefined,
      options.onStep,
    );
    result.app = { file: appFile, bytes: size(stagedApp), rows: appRows };
    const assigned: Record<string, number> = {};
    for (const project of projects) {
      const folder = join(staging, 'projects', project.id);
      await mkdir(folder, { recursive: true });
      const staged = join(folder, 'project.sqlite');
      const rows = build(
        staged,
        backup,
        [
          { name: 'projects', where: 'id=?' },
          ...Object.entries(projectTables).map(([name, where]) => ({ name, where })),
        ],
        project.id,
        options.onStep,
      );
      for (const [name, count] of Object.entries(rows))
        if (name !== 'projects') assigned[name] = (assigned[name] ?? 0) + count;
      const entry: SplitReport['projects'][number] = {
        id: project.id,
        name: project.name,
        file: join(projectsRoot, project.id, 'project.sqlite'),
        bytes: size(staged),
        rows,
      };
      const knowledge = join(knowledgeRoot, project.id + '.sqlite');
      if (exists(knowledge) && size(knowledge) > 0) {
        const target = join(folder, 'knowledge.sqlite');
        options.onStep?.('knowledge', { file: target });
        snapshotOf(knowledge, target);
        const a = new DatabaseSync(knowledge, { readOnly: true }),
          b = new DatabaseSync(target, { readOnly: true });
        try {
          if (JSON.stringify(rowCounts(a)) !== JSON.stringify(rowCounts(b)))
            fail('SPLIT_VERIFY_FAILED', `${target} row counts`);
        } finally {
          a.close();
          b.close();
        }
        entry.knowledge = {
          from: knowledge,
          file: join(projectsRoot, project.id, 'knowledge.sqlite'),
          bytes: size(target),
        };
      }
      result.projects.push(entry);
    }
    // Every source row landed in exactly one output: app rows in app.sqlite, the rest summed over projects.
    for (const [name, count] of Object.entries(sourceRows)) {
      if (name === 'schema_version') continue;
      const got = appTables.includes(name) ? appRows[name] : (assigned[name] ?? 0);
      if (got !== count) fail('SPLIT_ROWS_MISMATCH', `${name}: source ${count}, split ${got}`);
    }
    if (exists(knowledgeRoot)) {
      const known = new Set(projects.map((project) => project.id));
      for (const name of await readdir(knowledgeRoot))
        if (name.endsWith('.sqlite') && !known.has(name.slice(0, -'.sqlite'.length)))
          result.skippedKnowledge.push(join(knowledgeRoot, name));
    }
    options.onStep?.('verified', {});
    if (options.dryRun) {
      result.ms = Math.round(performance.now() - started);
      return result;
    }

    // Move into place. app.sqlite last but one: its presence marks the split as done.
    if (!exists(projectsRoot)) {
      await mkdir(projectsRoot);
      createdProjectsRoot = true;
    }
    for (const project of projects) {
      options.onStep?.('promote', { file: join(projectsRoot, project.id) });
      const to = join(projectsRoot, project.id);
      if (exists(to)) fail('SPLIT_TARGET_EXISTS', to);
      await rename(join(staging, 'projects', project.id), to);
      moved.push([join(staging, 'projects', project.id), to]);
    }
    options.onStep?.('promote', { file: appFile });
    await moveDb(stagedApp, appFile, moved);
    options.onStep?.('retire', { file: source });
    await moveDb(source, source + '.migrated', moved);
    // The originals are kept beside the copies that were just verified.
    for (const entry of result.projects)
      if (entry.knowledge)
        await moveDb(entry.knowledge.from, entry.knowledge.from + '.migrated', moved);
    moved.length = 0;
    result.ms = Math.round(performance.now() - started);
    return result;
  } catch (error) {
    // Undo in reverse; the old DB is back under its own name before anything is removed.
    for (const [from, to] of moved.reverse()) await rename(to, from).catch(() => undefined);
    if (createdProjectsRoot)
      await stat(projectsRoot)
        .then(async () =>
          (await readdir(projectsRoot)).length ? undefined : rm(projectsRoot, { recursive: true }),
        )
        .catch(() => undefined);
    if (backup && !options.dryRun) await rm(backup, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    controller?.close();
  }
}
