import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** v5 and later cannot be opened by an older installation (UNSUPPORTED_SCHEMA); see ARCH-03 §10.1. */
export const schemaVersion = 15;
export const baselineSchema = `
        CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          host TEXT NOT NULL, instanceId TEXT NOT NULL, documentId TEXT NOT NULL, connected INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS inputs(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          revision INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          revision INTEGER NOT NULL, goal TEXT NOT NULL, targets TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
          runId TEXT NOT NULL REFERENCES runs(id), connectionId TEXT NOT NULL REFERENCES connections(id),
          revision INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL,
          state TEXT NOT NULL, result TEXT, stale INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS queue_target ON commands(connectionId,state);
        CREATE TABLE IF NOT EXISTS approvals(commandId TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_requests (
      id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
      input TEXT NOT NULL, state TEXT NOT NULL, result TEXT, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, paths TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS extension_registrations(id TEXT PRIMARY KEY,version TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS review_snapshots(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL,title TEXT NOT NULL,createdAt TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_notes(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), reviewId TEXT NOT NULL REFERENCES review_snapshots(id), requestId TEXT NOT NULL, objectId TEXT, body TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS shared_feedback(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL REFERENCES workspace_requests(id),identity TEXT NOT NULL UNIQUE,original TEXT NOT NULL,receivedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS publication_exports(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),requestId TEXT NOT NULL REFERENCES workspace_requests(id),manifestHash TEXT NOT NULL,sourceHash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS table_views(id TEXT PRIMARY KEY,projectId TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,query TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL);
`;
export type Migration = { version: number; sql: string };
// Conversation entries a user removed from view; the request records themselves are kept.
const hiddenRequests = `CREATE TABLE IF NOT EXISTS hidden_requests(projectId TEXT NOT NULL REFERENCES projects(id),
  requestId TEXT NOT NULL REFERENCES workspace_requests(id), hiddenAt TEXT NOT NULL, PRIMARY KEY(projectId, requestId));`;
// Files linked to a project from a host plugin (SPEC-01.11); Sync records stay in workspace_requests.
const documentLinks = `CREATE TABLE IF NOT EXISTS document_links(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id), host TEXT NOT NULL, name TEXT NOT NULL, path TEXT,
  instance TEXT NOT NULL, documentId INTEGER NOT NULL, hidden INTEGER NOT NULL, linkedAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS document_links_project ON document_links(projectId);`;
