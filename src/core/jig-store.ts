import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { DomainError } from './store.ts';

// Rows of the jig tables (ARCH-03 §10.2, schema v5): installed packages, project pins, drafts,
// instances ('이 프로젝트의 jig'), setting-change log, step runs, input reads and bake records.
// Data access only: manifests, gates, recomputation and bake decisions live in src/jigs/runtime and
// src/jigs/bake (PLAN-22). Rows keyed by an instance take its ID only, so callers load the instance
// with `instance(projectId, id)` first; that is the project check.

const id = z.string().min(1).max(200);
const text = z.string().max(2000);
type Json = unknown;
const encode = (value: Json) => JSON.stringify(value ?? null);
const decode = (value: string | null): Json => (value === null ? null : JSON.parse(value));
const notFound = (): never => {
  throw new DomainError('NOT_FOUND');
};
const now = () => new Date().toISOString();

export interface JigPackage {
  id: string;
  version: string;
  stage: 'project';
  source: 'dev-pack' | 'ai-draft';
  digest: string;
  signer: string | null;
  path: string;
  approvedCaps: string[];
  installedAt: string;
}
const newPackage = z
  .object({
    id,
    version: id,
    stage: z.literal('project'),
    source: z.enum(['dev-pack', 'ai-draft']),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    signer: text.nullable().optional(),
    path: text.min(1),
    approvedCaps: z.array(id),
  })
  .strict();

export interface JigDraft {
  id: string;
  projectId: string;
  conversationId: string | null;
  path: string;
  state: 'open' | 'archived' | 'pinned' | 'discarded';
  createdAt: string;
  openedAt: string;
}

export type InstanceStatus = 'new' | 'computed' | 'gate-failed' | 'stale';
const instanceStatus = z.enum(['new', 'computed', 'gate-failed', 'stale']);
/** `body` holds layerRoot, assembly, params, zones and overrides (ARCH-03 §4) as one JSON value. */
export interface JigInstanceRow<Body = Record<string, unknown>> {
  id: string;
  projectId: string;
  jigId: string;
  version: string;
  title: string;
  body: Body;
  status: InstanceStatus;
  createdAt: string;
  updatedAt: string;
}
const newInstance = z
  .object({
    jigId: id,
    version: id,
    title: z.string().min(1).max(500),
    body: z.record(z.string(), z.unknown()),
    status: instanceStatus.optional(),
  })
  .strict();
const instancePatch = newInstance
  .pick({ version: true, title: true, body: true, status: true })
  .partial()
  .strict();

export interface ParamLogEntry {
  instanceId: string;
  seq: number;
  key: string;
  old: Json;
  new: Json;
  by: string;
  reason: string | null;
  requestId: string | null;
  at: string;
}
const newParamEntry = z
  .object({
    key: id,
    old: z.unknown(),
    new: z.unknown(),
    by: id,
    reason: text.nullable().optional(),
    requestId: id.nullable().optional(),
  })
  .strict();

export type StepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'stale'
  | 'waiting'
  | 'confirmed'
  | 'reconfirm';
const stepStatus = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'stale',
  'waiting',
  'confirmed',
  'reconfirm',
]);
export interface JigRun {
  instanceId: string;
  stepId: string;
  inputHash: string;
  outputRef: string | null;
  ms: number | null;
  status: StepStatus;
  gates: Json;
  at: string;
}
const runInput = z
  .object({
    inputHash: id,
    outputRef: text.nullable().optional(),
    ms: z.number().min(0).nullable().optional(),
    status: stepStatus,
    gates: z.unknown().optional(),
  })
  .strict();

export interface JigRead {
  id: string;
  instanceId: string;
  linkId: string;
  revisionKey: string;
  layers: string[];
  includeHidden: boolean;
  purpose: 'assembly' | 'pre-bake';
  ref: string;
  at: string;
}
const newRead = z
  .object({
    linkId: id,
    revisionKey: text.min(1),
    layers: z.array(text),
    includeHidden: z.boolean(),
    purpose: z.enum(['assembly', 'pre-bake']),
    ref: text.min(1),
  })
  .strict();

/** `items`: key → { nativeId, hash, layer, runId, state } (ARCH-03 §9.4). */
export interface JigBake<Items = Record<string, unknown>> {
  id: string;
  instanceId: string;
  bakeId: string;
  linkId: string;
  requestId: string;
  runId: string;
  items: Items;
  baselineReadId: string | null;
  appliedAt: string | null;
}
const newBake = z
  .object({
    bakeId: id,
    linkId: id,
    requestId: id,
    runId: id,
    items: z.record(z.string(), z.unknown()),
    baselineReadId: id.nullable().optional(),
  })
  .strict();
