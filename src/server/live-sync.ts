import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { hostTargetSchema } from '../contracts/host-documents.ts';
import { applyDisplayDelta, coverageAfter, displayCoverage } from '../core/display-delta.ts';
import { moveRowAsync } from '../core/model-move.ts';
import type { ModelDelta } from '../core/model-store.ts';
import type { SdkExecution } from './sdk-execution.ts';
import { captureInput } from './import-model.ts';

const inputSchema = hostTargetSchema.extend({
  basisId: z.string(),
  /** Revision of the display the caller holds; the returned delta applies to it. */
  revision: z.number().int().nonnegative(),
  /**
   * The basis must not change in place (a draft on the file uses it, SPEC-01.11 6): the merge goes
   * into a copy of its manifest, as for a basis another request references.
   */
  keep: z.boolean().optional(),
  /** Syncs the drafts that hold the file use now (pins, follow-up base): never edited in place. */
  held: z.array(z.string()).max(200).optional(),
});
const basisSchema = z
  .object({
    displayOnly: z.literal(true),
    hostExecuted: z.literal(true),
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
type Item = Record<string, unknown>;
type Scene = Parameters<typeof displayCoverage>[0];
type Definition = NonNullable<Parameters<typeof displayCoverage>[1]>[string];
const keyOf = (item: Item) => String(item.nativeId ?? item.id);
const shown = (definition: unknown) => {
  const value = definition as Partial<Definition> | undefined;
  return (
    !!value &&
    ((value.vertices?.length ?? 0) > 0 ||
      (value.segments?.length ?? 0) > 0 ||
      (value.texts?.length ?? 0) > 0)
  );
};
type RhinoChanges = Awaited<ReturnType<SdkExecution['liveSync']>>;
/**
 * What a host answers a Live Sync with: Rhino's change page, or ZWCAD's (T-128), which also brings
 * the whole drawing's display counts and extra result fields (`displayWarnings`).
 */
export type LiveChanges = {
  delta: ModelDelta;
  survey: Partial<RhinoChanges['survey']>;
  displayCoverage?: ReturnType<typeof displayCoverage>;
  result: RhinoChanges['result'] & Record<string, unknown>;
};
export interface LiveSource {
  liveSync(
    target: { instance: string; documentId: number },
    basis: { sourceDocument: Record<string, unknown> },
    since: number,
  ): Promise<LiveChanges>;
}
/** Outcomes that are not failures: a full Sync instead, or try again on the next change. */
export const LIVE_RETRY = ['SOURCE_CHANGED', 'HOST_BUSY', 'PROJECT_BUSY', 'WORKSPACE_CAPACITY'];

/**
 * SPEC-01.11 Live Sync: applies only the objects Rhino reports as changed to the latest display
 * Sync of the document, in its stored manifest (PLAN-27 1단계, ARCH-01 §5): the stored model is
 * never read whole. A Sync that other requests already reference, or that a draft holds (`keep`),
 * is never rewritten; a copy of its manifest becomes the new basis instead. While the draft keeps
 * holding the file, later Live Syncs update that copy in place (T-127) unless something references
 * it or a draft uses it, so one held basis gets one copy. Unknown state means RESYNC_REQUIRED (a
 * full Sync).
 */
export class LiveSync {
  private latest = new Map<string, string>();
  /** Per document: the copy a held Live Sync made (T-127), continued in place while held. */
  private copies = new Map<string, string>();
  private queue = new Map<string, Promise<unknown>>();
  private workspace: Workspace;
  private sdk: LiveSource;
  /** Waits for a full Sync of the same document that is running now (T-084). */
  private settled: (projectId: string, instance: string, documentId: number) => Promise<unknown>;
  constructor(
    workspace: Workspace,
    sdk: LiveSource,
    options: {
      settled?: (projectId: string, instance: string, documentId: number) => Promise<unknown>;
    } = {},
  ) {
    this.workspace = workspace;
    this.sdk = sdk;
    this.settled = options.settled ?? (async () => {});
  }
  private key(projectId: string, instance: string, documentId: number) {
    return `${projectId}|${instance}|${documentId}`;
  }
  /** A successful full display Sync becomes the newest basis of its document. */
  record(projectId: string, request: StoredWork) {
    const basis = basisSchema.safeParse(request.result);
    if (request.state === 'succeeded' && basis.success) {
      const { instance, documentId } = basis.data.sourceDocument;
      const key = this.key(projectId, instance, documentId);
      this.latest.set(key, request.id);
      this.copies.delete(key);
    }
  }
  /** The newest basis this engine knows for a document (recorded or continued by a Live Sync). */
  basisOf(projectId: string, instance: string, documentId: number) {
    return this.latest.get(this.key(projectId, instance, documentId));
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
        if (code === 'RESYNC_REQUIRED' || code === 'NOT_FOUND') return { resync: true as const };
        // Work queued on this document holds the update until it finishes (SPEC-01.11).
        if (LIVE_RETRY.includes(code!)) return { retry: code! };
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
    await this.settled(projectId, input.instance, input.documentId).catch(() => {});
    const basisId = this.latest.get(key) ?? input.basisId;
    // A Sync stored before per-object storage is moved now, once (ARCH-01 §5 「기존 결과 옮기기」).
    if (!this.workspace.model(projectId, basisId))
      await moveRowAsync(
        this.workspace.store.db(projectId),
        basisId,
        this.workspace.models(projectId),
      );
    const began = performance.now();
    const basis = this.workspace.brief(projectId, basisId);
    const view = this.workspace.model(projectId, basis.id);
    const parsed = basisSchema.safeParse(basis.result);
    if (
      basis.state !== 'succeeded' ||
      !parsed.success ||
      !view ||
      this.workspace.models(projectId).header(projectId, basis.id)?.objectCount === null ||
      parsed.data.sourceDocument.instance !== input.instance ||
      parsed.data.sourceDocument.documentId !== input.documentId
    )
      throw new DomainError('RESYNC_REQUIRED');
    // Changes since the older of the two displays bring both up to date.
    const since = Math.min(input.revision, parsed.data.sourceDocument.revision);
    const target = { instance: input.instance, documentId: input.documentId };
    let merged: LiveChanges;
    const asked = performance.now();
    try {
      merged = await this.sdk.liveSync(target, parsed.data, since);
    } catch (error) {
      throw new DomainError(errorCode(error) ?? 'RESYNC_REQUIRED');
    }
    const answered = performance.now();
    const delta = merged.delta as unknown as ModelDelta;
    // Display coverage from the counts before the page and the stored items it replaces.
    const definitions = new Map<string, unknown>();
    const definitionOf = (id: string) => {
      if (delta.definitions && id in delta.definitions) return delta.definitions[id];
      if (!definitions.has(id)) definitions.set(id, view.definition(id));
      return definitions.get(id);
    };
    const flipped = Object.entries(delta.definitions ?? {}).some(
      ([id, value]) => shown(value) !== shown(view.definition(id)),
    );
    const replaced = [...new Set([...delta.removed, ...delta.scene.map(keyOf)])]
      .map((item) => view.scene(item))
      .filter((item) => item !== undefined) as Scene;
    // A host that counts the whole document itself (ZWCAD) gives the counts after the page.
    const counts =
      merged.displayCoverage ??
      ((!flipped &&
        coverageAfter(
          parsed.data.displayCoverage as Parameters<typeof coverageAfter>[0],
          replaced,
          delta.scene as unknown as Scene,
          (id) => definitionOf(id) as Definition | undefined,
        )) ||
        (() => {
          // Counts unknown or a block definition appeared or emptied: count the whole model once.
          const whole = this.workspace.get(projectId, basis.id).result as unknown as {
            objects: { id: string }[];
            scene: Scene;
            definitions?: Record<string, Definition>;
          };
          const next = applyDisplayDelta(whole, delta as never);
          return displayCoverage(next.scene as Scene, next.definitions as never);
        })());
    const { coverage, layers } = merged.survey;
    const patch: Item = {
      ...merged.result,
      displayCoverage: {
        ...counts,
        ...(coverage
          ? {
              omittedHidden: coverage.omittedHidden,
              omittedFiltered: coverage.omittedFiltered,
              omittedBlockInternal: coverage.omittedBlockInternal,
              hiddenLayers: coverage.hiddenLayers,
            }
          : {}),
      },
      ...(layers ? { layers } : {}),
    };
    // Anything that points at the basis (a request, review, publication, jig read or bake, a
    // conversation's pins) keeps it as it was: the change goes to a new Sync instead, so a
    // structure jig sees its input as stale and a review still shows what it reviewed.
    // A draft's hold keeps the Sync it uses; the copy this engine made for that hold is not the
    // draft's, so it is continued in place unless a draft uses it or something points at it.
    const ownCopy = this.copies.get(key) === basis.id && !input.held?.includes(basis.id);
    const referenced =
      (input.keep && !ownCopy) ||
      !!input.held?.includes(basis.id) ||
      this.workspace.models(projectId).references(projectId, [basis.id]).has(basis.id);
    let savedId = basis.id;
    if (referenced) {
      savedId = randomUUID();
      const linkId = typeof basis.input.linkId === 'string' ? basis.input.linkId : undefined;
      this.workspace.submit(
        projectId,
        captureInput(
          { id: savedId, ...target, linkId },
          basis.input.host === 'zwcad' ? 'zwcad' : 'rhino',
        ),
      );
    }
    const applied = this.workspace.applyDelta(
      projectId,
      basis.id,
      delta,
      patch,
      referenced ? savedId : undefined,
    );
    this.latest.set(key, savedId);
    if (referenced && input.keep) this.copies.set(key, savedId);
    else if (!input.keep) this.copies.delete(key);
    const saved = this.workspace.brief(projectId, savedId);
    return {
      requestId: savedId,
      basisId: basis.id,
      created: savedId !== basis.id,
      since,
      revision: merged.result.sourceDocument.revision,
      /** The stored manifest's revision after this page (T-084 `delta?since=`). */
      displayRevision: applied.revision,
      request: saved,
      delta: merged.delta,
      timing: {
        hostMs: Math.round(answered - asked),
        engineMs: Math.round(performance.now() - answered + (asked - began)),
      },
    };
  }
}
