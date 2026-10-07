import { migrateDatabase } from './migrations.ts';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { checkDatabase } from './database-check.ts';

import { DomainError } from '../contracts/errors.ts';
export { DomainError } from '../contracts/errors.ts';
function fail(code: string): never {
  throw new DomainError(code);
}
const kinds = new Set(['sync', 'createCandidate', 'applyCandidate', 'discardCandidate']);
const isWrite = (kind: string) => kind !== 'sync';
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  fail('INVALID_INPUT');
}
function json(value: unknown) {
  // No size cap (ADR-031 7): a host command's payload or result is stored whole.
  return canonical(value);
}
function text(value: unknown, max = 10000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT');
  return value;
}
const projectRow = z.object({ id: z.string(), name: z.string() });
const connectionRow = z.object({
  id: z.string(),
  projectId: z.string(),
  host: z.enum(['rhino', 'zwcad']),
  instanceId: z.string(),
  documentId: z.string(),
  connected: z.number(),
});
const inputBody = z
  .object({
    text: z.string(),
    pins: z
      .array(z.object({ connectionId: z.string(), objectId: z.string() }).passthrough())
      .optional(),
  })
  .passthrough();
const inputRow = z.object({
  id: z.string(),
  projectId: z.string(),
  revision: z.number(),
  body: z.string(),
});
const runRow = z.object({
  id: z.string(),
  projectId: z.string(),
  revision: z.number(),
  goal: z.string(),
  targets: z.string(),
});
const commandSchema = z.object({
  id: z.string(),
  runId: z.string(),
  connectionId: z.string(),
  revision: z.number().int().positive(),
  kind: z.enum(['sync', 'createCandidate', 'applyCandidate', 'discardCandidate']),
  payload: z.record(z.string(), z.unknown()),
});
type Command = z.infer<typeof commandSchema>;
const commandRow = commandSchema.omit({ payload: true }).extend({
  projectId: z.string(),
  payload: z.string(),
  hash: z.string(),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled']),
  result: z.string().nullable(),
  stale: z.number(),
});
function request(value: unknown): Command {
  const kind = value && typeof value === 'object' && 'kind' in value ? value.kind : undefined;
  if (typeof kind !== 'string' || !kinds.has(kind)) fail('INVALID_COMMAND');
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) fail('INVALID_INPUT');
  const command = parsed.data;
  for (const key of ['id', 'runId', 'connectionId'] as const) text(command[key], 200);
  return command;
}
const digest = (value: unknown) => createHash('sha256').update(json(value)).digest('hex');
function decode(row: unknown) {
  if (!row) return null;
  const value = commandRow.parse(row);
  return {
    ...value,
    payload: z.record(z.string(), z.unknown()).parse(JSON.parse(value.payload)),
    result: value.result === null ? null : (JSON.parse(value.result) as unknown),
    stale: Boolean(value.stale),
  };
}
function decodeInput(row: unknown) {
  const value = inputRow.parse(row);
  return { ...value, body: inputBody.parse(JSON.parse(value.body)) };
}
function decodeRun(row: unknown) {
  const value = runRow.parse(row);
  return { ...value, targets: z.array(z.string()).parse(JSON.parse(value.targets)) };
}

/** Where a Store keeps its data (ADR-032, ARCH-01 §5). */
export type StoreLocation =
  /**
   * `':memory:'`: the split layout in memory (one in-memory DB per project). A file path: one DB
   * for everything (the old `vide.sqlite`, used while it cannot be split).
   */
  | string
  /** The split layout on disk: `<directory>/app.sqlite`, `<directory>/projects/<id>/project.sqlite`. */
  | { directory: string };
const safeProjectId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id);
/** A project's data folder in the split layout (its DB and knowledge DB). */
export const projectFolder = (directory: string, projectId: string) =>
  safeProjectId(projectId) ? join(directory, 'projects', projectId) : fail('INVALID_INPUT');
/**
 * Request id → project, so a lookup by request id alone opens one project DB (split layout). A
 * cache of the project DBs, rebuilt at each start; not part of the versioned schema.
 */