const bakePatch = z
  .object({
    items: z.record(z.string(), z.unknown()).optional(),
    baselineReadId: id.nullable().optional(),
    appliedAt: z.string().nullable().optional(),
  })
  .strict();

type Row = Record<string, unknown>;
const asPackage = (row: Row): JigPackage =>
  ({ ...row, approvedCaps: decode(row.approvedCaps as string) }) as JigPackage;
const asInstance = (row: Row): JigInstanceRow =>
  ({ ...row, body: decode(row.body as string) }) as JigInstanceRow;
const asParam = (row: Row): ParamLogEntry =>
  ({
    ...row,
    old: decode(row.old as string | null),
    new: decode(row.new as string),
  }) as ParamLogEntry;
const asRun = (row: Row): JigRun =>
  ({ ...row, gates: decode(row.gates as string | null) }) as JigRun;
const asRead = (row: Row): JigRead =>
  ({
    ...row,
    layers: decode(row.layers as string),
    includeHidden: row.includeHidden === 1,
  }) as JigRead;
const asBake = (row: Row): JigBake => ({ ...row, items: decode(row.items as string) }) as JigBake;

export class JigStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  // Rows come back as plain objects (node:sqlite returns null-prototype ones).
  private one(sql: string, ...args: (string | number | null)[]) {
    const row = this.db.prepare(sql).get(...args);
    return row ? ({ ...row } as Row) : undefined;
  }
  private all(sql: string, ...args: (string | number | null)[]) {
    return this.db
      .prepare(sql)
      .all(...args)
      .map((row) => ({ ...row }) as Row);
  }

  // Installed packages (this PC). The same id@version is never overwritten.
  addPackage(value: z.input<typeof newPackage>): JigPackage {
    const input = newPackage.parse(value);
    if (this.one('SELECT 1 FROM jig_packages WHERE id=? AND version=?', input.id, input.version))
      throw new DomainError('JIG_VERSION_EXISTS');
    this.db
      .prepare('INSERT INTO jig_packages VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        input.id,
        input.version,
        input.stage,
        input.source,
        input.digest,
        input.signer ?? null,
        input.path,
        encode(input.approvedCaps),
        now(),
      );
    return this.package(input.id, input.version);
  }
  package(jigId: string, version: string): JigPackage {
    const row = this.one('SELECT * FROM jig_packages WHERE id=? AND version=?', jigId, version);
    return row ? asPackage(row) : notFound();
  }
  packages(jigId?: string): JigPackage[] {
    return (
      jigId
        ? this.all('SELECT * FROM jig_packages WHERE id=? ORDER BY installedAt', jigId)
        : this.all('SELECT * FROM jig_packages ORDER BY id, installedAt')
    ).map(asPackage);
  }

  // Versions pinned to a project: one version per jig.
  pin(projectId: string, jigId: string, version: string) {
    this.db
      .prepare(
        `INSERT INTO project_jigs VALUES(?,?,?,?) ON CONFLICT(projectId, jigId)
          DO UPDATE SET version=excluded.version, pinnedAt=excluded.pinnedAt`,
      )
      .run(projectId, id.parse(jigId), id.parse(version), now());
    return this.pinned(projectId).find((row) => row.jigId === jigId)!;
  }
  pinned(projectId: string) {
    return this.all(
      'SELECT jigId, version, pinnedAt FROM project_jigs WHERE projectId=? ORDER BY pinnedAt',
      projectId,
    ) as { jigId: string; version: string; pinnedAt: string }[];
  }
  /** Takes the jig off the project's list; false when it was not pinned there. */
  unpin(projectId: string, jigId: string) {
    return (
      Number(
        this.db
          .prepare('DELETE FROM project_jigs WHERE projectId=? AND jigId=?')
          .run(projectId, jigId).changes,
      ) > 0
    );
  }

  // Drafts made in a make-conversation (PLAN-22 T-063).
  createDraft(
    projectId: string,
    value: { path: string; conversationId?: string | null },
  ): JigDraft {
    const draftId = randomUUID(),
      at = now();
    this.db
      .prepare("INSERT INTO jig_drafts VALUES(?,?,?,?,'open',?,?)")
      .run(
        draftId,
        projectId,
        id.nullable().optional().parse(value.conversationId) ?? null,
        text.min(1).parse(value.path),
        at,
        at,
      );
    return this.draft(projectId, draftId);
  }
  draft(projectId: string, draftId: string): JigDraft {
    const row = this.one('SELECT * FROM jig_drafts WHERE projectId=? AND id=?', projectId, draftId);
    return row ? (row as unknown as JigDraft) : notFound();
  }
  drafts(projectId: string, state?: JigDraft['state']): JigDraft[] {
    return (state
      ? this.all(
          'SELECT * FROM jig_drafts WHERE projectId=? AND state=? ORDER BY createdAt',
          projectId,
          state,
        )
      : this.all(
          'SELECT * FROM jig_drafts WHERE projectId=? ORDER BY createdAt',
          projectId,
        )) as unknown as JigDraft[];
  }
  /** Sets the state; `opened` also records the time it was last opened. */
  updateDraft(
    projectId: string,
    draftId: string,
    { state, opened = false }: { state?: JigDraft['state']; opened?: boolean },
  ): JigDraft {
    const draft = this.draft(projectId, draftId);
    this.db
      .prepare('UPDATE jig_drafts SET state=?, openedAt=? WHERE projectId=? AND id=?')
      .run(
        z.enum(['open', 'archived', 'pinned', 'discarded']).parse(state ?? draft.state),
        opened ? now() : draft.openedAt,
        projectId,
        draftId,
      );
    return this.draft(projectId, draftId);
  }

  // Instances.
  createInstance(projectId: string, value: z.input<typeof newInstance>): JigInstanceRow {
    const input = newInstance.parse(value);
    const instanceId = randomUUID(),
      at = now();
    this.db
      .prepare('INSERT INTO jig_instances VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        instanceId,
        projectId,
        input.jigId,
        input.version,
        input.title,
        encode(input.body),
        input.status ?? 'new',
        at,
        at,
      );
    return this.instance(projectId, instanceId);
  }
  instance(projectId: string, instanceId: string): JigInstanceRow {
    const row = this.one(
      'SELECT * FROM jig_instances WHERE projectId=? AND id=?',
      projectId,
      instanceId,
    );
    return row ? asInstance(row) : notFound();
  }
  instances(projectId: string): JigInstanceRow[] {
    return this.all(
      'SELECT * FROM jig_instances WHERE projectId=? ORDER BY createdAt',
      projectId,
    ).map(asInstance);
  }
  updateInstance(
    projectId: string,
    instanceId: string,
    value: z.input<typeof instancePatch>,
  ): JigInstanceRow {
    const patch = instancePatch.parse(value);
    const current = this.instance(projectId, instanceId);
    this.db
      .prepare(
        'UPDATE jig_instances SET version=?, title=?, body=?, status=?, updatedAt=? WHERE projectId=? AND id=?',
      )
      .run(
        patch.version ?? current.version,
        patch.title ?? current.title,
        encode(patch.body ?? current.body),
        patch.status ?? current.status,
        now(),
        projectId,
        instanceId,
      );
    return this.instance(projectId, instanceId);
  }

  // Setting-change log. `seq` counts up per instance and is the handle for undo.
  appendParam(instanceId: string, value: z.input<typeof newParamEntry>): ParamLogEntry {
    const input = newParamEntry.parse(value);
    const row = this.one(
      `INSERT INTO jig_param_log
        SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ? FROM jig_param_log WHERE instanceId=?
        RETURNING seq`,
      instanceId,
      input.key,
      input.old === undefined ? null : encode(input.old),
      encode(input.new),
      input.by,
      input.reason ?? null,
      input.requestId ?? null,
      now(),
      instanceId,
    );
    return this.paramEntry(instanceId, Number(row!.seq));
  }
  paramEntry(instanceId: string, seq: number): ParamLogEntry {
    const row = this.one(
      'SELECT * FROM jig_param_log WHERE instanceId=? AND seq=?',
      instanceId,
      seq,
    );
    return row ? asParam(row) : notFound();
  }
  paramLog(instanceId: string): ParamLogEntry[] {
    return this.all('SELECT * FROM jig_param_log WHERE instanceId=? ORDER BY seq', instanceId).map(
      asParam,
    );
  }

  // Step runs: the latest result of each step (input-hash cache and status). A failed run without
  // a result keeps the last kept result and its fingerprint, so a step's previous output (e.g. the
  // S-06 marks ledger, ARCH-03 §6.2) survives a failed recomputation.
  saveRun(instanceId: string, stepId: string, value: z.input<typeof runInput>): JigRun {
    const input = runInput.parse(value);
    const keep = `excluded.status='failed' AND excluded.outputRef IS NULL AND jig_runs.outputRef IS NOT NULL`;
    this.db
      .prepare(
        `INSERT INTO jig_runs VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instanceId, stepId) DO UPDATE SET
          inputHash=CASE WHEN ${keep} THEN jig_runs.inputHash ELSE excluded.inputHash END,
          outputRef=CASE WHEN ${keep} THEN jig_runs.outputRef ELSE excluded.outputRef END, ms=excluded.ms,
          status=excluded.status, gates=excluded.gates, at=excluded.at`,
      )
      .run(
        instanceId,
        id.parse(stepId),
        input.inputHash,
        input.outputRef ?? null,
        input.ms ?? null,
        input.status,
        input.gates === undefined ? null : encode(input.gates),
        now(),
      );
    return this.run(instanceId, stepId);
  }
  run(instanceId: string, stepId: string): JigRun {
    const row = this.one(
      'SELECT * FROM jig_runs WHERE instanceId=? AND stepId=?',
      instanceId,
      stepId,
    );
    return row ? asRun(row) : notFound();
  }
  runs(instanceId: string): JigRun[] {
    return this.all('SELECT * FROM jig_runs WHERE instanceId=? ORDER BY rowid', instanceId).map(
      asRun,
    );
  }
  /** Sets the status of the given steps (e.g. `stale` after a setting change), keeping results. */
  setRunStatus(instanceId: string, stepIds: string[], status: StepStatus) {
    const set = this.db.prepare('UPDATE jig_runs SET status=? WHERE instanceId=? AND stepId=?');
    for (const stepId of stepIds) set.run(stepStatus.parse(status), instanceId, stepId);
  }

  // Jig input reads. The read geometry itself is the file named by `ref`.
  addRead(instanceId: string, value: z.input<typeof newRead>): JigRead {
    const input = newRead.parse(value);
    const readId = randomUUID();
    this.db
      .prepare('INSERT INTO jig_reads VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        readId,
        instanceId,
        input.linkId,
        input.revisionKey,
        encode(input.layers),
        input.includeHidden ? 1 : 0,
        input.purpose,
        input.ref,
        now(),
      );
    return this.read(instanceId, readId);
  }
  read(instanceId: string, readId: string): JigRead {
    const row = this.one('SELECT * FROM jig_reads WHERE instanceId=? AND id=?', instanceId, readId);
    return row ? asRead(row) : notFound();
  }
  reads(instanceId: string, linkId?: string): JigRead[] {
    return (
      linkId
        ? this.all(
            'SELECT * FROM jig_reads WHERE instanceId=? AND linkId=? ORDER BY at, rowid',
            instanceId,
            linkId,
          )
        : this.all('SELECT * FROM jig_reads WHERE instanceId=? ORDER BY at, rowid', instanceId)
    ).map(asRead);
  }

  // Bake records.
  addBake(instanceId: string, value: z.input<typeof newBake>): JigBake {
    const input = newBake.parse(value);
    const recordId = randomUUID();
    this.db
      .prepare('INSERT INTO jig_bakes VALUES(?,?,?,?,?,?,?,?,NULL)')
      .run(
        recordId,
        instanceId,
        input.bakeId,
        input.linkId,
        input.requestId,
        input.runId,
        encode(input.items),
        input.baselineReadId ?? null,
      );
    return this.bake(instanceId, recordId);
  }
  bake(instanceId: string, recordId: string): JigBake {
    const row = this.one(
      'SELECT * FROM jig_bakes WHERE instanceId=? AND id=?',
      instanceId,
      recordId,
    );
    return row ? asBake(row) : notFound();
  }
  /** Records of one bake to one linked file, oldest first. */
  bakes(instanceId: string, bakeId: string, linkId: string): JigBake[] {
    return this.all(
      'SELECT * FROM jig_bakes WHERE instanceId=? AND bakeId=? AND linkId=? ORDER BY rowid',
      instanceId,
      bakeId,
      linkId,
    ).map(asBake);
  }
  updateBake(instanceId: string, recordId: string, value: z.input<typeof bakePatch>): JigBake {
    const patch = bakePatch.parse(value);
    const current = this.bake(instanceId, recordId);
    this.db
      .prepare(
        'UPDATE jig_bakes SET items=?, baselineReadId=?, appliedAt=? WHERE instanceId=? AND id=?',
      )
      .run(
        encode(patch.items ?? current.items),
        patch.baselineReadId === undefined ? current.baselineReadId : patch.baselineReadId,
        patch.appliedAt === undefined ? current.appliedAt : patch.appliedAt,
        instanceId,
        recordId,
      );
    return this.bake(instanceId, recordId);
  }
}
