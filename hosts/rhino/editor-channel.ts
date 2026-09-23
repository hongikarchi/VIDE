import { z } from 'zod';
import { resolve, isAbsolute } from 'node:path';
import { inspectWindowsProcess } from '../common/owned-process.ts';
import { sendHostCommand } from '../common/transport.ts';
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
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectedIds: z.array(z.string().uuid()),
});
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
  .extend({ filename: z.string(), fileHash: z.string().regex(/^[a-f0-9]{64}$/) });
function editorReply<T>(schema: z.ZodType<T>, value: unknown): T {
  const error = z.object({ ok: z.literal(false), code: z.string() }).safeParse(value);
  if (error.success) throw failure(error.data.code);
  return schema.parse(value);
}

export function editorMethods(
  call: (method: string, extra?: Record<string, unknown>) => Promise<unknown>,
) {
  return {
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

// Reconnect only a persisted, paired editor. This handle cannot kill or execute code in the process.
export function resumeEditor(
  connection: EditorConnection,
  executable: string,
  inspect = inspectWindowsProcess,
) {
  const { identity, token } = editorConnectionSchema.parse(connection);
  if (resolve(connection.executable).toLowerCase() !== resolve(executable).toLowerCase())
    throw failure('HOST_OWNERSHIP_MISMATCH');
  const call = async (method: string, extra: Record<string, unknown> = {}) =>
    sendHostCommand(
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
        timeoutMs: 60000,
        beforeSend: async () => {
          const observed = await inspect(identity.pid, identity.port);
          if (
            observed.pid !== identity.pid ||
            observed.startTicks !== identity.startTicks ||
            resolve(observed.executable).toLowerCase() !== resolve(executable).toLowerCase() ||
            observed.listeners.length !== 1 ||
            observed.listeners[0] !== identity.pid
          )
            throw failure('HOST_OWNERSHIP_MISMATCH');
        },
      },
    );
  return { ...editorMethods(call), identity, editorConnection: connection };
}
