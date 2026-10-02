import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import { inspectWindowsProcess } from '../common/owned-process.ts';
import { HOST_CALL_MS, sendHostCommand } from '../common/transport.ts';
import { readScenePages } from './scene-pages.ts';
import { viewMethods } from './view-tools.ts';
import {
  directExecuteInputSchema,
  directExecuteResultSchema,
  directUndoResultSchema,
  documentFingerprintSchema,
  type DirectExecuteInput,
} from './application-contract.ts';
import {
  displayObjectSchema,
  displaySceneSchema,
  displayDefinitionSchema,
  displayLayerSchema,
  sourceCoverageSchema,
  type ReadScope,
} from '../../src/contracts/native-model.ts';
const failure = (code: string) => Object.assign(new Error(code), { code });
export const editorConnectionSchema = z.object({
  identity: z.object({
    port: z.number().int().min(1).max(65535),
    pid: z.number().int().positive(),
    startTicks: z.string().regex(/^\d+$/),
    sessionId: z.string().uuid(),
    documentId: z.number().int().positive(),
    revision: z.literal(0),
  }),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  executable: z.string().refine(isAbsolute),
});
export type EditorConnection = z.infer<typeof editorConnectionSchema>;
const editorSnapshotSchema = z.object({
  ok: z.literal(true),
  documentId: z.number().int().positive(),
  name: z.string(),
  units: z.string(),
  objectCount: z.number().int().nonnegative(),
  modified: z.boolean(),
  readOnly: z.boolean().optional(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Attached connections only: change revision the documentHash token stands for. */
  revision: z.number().int().nonnegative().optional(),
  selectedIds: z.array(z.string().uuid()),
});
const changesPageSchema = z.object({
  objects: z.array(displayObjectSchema).max(1000),
  scene: z.array(displaySceneSchema).max(1000),
  removed: z.array(z.string().uuid()),
  definitions: z.record(z.string().uuid(), displayDefinitionSchema).optional(),
  // The document survey after the change (T-043 plugin); absent from an older plugin.
  coverage: sourceCoverageSchema.optional(),
  layers: z.array(displayLayerSchema).optional(),
  page: z.object({
    cursor: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  }),
});
type ChangesPage = z.infer<typeof changesPageSchema>;
// Same per-item checks as a full display model, applied to changed items only.
function validChanges({ objects, scene, definitions = {} }: ChangesPage) {
  const geometry = (item: { vertices: number[]; indices: number[] }) =>
    item.vertices.length % 3 === 0 &&
    item.indices.length % 3 === 0 &&
    item.indices.every((index) => index < item.vertices.length / 3);
  return (
    objects.length === scene.length &&
    objects.every((object, index) => object.nativeId === scene[index].nativeId) &&
    scene.every(
      (item) =>
        geometry(item) &&
        item.line.length % 3 === 0 &&
        (item.segments?.length ?? 0) % 6 === 0 &&
        (!item.block || !!definitions[item.block.definition]),
    ) &&
    Object.values(definitions).every(
      (definition) => geometry(definition) && definition.segments.length % 6 === 0,
    )
  );
}
const applicationPreviewSchema = z.object({
  documentHash: z.string(),
  added: z.number().int(),
  updated: z.number().int(),
  removed: z.number().int(),
  mode: z.literal('sdk-native'),
});
const applicationOutcomeSchema = z.object({
  state: z.enum(['succeeded', 'failed', 'unknown']),
  result: z.record(z.string(), z.unknown()),
});
const editorCaptureSchema = editorSnapshotSchema
  .omit({ objectCount: true, modified: true })
  .extend({
    filename: z.string(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Attached connections: the revision token at capture time; documentHash stays the content hash. */
    revisionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullish(),
  });
/**
 * What an application writes: the objects the AI added, modified or removed in its copy (by VIDE
 * id), and the capture that copy came from (its receipt holds each object's hash at capture time).
 */
export interface ChangeSet {
  capture: string;
  changes: { added: string[]; modified: string[]; removed: string[] };
}
function editorReply<T>(schema: z.ZodType<T>, value: unknown): T {
  const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(value);
  if (error.success) throw failure(error.data.code);
  return schema.parse(value);
}

export function editorMethods(
  call: (method: string, extra?: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    // View image and measurements (the AI's eyes); the worker client spreads these methods too.
    ...viewMethods(call),
    /** The display Sync, or with `scope` a layer-limited read (hidden objects too when asked). */
    async displayEditor(scope: ReadScope = {}) {
      const before = editorReply(editorSnapshotSchema, await call('inspectEditor'));
      const model = await readScenePages(
        (params) => call('displayPage', params),
        {},
        Infinity,
        true,
        scope,
      );
      const after = editorReply(editorSnapshotSchema, await call('inspectEditor'));
      if (before.documentHash !== after.documentHash) throw failure('SOURCE_CHANGED');
      return { ...model, source: after };
    },
    /** Objects changed or removed after `since`; RESYNC_REQUIRED when this connection cannot tell. */
    async displayChanges(since: number) {
      const objects: ChangesPage['objects'] = [],
        scene: ChangesPage['scene'] = [],
        removed: string[] = [];
      const definitions: NonNullable<ChangesPage['definitions']> = {};
      let cursor = 0,
        revision: number | undefined,
        changes: number | undefined,
        total = 0,
        survey: Pick<ChangesPage, 'coverage' | 'layers'> = {};
      do {
        const page = editorReply(
          changesPageSchema,
          await call('displayChanges', {
            since,
            cursor,
            ...(revision === undefined ? {} : { revision }),
          }),
        );
        if (
          !validChanges(page) ||
          page.page.cursor !== cursor ||
          page.page.nextCursor > page.page.changes ||
          (page.page.nextCursor === cursor && cursor < page.page.changes) ||
          (revision !== undefined &&
            (page.page.revision !== revision || page.page.changes !== changes))
        )
          throw failure('HOST_INVALID_RESPONSE');
        objects.push(...page.objects);
        scene.push(...page.scene);
        removed.push(...page.removed);
        Object.assign(definitions, page.definitions);
        if (cursor === 0) survey = { coverage: page.coverage, layers: page.layers };
        ({ revision, changes, total } = page.page);
        cursor = page.page.nextCursor;
      } while (cursor < changes!);
      const source = editorReply(editorSnapshotSchema, await call('inspectEditor'));
      if (source.revision !== revision) throw failure('SOURCE_CHANGED');
      return {
        objects,
        scene,
        removed,
        definitions,
        total,
        revision: revision!,
        source,
        ...survey,
      };
    },
    async attachedStatus() {
      return editorReply(
        z.object({
          ok: z.literal(true),
          documentId: z.number().int().positive(),
          name: z.string(),
          path: z.string().optional(),
          units: z.string(),
          objectCount: z.number().int().nonnegative(),
          modified: z.boolean(),
          generation: z.number().int().nonnegative(),
          live: z.boolean(),
          busy: z.boolean(),
          selectionVersion: z.number().int().nonnegative().optional(),
          selectedIds: z.array(z.string().uuid()).optional(),
          pinnedIds: z.array(z.string().uuid()).optional(),
          linkIds: z.array(z.string().max(100)).max(50).optional(),
        }),
        await call('attachedStatus'),
      );
    },
    /** Replace the document's shared pinned object set (browser and Rhino panel). */
    async setPins(ids: string[]) {
      return editorReply(
        z.object({
          ok: z.literal(true),
          pinnedIds: z.array(z.string().uuid()),
          selectionVersion: z.number().int().nonnegative(),
        }),
        await call('setPins', { ids }),
      );
    },
    /**
     * Store a project's VIDE link id in the document (ADR-030, [새 항목으로 분리]); the document is
     * modified until the user saves it.
     */
    async setLinkId(projectId: string, linkId: string) {
      return editorReply(
        z.object({ ok: z.literal(true), linkIds: z.array(z.string()) }),
        await call('setLinkId', { projectId, linkId }),
      );
    },
    async inspectEditor() {
      return editorReply(editorSnapshotSchema, await call('inspectEditor'));
    },
    /**
     * Direct mode: run the AI's C# body in this document inside one undo record. Compile, policy,
     * execution failures and tripped guards come back as results (the AI or the user acts on them);
     * a busy, mismatched or unreachable host throws its code.
     */
    async directExecute(input: DirectExecuteInput) {
      const value = await call('direct-execute', directExecuteInputSchema.parse(input));
      if (
        value &&
        typeof value === 'object' &&
        ['guarded', 'diagnostics', 'reverted'].some((key) => key in value)
      )
        return directExecuteResultSchema.parse(value);
      return editorReply(directExecuteResultSchema, value);
    },
    /** Host undo of that execution's record; `not-latest` when anything was recorded after it. */
    async directUndo(undoId: string) {
      if (!/^\d+$/.test(undoId)) throw failure('INVALID_INPUT');
      const value = await call('direct-undo', { undoId });
      const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(value);
      if (error.success) throw failure(error.data.code);
      return directUndoResultSchema.parse(value);
    },
    /** The connection's cheap change token and revision. */
    async fingerprint() {
      return editorReply(documentFingerprintSchema, await call('fingerprint'));
    },
    async captureEditor(operationId: string) {
      editorReply(
        z.object({ ok: z.literal(true), pending: z.literal(true) }),
        await call('captureEditor', { operationId }),
      );
      return editorReply(editorCaptureSchema, await call('verifyEditorCapture', { operationId }));
    },
    async previewEditorApplication(
      filename: string,
      candidateHash: string,
      documentHash: string,
      change: ChangeSet,
    ) {
      return editorReply(
        applicationPreviewSchema,
        await call('previewEditorApplication', {
          filename,
          candidateHash,
          documentHash,
          ...change,
        }),
      );
    },
    async applyEditorCandidate(
      operationId: string,
      filename: string,
      candidateHash: string,
      documentHash: string,
      change: ChangeSet,
    ) {
      return editorReply(
        applicationOutcomeSchema,
        await call('applyEditorCandidate', {
          operationId,
          filename,
          candidateHash,
          documentHash,
          ...change,
        }),
      );
    },
    async recoverEditorApplication(
      operationId: string,
      filename: string,
      candidateHash: string,
      documentHash: string,
      change: ChangeSet,
    ) {
      return editorReply(
        applicationOutcomeSchema,
        await call('recoverEditorApplication', {
          operationId,
          filename,
          candidateHash,
          documentHash,
          ...change,
        }),
      );
    },
  };
}

// A full OS ownership check costs ~1 s (PowerShell). A passed check is reused briefly while the
// same PID is alive; any transport failure or mismatch forgets it before the token is sent again.
const OWNERSHIP_REUSE_MS = 60000;
const verifiedOwners = new WeakMap<typeof inspectWindowsProcess, Map<string, number>>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
  }
};

