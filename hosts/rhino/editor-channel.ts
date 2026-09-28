import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import { inspectWindowsProcess } from '../common/owned-process.ts';
import { sendHostCommand } from '../common/transport.ts';
import { readScenePages } from './scene-pages.ts';
import {
  displayObjectSchema,
  displaySceneSchema,
  displayDefinitionSchema,
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
  page: z.object({
    cursor: z.number().int().nonnegative(),
    nextCursor: z.number().int().nonnegative(),
    changes: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().max(20000),
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
function editorReply<T>(schema: z.ZodType<T>, value: unknown): T {
  const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(value);
  if (error.success) throw failure(error.data.code);
  return schema.parse(value);
}

export function editorMethods(
  call: (method: string, extra?: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    async displayEditor() {
      const before = editorReply(editorSnapshotSchema, await call('inspectEditor'));
      const model = await readScenePages(
        (params) => call('displayPage', params),
        {},
        128 * 1024 * 1024,
        true,
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
        total = 0;
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
        ({ revision, changes, total } = page.page);
        cursor = page.page.nextCursor;
      } while (cursor < changes!);
      const source = editorReply(editorSnapshotSchema, await call('inspectEditor'));
      if (source.revision !== revision) throw failure('SOURCE_CHANGED');
      return { objects, scene, removed, definitions, total, revision: revision!, source };
    },
    async attachedStatus() {
      return editorReply(
        z.object({
          ok: z.literal(true),
          documentId: z.number().int().positive(),
          name: z.string(),
          units: z.string(),
          objectCount: z.number().int().nonnegative(),
          modified: z.boolean(),
          generation: z.number().int().nonnegative(),
          live: z.boolean(),
          busy: z.boolean(),
          selectionVersion: z.number().int().nonnegative().optional(),
          selectedIds: z.array(z.string().uuid()).max(2000).optional(),
          pinnedIds: z.array(z.string().uuid()).max(5000).optional(),
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
    async inspectEditor() {
      return editorReply(editorSnapshotSchema, await call('inspectEditor'));
    },
    async captureEditor(operationId: string) {
      editorReply(
        z.object({ ok: z.literal(true), pending: z.literal(true) }),
        await call('captureEditor', { operationId }),
      );
      return editorReply(editorCaptureSchema, await call('verifyEditorCapture', { operationId }));
    },
    async previewEditorApplication(filename: string, candidateHash: string, documentHash: string) {
      return editorReply(
        applicationPreviewSchema,
        await call('previewEditorApplication', { filename, candidateHash, documentHash }),
      );
    },
    async applyEditorCandidate(
      operationId: string,
      filename: string,
      candidateHash: string,
      documentHash: string,
    ) {
      return editorReply(
        applicationOutcomeSchema,
        await call('applyEditorCandidate', { operationId, filename, candidateHash, documentHash }),
      );
    },
    async recoverEditorApplication(
      operationId: string,
      filename: string,
      candidateHash: string,
      documentHash: string,
    ) {
      return editorReply(
        applicationOutcomeSchema,
        await call('recoverEditorApplication', {
          operationId,
          filename,
          candidateHash,
          documentHash,
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
          timeoutMs: method === 'displayPage' || method === 'displayChanges' ? 180000 : 60000,
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
