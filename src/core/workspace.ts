import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import { requestConflict } from '../contracts/request-scope.ts';
import { interventionInput } from './intervention.ts';
import { requestInputSchema, requestStateSchema } from '../contracts/workspace.ts';
import { DomainError } from './store.ts';
import type { Store } from './store.ts';
import type { RequestInput, RequestState } from '../contracts/workspace.ts';
import { storedWorkSchema, storedResultSchema } from '../contracts/stored-work.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { z } from 'zod';

function fail(code: string): never {
  throw new DomainError(code);
}
const encodedRow = z.object({ input: z.string(), result: z.string().nullable() }).passthrough();
const pinSchema = z
  .object({ id: z.string(), basis: z.string(), role: z.enum(['target', 'preserve', 'reference']) })
  .passthrough();
const decode = (row: unknown): StoredWork | null => {
  if (!row) return null;
  const value = encodedRow.parse(row);
  const decoded = {
    ...value,
    input: JSON.parse(value.input),
    result: value.result ? JSON.parse(value.result) : null,
  };
  storedWorkSchema.parse(decoded);
  // Validation must not reorder legacy JSON keys: extension retries compare their exact input serialization.
  return decoded as StoredWork;
};

/** A listed request without its display geometry (see `Workspace.list`). */
function withoutGeometry(work: StoredWork): StoredWork {
  const result = work.result;
  if (!result || (!('scene' in result) && !('definitions' in result))) return work;
  const { scene: _scene, definitions: _definitions, ...rest } = result as Record<string, unknown>;
  return { ...work, result: { ...rest, sceneOmitted: true } as StoredWork['result'] };
}

