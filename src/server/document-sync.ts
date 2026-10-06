// One full Sync of an open document (ARCH-01 §7 「엔진 주관 Sync(T-084)」): the body of
// `POST …/capture`, shared by that route (⟳, 지금 Sync, plugin Sync: `fresh`) and the engine's
// SyncScheduler. Syncs of the same document share one read through `documentSyncs` (PLAN-27 T-087).
import type { Workspace } from '../core/workspace.ts';
import type { StoredWork } from '../contracts/stored-work.ts';
import { breadcrumb } from '../core/breadcrumbs.ts';
import { previousMeasurements } from '../core/measurement-cache.ts';
import type { Diagnostics } from './diagnostics.ts';
import type { LiveSync } from './live-sync.ts';
import type { SdkExecution } from './sdk-execution.ts';
import type { ZwcadSdkExecution } from './zwcad-sdk-execution.ts';
import type { SyncCoalescer, Shared } from './sync-coalesce.ts';
import { captureModel } from './import-model.ts';

export interface DocumentSyncContext {
  workspace: Workspace;
  sdk?: Pick<SdkExecution, 'editors' | 'syncEditor' | 'fingerprint'>;
  zwcadSdk?: Pick<ZwcadSdkExecution, 'editors'>;
  /** Where a Rhino work copy is read (the SDK's import) and the fallback host without SDK. */
  rhinoImport: Parameters<typeof captureModel>[3];
  host: Parameters<typeof captureModel>[3];
  documentSyncs: SyncCoalescer<StoredWork>;
  liveSync?: Pick<LiveSync, 'record'> & Partial<Pick<LiveSync, 'basisOf'>>;
  diagnostics: Pick<Diagnostics, 'write'>;
}
export interface DocumentSyncTarget {
  /** The new Sync request's id. */
  id: string;
  instance: string;
  documentId: number;
  linkId?: string;
  /** The user asked for this Sync (⟳, 지금 Sync, plugin Sync): it never joins another. */
  fresh?: boolean;
}

/** The key Syncs of one open document share (`documentSyncs`). */
export const documentKey = (
  projectId: string,
  host: 'rhino' | 'zwcad',
  instance: string,
  documentId: number,
) => [projectId, host, instance, documentId].join('|');

/**
 * Reads an open document into a new Sync request. Returns the stored request (a joined or reused
 * Sync's request when `shared`).
 */
