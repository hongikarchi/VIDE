import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** v5 and later cannot be opened by an older installation (UNSUPPORTED_SCHEMA); see ARCH-03 §10.1. */
export const schemaVersion = 8;
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
export const migrations: Migration[] = [
  { version: 2, sql: baselineSchema },
  { version: 3, sql: hiddenRequests },
  { version: 4, sql: documentLinks },
  { version: 5, sql: conversationsAndJigs },
  { version: 6, sql: projectFolders },
  { version: 7, sql: agendaItems },
  { version: 8, sql: agendaKinds },
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