// Conversations, jig platform and project knowledge review (ARCH-03 §10.2), in one step so parallel
// work does not claim the same number. Existing request rows are never rewritten: a request's
// conversation is `input.conversationId`, exposed as a virtual column (NULL = the project's default
// conversation). A plain column would break every positional `INSERT INTO workspace_requests
// VALUES(...)`, and one stored after `result` would read the large Sync overflow pages. No index.
const conversationsAndJigs = `
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL, title TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, effort TEXT, accountProfileId TEXT,
  mode TEXT NOT NULL DEFAULT 'session', jigInstanceId TEXT, draftId TEXT, targets TEXT,
  state TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, closedAt TEXT);
CREATE INDEX IF NOT EXISTS conversations_project ON conversations(projectId, state);
ALTER TABLE workspace_requests ADD COLUMN conversationId TEXT
  GENERATED ALWAYS AS (json_extract(input, '$.conversationId')) VIRTUAL;
CREATE TABLE IF NOT EXISTS provider_sessions(conversationId TEXT NOT NULL REFERENCES conversations(id),
  provider TEXT NOT NULL, accountProfileId TEXT NOT NULL, sessionId TEXT NOT NULL,
  promptMode TEXT NOT NULL, cliVersion TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, inputTokens INTEGER NOT NULL DEFAULT 0, lastTurnAt TEXT,
  state TEXT NOT NULL, PRIMARY KEY(conversationId, provider, accountProfileId, sessionId));
CREATE TABLE IF NOT EXISTS ledger_items(id TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL REFERENCES conversations(id), kind TEXT NOT NULL, body TEXT NOT NULL,
  requestId TEXT, createdAt TEXT NOT NULL, supersededBy TEXT);
CREATE INDEX IF NOT EXISTS ledger_items_conversation ON ledger_items(conversationId, createdAt);
CREATE TABLE IF NOT EXISTS jig_packages(id TEXT NOT NULL, version TEXT NOT NULL,
  stage TEXT NOT NULL, source TEXT NOT NULL, digest TEXT NOT NULL, signer TEXT, path TEXT NOT NULL,
  approvedCaps TEXT NOT NULL, installedAt TEXT NOT NULL, PRIMARY KEY(id, version));
CREATE TABLE IF NOT EXISTS project_jigs(projectId TEXT NOT NULL REFERENCES projects(id),
  jigId TEXT NOT NULL, version TEXT NOT NULL, pinnedAt TEXT NOT NULL, PRIMARY KEY(projectId, jigId));
CREATE TABLE IF NOT EXISTS jig_drafts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
  conversationId TEXT, path TEXT NOT NULL, state TEXT NOT NULL,
  createdAt TEXT NOT NULL, openedAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jig_instances(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
  jigId TEXT NOT NULL, version TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jig_instances_project ON jig_instances(projectId);
CREATE TABLE IF NOT EXISTS jig_param_log(instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  seq INTEGER NOT NULL, key TEXT NOT NULL, old TEXT, new TEXT NOT NULL, by TEXT NOT NULL, reason TEXT,
  requestId TEXT, at TEXT NOT NULL, PRIMARY KEY(instanceId, seq));
CREATE TABLE IF NOT EXISTS jig_runs(instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  stepId TEXT NOT NULL, inputHash TEXT NOT NULL, outputRef TEXT, ms INTEGER, status TEXT NOT NULL,
  gates TEXT, at TEXT NOT NULL, PRIMARY KEY(instanceId, stepId));
CREATE TABLE IF NOT EXISTS jig_reads(id TEXT PRIMARY KEY, instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  linkId TEXT NOT NULL, revisionKey TEXT NOT NULL, layers TEXT NOT NULL, includeHidden INTEGER NOT NULL,
  purpose TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jig_bakes(id TEXT PRIMARY KEY, instanceId TEXT NOT NULL REFERENCES jig_instances(id),
  bakeId TEXT NOT NULL, linkId TEXT NOT NULL, requestId TEXT NOT NULL, runId TEXT NOT NULL,
  items TEXT NOT NULL, baselineReadId TEXT, appliedAt TEXT);
CREATE INDEX IF NOT EXISTS jig_bakes_instance ON jig_bakes(instanceId, bakeId, linkId);
CREATE TABLE IF NOT EXISTS knowledge_reviews(projectId TEXT NOT NULL REFERENCES projects(id),
  statementId INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('confirmed','rejected','contaminated','superseded','corrected')),
  correction TEXT, supersededBy INTEGER, reason TEXT, by TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY(projectId, statementId));
CREATE TABLE IF NOT EXISTS knowledge_source_rules(projectId TEXT NOT NULL REFERENCES projects(id),
  pattern TEXT NOT NULL, reason TEXT, PRIMARY KEY(projectId, pattern));
CREATE TABLE IF NOT EXISTS project_roots(projectId TEXT PRIMARY KEY REFERENCES projects(id),
  kdbRoot TEXT, localRoot TEXT);`;
// Project folders and the folders the user let the AI read (SPEC-01.13, ARCH-01 §3): real paths.
const projectFolders = `CREATE TABLE IF NOT EXISTS project_folders(projectId TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL COLLATE NOCASE, kind TEXT NOT NULL CHECK(kind IN ('project','read')),
  addedAt TEXT NOT NULL, PRIMARY KEY(projectId, path));`;
// The project's 할 일 on the dashboard (SPEC-01.14, ARCH-01 §3): local date/time text, done when
// doneAt is set, `ord` is the user's order.
const agendaItems = `CREATE TABLE IF NOT EXISTS agenda_items(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id), text TEXT NOT NULL, date TEXT, time TEXT,
  doneAt TEXT, ord REAL NOT NULL, source TEXT NOT NULL CHECK(source IN ('user','ai')),
  revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS agenda_items_project ON agenda_items(projectId, ord);`;
