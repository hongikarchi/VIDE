import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const schemaVersion = 2;
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
export type Migration = {version:number; sql:string};
const migrations:Migration[] = [{version:2, sql:baselineSchema}];

/** Caller holds the exclusive controller lock. Never migrates user model files. */
export function migrateDatabase(db:DatabaseSync, filename:string, current:number, steps:Migration[]=migrations) {
  if (current === schemaVersion) return;
  if (![0,1].includes(current)) throw Object.assign(Error('UNSUPPORTED_SCHEMA'),{code:'UNSUPPORTED_SCHEMA'});
  let backup:string|undefined;
  if (current > 0 && filename !== ':memory:') {
    const directory = filename + '.backups';
    try {
      mkdirSync(directory,{recursive:true});
      backup = join(directory,`schema-${current}-${randomUUID()}.sqlite`);
      // SQLite snapshots include committed WAL pages; copying only the .sqlite file would not.
      db.prepare('VACUUM INTO ?').run(backup);
      const snapshot = new DatabaseSync(backup,{readOnly:true});
      try {
        if (Object.values(snapshot.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw Error('Invalid backup');
      } finally {snapshot.close();}
    } catch (cause) {throw Object.assign(Error('DATABASE_BACKUP_FAILED',{cause}),{code:'DATABASE_BACKUP_FAILED'});}
  }
  db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
  try {
    if (current === 0) db.exec('CREATE TABLE schema_version(version INTEGER NOT NULL); INSERT INTO schema_version VALUES(1)');
    let version = current || 1;
    for (const step of steps) {
      if (step.version <= version) continue;
      if (step.version !== version + 1) throw Error('Non-sequential migration');
      db.exec(step.sql);
      db.prepare('UPDATE schema_version SET version=?').run(step.version);
      version = step.version;
    }
    if (version !== schemaVersion) throw Error('Missing migration');
    if (db.prepare('PRAGMA foreign_key_check').all().length || Object.values(db.prepare('PRAGMA quick_check').get()!)[0] !== 'ok') throw Error('Migration integrity check failed');
    db.exec('COMMIT');
  } catch (cause) {
    db.exec('ROLLBACK');
    throw Object.assign(Error('DATABASE_MIGRATION_FAILED',{cause}),{code:'DATABASE_MIGRATION_FAILED',backup});
  }
}
