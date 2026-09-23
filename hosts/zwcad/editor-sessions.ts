import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { launchZwcadWorker } from './worker-client.ts';
import { inspectWindowsProcess } from '../common/owned-process.ts';
import { DomainError } from '../../src/contracts/errors.ts';
import { sendHostCommand } from '../common/transport.ts';
import { workspaceResultSchema } from '../../src/contracts/workspace-result.ts';
import type { HostTarget } from '../../src/contracts/host-documents.ts';

const connectionSchema = z.object({
  identity: z.object({
    pid: z.number().int().positive(),
    startTicks: z.string().regex(/^\d+$/),
    sessionId: z.string().uuid(),
    documentId: z.string().uuid(),
    port: z.number().int().min(1).max(65535),
  }),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  directory: z.string(),
  executable: z.string(),
});
type Connection = z.infer<typeof connectionSchema>;
const modelSchema = workspaceResultSchema.extend({
  objects: workspaceResultSchema.shape.objects.unwrap(),
  scene: workspaceResultSchema.shape.scene.unwrap(),
});
const querySchema = z.object({
  ok: z.literal(true),
  editor: z.literal(true),
  documentId: z.literal(1),
  name: z.string(),
  units: z.string(),
  modified: z.boolean().nullable(),
  documentHash: z.string().regex(/^[a-f0-9]{64}$/),
  model: modelSchema,
});
const failure = (code: string) => new DomainError(code);
export class ZwcadEditors {
  private connections = new Map<string, Connection>();
  private loaded?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  private async load() {
    this.loaded ??= (async () => {
      try {
        for (const item of z
          .array(connectionSchema)
          .parse(JSON.parse(await readFile(this.directory + '.editors.json', 'utf8'))))
          this.connections.set(item.identity.pid + ':' + item.identity.startTicks, item);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw failure('EDITOR_REGISTRY_INVALID');
      }
    })();
    await this.loaded;
  }
  private async persist() {
    const save = async () => {
      const path = this.directory + '.editors.json';
      await writeFile(path + '.tmp', JSON.stringify([...this.connections.values()]));
      await rename(path + '.tmp', path);
    };
    const pending = this.tail.then(save, save);
    this.tail = pending.catch(() => {});
    await pending;
  }
  async has(instance: string) {
    await this.load();
    return this.connections.has(instance);
  }
  private async call(target: HostTarget, method: string, params: Record<string, unknown> = {}) {
    await this.load();
    const connection = this.connections.get(target.instance);
    if (!connection || target.documentId !== 1) throw failure('DOCUMENT_MISMATCH');
    const { identity, token, executable } = connection;
    const result = await sendHostCommand(
      'vide',
      { ...params, ...identity, token, method },
      {
        port: identity.port,
        timeoutMs: 25000,
        beforeSend: async () => {
          const actual = await inspectWindowsProcess(identity.pid, identity.port);
          if (
            actual.startTicks !== identity.startTicks ||
            resolve(actual.executable).toLowerCase() !== resolve(executable).toLowerCase() ||
            actual.listeners.length !== 1 ||
            actual.listeners[0] !== identity.pid
          )
            throw failure('HOST_OWNERSHIP_MISMATCH');
        },
      },
    );
    const rejected = z.object({ ok: z.literal(false), code: z.string() }).safeParse(result);
    if (rejected.success) throw failure(rejected.data.code);
    return result;
  }
  async open(source: { filename: string; fileHash: string }) {
    await this.load();
    const path = relative(resolve(this.directory), resolve(source.filename));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('INVALID_ARTIFACT');
    if (
      createHash('sha256')
        .update(await readFile(source.filename))
        .digest('hex') !== source.fileHash
    )
      throw failure('SOURCE_CHANGED');
    await mkdir(this.directory, { recursive: true });
    const worker = await launchZwcadWorker({
      directory: join(this.directory, 'editor-' + randomUUID()),
      source,
      editor: true,
      visible: true,
    });
    try {
      const snapshot = querySchema.parse(await worker.query());
      const instance = worker.identity.pid + ':' + worker.identity.startTicks;
      this.connections.set(instance, connectionSchema.parse(worker.connection));
      await this.persist();
      worker.detach();
      return {
        opened: true,
        host: 'zwcad',
        instance,
        documentId: 1,
        name: snapshot.name,
        sourceUnchanged: true,
      };
    } catch (error) {
      await worker.stop();
      throw error;
    }
  }
  async list() {
    await this.load();
    const documents = [];
    for (const instance of this.connections.keys()) {
      try {
        const result = querySchema.parse(await this.call({ instance, documentId: 1 }, 'query'));
        documents.push({
          instance,
          id: 1,
          host: 'zwcad' as const,
          name: result.name,
          units: result.units,
          objectCount: result.model.objects.length,
          modified: result.modified,
        });
      } catch {
        /* Stale editor connections never trigger relaunch or process adoption. */
      }
    }
    return documents;
  }
  private candidate(value: unknown, target: HostTarget) {
    const parsed = z
      .object({
        filename: z.string(),
        fileHash: z.string().regex(/^[a-f0-9]{64}$/),
        sourceDocument: z.object({
          instance: z.string(),
          documentId: z.number(),
          documentHash: z.string(),
        }),
      })
      .parse(value);
    if (
      parsed.sourceDocument.instance !== target.instance ||
      parsed.sourceDocument.documentId !== target.documentId
    )
      throw failure('TARGET_MISMATCH');
    const path = relative(resolve(this.directory), resolve(parsed.filename));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw failure('INVALID_ARTIFACT');
    return parsed;
  }
  async preview(target: HostTarget, candidate: unknown) {
    const source = this.candidate(candidate, target);
    return this.call(target, 'preview', {
      filename: source.filename,
      candidateHash: source.fileHash,
      documentHash: source.sourceDocument.documentHash,
    });
  }
  async apply(
    id: string,
    candidate: unknown,
    target: HostTarget & { documentHash: string; candidateHash: string },
  ) {
    const source = this.candidate(candidate, target);
    if (
      source.fileHash !== target.candidateHash ||
      source.sourceDocument.documentHash !== target.documentHash
    )
      throw failure('STALE_REFERENCE');
    return this.call(target, 'apply', {
      operationId: id,
      filename: source.filename,
      candidateHash: target.candidateHash,
      documentHash: target.documentHash,
    });
  }
  async reconcile(
    id: string,
    candidate: unknown,
    target: HostTarget & { documentHash: string; candidateHash: string },
  ) {
    const source = this.candidate(candidate, target);
    return this.call(target, 'reconcile', {
      operationId: id,
      filename: source.filename,
      candidateHash: target.candidateHash,
      documentHash: target.documentHash,
    });
  }
  async inspect(target: HostTarget) {
    const result = z
      .object({
        ok: z.literal(true),
        documentHash: z.string().regex(/^[a-f0-9]{64}$/),
        selectedIds: z.array(z.string()),
      })
      .parse(await this.call(target, 'selection'));
    return {
      ...target,
      documentHash: result.documentHash,
      selectedIds: result.selectedIds,
      observedAt: new Date().toISOString(),
    };
  }
  async capture(target: HostTarget) {
    const result = querySchema
      .extend({ filename: z.string(), fileHash: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(await this.call(target, 'capture'));
    const connection = this.connections.get(target.instance)!;
    if (
      resolve(result.filename) !==
      join(resolve(connection.directory), result.filename.split(/[\\/]/).at(-1)!)
    )
      throw failure('INVALID_ARTIFACT');
    if (
      createHash('sha256')
        .update(await readFile(result.filename))
        .digest('hex') !== result.fileHash
    )
      throw failure('SOURCE_CHANGED');
    return {
      ...result.model,
      filename: result.filename,
      fileHash: result.fileHash,
      host: 'zwcad',
      executionMode: 'sdk',
      verified: true,
      sourceDocument: {
        ...target,
        connection: 'owned-editor',
        documentHash: result.documentHash,
        name: result.name,
        units: result.units,
        selectedIds: [],
        capturedAt: new Date().toISOString(),
      },
    };
  }
}