// The kind of a 할 일 (SPEC-01.14 1, ARCH-01 §3): existing rows become '할 일' (task). The column is
// added at the end, so every write names its columns.
const agendaKinds = `ALTER TABLE agenda_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'
  CHECK(kind IN ('task','meeting','deadline'));`;
// The project's day log (SPEC-01.14 10, ARCH-01 §3, PLAN-30 T-137): one row per date and kind;
// 퇴근하기 writes 'day-end'. No CHECK on kind: a later shared-notes or journal feature adds its own.
const dayLog = `CREATE TABLE IF NOT EXISTS day_log(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id), date TEXT NOT NULL, kind TEXT NOT NULL,
  text TEXT NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  UNIQUE(projectId, date, kind));`;
// 할 일 over a period, with 접수, 위치 and 참석자 (SPEC-01.14 1, ARCH-01 §3, PLAN-39 T-180): SQLite
// cannot change a CHECK in place, so the table is made again and the rows move by column name.
// Nothing references agenda_items; the index goes with the old table and is made again.
const agendaFields = `CREATE TABLE agenda_items_v11(id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id), text TEXT NOT NULL, date TEXT, time TEXT,
  doneAt TEXT, ord REAL NOT NULL, source TEXT NOT NULL CHECK(source IN ('user','ai')),
  revision INTEGER NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','meeting','receipt','deadline')),
  endDate TEXT, endTime TEXT, location TEXT, attendees TEXT);
INSERT INTO agenda_items_v11(id,projectId,text,date,time,doneAt,ord,source,revision,createdAt,updatedAt,kind)
  SELECT id,projectId,text,date,time,doneAt,ord,source,revision,createdAt,updatedAt,kind FROM agenda_items;
DROP TABLE agenda_items;
ALTER TABLE agenda_items_v11 RENAME TO agenda_items;
CREATE INDEX IF NOT EXISTS agenda_items_project ON agenda_items(projectId, ord);`;
// Display geometry of Sync results per object (PLAN-27 1단계, ARCH-01 §5 「Sync 표시 형상의 객체 단위
// 저장」): immutable object versions named by content, one manifest per request result. Existing
// rows are moved later, one per transaction (src/core/model-move.ts); this step only adds tables.
const objectManifests = `CREATE TABLE IF NOT EXISTS object_versions(
  projectId TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('object','definition')), meta TEXT NOT NULL, geometry BLOB,
  size INTEGER NOT NULL, PRIMARY KEY(projectId, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_manifests(
  requestId TEXT PRIMARY KEY REFERENCES workspace_requests(id) ON DELETE CASCADE,
  projectId TEXT NOT NULL, parentId TEXT, documentRevision INTEGER, revision INTEGER NOT NULL,
  objectCount INTEGER, definitionCount INTEGER, updatedAt TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sync_manifests_project ON sync_manifests(projectId);
CREATE TABLE IF NOT EXISTS sync_manifest_items(
  requestId TEXT NOT NULL REFERENCES sync_manifests(requestId) ON DELETE CASCADE,
  projectId TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('object','definition')),
  key TEXT NOT NULL, position INTEGER NOT NULL, versionId TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(requestId, kind, key),
  FOREIGN KEY(projectId, versionId) REFERENCES object_versions(projectId, id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sync_manifest_items_version ON sync_manifest_items(projectId, versionId);
CREATE INDEX IF NOT EXISTS sync_manifest_items_revision ON sync_manifest_items(requestId, revision);
CREATE TABLE IF NOT EXISTS sync_manifest_removed(
  requestId TEXT NOT NULL REFERENCES sync_manifests(requestId) ON DELETE CASCADE,
  kind TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(requestId, kind, key)) WITHOUT ROWID;`;
// 마감 일람표 jig (SPEC-11.6, PLAN-43 T-198): a project's rooms (층별·실번호·실명 and the F·W·C
// code lists as JSON arrays, `ord` is the table order) and one sheet row (채택, 두께 조절, 표제,
// 프로젝트 일반사항 as JSON). A save replaces the project's rows in one transaction.
const finishSchedule = `CREATE TABLE IF NOT EXISTS finish_rooms(id TEXT NOT NULL,
  projectId TEXT NOT NULL REFERENCES projects(id), ord INTEGER NOT NULL, floor TEXT NOT NULL,
  roomNo TEXT NOT NULL, name TEXT NOT NULL, floorCodes TEXT NOT NULL, wallCodes TEXT NOT NULL,
  ceilingCodes TEXT NOT NULL, PRIMARY KEY(projectId, id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS finish_sheets(projectId TEXT PRIMARY KEY REFERENCES projects(id),
  body TEXT NOT NULL, updatedAt TEXT NOT NULL);`;
