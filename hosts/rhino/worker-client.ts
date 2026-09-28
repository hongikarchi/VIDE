import { editorMethods } from './editor-channel.ts';
import { readScenePages } from './scene-pages.ts';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { launchOwnedHost } from '../common/owned-process.ts';
import { sendHostCommand } from '../common/transport.ts';
import { modelChangesSchema } from '../../src/contracts/model-changes.ts';

// Preserve a bounded read failure without treating it as a malformed model.
function readResponse(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    'ok' in value &&
    value.ok === false &&
    'code' in value &&
    value.code === 'HOST_RESULT_TOO_LARGE'
  )
    throw Object.assign(new Error('HOST_RESULT_TOO_LARGE'), { code: 'HOST_RESULT_TOO_LARGE' });
  return value;
}

const readySchema = z.object({
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^\d+$/),
  sessionId: z.string().uuid(),
  documentId: z.number().int().positive(),
  revision: z.literal(0),
});
const point = z.tuple([z.number(), z.number(), z.number()]);
export const workerSnapshotSchema = z.object({
  ok: z.literal(true),
  revision: z.number().int().nonnegative(),
  uncertain: z.boolean(),
  units: z.string(),
  objects: z.array(
    z.object({
      id: z.string(),
      nativeId: z.string().uuid(),
      name: z.string(),
      type: z.string(),
      bounds: z.tuple([point, point]),
    }),
  ),
});
export const workerChangesSchema = modelChangesSchema;
export const workerResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(false),
    code: z.string(),
    revision: z.number().optional(),
    diagnostics: z.array(z.string()).optional(),
    diagnosticId: z.string().uuid().optional(),
    exceptionType: z.string().optional(),
  }),
  z.object({
    ok: z.literal(true),
    operationId: z.string().uuid(),
    revision: z.number().int().positive(),
    filename: z.string(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    readbackVerified: z.literal(true),
    snapshot: workerSnapshotSchema,
    changes: workerChangesSchema.optional(),
    value: z.unknown().optional(),
  }),
]);

interface Options {
  directory: string;
  executable: string;
  plugin: string;
  bootstrap: string;
  visible?: boolean;
  mode?: 'worker' | 'editor';
  startupTimeoutMs?: number;
  source?: {
    filename: string;
    fileHash: string;
    measurements?: {
      id: string;
      area: number | null;
      volume: number | null;
      length: number | null;
    }[];
    geometryMeasurements?: {
      id: string;
      geometryHash: string;
      area: number | null;
      volume: number | null;
      length: number | null;
    }[];
  };
  normalizeUnits?: boolean;
}
const failure = (code: string) => Object.assign(new Error(code), { code });
async function fingerprint(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function launchRhinoWorker({
  directory,
  executable,
  plugin,
  bootstrap,
  visible = false,
  mode = 'worker',
  startupTimeoutMs = 90000,
  source,
  normalizeUnits = false,
}: Options) {
  if (
    ![directory, executable, plugin, bootstrap].every(isAbsolute) ||
    /["\r\n()]/.test(bootstrap) ||
    !Number.isFinite(startupTimeoutMs) ||
    startupTimeoutMs < 1 ||
    startupTimeoutMs > 180000
  )
    throw failure('INVALID_HOST_LAUNCH');
  await Promise.all([access(executable), access(plugin), access(bootstrap)]);
  // A fresh output directory prevents adoption of stale reports or prior task receipts.
  await mkdir(directory, { recursive: false });
  let seed = '';
  if (source) {
    if (
      !isAbsolute(source.filename) ||
      !/^[a-f0-9]{64}$/.test(source.fileHash) ||
      (await fingerprint(source.filename)) !== source.fileHash
    )
      throw failure('SOURCE_CHANGED');
    seed = join(directory, 'source.3dm');
    await copyFile(source.filename, seed, constants.COPYFILE_EXCL);
    if (
      (await fingerprint(seed)) !== source.fileHash ||
      (await fingerprint(source.filename)) !== source.fileHash
    )
      throw failure('SOURCE_CHANGED');
  }
  const report = join(directory, 'ready.json'),
    sessionId = randomUUID(),
    token = randomBytes(32).toString('hex');
  const lease = await launchOwnedHost({
    executable,
    visible,
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${bootstrap})"`,
    ],
    environment: {
      ...process.env,
      VIDE_WORKER_MODE: mode,
      VIDE_WORKER_NORMALIZE_UNITS: normalizeUnits ? '1' : '0',
      VIDE_WORKER_SOURCE: seed,
      VIDE_WORKER_PLUGIN: plugin,
      VIDE_WORKER_TOKEN: token,
      VIDE_WORKER_SESSION: sessionId,
      VIDE_WORKER_REPORT: report,
    },
    spawnProcess: (file, args, options) =>
      spawn(file, args, { ...options, windowsVerbatimArguments: true }),
  });
  try {
    const deadline = Date.now() + startupTimeoutMs;
    let ready: z.infer<typeof readySchema> | undefined;
    while (Date.now() < deadline) {
      try {
        ready = readySchema.parse(JSON.parse(await readFile(report, 'utf8')));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw failure('WORKER_INVALID_READY');
      }
      try {
        const reportError = z
          .object({ code: z.string() })
          .parse(JSON.parse(await readFile(report + '.error.json', 'utf8')));
        throw failure(
          ['UNKNOWN_UNITS', 'IMPORT_LIMIT', 'INVALID_GEOMETRY'].includes(reportError.code)
            ? reportError.code
            : 'WORKER_BOOTSTRAP_FAILED',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw failure('WORKER_START_TIMEOUT');
    if (
      ready.pid !== lease.identity.pid ||
      ready.startTicks !== lease.identity.startTicks ||
      ready.sessionId !== sessionId
    )
      throw failure('HOST_OWNERSHIP_MISMATCH');
    const identity = ready;
    let closed = false;
    const call = async (method: string, extra: Record<string, unknown> = {}) => {
      if (closed) throw failure('HOST_LEASE_EXPIRED');
      return sendHostCommand(
        'vide',
        {
          ...extra,
          token,
          sessionId,
          pid: identity.pid,
          startTicks: identity.startTicks,
          documentId: identity.documentId,
          method,
        },
        { port: identity.port, timeoutMs: 60000, beforeSend: () => lease.verify(identity.port) },
      );
    };
    return {
      identity: { ...identity },
      ...editorMethods(call),
      editorConnection:
        mode === 'editor' ? { identity: { ...identity }, token, executable } : undefined,
      detach() {
        lease.detach();
      },
      async query() {
        return workerSnapshotSchema.parse(readResponse(await call('query')));
      },
      async exportModel() {
        return readScenePages((params) => call('exportPage', params), {
          ...(source?.measurements && !normalizeUnits
            ? { measurementCache: source.measurements }
            : {}),
          ...(source?.geometryMeasurements
            ? { geometryMeasurementCache: source.geometryMeasurements }
            : {}),
        });
      },
      async execute(
        operationId: string,
        revision: number,
        code: string,
        protectedIds: string[] = [],
      ) {
        return workerResultSchema.parse(
          await call('execute', { operationId, revision, code, protectedIds }),
        );
      },
      async stop() {
        closed = true;
        await lease.stop();
      },
    };
  } catch (error) {
    await lease.stop();
    throw error;
  }
}