// Reconnect only a persisted, paired editor. This handle cannot kill or execute code in the process.
export function resumeEditor(
  connection: EditorConnection,
  executable: string,
  inspect = inspectWindowsProcess,
) {
  const { identity, token } = editorConnectionSchema.parse(connection);
  if (resolve(connection.executable).toLowerCase() !== resolve(executable).toLowerCase())
    throw failure('HOST_OWNERSHIP_MISMATCH');
  let verified = verifiedOwners.get(inspect);
  if (!verified) verifiedOwners.set(inspect, (verified = new Map()));
  const owners = verified;
  const owner = [
    identity.pid,
    identity.startTicks,
    identity.port,
    resolve(executable).toLowerCase(),
  ].join('|');
  const call = async (method: string, extra: Record<string, unknown> = {}) => {
    try {
      return await sendHostCommand(
        'vide',
        {
          ...extra,
          token,
          sessionId: identity.sessionId,
          pid: identity.pid,
          startTicks: identity.startTicks,
          documentId: identity.documentId,
          method,
        },
        {
          port: identity.port,
          timeoutMs: ['displayPage', 'displayChanges', 'direct-execute'].includes(method)
            ? HOST_CALL_MS
            : 60000,
          beforeSend: async () => {
            const at = owners.get(owner);
            if (at !== undefined && Date.now() - at < OWNERSHIP_REUSE_MS && alive(identity.pid))
              return;
            owners.delete(owner);
            const observed = await inspect(identity.pid, identity.port);
            if (
              observed.pid !== identity.pid ||
              observed.startTicks !== identity.startTicks ||
              resolve(observed.executable).toLowerCase() !== resolve(executable).toLowerCase() ||
              observed.listeners.length !== 1 ||
              observed.listeners[0] !== identity.pid
            )
              throw failure('HOST_OWNERSHIP_MISMATCH');
            owners.set(owner, Date.now());
          },
        },
      );
    } catch (error) {
      owners.delete(owner);
      throw error;
    }
  };
  return { ...editorMethods(call), identity, editorConnection: connection };
}