// 도면 읽기와 레이어 대응 (SPEC-14.3, PLAN-47 T-227): the last read of a project drawing (its
// fingerprint — size, modification time, sha256 of the copy read — and the worker's answer) and one
// layer table per drawing (source layer → drawing layer entries as JSON, with the fingerprint of the
// read it was made against). `key` is the Windows path key (case and separators folded).
const drawingLayers = `CREATE TABLE IF NOT EXISTS drawing_reads(projectId TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL,
  sha256 TEXT NOT NULL, readAt TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(projectId, key)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS drawing_layer_maps(projectId TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL, path TEXT NOT NULL, entries TEXT NOT NULL, sha256 TEXT NOT NULL,
  revision INTEGER NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY(projectId, key)) WITHOUT ROWID;`;
export const migrations: Migration[] = [
  { version: 2, sql: baselineSchema },
  { version: 3, sql: hiddenRequests },
  { version: 4, sql: documentLinks },
  { version: 5, sql: conversationsAndJigs },
  { version: 6, sql: projectFolders },
  { version: 7, sql: agendaItems },
  { version: 8, sql: agendaKinds },
  { version: 9, sql: objectManifests },
  { version: 10, sql: dayLog },
  { version: 11, sql: agendaFields },
  { version: 12, sql: finishSchedule },
  // RESERVED for parallel tickets (2026-10-08): their migrations replace these two empty steps when
  // the branches are merged. Never release a build with these placeholders.
  { version: 13, sql: '' },
  { version: 14, sql: '' },
  { version: 15, sql: drawingLayers },
];

/** Caller holds the exclusive controller lock. Never migrates user model files. */
export function migrateDatabase(
  db: DatabaseSync,
  filename: string,
  current: number,
  steps: Migration[] = migrations,
) {
  if (current === schemaVersion) return;
  if (current < 0 || current >= schemaVersion)
    throw Object.assign(Error('UNSUPPORTED_SCHEMA'), { code: 'UNSUPPORTED_SCHEMA' });
  let backup: string | undefined;
  if (current > 0 && filename !== ':memory:') {
    const directory = filename + '.backups';
    try {
      mkdirSync(directory, { recursive: true });
      backup = join(directory, `schema-${current}-${randomUUID()}.sqlite`);
      // SQLite snapshots include committed WAL pages; copying only the .sqlite file would not.
      db.prepare('VACUUM INTO ?').run(backup);
      const snapshot = new DatabaseSync(backup, { readOnly: true });
      try {
        if (Object.values(snapshot.prepare('PRAGMA quick_check').get()!)[0] !== 'ok')
          throw Error('Invalid backup');
      } finally {
        snapshot.close();
      }
    } catch (cause) {
      throw Object.assign(Error('DATABASE_BACKUP_FAILED', { cause }), {
        code: 'DATABASE_BACKUP_FAILED',
      });
    }
  }
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    if (current === 0)
      db.exec(
        'CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1)',
      );
    let version = current || 1;
    for (const step of steps) {
      if (step.version <= version) continue;
      if (step.version !== version + 1) throw Error('Non-sequential migration');
      db.exec(step.sql);
      db.prepare('UPDATE schema_version SET version=?').run(step.version);
      version = step.version;
    }
    if (version !== schemaVersion) throw Error('Missing migration');
    if (
      db.prepare('PRAGMA foreign_key_check').all().length ||
      Object.values(db.prepare('PRAGMA quick_check').get()!)[0] !== 'ok'
    )
      throw Error('Migration integrity check failed');
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw Object.assign(Error('DATABASE_MIGRATION_FAILED', { cause }), {
      code: 'DATABASE_MIGRATION_FAILED',
      backup,
    });
  }
}