/** Durable browser jobs, separate from the host command queue. */
export class Workspace {
  readonly store: Store;
  constructor(store: Store) {
    this.store = store;
    store.db.exec(`
      UPDATE workspace_requests SET state=CASE WHEN state='running' AND json_extract(result,'$.phase')='host' THEN 'unknown' ELSE 'interrupted' END WHERE state IN ('queued','running');`);
  }
  /**
   * Every request of the project, without display geometry (`scene`, `definitions`; marked
   * `sceneOmitted`). A display Sync holds tens of MB; parsing them all on each call (the linked
   * file list polls every 1.5 s) saturated the engine. Rows are decoded once and reused while their
   * state and stored sizes are unchanged; writes through this class drop them at once. Use
   * `get(id)` for one request with its geometry, or `{ full: true }` when every model is needed.
   */
  list(projectId: string, options: { full?: boolean } = {}): StoredWork[] {
    this.store.project(projectId);
    if (options.full)
      return this.store.db
        .prepare('SELECT * FROM workspace_requests WHERE projectId=? ORDER BY rowid')
        .all(projectId)
        .map((row) => decode(row)!);
    const rows = this.store.db
      .prepare(
        'SELECT id,state,octet_length(input) AS i,octet_length(result) AS r FROM workspace_requests WHERE projectId=? ORDER BY rowid',
      )
      .all(projectId) as { id: string; state: string; i: number; r: number | null }[];
    return rows.map((row) => {
      const key = `${row.state}|${row.i}|${row.r ?? -1}`;
      const known = this.light.get(row.id);
      if (known?.key === key && known.projectId === projectId) return known.work;
      const work = withoutGeometry(this.get(projectId, row.id));
      this.light.set(row.id, { key, projectId, work });
      return work;
    });
  }
  private light = new Map<string, { key: string; projectId: string; work: StoredWork }>();
  /** Remove a finished request from the conversation view; the record and its links stay. */
  hide(projectId: string, id: string) {
    const request = this.get(projectId, id);
    if (['queued', 'running'].includes(request.state)) fail('PROJECT_BUSY');
    this.store.db
      .prepare('INSERT OR IGNORE INTO hidden_requests VALUES(?,?,?)')
      .run(projectId, id, new Date().toISOString());
  }
  hiddenIds(projectId: string) {
    return new Set(
      this.store.db
        .prepare('SELECT requestId FROM hidden_requests WHERE projectId=?')
        .all(projectId)
        .map((row) => String(row.requestId)),
    );
  }
  get(projectId: string, id: string): StoredWork {
    return (
      decode(
        this.store.db
          .prepare('SELECT * FROM workspace_requests WHERE projectId=? AND id=?')
          .get(projectId, id),
      ) ?? fail('NOT_FOUND')
    );
  }
  basis(
    projectId: string,
    input: Pick<RequestInput, 'id' | 'baseRequestId' | 'host'>,
  ): StoredWork | undefined {
    if (input.baseRequestId === null) return undefined;
    if (input.baseRequestId) return this.get(projectId, input.baseRequestId);
    const latest = this.list(projectId)
      .filter(
        (request) =>
          request.id !== input.id &&
          request.result?.hostExecuted &&
          (request.result.host || 'rhino') === (input.host || 'rhino'),
      )
      .at(-1);
    return latest && this.get(projectId, latest.id);
  }
  submit(projectId: string, value: unknown) {
    return this.insert(projectId, value);
  }
  intervene(projectId: string, predecessorId: string, value: unknown) {
    const predecessor = this.get(projectId, predecessorId);
    const merged = interventionInput(predecessor.input, value);
    const existing = this.list(projectId).find((row) => row.id === merged.id);
    if (existing) {
      if (
        existing.input.supersedesRequestId !== predecessorId ||
        JSON.stringify(existing.input.interventionInput) !== JSON.stringify(value)
      )
        fail('REVISION_CONFLICT');
      return { request: existing, created: false };
    }
    if (!['queued', 'running'].includes(predecessor.state) || predecessor.input.parentRequestId)
      fail('REVISION_CONFLICT');
    if (
      this.list(projectId).some(
        (row) =>
          row.input.supersedesRequestId === predecessorId &&
          ['queued', 'running'].includes(row.state),
      )
    )
      fail('PROJECT_BUSY');
    merged.baseRequestId = this.basis(projectId, predecessor.input)?.id ?? null;
    return this.insert(projectId, merged, predecessorId);
  }
  private insert(projectId: string, value: unknown, predecessorId?: string) {
    this.store.project(projectId);
    const parsed = requestInputSchema.safeParse(value);
    if (!parsed.success) fail('INVALID_INPUT');
    const input = parsed.data;
    if (input.parentRequestId !== undefined) fail('INVALID_INPUT');
    if (input.supersedesRequestId !== undefined && input.supersedesRequestId !== predecessorId)
      fail('INVALID_INPUT');
    // Keep the original serialization for existing idempotency records.
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > 200000) fail('INPUT_TOO_LARGE');
    const existing = this.store.db
      .prepare('SELECT * FROM workspace_requests WHERE id=?')
      .get(input.id);
    if (existing) {
      if (existing.projectId !== projectId || existing.input !== serialized)
        fail('REVISION_CONFLICT');
      return { request: decode(existing)!, created: false };
    }
    const target = input.host || 'rhino';
    const targets = input.linkedTargets;
    if (targets) {
      const documentKeys = new Set<string>();
      for (const item of targets) {
        const source = this.get(projectId, item.baseRequestId);
        // A Sync of a document open in Rhino/ZWCAD is a valid target too: Rhino captures a work
        // copy when the request runs, ZWCAD is edited in place.
        const openDocument =
          source.result?.displayOnly === true &&
          z
            .object({ connection: z.literal('attached-editor') })
            .safeParse(source.result.sourceDocument).success;
        if (
          source.state !== 'succeeded' ||
          (!source.result?.verified && !openDocument) ||
          !source.result?.hostExecuted
        )
          fail('STALE_REFERENCE');
        if ((source.result.host || 'rhino') !== item.host || source.result.executionMode !== 'sdk')
          fail('TARGET_MISMATCH');
        if (
          input.permission === 'candidate' &&
          source.result.referenceOnly &&
          !openDocument &&
          !isDwgSdkEditMode(source.result.dwgEditMode)
        )
          fail('ZWCAD_REFERENCE_ONLY');
        const doc = z
          .object({ instance: z.string(), documentId: z.number() })
          .safeParse(source.result.sourceDocument);
        if (doc.success) {
          const key = doc.data.instance + '/' + doc.data.documentId;
          if (documentKeys.has(key)) fail('TARGET_MISMATCH');
          documentKeys.add(key);
        }
      }
    }
    const baseline = targets ? undefined : this.basis(projectId, input);
    if (!targets && input.baseRequestId && !baseline?.result?.hostExecuted) fail('STALE_REFERENCE');
    if (baseline && (baseline.result?.host || 'rhino') !== target) fail('TARGET_MISMATCH');
    if (input.applyToSource) {
      const source = z
        .object({
          connection: z.literal('attached-editor'),
          instance: z.string(),
          documentId: z.number(),
          documentHash: z.string(),
        })
        .safeParse(baseline?.result?.sourceDocument);
      if (
        !source.success ||
        baseline?.state !== 'succeeded' ||
        (!baseline.result?.verified && baseline.result?.displayOnly !== true) ||
        baseline.result.executionMode !== 'sdk'
      )
        fail('STALE_REFERENCE');
    }
    for (const value of input.pins) {
      const parsedPin = pinSchema.safeParse(value);
      if (!parsedPin.success) fail('STALE_REFERENCE');
      const pin = parsedPin.data;
      let source;
      try {
        source = this.get(projectId, pin.basis);
      } catch {
        fail('STALE_REFERENCE');
      }
      if (!source.result?.hostExecuted || !source.result.objects?.some((o) => o.id === pin.id))
        fail('STALE_REFERENCE');
      if (
        (targets
          ? targets.some((t) => t.host === (source.result!.host || 'rhino'))
          : (source.result.host || 'rhino') === target) &&
        ['target', 'preserve'].includes(pin.role) &&
        (targets ? !targets.some((t) => t.baseRequestId === pin.basis) : pin.basis !== baseline?.id)
      )
        fail('STALE_REFERENCE');
    }
    const conflict = requestConflict(
      input,
      this.list(projectId).filter(
        (row) =>
          !predecessorId ||
          (row.id !== predecessorId && row.input.parentRequestId !== predecessorId),
      ),
    );
    if (conflict) fail(conflict);
    this.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        input.id,
        projectId,
        serialized,
        'queued',
        predecessorId ? JSON.stringify({ phase: 'waiting' }) : null,
        new Date().toISOString(),
      );
    return { request: this.get(projectId, input.id), created: true };
  }
  update(projectId: string, id: string, state: RequestState, result: unknown = null): StoredWork {
    if (state === 'queued' || !requestStateSchema.safeParse(state).success) fail('INVALID_INPUT');
    // Existence only: decoding the stored result (a whole model for a Sync) is not needed here.
    if (
      !this.store.db
        .prepare('SELECT 1 FROM workspace_requests WHERE projectId=? AND id=?')
        .get(projectId, id)
    )
      fail('NOT_FOUND');
    if (result !== null && !storedResultSchema.safeParse(result).success)
      fail('INVALID_HOST_RESULT');
    this.store.db
      .prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?')
      .run(state, result === null ? null : JSON.stringify(result), id, projectId);
    this.light.delete(id);
    const updated = this.get(projectId, id);
    if (typeof updated.input.parentRequestId === 'string') {
      const parent = this.get(projectId, updated.input.parentRequestId);
      const rows = z
        .array(
          z
            .object({ requestId: z.string(), host: z.string(), state: requestStateSchema })
            .passthrough(),
        )
        .safeParse(parent.result?.targetResults);
      if (rows.success && rows.data.some((row) => row.requestId === id)) {
        const next = {
          ...parent.result,
          targetResults: rows.data.map((row) =>
            row.requestId === id
              ? { ...row, state, candidate: updated.result?.hostExecuted === true }
              : row,
          ),
        };
        this.store.db
          .prepare('UPDATE workspace_requests SET result=? WHERE id=? AND projectId=?')
          .run(JSON.stringify(next), parent.id, projectId);
        this.light.delete(parent.id);
      }
    }
    return updated;
  }
  createLinkedChild(parent: StoredWork, childId: string, index: number): StoredWork {
    const target = parent.input.linkedTargets?.[index];
    if (!target || this.get(parent.projectId, parent.id).state !== 'running') fail('INVALID_INPUT');
    const { linkedTargets: _targets, coordinateBasis: _basis, ...rest } = parent.input;
    const input = requestInputSchema.parse({
      ...rest,
      id: childId,
      ...target,
      parentRequestId: parent.id,
      body: `${target.host} · ${parent.input.body}`,
    });
    this.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        childId,
        parent.projectId,
        JSON.stringify(input),
        'running',
        null,
        new Date().toISOString(),
      );
    return this.get(parent.projectId, childId);
  }
}
