import { migrateDatabase } from './migrations.ts';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  const result = canonical(value);
  if (Buffer.byteLength(result) > 1024 * 1024) fail('INPUT_TOO_LARGE');
  return result;
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

/** Single local controller. Every network caller must authenticate before reaching this layer. */
export class Store {
  closed = false;
  db!: DatabaseSync;
  controller?: DatabaseSync | null;
  constructor(filename: string) {
    this.closed = false;
    try {
      if (filename !== ':memory:') {
        mkdirSync(dirname(filename), { recursive: true });
        this.controller = new DatabaseSync(filename + '.controller');
        try {
          this.controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
        } catch {
          this.controller.close();
          this.controller = null;
          fail('CONTROLLER_BUSY');
        }
      }
      const version = checkDatabase(filename);
      this.db = new DatabaseSync(filename);
      migrateDatabase(this.db, filename, version);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(`
        UPDATE commands SET state='unknown' WHERE state='running';
        UPDATE connections SET connected=0;
        UPDATE commands SET state='cancelled' WHERE state='queued';`);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db?.close();
    } finally {
      this.controller?.close();
    }
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  project(id: string) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ? projectRow.parse(row) : fail('NOT_FOUND');
  }
  createProject(name: unknown) {
    const row = { id: randomUUID(), name: text(name, 200) };
    this.db.prepare('INSERT INTO projects VALUES(?,?)').run(row.id, row.name);
    return row;
  }
  renameProject(id: string, name: unknown) {
    this.project(id);
    const row = { id, name: text(name, 200) };
    this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(row.name, id);
    return row;
  }
  /** A project listed for this PC on the account site: create it here, or follow its name. */
  ensureProject(id: string, name: string) {
    const row = { id, name: text(name, 200) };
    const current = this.db.prepare('SELECT name FROM projects WHERE id=?').get(id);
    if (!current) this.db.prepare('INSERT INTO projects VALUES(?,?)').run(id, row.name);
    else if (current.name !== row.name)
      this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(row.name, id);
    return !current || current.name !== row.name;
  }
  /** Last request time per project (ms), for recent-first listing on the account site. */
  projectActivity() {
    const activity: Record<string, number> = {};
    for (const row of this.db
      .prepare('SELECT projectId, MAX(createdAt) AS at FROM workspace_requests GROUP BY projectId')
      .all()) {
      const at = Date.parse(String(row.at));
      if (Number.isFinite(at)) activity[String(row.projectId)] = at;
    }
    return activity;
  }
  /**
   * Delete a project and every row it owns, children first (foreign keys are on). Files are the
   * caller's (see server/project-removal.ts). Refuses while one of its requests is still running.
   */
  deleteProject(id: string) {
    this.project(id);
    return this.tx(() => {
      const busy = this.db
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
        'DELETE FROM review_notes WHERE projectId=?',
        'DELETE FROM review_snapshots WHERE projectId=?',
        'DELETE FROM shared_feedback WHERE projectId=?',
        'DELETE FROM publication_exports WHERE projectId=?',
        'DELETE FROM table_views WHERE projectId=?',
        'DELETE FROM hidden_requests WHERE projectId=?',
        'DELETE FROM workspace_requests WHERE projectId=?',
        'DELETE FROM document_links WHERE projectId=?',
        'DELETE FROM approvals WHERE projectId=?',
        'DELETE FROM commands WHERE projectId=?',
        'DELETE FROM runs WHERE projectId=?',
        'DELETE FROM inputs WHERE projectId=?',
        'DELETE FROM connections WHERE projectId=?',
        'DELETE FROM projects WHERE id=?',
      ])
        this.db.prepare(sql).run(id);
      return { id };
    });
  }
  listProjects() {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY rowid')
      .all()
      .map((row) => projectRow.parse(row));
  }
  connection(projectId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM connections WHERE id=? AND projectId=?')
      .get(id, projectId);
    return row ? connectionRow.parse(row) : fail('TARGET_MISMATCH');
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
    return this.tx(() => {
      const duplicate = this.db
        .prepare(
          `SELECT id FROM connections WHERE host=? AND instanceId=? AND documentId=? AND connected=1`,
        )
        .get(row.host, row.instanceId, row.documentId);
      if (duplicate) fail('DOCUMENT_ALREADY_CONNECTED');
      this.db
        .prepare('INSERT INTO connections VALUES(?,?,?,?,?,1)')
        .run(row.id, projectId, row.host, row.instanceId, row.documentId);
      return row;
    });
  }
  disconnect(connectionId: string) {
    this.tx(() => {
      this.db.prepare('UPDATE connections SET connected=0 WHERE id=?').run(connectionId);
      this.db
        .prepare("UPDATE commands SET state='unknown' WHERE connectionId=? AND state='running'")
        .run(connectionId);
      this.db
        .prepare("UPDATE commands SET state='cancelled' WHERE connectionId=? AND state='queued'")
        .run(connectionId);
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
    this.db.prepare('INSERT INTO inputs VALUES(?,?,1,?)').run(id, projectId, json(body));
    return this.getInput(projectId, id);
  }
  getInput(projectId: string, id: string) {
    const row = this.db
      .prepare('SELECT * FROM inputs WHERE id=? AND projectId=?')
      .get(id, projectId);
    if (!row) fail('NOT_FOUND');
    return decodeInput(row);
  }
  listInputs(projectId: string) {
    this.project(projectId);
    return this.db
      .prepare('SELECT * FROM inputs WHERE projectId=? ORDER BY rowid DESC')
      .all(projectId)
      .map(decodeInput);
  }
  updateInput(projectId: string, id: string, revision: number, body: unknown) {
    this.validateInput(projectId, body);
    return this.tx(() => {
      if (this.getInput(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      this.db
        .prepare('UPDATE inputs SET revision=revision+1,body=? WHERE id=? AND projectId=?')
        .run(json(body), id, projectId);
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
    this.db.prepare('INSERT INTO runs VALUES(?,?,1,?,?)').run(id, projectId, goal, json(targets));
    return this.getRun(projectId, id);
  }
  getRun(projectId: string, id: string) {
    const row = this.db.prepare('SELECT * FROM runs WHERE projectId=? AND id=?').get(projectId, id);
    if (!row) fail('NOT_FOUND');
    return decodeRun(row);
  }
  reviseRun(projectId: string, id: string, revision: number, goal: string) {
    text(goal);
    return this.tx(() => {
      if (this.getRun(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      this.db
        .prepare('UPDATE runs SET revision=revision+1,goal=? WHERE id=? AND projectId=?')
        .run(goal, id, projectId);
      this.db
        .prepare("UPDATE commands SET state='cancelled',stale=1 WHERE runId=? AND state='queued'")
        .run(id);
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
    this.db
      .prepare(
        'INSERT INTO approvals VALUES(?,?,?) ON CONFLICT(commandId) DO UPDATE SET hash=excluded.hash WHERE approvals.projectId=excluded.projectId',
      )
      .run(command.id, projectId, digest(command));
  }
  hasUncertainWrite(connectionId: string) {
    // A fresh transport connection is not evidence that an earlier native write failed.
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM commands command
      JOIN connections previous ON command.connectionId=previous.id
      JOIN connections current ON current.id=?
      WHERE command.state='unknown' AND command.kind!='sync'
      AND previous.host=current.host AND previous.instanceId=current.instanceId
      AND previous.documentId=current.documentId`,
        )
        .get(connectionId),
    );
  }
  enqueue(projectId: string, raw: unknown) {
    const command = request(raw),
      hash = digest(command);
    return this.tx(() => {
      this.project(projectId);
      const existing = this.db.prepare('SELECT * FROM commands WHERE id=?').get(command.id);
      if (existing) {
        if (existing.projectId !== projectId || existing.hash !== hash)
          fail('IDEMPOTENCY_CONFLICT');
        return decode(existing);
      }
      this.validateTarget(projectId, command);
      if (isWrite(command.kind) && this.hasUncertainWrite(command.connectionId))
        fail('WRITE_UNCERTAIN');
      if (command.kind === 'applyCandidate') {
        const approval = this.db
          .prepare('SELECT hash FROM approvals WHERE commandId=? AND projectId=?')
          .get(command.id, projectId);
        if (approval?.hash !== hash) fail('APPROVAL_REQUIRED');
      }
      this.db
        .prepare(
          `INSERT INTO commands(id,projectId,runId,connectionId,revision,kind,payload,hash,state)
        VALUES(?,?,?,?,?,?,?,?,'queued')`,
        )
        .run(
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
    const row = this.db
      .prepare('SELECT * FROM commands WHERE projectId=? AND id=?')
      .get(projectId, id);
    return decode(row) ?? fail('NOT_FOUND');
  }
  lease(connectionId: string) {
    return this.tx(() => {
      const connection = this.db.prepare('SELECT * FROM connections WHERE id=?').get(connectionId);
      if (!connection?.connected) return null;
      if (
        this.db
          .prepare("SELECT 1 FROM commands WHERE connectionId=? AND state='running'")
          .get(connectionId)
      )
        return null;
      const uncertain = this.hasUncertainWrite(connectionId);
      const rows = this.db
        .prepare("SELECT * FROM commands WHERE connectionId=? AND state='queued' ORDER BY rowid")
        .all(connectionId);
      for (const raw of rows) {
        const row = commandRow.parse(raw);
        if (uncertain && isWrite(row.kind)) continue;
        if (this.getRun(row.projectId, row.runId).revision !== row.revision) {
          this.db.prepare("UPDATE commands SET state='cancelled',stale=1 WHERE id=?").run(row.id);
          continue;
        }
        this.db.prepare("UPDATE commands SET state='running' WHERE id=?").run(row.id);
        return this.getCommand(row.projectId, row.id);
      }
      return null;
    });
  }
  complete(connectionId: string, commandId: string, outcome: { state: string; result?: unknown }) {
    if (!['succeeded', 'failed', 'unknown'].includes(outcome?.state)) fail('INVALID_RESULT');
    const encoded = json(outcome.result ?? null);
    return this.tx(() => {
      const raw = this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
      if (!raw) fail('TARGET_MISMATCH');
      const row = commandRow.parse(raw);
      if (row.connectionId !== connectionId) fail('TARGET_MISMATCH');
      if (!['running', 'unknown'].includes(row.state)) {
        if (row.state === outcome.state && row.result === encoded) return decode(row);
        fail('INVALID_TRANSITION');
      }
      const stale = this.getRun(row.projectId, row.runId).revision !== row.revision;
      this.db
        .prepare('UPDATE commands SET state=?,result=?,stale=? WHERE id=?')
        .run(outcome.state, encoded, Number(stale), row.id);
      return this.getCommand(row.projectId, row.id);
    });
  }
}
