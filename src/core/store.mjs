import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkDatabase } from './database-check.mjs';

export class DomainError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new DomainError(code); };
const kinds = new Set(['sync', 'createCandidate', 'applyCandidate', 'discardCandidate']);
const isWrite = kind => kind !== 'sync';
function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  fail('INVALID_INPUT');
}
function json(value) {
  const result = canonical(value);
  if (Buffer.byteLength(result) > 1024 * 1024) fail('INPUT_TOO_LARGE');
  return result;
}
function text(value, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('INVALID_INPUT');
  return value;
}
function request(command) {
  if (!command || !kinds.has(command.kind)) fail('INVALID_COMMAND');
  for (const key of ['id', 'runId', 'connectionId']) text(command[key], 200);
  if (!Number.isSafeInteger(command.revision) || command.revision < 1) fail('INVALID_INPUT');
  if (!command.payload || Array.isArray(command.payload) || typeof command.payload !== 'object') fail('INVALID_INPUT');
  return { id: command.id, runId: command.runId, connectionId: command.connectionId,
    revision: command.revision, kind: command.kind, payload: command.payload };
}
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const decode = row => row ? { ...row, payload: JSON.parse(row.payload),
  result: row.result === null ? null : JSON.parse(row.result), stale: Boolean(row.stale) } : null;