export async function runDocumentSync(
  context: DocumentSyncContext,
  projectId: string,
  target: DocumentSyncTarget,
): Promise<{ result: StoredWork; shared?: Shared }> {
  const began = performance.now();
  try {
    return await syncDocument(context, projectId, target);
  } catch (error) {
    // A Sync that throws instead of recording a failed request is logged with its code (T-126).
    const code = (error as { code?: unknown } | null)?.code;
    context.diagnostics.write('sync-failed', {
      request: target.id,
      projectId,
      ms: Math.round(performance.now() - began),
      code: typeof code === 'string' ? code : 'INTERNAL_ERROR',
      ...(typeof code === 'string' ? {} : { name: (error as Error | null)?.name }),
    });
    throw error;
  }
}
async function syncDocument(
  context: DocumentSyncContext,
  projectId: string,
  target: DocumentSyncTarget,
): Promise<{ result: StoredWork; shared?: Shared }> {
  const { workspace, sdk, zwcadSdk, documentSyncs, diagnostics } = context;
  const own = await sdk?.editors.has(target.instance);
  const cadOwn = await zwcadSdk?.editors.has(target.instance);
  const attached =
    !cadOwn && own && (await sdk!.editors.connectionKind(target.instance)) === 'attached-editor';
  const { result, shared } = await documentSyncs.run(
    documentKey(projectId, cadOwn ? 'zwcad' : 'rhino', target.instance, target.documentId),
    async () => {
      // Sync timing (PLAN-18 step 3): the host read (meshing, pages) and the rest (checks, storing).
      const began = performance.now();
      breadcrumb('sync-begin', { request: target.id });
      let hostMs: number | undefined;
      const timed =
        <T>(read: () => Promise<T>) =>
        async () => {
          const start = performance.now();
          try {
            return await read();
          } finally {
            hostMs = Math.round(performance.now() - start);
          }
        };
      const captured = await captureModel(
        projectId,
        target,
        workspace,
        own ? context.rhinoImport : context.host,
        cadOwn
          ? timed(async () => zwcadSdk!.editors.capture(target))
          : own
            ? timed(async () =>
                sdk!.syncEditor(
                  target,
                  (intent) => workspace.update(projectId, target.id, 'running', intent),
                  // Attached display reads never measure; skip reading stored measurements.
                  attached ? [] : previousMeasurements(workspace, projectId, target),
                ),
              )
            : undefined,
        cadOwn ? 'zwcad' : 'rhino',
      );
      const outcome = captured.result as {
        scene?: unknown[];
        code?: unknown;
        phase?: unknown;
        objectCount?: unknown;
        bytes?: unknown;
      } | null;
      const scene = outcome?.scene;
      diagnostics.write('sync', {
        request: target.id,
        projectId,
        host: cadOwn ? 'zwcad' : 'rhino',
        state: captured.state,
        ms: Math.round(performance.now() - began),
        hostMs,
        objects: Array.isArray(scene) ? scene.length : undefined,
        // A failed Sync names its code and the step it stopped in (T-126).
        ...(captured.state !== 'succeeded'
          ? {
              code: typeof outcome?.code === 'string' ? outcome.code : undefined,
              phase: typeof outcome?.phase === 'string' ? outcome.phase : undefined,
              ...(typeof outcome?.objectCount === 'number' ? { objects: outcome.objectCount } : {}),
              ...(typeof outcome?.bytes === 'number' ? { bytes: outcome.bytes } : {}),
            }
          : {}),
      });
      if (!cadOwn) context.liveSync?.record(projectId, captured);
      return captured;
    },
    {
      fresh: target.fresh,
      // Reused only while the attached document is still at the revision that Sync read.
      reusable: async (done) => {
        if (!attached) return false;
        const current = workspace.summary(projectId, done.id);
        const hash = (current.result?.sourceDocument as { documentHash?: unknown } | undefined)
          ?.documentHash;
        return (
          current.state === 'succeeded' &&
          typeof hash === 'string' &&
          (await sdk!.fingerprint(target)).documentHash === hash
        );
      },
    },
  );
  if (shared) diagnostics.write('sync-shared', { request: target.id, shared, with: result.id });
  return { result, shared };
}

/** What a user's Sync did: a Live Sync of the shown basis, or a full read of the document. */
export type UserSyncAction = 'live' | 'full';
type LiveReply = { resync: true } | { retry: string } | { requestId: string };
/** Waits between Live Sync attempts of a user's Sync after a transient refusal (T-127). */
export const LIVE_RETRY_MS = [300, 800, 1500] as const;
/** Refusals that pass on their own: a user's Sync asks the Live Sync again (T-127). */
const TRANSIENT = ['SOURCE_CHANGED', 'HOST_BUSY'];

/**
 * ⟳, 지금 Sync and the plugin's Sync (ARCH-01 §7 「사용자 Sync」, T-123): never joined to an
 * automatic Sync, always asked of the host. When the document's newest Sync is a Rhino display
 * Sync that a Live Sync can continue, only the objects changed since it are read (`live`). A
 * transient refusal (`retry`: the document changed during the read, the host busy) is asked again
 * a few times after a short wait. The first Sync, a basis a Live Sync cannot continue (`resync`,
 * retries used up, no basis, ZWCAD, a work copy) and `full` read the whole document
 * (`runDocumentSync`).
 */