const REQUEST_INDEX =
  'CREATE TABLE IF NOT EXISTS request_index(id TEXT PRIMARY KEY, projectId TEXT NOT NULL) WITHOUT ROWID';

function openDatabase(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const version = checkDatabase(filename);
  const db = new DatabaseSync(filename);
  try {
    migrateDatabase(db, filename, version);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    db.exec(`
        UPDATE commands SET state='unknown' WHERE state='running';
        UPDATE connections SET connected=0;
        UPDATE commands SET state='cancelled' WHERE state='queued';`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Single local controller. Every network caller must authenticate before reaching this layer.
 *
 * Split layout (ADR-032, ARCH-01 §5): `app` holds what belongs to no project (projects, AI
 * settings, extension registrations, jig packages) and each project's rows live in its own DB,
 * `db(projectId)`; all are opened at start and kept open. Every DB has the full schema, and a
 * project DB keeps its own `projects` row so foreign keys and the existing SQL work unchanged.
 * Checks that span projects (a request id, a command id, an open document connected once, a
 * feedback identity) look through `databases()` or the request index in `app`. In the single
 * layout one DB plays every part, exactly as before the split.
 */
export class Store {
  closed = false;
  readonly layout: 'single' | 'split';
  /** The data folder of the split layout on disk (undefined in memory or for a single file). */
  readonly directory?: string;
  /** The shared DB (app.sqlite); in the single layout, the one DB. */
  app!: DatabaseSync;
  controller?: DatabaseSync | null;
  private readonly projectDbs = new Map<string, DatabaseSync>();
  constructor(location: StoreLocation) {
    const memory = location === ':memory:';
    this.layout = typeof location === 'string' && !memory ? 'single' : 'split';
    this.directory = typeof location === 'string' ? undefined : resolve(location.directory);
    try {
      if (!memory) {
        // One lock per data folder: the same file in both layouts and for the split and backup tools.
        const lock = this.directory ? join(this.directory, 'vide.sqlite') : (location as string);
        mkdirSync(dirname(lock), { recursive: true });
        this.controller = new DatabaseSync(lock + '.controller');
        try {
          this.controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        } catch {
          this.controller.close();
          this.controller = null;
          fail('CONTROLLER_BUSY');
        }
      }
      this.app = openDatabase(
        this.directory ? join(this.directory, 'app.sqlite') : (location as string),
      );
      if (this.layout === 'split') {
        this.app.exec(REQUEST_INDEX);
        for (const project of this.listProjects()) this.openProject(project.id, project.name);
        this.reindexRequests();
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const db of this.projectDbs.values()) db.close();
      this.projectDbs.clear();
      this.app?.close();
    } finally {
      this.controller?.close();
    }
  }
  /** The DB holding a project's rows. NOT_FOUND for a project this PC does not have. */
  db(projectId: string): DatabaseSync {
    if (this.layout === 'single') return this.app;
    return this.projectDbs.get(projectId) ?? fail('NOT_FOUND');
  }
  /** Every DB that holds project rows, in project order (the one DB in the single layout). */
  databases(): DatabaseSync[] {
    return this.layout === 'single' ? [this.app] : [...this.projectDbs.values()];
  }
  /** The data folder: the split layout's, or the single file's folder (undefined in memory). */
  dataDirectory(): string | undefined {
    if (this.directory) return this.directory;
    const file = this.layout === 'single' ? this.app.location() : null;
    return file ? dirname(file) : undefined;
  }
  /** A project's data folder (split layout on disk only). */
  folder(projectId: string) {
    return this.directory && safeProjectId(projectId)
      ? projectFolder(this.directory, projectId)
      : undefined;
  }
  /** Opens (creating when new) a project's DB and keeps its `projects` row in step with app's. */
  private openProject(id: string, name: string) {
    if (this.layout === 'single') return;
    let db = this.projectDbs.get(id);
    if (!db) {
      db = openDatabase(
        this.directory ? join(projectFolder(this.directory, id), 'project.sqlite') : ':memory:',
      );
      this.projectDbs.set(id, db);
    }
    const row = db.prepare('SELECT name FROM projects WHERE id=?').get(id);
    if (!row) db.prepare('INSERT INTO projects VALUES(?,?)').run(id, name);
    else if (row.name !== name) db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, id);
  }
  /** The project a request belongs to, by its id alone: the request index, else every project. */
  projectOfRequest(requestId: string): string | undefined {
    const has = (db: DatabaseSync) =>
      db.prepare('SELECT projectId FROM workspace_requests WHERE id=?').get(requestId);
    if (this.layout === 'single') {
      const row = has(this.app);
      return row ? String(row.projectId) : undefined;
    }
    const indexed = this.app
      .prepare('SELECT projectId FROM request_index WHERE id=?')
      .get(requestId);
    const known = indexed && this.projectDbs.get(String(indexed.projectId));
    if (known && has(known)) return String(indexed.projectId);
    // Not indexed (a row written straight into a project DB) or stale: look and repair.
    for (const [projectId, db] of this.projectDbs)
      if (has(db)) {
        this.indexRequest(requestId, projectId);
        return projectId;
      }
    if (indexed) this.app.prepare('DELETE FROM request_index WHERE id=?').run(requestId);
    return undefined;
  }
  /** Records a new request's project in the request index (split layout). */
  indexRequest(requestId: string, projectId: string) {
    if (this.layout === 'split')
      this.app
        .prepare('INSERT OR REPLACE INTO request_index VALUES(?,?)')
        .run(requestId, projectId);
  }
  /** Drops deleted requests from the request index (split layout). */
  unindexRequests(requestIds: readonly string[]) {
    if (this.layout !== 'split') return;
    const drop = this.app.prepare('DELETE FROM request_index WHERE id=?');
    for (const id of requestIds) drop.run(id);
  }
  /** Rebuilds the request index from the project DBs (at each start: it only caches them). */
  private reindexRequests() {
    this.tx(this.app, () => {
      this.app.exec('DELETE FROM request_index');
      const insert = this.app.prepare('INSERT OR IGNORE INTO request_index VALUES(?,?)');
      for (const [projectId, db] of this.projectDbs)
        for (const row of db.prepare('SELECT id FROM workspace_requests').iterate())
          insert.run(String(row.id), projectId);
    });
  }
  /** The first project DB where `sql` finds a row (checks that span every project). */
  findDb(sql: string, ...args: (string | number)[]) {
    for (const db of this.databases()) if (db.prepare(sql).get(...args)) return db;
    return undefined;
  }
  tx<T>(db: DatabaseSync, fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  project(id: string) {
    const row = this.app.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? projectRow.parse(row) : fail('NOT_FOUND');
  }
  createProject(name: unknown) {
    const row = { id: randomUUID(), name: text(name, 200) };
    this.app.prepare('INSERT INTO projects VALUES(?,?)').run(row.id, row.name);
    this.openProject(row.id, row.name);
    return row;
  }
  renameProject(id: string, name: unknown) {
    this.project(id);
    const row = { id, name: text(name, 200) };
    this.app.prepare('UPDATE projects SET name=? WHERE id=?').run(row.name, id);
    this.openProject(id, row.name);
    return row;
  }
  /** A project listed for this PC on the account site: create it here, or follow its name. */
  ensureProject(id: string, name: string) {
    const row = { id, name: text(name, 200) };
    if (this.layout === 'split' && this.directory && !safeProjectId(id)) fail('INVALID_INPUT');
    const current = this.app.prepare('SELECT name FROM projects WHERE id=?').get(id);
    if (!current) this.app.prepare('INSERT INTO projects VALUES(?,?)').run(id, row.name);
    else if (current.name !== row.name)
      this.app.prepare('UPDATE projects SET name=? WHERE id=?').run(row.name, id);
    this.openProject(id, row.name);
    return !current || current.name !== row.name;
  }
  /** Last request time per project (ms), for recent-first listing on the account site. */
  projectActivity() {
    const activity: Record<string, number> = {};
    for (const db of this.databases())
      for (const row of db
        .prepare(
          'SELECT projectId, MAX(createdAt) AS at FROM workspace_requests GROUP BY projectId',
        )
        .all()) {
        const at = Date.parse(String(row.at));
        if (Number.isFinite(at)) activity[String(row.projectId)] = at;
      }
    return activity;
  }
  /**
   * Delete a project and every row it owns. Split layout: its DB is closed and its data folder
   * removed (ADR-032). Single layout: its rows, children first (foreign keys are on). Other files
   * are the caller's (see server/project-removal.ts). Refuses while one of its requests runs.
   */
  deleteProject(id: string) {
    this.project(id);
    if (this.layout === 'split') {
      const db = this.db(id);
      if (
        db
          .prepare(
            "SELECT 1 FROM workspace_requests WHERE projectId=? AND state IN ('queued','running') LIMIT 1",
          )
          .get(id)
      )
        fail('PROJECT_BUSY');
      this.tx(this.app, () => {
        this.app.prepare('DELETE FROM request_index WHERE projectId=?').run(id);
        this.app.prepare('DELETE FROM projects WHERE id=?').run(id);
      });
      this.projectDbs.delete(id);
      db.close();
      const folder = this.folder(id);
      // A file still open elsewhere (an AI's read) may refuse; the project is gone either way.
      if (folder)
        try {
          rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* Left behind: an unknown project folder is never opened again. */
        }
      return { id };
    }
    return this.tx(this.app, () => {
      const busy = this.app
        .prepare(
          "SELECT 1 FROM workspace_requests WHERE projectId=? AND state IN ('queued','running') LIMIT 1",
        )
        .get(id);
      if (busy) fail('PROJECT_BUSY');
      const instances = 'SELECT id FROM jig_instances WHERE projectId=?',
        conversations = 'SELECT id FROM conversations WHERE projectId=?';
      for (const sql of [
        `DELETE FROM jig_param_log WHERE instanceId IN (${instances})`,
        `DELETE FROM jig_runs WHERE instanceId IN (${instances})`,
        `DELETE FROM jig_bakes WHERE instanceId IN (${instances})`,
        `DELETE FROM jig_reads WHERE instanceId IN (${instances})`,
        'DELETE FROM jig_instances WHERE projectId=?',
        `DELETE FROM provider_sessions WHERE conversationId IN (${conversations})`,
        `DELETE FROM ledger_items WHERE conversationId IN (${conversations})`,
        'DELETE FROM conversations WHERE projectId=?',
        'DELETE FROM jig_drafts WHERE projectId=?',
        'DELETE FROM project_jigs WHERE projectId=?',
        'DELETE FROM knowledge_reviews WHERE projectId=?',
        'DELETE FROM knowledge_source_rules WHERE projectId=?',
        'DELETE FROM project_roots WHERE projectId=?',
        'DELETE FROM project_folders WHERE projectId=?',
        'DELETE FROM agenda_items WHERE projectId=?',
        'DELETE FROM day_log WHERE projectId=?',
        'DELETE FROM finish_rooms WHERE projectId=?',
        'DELETE FROM finish_sheets WHERE projectId=?',
        'DELETE FROM drawing_reads WHERE projectId=?',
        'DELETE FROM drawing_layer_maps WHERE projectId=?',
        'DELETE FROM review_notes WHERE projectId=?',
        'DELETE FROM review_snapshots WHERE projectId=?',
        'DELETE FROM shared_feedback WHERE projectId=?',
        'DELETE FROM publication_exports WHERE projectId=?',
        'DELETE FROM table_views WHERE projectId=?',
        'DELETE FROM hidden_requests WHERE projectId=?',
        // Sync manifests go with their request rows (ON DELETE CASCADE); then the object versions.
        'DELETE FROM workspace_requests WHERE projectId=?',
        'DELETE FROM object_versions WHERE projectId=?',
        'DELETE FROM document_links WHERE projectId=?',
        'DELETE FROM approvals WHERE projectId=?',
        'DELETE FROM commands WHERE projectId=?',
        'DELETE FROM runs WHERE projectId=?',
        'DELETE FROM inputs WHERE projectId=?',
        'DELETE FROM connections WHERE projectId=?',
        'DELETE FROM projects WHERE id=?',
      ])
        this.app.prepare(sql).run(id);
      return { id };
    });
  }
  /**
   * Gives the space of deleted rows back to the disk (VACUUM) once free pages are a large share of
   * a file: deleting rows alone leaves the file as big as before. Each DB is weighed on its own.
   * False when every one was skipped or busy.
   */
  compact({ minShare = 0.25, minPages = 1024 } = {}) {
    let done = false;
    for (const db of new Set([this.app, ...this.databases()])) {
      const pragma = (name: string) =>
        Number(Object.values(db.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? 0);
      const pages = pragma('page_count'),
        free = pragma('freelist_count');
      if (free < minPages || free < pages * minShare) continue;
      try {
        db.exec('VACUUM');
        done = true;
      } catch {
        // Another reader or an open transaction: the next deletion tries again.
      }
    }
    return done;
  }
  listProjects() {
    return this.app
      .prepare('SELECT * FROM projects ORDER BY rowid')
      .all()
      .map((row) => projectRow.parse(row));
  }
  connection(projectId: string, id: string) {
    const row = this.db(projectId)
      .prepare('SELECT * FROM connections WHERE id=? AND projectId=?')
      .get(id, projectId);
    return row ? connectionRow.parse(row) : fail('TARGET_MISMATCH');
  }
  /** The connected row of one open host document, in whichever project holds it. */
  connectedDocument(host: string, instanceId: string, documentId: string) {
    const sql =
      'SELECT * FROM connections WHERE host=? AND instanceId=? AND documentId=? AND connected=1';
    for (const db of this.databases()) {
      const row = db.prepare(sql).get(host, instanceId, documentId);
      if (row) return connectionRow.parse(row);
    }
    return undefined;
  }
  /** The DB holding a host connection row (connection ids are unique across projects). */
  private connectionDb(connectionId: string) {
    return this.findDb('SELECT 1 FROM connections WHERE id=?', connectionId);
  }
  registerConnection(
    projectId: string,
    source: { host: string; instanceId: string; documentId: string },
  ) {
    this.project(projectId);
    if (!['rhino', 'zwcad'].includes(source.host)) fail('INVALID_HOST');
    const row = {
      id: randomUUID(),
      projectId,
      host: source.host,
      instanceId: text(source.instanceId, 200),
      documentId: text(source.documentId, 200),
      connected: 1,
    };
    const db = this.db(projectId);
    return this.tx(db, () => {
      // One open document is connected to one project at a time, across every project DB.
      if (this.connectedDocument(row.host, row.instanceId, row.documentId))
        fail('DOCUMENT_ALREADY_CONNECTED');
      db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,1)').run(
        row.id,
        projectId,
        row.host,
        row.instanceId,
        row.documentId,
      );
      return row;
    });
  }
  disconnect(connectionId: string) {
    const db = this.connectionDb(connectionId);
    if (!db) return;
    this.tx(db, () => {
      db.prepare('UPDATE connections SET connected=0 WHERE id=?').run(connectionId);
      db.prepare(
        "UPDATE commands SET state='unknown' WHERE connectionId=? AND state='running'",
      ).run(connectionId);
      db.prepare(
        "UPDATE commands SET state='cancelled' WHERE connectionId=? AND state='queued'",
      ).run(connectionId);
    });
  }
  validateInput(projectId: string, body: unknown) {
    this.project(projectId);
    json(body);
    const parsed = inputBody.safeParse(body);
    if (!parsed.success) fail('INVALID_INPUT');
    for (const pin of parsed.data.pins ?? []) {
      this.connection(projectId, pin.connectionId);
      text(pin.objectId, 200);
    }
  }

  saveInput(projectId: string, body: unknown) {
    this.validateInput(projectId, body);
    const id = randomUUID();
    this.db(projectId).prepare('INSERT INTO inputs VALUES(?,?,1,?)').run(id, projectId, json(body));
    return this.getInput(projectId, id);
  }
  getInput(projectId: string, id: string) {
    const row = this.db(projectId)
      .prepare('SELECT * FROM inputs WHERE id=? AND projectId=?')
      .get(id, projectId);
    if (!row) fail('NOT_FOUND');
    return decodeInput(row);
  }
  listInputs(projectId: string) {
    this.project(projectId);
    return this.db(projectId)
      .prepare('SELECT * FROM inputs WHERE projectId=? ORDER BY rowid DESC')
      .all(projectId)
      .map(decodeInput);
  }
  updateInput(projectId: string, id: string, revision: number, body: unknown) {
    this.validateInput(projectId, body);
    const db = this.db(projectId);
    return this.tx(db, () => {
      if (this.getInput(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      db.prepare('UPDATE inputs SET revision=revision+1,body=? WHERE id=? AND projectId=?').run(
        json(body),
        id,
        projectId,
      );
      return this.getInput(projectId, id);
    });
  }
  createRun(projectId: string, { goal, targets }: { goal: string; targets: string[] }) {
    this.project(projectId);
    text(goal);
    if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length)
      fail('INVALID_INPUT');
    for (const id of targets) {
      if (!this.connection(projectId, id).connected) fail('DISCONNECTED');
    }
    const id = randomUUID();
    this.db(projectId)
      .prepare('INSERT INTO runs VALUES(?,?,1,?,?)')
      .run(id, projectId, goal, json(targets));
    return this.getRun(projectId, id);
  }
  getRun(projectId: string, id: string) {
    const row = this.db(projectId)
      .prepare('SELECT * FROM runs WHERE projectId=? AND id=?')
      .get(projectId, id);
    if (!row) fail('NOT_FOUND');
    return decodeRun(row);
  }
  reviseRun(projectId: string, id: string, revision: number, goal: string) {
    text(goal);
    const db = this.db(projectId);
    return this.tx(db, () => {
      if (this.getRun(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      db.prepare('UPDATE runs SET revision=revision+1,goal=? WHERE id=? AND projectId=?').run(
        goal,
        id,
        projectId,
      );
      db.prepare(
        "UPDATE commands SET state='cancelled',stale=1 WHERE runId=? AND state='queued'",
      ).run(id);
      return this.getRun(projectId, id);
    });
  }
  validateTarget(projectId: string, command: Command) {
    const run = this.getRun(projectId, command.runId);
    if (run.revision !== command.revision) fail('REVISION_CONFLICT');
    const connection = this.connection(projectId, command.connectionId);
    if (!run.targets.includes(connection.id)) fail('TARGET_MISMATCH');
    if (!connection.connected) fail('DISCONNECTED');
    return run;
  }
  approve(projectId: string, raw: unknown, authority: string) {
    if (authority !== 'local-controller') fail('FORBIDDEN');
    const command = request(raw);
    this.validateTarget(projectId, command);
    this.db(projectId)
      .prepare(
        'INSERT INTO approvals VALUES(?,?,?) ON CONFLICT(commandId) DO UPDATE SET hash=excluded.hash WHERE approvals.projectId=excluded.projectId',
      )
      .run(command.id, projectId, digest(command));
  }
  hasUncertainWrite(connectionId: string) {
    // A fresh transport connection is not evidence that an earlier native write failed. The same
    // host document may have been connected from another project: every project DB is asked.
    const db = this.connectionDb(connectionId);
    const current = db?.prepare('SELECT * FROM connections WHERE id=?').get(connectionId);
    if (!current) return false;
    return this.databases().some((other) =>
      Boolean(
        other
          .prepare(
            `SELECT 1 FROM commands command
      JOIN connections previous ON command.connectionId=previous.id
      WHERE command.state='unknown' AND command.kind!='sync'
      AND previous.host=? AND previous.instanceId=? AND previous.documentId=?`,
          )
          .get(String(current.host), String(current.instanceId), String(current.documentId)),
      ),
    );
  }
  enqueue(projectId: string, raw: unknown) {
    const command = request(raw),
      hash = digest(command);
    this.project(projectId);
    const db = this.db(projectId);
    return this.tx(db, () => {
      // Command ids are unique across every project.
      const owner = this.findDb('SELECT 1 FROM commands WHERE id=?', command.id);
      const existing = owner?.prepare('SELECT * FROM commands WHERE id=?').get(command.id);
      if (existing) {
        if (existing.projectId !== projectId || existing.hash !== hash)
          fail('IDEMPOTENCY_CONFLICT');
        return decode(existing);
      }
      this.validateTarget(projectId, command);
      if (isWrite(command.kind) && this.hasUncertainWrite(command.connectionId))
        fail('WRITE_UNCERTAIN');
      if (command.kind === 'applyCandidate') {
        const approval = db
          .prepare('SELECT hash FROM approvals WHERE commandId=? AND projectId=?')
          .get(command.id, projectId);
        if (approval?.hash !== hash) fail('APPROVAL_REQUIRED');
      }
      db.prepare(
        `INSERT INTO commands(id,projectId,runId,connectionId,revision,kind,payload,hash,state)
        VALUES(?,?,?,?,?,?,?,?,'queued')`,
      ).run(
        command.id,
        projectId,
        command.runId,
        command.connectionId,
        command.revision,
        command.kind,
        json(command.payload),
        hash,
      );
      return this.getCommand(projectId, command.id);
    });
  }
  getCommand(projectId: string, id: string) {
    const row = this.db(projectId)
      .prepare('SELECT * FROM commands WHERE projectId=? AND id=?')
      .get(projectId, id);
    return decode(row) ?? fail('NOT_FOUND');
  }
  lease(connectionId: string) {
    const db = this.connectionDb(connectionId);
    if (!db) return null;
    return this.tx(db, () => {
      const connection = db.prepare('SELECT * FROM connections WHERE id=?').get(connectionId);
      if (!connection?.connected) return null;
      if (
        db
          .prepare("SELECT 1 FROM commands WHERE connectionId=? AND state='running'")
          .get(connectionId)
      )
        return null;
      const uncertain = this.hasUncertainWrite(connectionId);
      const rows = db
        .prepare("SELECT * FROM commands WHERE connectionId=? AND state='queued' ORDER BY rowid")
        .all(connectionId);
      for (const raw of rows) {
        const row = commandRow.parse(raw);
        if (uncertain && isWrite(row.kind)) continue;
        if (this.getRun(row.projectId, row.runId).revision !== row.revision) {
          db.prepare("UPDATE commands SET state='cancelled',stale=1 WHERE id=?").run(row.id);
          continue;
        }
        db.prepare("UPDATE commands SET state='running' WHERE id=?").run(row.id);
        return this.getCommand(row.projectId, row.id);
      }
      return null;
    });
  }
  complete(connectionId: string, commandId: string, outcome: { state: string; result?: unknown }) {
    if (!['succeeded', 'failed', 'unknown'].includes(outcome?.state)) fail('INVALID_RESULT');
    const encoded = json(outcome.result ?? null);
    const db = this.findDb('SELECT 1 FROM commands WHERE id=?', commandId);
    if (!db) fail('TARGET_MISMATCH');
    return this.tx(db, () => {
      const raw = db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
      if (!raw) fail('TARGET_MISMATCH');
      const row = commandRow.parse(raw);
      if (row.connectionId !== connectionId) fail('TARGET_MISMATCH');
      if (!['running', 'unknown'].includes(row.state)) {
        if (row.state === outcome.state && row.result === encoded) return decode(row);
        fail('INVALID_TRANSITION');
      }
      const stale = this.getRun(row.projectId, row.runId).revision !== row.revision;
      db.prepare('UPDATE commands SET state=?,result=?,stale=? WHERE id=?').run(
        outcome.state,
        encoded,
        Number(stale),
        row.id,
      );
      return this.getCommand(row.projectId, row.id);
    });
  }
}
