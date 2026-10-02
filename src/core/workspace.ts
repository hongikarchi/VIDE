import { randomUUID } from 'node:crypto';
import { isDwgSdkEditMode } from '../contracts/dwg-edit-mode.ts';
import { AI_TURN_LIMIT, requestAdmission, waitingOf } from '../contracts/request-scope.ts';
import type { WaitingFor } from '../contracts/request-scope.ts';
import { interventionInput } from './intervention.ts';
import { requestInputSchema, requestStateSchema } from '../contracts/workspace.ts';
import { DomainError } from './store.ts';
import type { Store } from './store.ts';
import type { RequestInput, RequestState } from '../contracts/workspace.ts';
import { storedWorkSchema, storedResultSchema } from '../contracts/stored-work.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { z } from 'zod';
import { BIG_JSON, breadcrumb } from './breadcrumbs.ts';

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
  if (value.result && value.result.length >= BIG_JSON)
    breadcrumb('parse-big', { id: value.id, bytes: value.result.length });
  const decoded = {
    ...value,
    input: JSON.parse(value.input),
    result: value.result ? JSON.parse(value.result) : null,
  };
  storedWorkSchema.parse(decoded);
  // Validation must not reorder legacy JSON keys: extension retries compare their exact input serialization.
  return decoded as StoredWork;
};

