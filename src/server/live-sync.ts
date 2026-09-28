import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostTargetSchema } from '../contracts/host-documents.ts';
import type { SdkExecution } from './sdk-execution.ts';
import { captureInput } from './import-model.ts';

const inputSchema = hostTargetSchema.extend({
  basisId: z.string(),
  /** Revision of the display the caller holds; the returned delta applies to it. */
  revision: z.number().int().nonnegative(),
});
const basisSchema = z
  .object({
    displayOnly: z.literal(true),
    hostExecuted: z.literal(true),
    objects: z.array(z.unknown()),
    scene: z.array(z.unknown()),
    sourceDocument: z
      .object({
        connection: z.literal('attached-editor'),
        instance: z.string(),
        documentId: z.number(),
        revision: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/**
 * SPEC-01.9 Live Sync: merges only the objects Rhino reports as changed into the latest display
 * Sync of the document. A Sync that other requests already reference is never rewritten; a merged
 * copy becomes the new basis instead. Unknown state means RESYNC_REQUIRED (a full Sync).
 */
export class LiveSync {
  private latest = new Map<string, string>();
  private queue = new Map<string, Promise<unknown>>();
  private workspace: Workspace;
  private sdk: Pick<SdkExecution, 'liveSync'>;
  constructor(workspace: Workspace, sdk: Pick<SdkExecution, 'liveSync'>) {
    this.workspace = workspace;
    this.sdk = sdk;
  }
  private key(projectId: string, instance: string, documentId: number) {
    return `${projectId}|${instance}|${documentId}`;
  }
  /** A successful full display Sync becomes the newest basis of its document. */
  record(projectId: string, request: StoredWork) {
    const basis = basisSchema.safeParse(request.result);
    if (request.state === 'succeeded' && basis.success) {
      const { instance, documentId } = basis.data.sourceDocument;
      this.latest.set(this.key(projectId, instance, documentId), request.id);
    }
  }
  run(projectId: string, value: unknown) {
    const input = inputSchema.parse(value);
    const key = this.key(projectId, input.instance, input.documentId);
    // One merge at a time per document; the next one starts from the stored result.
    const next = (this.queue.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.apply(projectId, key, input))
      .catch((error: unknown) => {
        // Expected outcomes, not failures: fall back to a full Sync, or retry on the next change.
        const code = errorCode(error);
        if (code === 'RESYNC_REQUIRED') return { resync: true as const };
        // Work queued on this document holds the update until it finishes (SPEC-01.9).
        if (['SOURCE_CHANGED', 'HOST_BUSY', 'PROJECT_BUSY', 'WORKSPACE_CAPACITY'].includes(code!))
          return { retry: code! };
        throw error;
      });
    this.queue.set(key, next);
    void next
      .finally(() => {
        if (this.queue.get(key) === next) this.queue.delete(key);
      })
      .catch(() => {});
    return next;
  }
  private async apply(projectId: string, key: string, input: z.infer<typeof inputSchema>) {
    const basis = this.workspace.get(projectId, this.latest.get(key) ?? input.basisId);
    const parsed = basisSchema.safeParse(basis.result);
    if (
      basis.state !== 'succeeded' ||
      !parsed.success ||
      parsed.data.sourceDocument.instance !== input.instance ||
      parsed.data.sourceDocument.documentId !== input.documentId
    )
      throw new DomainError('RESYNC_REQUIRED');
    // Changes since the older of the two displays bring both up to date.
    const since = Math.min(input.revision, parsed.data.sourceDocument.revision);
    const target = { instance: input.instance, documentId: input.documentId };
    let merged: Awaited<ReturnType<SdkExecution['liveSync']>>;
    try {
      merged = await this.sdk.liveSync(target, parsed.data, since);
    } catch (error) {
      throw new DomainError(errorCode(error) ?? 'RESYNC_REQUIRED');
    }
    const referenced = this.workspace.store.db
      .prepare(
        'SELECT 1 FROM workspace_requests WHERE projectId=? AND id<>? AND instr(input, ?)>0 LIMIT 1',
      )
      .get(projectId, basis.id, basis.id);
    const result = { ...basis.result, ...merged.result };
    let saved: StoredWork;
    if (!referenced) saved = this.workspace.update(projectId, basis.id, 'succeeded', result);
    else {
      const id = randomUUID();
      this.workspace.submit(projectId, captureInput({ id, ...target }));
      saved = this.workspace.update(projectId, id, 'succeeded', result);
    }
    this.latest.set(key, saved.id);
    const { objects: _objects, scene: _scene, ...summary } = saved.result ?? {};
    return {
      requestId: saved.id,
      basisId: basis.id,
      created: saved.id !== basis.id,
      since,
      revision: merged.result.sourceDocument.revision,
      request: { ...saved, result: summary },
      delta: merged.delta,
    };
  }
}
