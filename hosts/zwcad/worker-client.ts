import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { launchOwnedHost } from '../common/owned-process.ts';
import { sendHostCommand } from '../common/transport.ts';
import { inspectorOptions } from './inspector.ts';

const readySchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^\d+$/),
  sessionId: z.string().uuid(),
  documentId: z.string().uuid(),
  port: z.number().int().min(1).max(65535),
  revision: z.literal(0),
});
export const zwcadReceiptSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(false),
    code: z.string(),
    revision: z.number().int().optional(),
    diagnosticId: z.string().uuid().optional(),
    exceptionType: z.string().optional(),
    diagnostics: z.array(z.string()).optional(),
  }),
  z.object({
    ok: z.literal(true),
    operationId: z.string().uuid(),
    revision: z.number().int().positive(),
    filename: z.string(),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
    model: z.unknown(),
    value: z.unknown().optional(),
    readbackVerified: z.literal(true),
  }),
]);
const failure = (code: string) => Object.assign(new Error(code), { code });
export async function launchZwcadWorker(options: {
  directory: string;
  executable?: string;
  plugin?: string;
  source?: { filename: string; fileHash: string };
}) {
  const config = { ...inspectorOptions(), ...options };
  if (![config.directory, config.executable, config.plugin].every(isAbsolute))
    throw failure('INVALID_HOST_LAUNCH');
  await mkdir(config.directory, { recursive: true });
  const token = randomBytes(32).toString('hex'),
    sessionId = randomUUID();
  const script = join(config.directory, 'start.scr');
  await writeFile(
    script,
    `(command "_NETLOAD" ${JSON.stringify(config.plugin.replaceAll('\\', '/'))})\nVIDESdkSession\n`,
    { flag: 'wx' },
  );
  const owner = await launchOwnedHost({
    executable: config.executable,
    args: ['/b', script],
    visible: false,
    environment: {
      ...process.env,
      VIDE_WORKER_DIRECTORY: config.directory,
      VIDE_WORKER_TOKEN: token,
      VIDE_WORKER_SESSION: sessionId,
      VIDE_WORKER_SOURCE: config.source?.filename || '',
      VIDE_WORKER_SOURCE_HASH: config.source?.fileHash || '',
    },
  });
  try {
    await writeFile(join(config.directory, 'process.json'), JSON.stringify(owner.identity), {
      flag: 'wx',
    });
    let ready: z.infer<typeof readySchema> | undefined;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        ready = readySchema.parse(
          JSON.parse(await readFile(join(config.directory, 'ready.json'), 'utf8')),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        const error = z
          .object({ code: z.string() })
          .parse(
            JSON.parse(await readFile(join(config.directory, 'ready.json.error.json'), 'utf8')),
          );
        const known = new Set([
          'SOURCE_CHANGED',
          'UNKNOWN_UNITS',
          'UNSUPPORTED_DWG_CONTENT',
          'EMPTY_DWG',
          'SESSION_EXISTS',
        ]);
        throw failure(known.has(error.code) ? error.code : 'ZWCAD_EXECUTION_FAILED');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw failure('WORKER_START_TIMEOUT');
    if (
      ready.pid !== owner.identity.pid ||
      ready.startTicks !== owner.identity.startTicks ||
      ready.sessionId !== sessionId
    )
      throw failure('HOST_OWNERSHIP_MISMATCH');
    const identity = ready;
    const call = (params: Record<string, unknown>) =>
      sendHostCommand(
        'vide',
        {
          ...params,
          token,
          sessionId,
          pid: identity.pid,
          startTicks: identity.startTicks,
          documentId: identity.documentId,
        },
        { port: identity.port, timeoutMs: 25000, beforeSend: () => owner.verify(identity.port) },
      );
    return {
      identity,
      stop: () => owner.stop(),
      query: () => call({ method: 'query' }),
      exportModel: async () =>
        z
          .object({ ok: z.literal(true), model: z.unknown() })
          .parse(await call({ method: 'export' })).model,
      execute: async (operationId: string, revision: number, code: string) =>
        zwcadReceiptSchema.parse(await call({ method: 'execute', operationId, revision, code })),
    };
  } catch (error) {
    await owner.stop();
    throw error;
  }
}
