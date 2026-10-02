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
import { ModelStore, type ModelDelta, type ModelView, type StoredModel } from './model-store.ts';

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

type LightRow = { id: string; state: string; i: number; r: number | null; m: number | null };
const LIGHT_COLUMNS =
  'w.id,w.state,octet_length(w.input) AS i,octet_length(w.result) AS r,m.revision AS m FROM workspace_requests w LEFT JOIN sync_manifests m ON m.requestId=w.id';
/** Requests whose display part is stored per object (ARCH-01 §5, T-083). */
const modelStoreOf = (work: StoredWork) =>
  (work.result as { modelStore?: unknown } | null)?.modelStore;

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
  /** Display geometry of results stored per object (ARCH-01 §5 「Sync 표시 형상의 객체 단위 저장」). */
  readonly models: ModelStore;
  constructor(store: Store) {
    this.store = store;
    this.models = new ModelStore(store.db);
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
        .map((row) => this.expand(decode(row)!));
    const rows = this.store.db
      .prepare(`SELECT ${LIGHT_COLUMNS} WHERE w.projectId=? ORDER BY w.rowid`)
      .all(projectId) as LightRow[];
    return rows.map((row) => this.#light(projectId, row));
  }
  /** Drops decoded copies of requests whose input another class rewrote in SQL (a link merge). */
  forget(ids: Iterable<string>) {
    for (const id of ids) this.light.delete(id);
  }
  private light = new Map<string, { key: string; projectId: string; work: StoredWork }>();
  #light(projectId: string, row: LightRow): StoredWork {
    // A Live Sync in place can leave the result the same size: the manifest revision tells.
    const key = `${row.state}|${row.i}|${row.r ?? -1}|${row.m ?? -1}`;
    const known = this.light.get(row.id);
    if (known?.key === key && known.projectId === projectId) return known.work;
    const work = this.lightWork(projectId, row.id);
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
      .prepare(`SELECT ${LIGHT_COLUMNS} WHERE w.projectId=? AND w.id=?`)
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
        // The stored row without its model: callers read small fields (work folders, inputs).
        const request = this.raw(projectId, id);
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
      // Object versions only the deleted Syncs used (their manifests went with the rows).
      if (deleted.length) this.models.sweep(projectId);
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
    return this.expand(this.raw(projectId, id));
  }
  /** The stored row as it is: a per-object result keeps its `modelStore` marker and no model. */
  private raw(projectId: string, id: string): StoredWork {
    return (
      decode(
        this.store.db
          .prepare('SELECT * FROM workspace_requests WHERE projectId=? AND id=?')
          .get(projectId, id),
      ) ?? fail('NOT_FOUND')
    );
  }
  /**
   * The result in the shape it was written (`objects`, `scene`, `definitions` rebuilt from the
   * manifest). A Sync whose manifest was pruned (ARCH-01 §5 「정리」) has no geometry left: it reads
   * as an empty scene marked `modelPruned`.
   */
  private expand(work: StoredWork): StoredWork {
    const marker = modelStoreOf(work);
    if (!marker) return work;
    const { modelStore: _marker, ...rest } = work.result as Record<string, unknown>;
    const model = marker === 'manifest' ? this.models.load(work.projectId, work.id) : undefined;
    return {
      ...work,
      result: (model
        ? { ...rest, ...model }
        : { ...rest, scene: [], modelPruned: true }) as StoredWork['result'],
    };
  }
  /** `list`'s form of one request: no display geometry, object rows from the manifest's meta. */
  private lightWork(projectId: string, id: string): StoredWork {
    const work = this.raw(projectId, id);
    const marker = modelStoreOf(work);
    if (!marker) return withoutGeometry(work);
    const { modelStore: _marker, ...rest } = work.result as Record<string, unknown>;
    const header = marker === 'manifest' ? this.models.header(projectId, id) : undefined;
    const view = header && this.models.view(projectId, id);
    return {
      ...work,
      result: {
        ...rest,
        ...(view && header.objectCount !== null ? { objects: view.rows() } : {}),
        ...(view ? {} : { modelPruned: true }),
        sceneOmitted: true,
      } as StoredWork['result'],
    };
  }
  /**
   * Lazy reads of a request stored per object (`keys`, `object`, `scene`, `rows`, `geometry`);
   * undefined for a result kept as JSON (not moved yet, without a scene, or pruned).
   */
  model(projectId: string, id: string): ModelView | undefined {
    return this.models.view(projectId, id);
  }
  /** One request with only the result fields kept as JSON (no `objects`, `scene`, `definitions`). */
  brief(projectId: string, id: string): StoredWork {
    const work = this.raw(projectId, id);
    if (!modelStoreOf(work)) return withoutGeometry(work);
    const { modelStore: _marker, ...rest } = work.result as Record<string, unknown>;
    return { ...work, result: rest as StoredWork['result'] };
  }
  /**
   * Live Sync on a stored model (ARCH-01 §5 「쓰기」): the change page goes into the manifest of
   * `id` in place, or, when `into` names a request already submitted for it, into a copy of the
   * manifest there that takes `id`'s small result (the basis is referenced and must not change).
   * `patch` sets small result fields. Nothing else of the model is read or decoded.
   */
  applyDelta(
    projectId: string,
    id: string,
    delta: ModelDelta,
    patch: Record<string, unknown>,
    into?: string,
  ) {
    const db = this.store.db;
    db.exec('SAVEPOINT workspace_delta');
    try {
      let target = id;
      if (into) {
        const basis = this.raw(projectId, id);
        db.prepare(
          "UPDATE workspace_requests SET state='succeeded', result=? WHERE id=? AND projectId=?",
        ).run(JSON.stringify(basis.result), into, projectId);
        this.models.copyManifest(projectId, id, into);
        target = into;
      }
      const applied = this.models.applyDelta(projectId, target, delta, patch);
      db.exec('RELEASE workspace_delta');
      this.light.delete(target);
      return { ...applied, requestId: target };
    } catch (error) {
      db.exec('ROLLBACK TO workspace_delta; RELEASE workspace_delta');
      throw error;
    }
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
    // No size cap of its own (ADR-031 7): the HTTP body guard is the only one.
    const serialized = JSON.stringify(value);
    const existing = this.store.db
      .prepare('SELECT * FROM workspace_requests WHERE id=?')
      .get(input.id);
    if (existing) {
      if (existing.projectId !== projectId || existing.input !== serialized)
        fail('REVISION_CONFLICT');
      return { request: this.expand(decode(existing)!), created: false };
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
    // Pins have no count cap (ADR-031 7): each basis's object ids are looked up once.
    const basisIds = new Map<string, Set<string>>();
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
      if (!source.result?.hostExecuted) fail('STALE_REFERENCE');
      let known = basisIds.get(pin.basis);
      if (!known) {
        known = new Set((source.result.objects ?? []).map((o) => o.id));
        basisIds.set(pin.basis, known);
      }
      if (!known.has(pin.id)) fail('STALE_REFERENCE');
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
    this.write(projectId, id, state, result as Record<string, unknown> | null);
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
  /**
   * Stores a result. One with a `scene` array keeps its `objects`, `scene` and `definitions` per
   * object (ModelStore) and the rest as JSON marked `modelStore: 'manifest'`, in one transaction
   * (ARCH-01 §5). A model storage cannot rebuild exactly (MODEL_STORE_UNSUPPORTED) stays JSON.
   */
  private write(
    projectId: string,
    id: string,
    state: RequestState,
    result: Record<string, unknown> | null,
  ) {
    const db = this.store.db;
    const plain = (value: Record<string, unknown> | null) => {
      const text = value === null ? null : JSON.stringify(value);
      const big = text !== null && text.length >= BIG_JSON;
      if (big) breadcrumb('write-big', { id, bytes: text.length });
      db.prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=? AND projectId=?').run(
        state,
        text,
        id,
        projectId,
      );
      if (big) breadcrumb('write-big-done', { id });
    };
    db.exec('SAVEPOINT workspace_write');
    try {
      if (result && Array.isArray(result.scene)) {
        const { objects, scene, definitions, sceneOmitted: _omitted, ...rest } = result;
        const model = { scene } as StoredModel;
        if (objects !== undefined) model.objects = objects as StoredModel['objects'];
        if (definitions !== undefined)
          model.definitions = definitions as StoredModel['definitions'];
        const source = rest.sourceDocument as { revision?: unknown } | undefined;
        db.exec('SAVEPOINT workspace_model');
        try {
          plain({ ...rest, modelStore: 'manifest' });
          this.models.store(projectId, id, model, {
            parentId: this.previousSync(projectId, id),
            documentRevision: typeof source?.revision === 'number' ? source.revision : null,
          });
          db.exec('RELEASE workspace_model');
        } catch (error) {
          db.exec('ROLLBACK TO workspace_model; RELEASE workspace_model');
          if ((error as { code?: unknown }).code !== 'MODEL_STORE_UNSUPPORTED') throw error;
          this.dropModel(projectId, id);
          plain(result);
        }
      } else {
        this.dropModel(projectId, id);
        plain(result);
      }
      db.exec('RELEASE workspace_write');
    } catch (error) {
      db.exec('ROLLBACK TO workspace_write; RELEASE workspace_write');
      throw error;
    }
  }
  /** A result written without a model leaves no manifest behind (nor versions only it used). */
  private dropModel(projectId: string, id: string) {
    if (!this.models.header(projectId, id)) return;
    const versions = this.store.db
      .prepare('SELECT versionId FROM sync_manifest_items WHERE requestId=?')
      .all(id)
      .map((row) => String(row.versionId));
    this.store.db.prepare('DELETE FROM sync_manifests WHERE requestId=?').run(id);
    this.models.sweep(projectId, versions);
  }
  /**
   * The Sync this one follows (`sync_manifests.parentId`): the newest other successful stored
   * Sync of the same linked file, or without a link of the same open document.
   */
  private previousSync(projectId: string, id: string): string | null {
    const row = this.store.db
      .prepare('SELECT input FROM workspace_requests WHERE id=? AND projectId=?')
      .get(id, projectId) as { input: string } | undefined;
    if (!row) return null;
    const input = JSON.parse(row.input) as {
      source?: unknown;
      linkId?: unknown;
      sourceDocument?: { instance?: unknown; documentId?: unknown };
    };
    if (input.source !== 'document') return null;
    const base = `SELECT w.id FROM sync_manifests m JOIN workspace_requests w ON w.id=m.requestId
      WHERE m.projectId=? AND w.id<>? AND w.state='succeeded'
        AND json_extract(w.input,'$.source')='document'`;
    const found =
      typeof input.linkId === 'string'
        ? this.store.db
            .prepare(`${base} AND json_extract(w.input,'$.linkId')=? ORDER BY w.rowid DESC LIMIT 1`)
            .get(projectId, id, input.linkId)
        : this.store.db
            .prepare(
              `${base} AND json_extract(w.input,'$.sourceDocument.instance')=?
                AND json_extract(w.input,'$.sourceDocument.documentId')=?
                ORDER BY w.rowid DESC LIMIT 1`,
            )
            .get(
              projectId,
              id,
              String(input.sourceDocument?.instance ?? ''),
              Number(input.sourceDocument?.documentId ?? -1),
            );
    return found ? String(found.id) : null;
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