/** Single local controller. Every network caller must authenticate before reaching this layer. */
export class Store {
  constructor(filename) {
    this.closed = false;
    try {
      if (filename !== ':memory:') {
        mkdirSync(dirname(filename), { recursive: true });
        this.controller = new DatabaseSync(filename + '.controller');
        try { this.controller.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
        catch { this.controller.close(); this.controller = null; fail('CONTROLLER_BUSY'); }
      }
      checkDatabase(filename);
      this.db = new DatabaseSync(filename);
      this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
        INSERT INTO schema_version SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);`);
      if (this.db.prepare('SELECT version FROM schema_version').get().version !== 1) fail('UNSUPPORTED_SCHEMA');
      this.db.exec(`
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
        UPDATE commands SET state='unknown' WHERE state='running';
        UPDATE connections SET connected=0;
        UPDATE commands SET state='cancelled' WHERE state='queued';`);
    } catch (error) { this.close(); throw error; }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db?.close(); } finally { this.controller?.close(); }
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  project(id) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    return row ?? fail('NOT_FOUND');
  }
  createProject(name) {
    const row = { id: randomUUID(), name: text(name, 200) };
    this.db.prepare('INSERT INTO projects VALUES(?,?)').run(row.id, row.name); return row;
  }
  listProjects() { return this.db.prepare('SELECT * FROM projects ORDER BY rowid').all(); }
  connection(projectId, id) {
    const row = this.db.prepare('SELECT * FROM connections WHERE id=? AND projectId=?').get(id, projectId);
    return row ?? fail('TARGET_MISMATCH');
  }
  registerConnection(projectId, source) {
    this.project(projectId);
    if (!['rhino', 'zwcad'].includes(source.host)) fail('INVALID_HOST');
    const row = { id: randomUUID(), projectId, host: source.host,
      instanceId: text(source.instanceId, 200), documentId: text(source.documentId, 200), connected: 1 };
    return this.tx(() => {
      const duplicate = this.db.prepare(`SELECT id FROM connections WHERE host=? AND instanceId=? AND documentId=? AND connected=1`)
        .get(row.host, row.instanceId, row.documentId);
      if (duplicate) fail('DOCUMENT_ALREADY_CONNECTED');
      this.db.prepare('INSERT INTO connections VALUES(?,?,?,?,?,1)').run(row.id, projectId, row.host, row.instanceId, row.documentId);
      return row;
    });
  }
  disconnect(connectionId) {
    this.tx(() => {
      this.db.prepare('UPDATE connections SET connected=0 WHERE id=?').run(connectionId);
      this.db.prepare("UPDATE commands SET state='unknown' WHERE connectionId=? AND state='running'").run(connectionId);
      this.db.prepare("UPDATE commands SET state='cancelled' WHERE connectionId=? AND state='queued'").run(connectionId);
    });
  }
  validateInput(projectId, body) {
    this.project(projectId); json(body);
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') fail('INVALID_INPUT');
    if (body.pins !== undefined && !Array.isArray(body.pins)) fail('INVALID_INPUT');
    for (const pin of body.pins ?? []) { this.connection(projectId, pin.connectionId); text(pin.objectId, 200); }
  }
  saveInput(projectId, body) {
    this.validateInput(projectId, body);
    const id = randomUUID(); this.db.prepare('INSERT INTO inputs VALUES(?,?,1,?)').run(id, projectId, json(body));
    return this.getInput(projectId, id);
  }
  getInput(projectId, id) {
    const row = this.db.prepare('SELECT * FROM inputs WHERE id=? AND projectId=?').get(id, projectId);
    if (!row) fail('NOT_FOUND'); return { ...row, body: JSON.parse(row.body) };
  }
  listInputs(projectId) {
    this.project(projectId);
    return this.db.prepare('SELECT * FROM inputs WHERE projectId=? ORDER BY rowid DESC').all(projectId)
      .map(row => ({ ...row, body: JSON.parse(row.body) }));
  }
  updateInput(projectId, id, revision, body) {
    this.validateInput(projectId, body);
    return this.tx(() => {
      if (this.getInput(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      this.db.prepare('UPDATE inputs SET revision=revision+1,body=? WHERE id=? AND projectId=?').run(json(body), id, projectId);
      return this.getInput(projectId, id);
    });
  }
  createRun(projectId, { goal, targets }) {
    this.project(projectId); text(goal);
    if (!Array.isArray(targets) || !targets.length || new Set(targets).size !== targets.length) fail('INVALID_INPUT');
    for (const id of targets) { if (!this.connection(projectId, id).connected) fail('DISCONNECTED'); }
    const id = randomUUID();
    this.db.prepare('INSERT INTO runs VALUES(?,?,1,?,?)').run(id, projectId, goal, json(targets));
    return this.getRun(projectId, id);
  }
  getRun(projectId, id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE projectId=? AND id=?').get(projectId, id);
    if (!row) fail('NOT_FOUND'); return { ...row, targets: JSON.parse(row.targets) };
  }
  reviseRun(projectId, id, revision, goal) {
    text(goal);
    return this.tx(() => {
      if (this.getRun(projectId, id).revision !== revision) fail('REVISION_CONFLICT');
      this.db.prepare('UPDATE runs SET revision=revision+1,goal=? WHERE id=? AND projectId=?').run(goal, id, projectId);
      this.db.prepare("UPDATE commands SET state='cancelled',stale=1 WHERE runId=? AND state='queued'").run(id);
      return this.getRun(projectId, id);
    });
  }
  validateTarget(projectId, command) {
    const run = this.getRun(projectId, command.runId);
    if (run.revision !== command.revision) fail('REVISION_CONFLICT');
    const connection = this.connection(projectId, command.connectionId);
    if (!run.targets.includes(connection.id)) fail('TARGET_MISMATCH');
    if (!connection.connected) fail('DISCONNECTED');
    return run;
  }
  approve(projectId, raw, authority) {
    if (authority !== 'local-controller') fail('FORBIDDEN');
    const command = request(raw); this.validateTarget(projectId, command);
    this.db.prepare('INSERT INTO approvals VALUES(?,?,?) ON CONFLICT(commandId) DO UPDATE SET hash=excluded.hash WHERE approvals.projectId=excluded.projectId')
      .run(command.id, projectId, digest(command));
  }
  hasUncertainWrite(connectionId) {
    // A fresh transport connection is not evidence that an earlier native write failed.
    return Boolean(this.db.prepare(`SELECT 1 FROM commands command
      JOIN connections previous ON command.connectionId=previous.id
      JOIN connections current ON current.id=?
      WHERE command.state='unknown' AND command.kind!='sync'
      AND previous.host=current.host AND previous.instanceId=current.instanceId
      AND previous.documentId=current.documentId`).get(connectionId));
  }
  enqueue(projectId, raw) {
    const command = request(raw), hash = digest(command);
    return this.tx(() => {
      this.project(projectId);
      const existing = this.db.prepare('SELECT * FROM commands WHERE id=?').get(command.id);
      if (existing) {
        if (existing.projectId !== projectId || existing.hash !== hash) fail('IDEMPOTENCY_CONFLICT');
        return decode(existing);
      }
      this.validateTarget(projectId, command);
      if (isWrite(command.kind) && this.hasUncertainWrite(command.connectionId)) fail('WRITE_UNCERTAIN');
      if (command.kind === 'applyCandidate') {
        const approval = this.db.prepare('SELECT hash FROM approvals WHERE commandId=? AND projectId=?').get(command.id, projectId);
        if (approval?.hash !== hash) fail('APPROVAL_REQUIRED');
      }
      this.db.prepare(`INSERT INTO commands(id,projectId,runId,connectionId,revision,kind,payload,hash,state)
        VALUES(?,?,?,?,?,?,?,?,'queued')`).run(command.id, projectId, command.runId, command.connectionId, command.revision, command.kind, json(command.payload), hash);
      return this.getCommand(projectId, command.id);
    });
  }
  getCommand(projectId, id) {
    const row = this.db.prepare('SELECT * FROM commands WHERE projectId=? AND id=?').get(projectId, id);
    return decode(row) ?? fail('NOT_FOUND');
  }
  lease(connectionId) {
    return this.tx(() => {
      const connection = this.db.prepare('SELECT * FROM connections WHERE id=?').get(connectionId);
      if (!connection?.connected) return null;
      if (this.db.prepare("SELECT 1 FROM commands WHERE connectionId=? AND state='running'").get(connectionId)) return null;
      const uncertain = this.hasUncertainWrite(connectionId);
      const rows = this.db.prepare("SELECT * FROM commands WHERE connectionId=? AND state='queued' ORDER BY rowid").all(connectionId);
      for (const row of rows) {
        if (uncertain && isWrite(row.kind)) continue;
        if (this.getRun(row.projectId, row.runId).revision !== row.revision) {
          this.db.prepare("UPDATE commands SET state='cancelled',stale=1 WHERE id=?").run(row.id); continue;
        }
        this.db.prepare("UPDATE commands SET state='running' WHERE id=?").run(row.id);
        return this.getCommand(row.projectId, row.id);
      }
      return null;
    });
  }
  complete(connectionId, commandId, outcome) {
    if (!['succeeded', 'failed', 'unknown'].includes(outcome?.state)) fail('INVALID_RESULT');
    const encoded = json(outcome.result ?? null);
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM commands WHERE id=?').get(commandId);
      if (!row || row.connectionId !== connectionId) fail('TARGET_MISMATCH');
      if (!['running', 'unknown'].includes(row.state)) {
        if (row.state === outcome.state && row.result === encoded) return decode(row);
        fail('INVALID_TRANSITION');
      }
      const stale = this.getRun(row.projectId, row.runId).revision !== row.revision;
      this.db.prepare('UPDATE commands SET state=?,result=?,stale=? WHERE id=?')
        .run(outcome.state, encoded, Number(stale), row.id);
      return this.getCommand(row.projectId, row.id);
    });
  }
}
