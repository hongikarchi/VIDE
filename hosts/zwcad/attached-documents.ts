import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { sendHostCommand } from '../common/transport.ts';
import { inspectWindowsProcess } from '../common/owned-process.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { workspaceResultSchema } from '../../src/contracts/workspace-result.ts';
import { DIRECT_MAX_DELETES, type HostTarget } from '../../src/contracts/host-documents.ts';

const connectionSchema = z.object({
  attached: z.literal(true),
  identity: z.object({
    pid: z.number().int().positive(),
    startTicks: z.string().regex(/^\d+$/),
    sessionId: z.string().uuid(),
    documentId: z.string().uuid(),
    port: z.number().int().min(1).max(65535),
  }),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.string(),
});
type Connection = z.infer<typeof connectionSchema>;
const statusSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  path: z.string().optional(),
  units: z.string(),
  objectCount: z.number().int().nonnegative(),
  modified: z.boolean().nullable(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
  live: z.boolean(),
  hostBusy: z.boolean(),
  /** VIDE link ids stored in the drawing (ADR-030), one per project it was linked to. */
  linkIds: z.array(z.string().max(100)).max(50).optional(),
  /** The plugin answers `displayChanges` (Live Sync, T-128); absent from an older plugin. */
  liveChanges: z.boolean().optional(),
});
const countsSchema = z.record(z.string(), z.number().int().nonnegative());
/** One Live Sync change page (T-128): changed rows, removed handles, and on the last page the counts. */
const changesSchema = z.object({
  ok: z.literal(true),
  cursor: z.number().int().nonnegative(),
  next: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  objects: workspaceResultSchema.shape.objects.unwrap(),
  scene: workspaceResultSchema.shape.scene.unwrap(),
  removed: z.array(z.string()),
  coverage: z
    .object({
      total: z.number().int().nonnegative(),
      displayed: z.number().int().nonnegative(),
      omitted: z.number().int().nonnegative(),
      omittedTypes: countsSchema,
      displayWarnings: countsSchema,
    })
    .nullable(),
});
const pageSchema = z.object({
  ok: z.literal(true),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  next: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  objects: workspaceResultSchema.shape.objects.unwrap(),
  scene: workspaceResultSchema.shape.scene.unwrap(),
  displayed: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  omittedTypes: z.record(z.string(), z.number().int().nonnegative()),
  displayWarnings: z.record(z.string(), z.number().int().nonnegative()),
});
const guardKind = z.enum(['bulk-delete', 'layer-delete', 'purge', 'save-as', 'export', 'publish']);
const changedRow = z
  .object({ nativeId: z.string(), hash: z.string(), layer: z.string() })
  .passthrough();
/** Host answer to 'direct-execute' (direct-mode contract, user decision 2026-09-30). */
export const directExecuteResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      undoId: z.string().nullable(),
      requestId: z.string().nullable().optional(),
      changes: z.object({
        added: z.array(changedRow),
        changed: z.array(changedRow),
        removed: z.array(z.object({ nativeId: z.string(), layer: z.string() }).passthrough()),
        layersRemoved: z.array(z.string()).optional(),
        purged: z.array(z.string()).optional(),
      }),
      confirmedGuard: z.object({ kind: guardKind, detail: z.string() }).passthrough().optional(),
      log: z.array(z.string()),
      documentHash: z.string().optional(),
      revision: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      code: z.string(),
      diagnostics: z.array(z.string()).nullable().optional(),
      guarded: z.object({ kind: guardKind, detail: z.string() }).passthrough().optional(),
      log: z.array(z.string()).optional(),
    })
    .passthrough(),
]);
export type DirectExecuteResult = z.infer<typeof directExecuteResultSchema>;
export interface DirectExecuteInput {
  requestId: string;
  code: string;
  label: string;
  guard?: { confirmed?: boolean; maxDeletes?: number };
}
export const directUndoResultSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({ ok: z.literal(false), reason: z.string() }).passthrough(),
]);
export async function readDisplayPages(
  read: (offset: number, limit: number) => Promise<unknown>,
  start: number,
  count: number,
  total: number,
  revision: number,
): Promise<z.infer<typeof pageSchema>[]> {
  try {
    return [pageSchema.parse(await read(start, count))];
  } catch (error) {
    // Read-only SDK failures are isolated to one original entity, never interpreted as a deletion.
    // Authentication, changed revision, transport and unknown execution failures still abort Sync.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code !== 'HOST_READ_FAILED' && code !== 'HOST_RESPONSE_TOO_LARGE') throw error;
    if (count > 1) {
      if (code === 'HOST_RESPONSE_TOO_LARGE') {
        // Do not serialize the same enormous block again at every binary split.
        const pages: z.infer<typeof pageSchema>[] = [];
        for (let offset = start; offset < start + count; offset++)
          pages.push(...(await readDisplayPages(read, offset, 1, total, revision)));
        return pages;
      }
      const half = Math.floor(count / 2);
      return [
        ...(await readDisplayPages(read, start, half, total, revision)),
        ...(await readDisplayPages(read, start + half, count - half, total, revision)),
      ];
    }
    const omittedType =
      code === 'HOST_RESPONSE_TOO_LARGE' ? 'OversizedDisplay' : 'UnreadableObject';
    return [
      {
        ok: true,
        offset: start,
        next: start + 1,
        total: total,
        revision: revision,
        objects: [],
        scene: [],
        displayed: 0,
        omitted: 1,
        omittedTypes: { [omittedType]: 1 },
        displayWarnings: { [omittedType]: 1 },
      },
    ];
  }
}

