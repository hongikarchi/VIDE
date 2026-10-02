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
  liveSync?: Pick<LiveSync, 'record'>;
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
      const scene = (captured.result as { scene?: unknown[] } | null)?.scene;
      diagnostics.write('sync', {
        request: target.id,
        host: cadOwn ? 'zwcad' : 'rhino',
        state: captured.state,
        ms: Math.round(performance.now() - began),
        hostMs,
        objects: Array.isArray(scene) ? scene.length : undefined,
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