type LightRow = { id: string; state: string; i: number; r: number | null };

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
   * Writes that run outside the request table while they last: a jig's direct bake on an attached
   * document (SPEC-02.9 3, ADR-027 5). Admission and a turn's lock check (`claimRows`) see each as a
   * running write of that document; nothing is stored or listed.
   */
  private readonly briefWrites = new Map<string, StoredWork>();
  /** Holds a document for a brief write; call the returned function when the write has ended. */
  holdWrite(projectId: string, document: { host: string; instance: string; documentId: number }) {
    const id = `brief-write:${randomUUID()}`;
    const input = {
      id,
      body: '',
      provider: 'claude-cli',
      mode: 'auto',
      permission: 'candidate',
      pins: [],
      sketches: [],
      files: [],
      host: document.host,
      hostUse: 'write',
      // A write of exactly that document (request-scope claims a 'document' source by its id).
      source: 'document',
      sourceDocument: { instance: document.instance, documentId: document.documentId },
    } as unknown as RequestInput;
    this.briefWrites.set(id, {
      id,
      projectId,
      input,
      state: 'running',
      result: null,
      createdAt: new Date().toISOString(),
    });
    return () => void this.briefWrites.delete(id);
  }
  /** The project's requests and the brief writes running now: what write admission weighs. */
  claimRows(projectId: string): StoredWork[] {
    const brief = [...this.briefWrites.values()].filter((row) => row.projectId === projectId);
    return brief.length ? [...this.list(projectId), ...brief] : this.list(projectId);
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
      .all(projectId) as LightRow[];
    return rows.map((row) => this.#light(projectId, row));
  }
  /** Drops decoded copies of requests whose input another class rewrote in SQL (a link merge). */
  forget(ids: Iterable<string>) {
    for (const id of ids) this.light.delete(id);
  }
  private light = new Map<string, { key: string; projectId: string; work: StoredWork }>();
  #light(projectId: string, row: LightRow): StoredWork {
    const key = `${row.state}|${row.i}|${row.r ?? -1}`;
    const known = this.light.get(row.id);
    if (known?.key === key && known.projectId === projectId) return known.work;
    const work = withoutGeometry(this.get(projectId, row.id));
    this.light.set(row.id, { key, projectId, work });
    return work;
  }
  /**
   * One request without its display geometry (as `list` gives it, `sceneOmitted`), decoded once per
   * stored change. Checks that need a request's state, host, document or object ids use this: a
   * display Sync of a large document is tens of MB, and decoding it again for each pin of a request
   * held the engine for seconds and near 2 GB of heap (PLAN-27, 2026-10-02). Read-only: the object
   * is shared with `list`.
   */
  summary(projectId: string, id: string): StoredWork {
    const row = this.store.db
      .prepare(
        'SELECT id,state,octet_length(input) AS i,octet_length(result) AS r FROM workspace_requests WHERE projectId=? AND id=?',
      )
      .get(projectId, id) as LightRow | undefined;
    return row ? this.#light(projectId, row) : fail('NOT_FOUND');
  }
  /** Remove a finished request from the conversation view; the record and its links stay. */
  hide(projectId: string, id: string) {
    const request = this.get(projectId, id);
    if (['queued', 'running'].includes(request.state)) fail('PROJECT_BUSY');
    this.store.db
      .prepare('INSERT OR IGNORE INTO hidden_requests VALUES(?,?,?)')
      .run(projectId, id, new Date().toISOString());
  }
  /**
   * Delete finished requests for good (a removed linked file, SPEC-01.11 9). A request a web
   * publication or shared feedback points at is hidden instead. Returns the deleted requests.
   */
  purge(projectId: string, ids: string[]): StoredWork[] {
    const db = this.store.db;
    return this.store.tx(() => {
      const deleted: StoredWork[] = [];
      for (const id of ids) {
        const request = this.get(projectId, id);
        if (['queued', 'running'].includes(request.state)) fail('PROJECT_BUSY');
        const referenced =
          db.prepare('SELECT 1 FROM publication_exports WHERE requestId=? LIMIT 1').get(id) ||
          db.prepare('SELECT 1 FROM shared_feedback WHERE requestId=? LIMIT 1').get(id);
        if (referenced) {
          this.hide(projectId, id);
          continue;
        }
        db.prepare('DELETE FROM hidden_requests WHERE projectId=? AND requestId=?').run(
          projectId,
          id,
        );
        db.prepare('DELETE FROM workspace_requests WHERE projectId=? AND id=?').run(projectId, id);
        this.light.delete(id);
        deleted.push(request);
      }
      return deleted;
    });
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
    const base = this.baseline(projectId, input);
    return base && this.get(projectId, base.id);
  }
  /** `basis` without its display geometry (`summary`): for checks that need no model. */
  baseline(
    projectId: string,
    input: Pick<RequestInput, 'id' | 'baseRequestId' | 'host'>,
  ): StoredWork | undefined {
    if (input.baseRequestId === null) return undefined;
    if (input.baseRequestId) return this.summary(projectId, input.baseRequestId);
    return this.list(projectId)
      .filter(
        (request) =>
          request.id !== input.id &&
          request.result?.hostExecuted &&
          (request.result.host || 'rhino') === (input.host || 'rhino'),
      )
      .at(-1);
  }
  /** The user document (`sourceDocument` key) a request's chain stands on, if identified. */
  private documentOf(projectId: string, id: string | null | undefined): string | undefined {
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id);
      let row;
      try {
        row = this.summary(projectId, id);
      } catch {
        return;
      }
      const source = row.result?.sourceDocument as Record<string, unknown> | undefined;
      if (source && typeof source.instance === 'string' && typeof source.documentId === 'number')
        return JSON.stringify([
          row.result?.host || row.input.host || 'rhino',
          source.instance,
          source.documentId,
        ]);
      const parent =
        row.input.baseRequestId ??
        (row.result as { baseRequestId?: unknown } | null)?.baseRequestId;
      id = typeof parent === 'string' ? parent : undefined;
    }
  }
  /**
   * A change pin in another linked file than the request's starting document (T-103, SPEC-01.11
   * 5): the AI picks which linked file it edits, so such a pin is not stale for this baseline.
   */
  private otherDocument(projectId: string, basis: string, baseline: string | undefined) {
    const pinned = this.documentOf(projectId, basis);
    const start = this.documentOf(projectId, baseline);
    return pinned !== undefined && start !== undefined && pinned !== start;
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
    merged.baseRequestId = this.baseline(projectId, predecessor.input)?.id ?? null;
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
        const source = this.summary(projectId, item.baseRequestId);
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
    const baseline = targets ? undefined : this.baseline(projectId, input);
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
        source = this.summary(projectId, pin.basis);
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
        (targets
          ? !targets.some((t) => t.baseRequestId === pin.basis)
          : pin.basis !== baseline?.id && !this.otherDocument(projectId, pin.basis, baseline?.id))
      )
        fail('STALE_REFERENCE');
    }
    // SPEC-02.9: overlapping work is stored to wait its turn, not refused. An intervention waits
    // for its predecessor first; its own turn is checked when that one ends (Execution).
    const admission = requestAdmission(
      input,
      this.claimRows(projectId).filter(
        (row) =>
          !predecessorId ||
          (row.id !== predecessorId && row.input.parentRequestId !== predecessorId),
      ),
      { aiTurns: this.aiTurns },
    );
    if (admission.code) fail(admission.code);
    this.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        input.id,
        projectId,
        serialized,
        'queued',
        predecessorId
          ? JSON.stringify({ phase: 'waiting' })
          : admission.waitingFor
            ? JSON.stringify({ phase: 'queue', waitingFor: admission.waitingFor })
            : null,
        new Date().toISOString(),
      );
    return { request: this.get(projectId, input.id), created: true };
  }
  /** AI turns running at once in a project (SPEC-02.9 4; setting 2-4). */
  aiTurns = AI_TURN_LIMIT;
  /**
   * Admission of a stored request against the requests ahead of it: those running and those
   * waiting before it. Later waiting requests stand behind it; an intervention keeps the place of
   * the request it replaces.
   */
  admission(projectId: string, id: string, rows = this.claimRows(projectId)) {
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) fail('NOT_FOUND');
    const placeOf = (at: number) => {
      const replaced = rows.findIndex((row) => row.id === rows[at].input.supersedesRequestId);
      return replaced >= 0 ? Math.min(replaced, at) : at;
    };
    const place = placeOf(index);
    return requestAdmission(
      rows[index].input,
      rows.filter((row, at) => at !== index && !(waitingOf(row) && placeOf(at) > place)),
      { aiTurns: this.aiTurns },
    );
  }
  /** Keep a queued request waiting with its current place in line (never a running one). */
  wait(projectId: string, id: string, waitingFor: WaitingFor) {
    this.store.db
      .prepare(
        `UPDATE workspace_requests SET result=? WHERE projectId=? AND id=? AND state='queued'`,
      )
      .run(JSON.stringify({ phase: 'queue', waitingFor }), projectId, id);
    this.light.delete(id);
    return this.get(projectId, id);
  }
  /**
   * The waiting requests whose turn has come, in order (the executor starts them now). The rest
   * keep an up-to-date place in line; one whose admission is refused (an invalid declaration, a
   * capture that cannot wait) stops with that reason and is kept, not run.
   */
  release(projectId: string): StoredWork[] {
    const rows = this.claimRows(projectId);
    const ready: StoredWork[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const waiting = waitingOf(row);
      if (!waiting) continue;
      const admission = this.admission(projectId, row.id, rows);
      if (admission.code) {
        rows[index] = this.update(projectId, row.id, 'interrupted', {
          ...row.result,
          code: admission.code,
        });
      } else if (admission.waitingFor) {
        if (JSON.stringify(admission.waitingFor) !== JSON.stringify(waiting))
          rows[index] = this.wait(projectId, row.id, admission.waitingFor);
      } else {
        ready.push(row);
        // Counted as running for the requests behind it.
        rows[index] = { ...row, state: 'running', result: null };
      }
    }
    return ready;
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
    const text = result === null ? null : JSON.stringify(result);
    const big = text !== null && text.length >= BIG_JSON;
    if (big) breadcrumb('write-big', { id, bytes: text.length });
    this.store.db
      .prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?')
      .run(state, text, id, projectId);
    if (big) breadcrumb('write-big-done', { id });
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