/** A backflow answer: an older plugin's UNSUPPORTED_METHOD means the plugin must be updated. */
function backflowAnswer(result: unknown) {
  const rejected = z
    .object({ ok: z.literal(false), code: z.string() })
    .passthrough()
    .safeParse(result);
  if (rejected.success && rejected.data.code === 'UNSUPPORTED_METHOD')
    throw new DomainError('ZWCAD_PLUGIN_UPDATE_REQUIRED');
  if (
    rejected.success &&
    rejected.data.code !== 'OP_REFUSED' &&
    rejected.data.code !== 'FILE_CHANGED'
  )
    throw new DomainError(rejected.data.code);
  if (!result || typeof result !== 'object') throw new DomainError('HOST_INVALID_RESPONSE');
  return result as Record<string, unknown>;
}

export class AttachedZwcadDocuments {
  private connections = new Map<string, Connection>();
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private async discover() {
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.connections.clear();
        return;
      }
      throw error;
    }
    const next = new Map<string, Connection>();
    for (const file of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
      try {
        const path = join(this.directory, file),
          info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) continue;
        const connection = connectionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        if (
          connection.identity.sessionId + '.json' !== file ||
          connection.identity.documentId !== connection.identity.sessionId
        )
          continue;
        const { pid, startTicks, sessionId } = connection.identity;
        next.set(`${pid}:${startTicks}:${sessionId}`, connection);
      } catch {
        /* A concurrently removed or invalid record never authorizes a connection. */
      }
    }
    this.connections = next;
  }
  async has(instance: string) {
    await this.discover();
    return this.connections.has(instance);
  }
  private async call(
    target: HostTarget,
    method: string,
    params: Record<string, unknown> = {},
    verify = true,
    raw = false,
  ) {
    const connection = this.connections.get(target.instance);
    if (!connection || target.documentId !== 1) throw new DomainError('DOCUMENT_MISMATCH');
    const { identity, token, executable } = connection;
    const result = await sendHostCommand(
      'vide',
      { ...params, ...identity, token, method },
      {
        port: identity.port,
        timeoutMs: 70000,
        maxResponseBytes: [
          'displayPage',
          'displayChanges',
          'backflow-read',
          'backflow-apply',
        ].includes(method)
          ? 128 * 1024 * 1024
          : 16 * 1024 * 1024,
        beforeSend: verify
          ? async () => {
              const actual = await inspectWindowsProcess(identity.pid, identity.port);
              if (
                actual.startTicks !== identity.startTicks ||
                resolve(actual.executable).toLowerCase() !== resolve(executable).toLowerCase() ||
                actual.listeners.length !== 1 ||
                actual.listeners[0] !== identity.pid
              )
                throw new DomainError('HOST_OWNERSHIP_MISMATCH');
            }
          : undefined,
      },
    );
    const rejected = z.object({ ok: z.literal(false), code: z.string() }).safeParse(result);
    if (rejected.success && !raw) throw new DomainError(rejected.data.code);
    return result;
  }
  async list() {
    await this.discover();
    const result = [];
    for (const instance of this.connections.keys()) {
      try {
        const status = statusSchema.parse(
          await this.call({ instance, documentId: 1 }, 'attachedStatus'),
        );
        result.push({
          instance,
          id: 1,
          host: 'zwcad' as const,
          connection: 'attached-editor' as const,
          name: status.name,
          ...(status.path ? { path: status.path } : {}),
          units: status.units,
          objectCount: status.objectCount,
          modified: status.modified,
          generation: status.generation,
          live: status.live,
          hostBusy: status.hostBusy,
          ...(status.linkIds ? { linkIds: status.linkIds } : {}),
        });
      } catch {
        /* Closed/busy sessions do not reopen or replace user windows. */
      }
    }
    return result;
  }
  /**
   * Store a project's VIDE link id in the drawing's named object dictionary (ADR-030); the drawing
   * is modified until the user saves it.
   */
  async setLinkId(target: HostTarget, projectId: string, linkId: string) {
    await this.discover();
    return z
      .object({ ok: z.literal(true), linkIds: z.array(z.string()) })
      .parse(await this.call(target, 'setLinkId', { projectId, linkId }));
  }
  async inspect(target: HostTarget) {
    await this.discover();
    const result = z
      .object({
        ok: z.literal(true),
        documentHash: z.string().regex(/^[a-f0-9]{64}$/),
        selectedIds: z.array(z.string()),
      })
      .parse(await this.call(target, 'selection'));
    return { ...target, ...result, observedAt: new Date().toISOString() };
  }
  /** Entities of the open drawing, paged (AI query). */
  async query(target: HostTarget, params: Record<string, unknown>) {
    await this.discover();
    return this.call(target, 'queryEntities', params, false);
  }
  /**
   * Runs an AI method body on the open drawing: a read aborts its transaction; a write commits one
   * transaction (one UNDO step in ZWCAD) and reports the handles it added, modified and erased.
   */
  async run(target: HostTarget, code: string, write: boolean) {
    await this.discover();
    // Compile, policy and runtime rejections come back as {ok:false} with diagnostics for the AI.
    return (await this.call(target, 'runCode', { code, write }, false, true)) as Record<
      string,
      unknown
    >;
  }
  /**
   * Direct mode: runs one AI method body in the open drawing as one ZWCAD UNDO step. Guarded
   * effects (bulk erase above guard.maxDeletes, layer deletion, purge) are not applied unless
   * guard.confirmed; the host then answers {ok:false, code:'GUARD_CONFIRMATION_REQUIRED', guarded}.
   */
  async directExecute(target: HostTarget, input: DirectExecuteInput): Promise<DirectExecuteResult> {
    await this.discover();
    const guard = {
      confirmed: input.guard?.confirmed === true,
      maxDeletes: input.guard?.maxDeletes ?? DIRECT_MAX_DELETES,
    };
    return directExecuteResultSchema.parse(
      await this.call(
        target,
        'direct-execute',
        { requestId: input.requestId, code: input.code, label: input.label, guard },
        false,
        true,
      ),
    );
  }
  /** ZWCAD's U for that execute, only while it is still the drawing's latest change. */
  async directUndo(target: HostTarget, undoId: string) {
    await this.discover();
    return directUndoResultSchema.parse(
      await this.call(target, 'direct-undo', { undoId }, false, true),
    );
  }
  /**
   * 역반영 (PLAN-47 T-233): the open drawing's model space entities, dimensions and layers as a backflow
   * reads them (with the preservation snapshot when asked). An older plugin answers
   * `ZWCAD_PLUGIN_UPDATE_REQUIRED`.
   */
  async backflowRead(target: HostTarget, snapshot = false) {
    await this.discover();
    const result = await this.call(target, 'backflow-read', { snapshot }, false, true);
    return backflowAnswer(result) as Record<string, unknown> & {
      documentHash: string;
      revision: number;
      path: string;
      units: number;
      version: string;
    };
  }
  /**
   * Applies a backflow's ops to the open drawing as one ZWCAD UNDO step (one VIDEAIRUN command), only
   * while its documentHash is `expected`. The answer has the state before and after and an undoId
   * for `directUndo`; a refused op leaves the drawing as it was ({ok:false, code:'OP_REFUSED'}).
   */
  async backflowApply(
    target: HostTarget,
    input: { ops: unknown[]; expected: string; stamp: number },
  ) {
    await this.discover();
    return backflowAnswer(await this.call(target, 'backflow-apply', input, false, true)) as Record<
      string,
      unknown
    >;
  }
  async fingerprint(target: HostTarget) {
    await this.discover();
    return z
      .object({
        ok: z.literal(true),
        documentHash: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.number().int().nonnegative(),
      })
      .parse(await this.call(target, 'fingerprint', {}, false));
  }
  async capture(target: HostTarget) {
    await this.discover();
    const status = statusSchema.parse(await this.call(target, 'attachedStatus'));
    if (status.hostBusy) throw new DomainError('HOST_BUSY');
    const objects: z.infer<typeof pageSchema>['objects'] = [],
      scene: z.infer<typeof pageSchema>['scene'] = [];
    const ids = new Set<string>(),
      omittedTypes: Record<string, number> = {},
      displayWarnings: Record<string, number> = {};
    let offset = 0,
      displayed = 0,
      omitted = 0;
    do {
      const pages = await readDisplayPages(
        (start, count) =>
          this.call(
            target,
            'displayPage',
            { offset: start, limit: count, revision: status.revision },
            false,
          ),
        offset,
        Math.max(1, Math.min(100, status.objectCount - offset)),
        status.objectCount,
        status.revision,
      );
      for (const page of pages) {
        if (
          page.offset !== offset ||
          page.total !== status.objectCount ||
          page.revision !== status.revision ||
          page.next > page.total ||
          (page.next <= offset && page.total !== 0) ||
          page.displayed + page.omitted !== page.next - offset ||
          page.objects.length !== page.scene.length
        )
          throw new DomainError('HOST_INVALID_RESPONSE');
        for (let i = 0; i < page.objects.length; i++) {
          const object = page.objects[i];
          if (ids.has(object.id) || page.scene[i].id !== object.id)
            throw new DomainError('HOST_INVALID_RESPONSE');
          ids.add(object.id);
          objects.push(object);
          scene.push(page.scene[i]);
        }
        displayed += page.displayed;
        omitted += page.omitted;
        for (const [kind, count] of Object.entries(page.omittedTypes))
          omittedTypes[kind] = (omittedTypes[kind] ?? 0) + count;
        for (const [kind, count] of Object.entries(page.displayWarnings))
          displayWarnings[kind] = (displayWarnings[kind] ?? 0) + count;
        offset = page.next;
      }
    } while (offset < status.objectCount);
    const after = statusSchema.parse(await this.call(target, 'attachedStatus', {}, false));
    if (after.documentHash !== status.documentHash || after.revision !== status.revision)
      throw new DomainError('SOURCE_CHANGED');
    return {
      host: 'zwcad',
      executionMode: 'sdk',
      displayOnly: true,
      verified: false,
      referenceOnly: true,
      objects,
      scene,
      sourceUnits: status.units,
      displayWarnings,
      displayCoverage: { total: status.objectCount, displayed, omitted, omittedTypes },
      sourceDocument: {
        ...target,
        connection: 'attached-editor',
        documentHash: status.documentHash,
        name: status.name,
        units: status.units,
        // The revision a Live Sync continues from; only a plugin that reports changes has one.
        ...(status.liveChanges ? { revision: status.revision } : {}),
        capturedAt: new Date().toISOString(),
        selectedIds: [],
      },
    };
  }
  /**
   * Live Sync (T-128): the model space entities changed after revision `since`, as rows, removed
   * handles and the drawing's display counts after them. RESYNC_REQUIRED when the plugin cannot
   * tell (an older plugin, no full read in its session, a layer or block definition changed).
   */
  async changes(target: HostTarget, since: number) {
    await this.discover();
    const objects: z.infer<typeof changesSchema>['objects'] = [],
      scene: z.infer<typeof changesSchema>['scene'] = [],
      removed: string[] = [];
    let cursor = 0,
      revision: number | undefined,
      changes = 0,
      coverage: z.infer<typeof changesSchema>['coverage'] = null;
    do {
      let page: z.infer<typeof changesSchema>;
      try {
        page = changesSchema.parse(
          await this.call(
            target,
            'displayChanges',
            { since, cursor, ...(revision === undefined ? {} : { revision }) },
            false,
          ),
        );
      } catch (error) {
        // An older plugin has no such method: a full read, as before.
        if ((error as { code?: unknown }).code === 'UNSUPPORTED_METHOD')
          throw new DomainError('RESYNC_REQUIRED');
        throw error;
      }
      if (
        page.cursor !== cursor ||
        page.next > page.changes ||
        (page.next === cursor && cursor < page.changes) ||
        page.objects.length !== page.scene.length ||
        page.objects.some((object, i) => page.scene[i].id !== object.id) ||
        (revision !== undefined && (page.revision !== revision || page.changes !== changes))
      )
        throw new DomainError('HOST_INVALID_RESPONSE');
      objects.push(...page.objects);
      scene.push(...page.scene);
      removed.push(...page.removed);
      ({ revision, changes } = page);
      cursor = page.next;
      if (page.coverage) coverage = page.coverage;
    } while (cursor < changes);
    if (!coverage) throw new DomainError('HOST_INVALID_RESPONSE');
    const after = statusSchema.parse(await this.call(target, 'attachedStatus', {}, false));
    if (after.revision !== revision) throw new DomainError('SOURCE_CHANGED');
    const { displayWarnings, ...counts } = coverage;
    return {
      objects,
      scene,
      removed,
      revision: revision!,
      displayCoverage: counts,
      displayWarnings,
      source: after,
    };
  }
}