export async function runUserSync(
  context: DocumentSyncContext & {
    live?: (projectId: string, input: unknown) => Promise<LiveReply>;
    /**
     * True when the engine holds the document's automatic Sync (a draft, work on it): the Live
     * Sync then writes into a copy and the shown Sync the draft uses stays as it is (SPEC-01.11 6).
     */
    holds?: (projectId: string, target: DocumentSyncTarget) => boolean;
    /** The Syncs held drafts use (pins, follow-up base): a Live Sync never edits them in place. */
    heldBases?: (projectId: string) => string[];
    /** Waits before asking a Live Sync again after a transient refusal (`retry`). */
    liveRetryMs?: readonly number[];
    /** The document is up to date: the engine's wait or failure shown on its row is over. */
    synced?: (projectId: string, target: DocumentSyncTarget) => void;
  },
  projectId: string,
  target: DocumentSyncTarget & { full?: boolean },
): Promise<{ result: StoredWork; action: UserSyncAction }> {
  const began = performance.now();
  const delays = context.liveRetryMs ?? LIVE_RETRY_MS;
  // A transient refusal (the document changed while read, the host busy) is asked again as a Live
  // Sync after a short wait; only then the whole document is read (T-127).
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const basis =
      target.full || !context.live ? undefined : userSyncBasis(context, projectId, target);
    if (!basis) break;
    let reply: LiveReply | undefined;
    try {
      const keep = context.holds?.(projectId, target);
      const held = keep ? context.heldBases?.(projectId) : undefined;
      reply = await context.live!(projectId, {
        instance: target.instance,
        documentId: target.documentId,
        basisId: basis.id,
        revision: basis.revision,
        ...(keep ? { keep: true } : {}),
        ...(held?.length ? { held } : {}),
      });
    } catch {
      reply = undefined;
    }
    if (reply && 'requestId' in reply) {
      context.diagnostics.write('user-sync', {
        request: reply.requestId,
        projectId,
        action: 'live',
        ms: Math.round(performance.now() - began),
        ...(attempt ? { attempts: attempt + 1 } : {}),
      });
      context.synced?.(projectId, target);
      return { result: context.workspace.summary(projectId, reply.requestId), action: 'live' };
    }
    if (
      !reply ||
      !('retry' in reply) ||
      !TRANSIENT.includes(reply.retry) ||
      attempt === delays.length
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }
  const { result } = await runDocumentSync(context, projectId, {
    ...target,
    fresh: target.fresh ?? true,
  });
  context.diagnostics.write('user-sync', {
    request: result.id,
    projectId,
    action: 'full',
    ms: Math.round(performance.now() - began),
  });
  if (result.state === 'succeeded') context.synced?.(projectId, target);
  return { result, action: 'full' };
}

/** The newest Rhino display Sync of the document a Live Sync can continue, with its revision. */
function userSyncBasis(
  context: DocumentSyncContext & { liveSync?: Partial<Pick<LiveSync, 'basisOf'>> },
  projectId: string,
  target: DocumentSyncTarget,
) {
  const { workspace } = context;
  const continues = (id: string | undefined) => {
    if (!id) return undefined;
    let row: StoredWork;
    try {
      row = workspace.brief(projectId, id);
    } catch {
      return undefined;
    }
    const result = row.result as Record<string, unknown> | null;
    const source = result?.sourceDocument as Record<string, unknown> | undefined;
    if (
      row.state !== 'succeeded' ||
      result?.displayOnly !== true ||
      (result.host ?? 'rhino') !== 'rhino' ||
      source?.connection !== 'attached-editor' ||
      source.instance !== target.instance ||
      source.documentId !== target.documentId ||
      typeof source.revision !== 'number'
    )
      return undefined;
    return { id: row.id, revision: source.revision };
  };
  const known = continues(
    context.liveSync?.basisOf?.(projectId, target.instance, target.documentId),
  );
  if (known) return known;
  const newest = workspace
    .list(projectId)
    .filter((row) => {
      const source = row.result?.sourceDocument as Record<string, unknown> | undefined;
      return (
        row.state === 'succeeded' &&
        row.result?.displayOnly === true &&
        source?.instance === target.instance &&
        source.documentId === target.documentId &&
        (!target.linkId || row.input.linkId === target.linkId)
      );
    })
    .at(-1);
  return continues(newest?.id);
}
