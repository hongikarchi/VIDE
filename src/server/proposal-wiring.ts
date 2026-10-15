// The engine's wiring of 동기화 쌍 and 갱신 제안 (PLAN-54 T-349·T-351): the pair store over the work
// folder manifest, the watch over the linked files' Syncs, and the existing paths it calls — the
// Sync jig's comparison (`runSync` with the pair's relation) and the backflow apply of PLAN-47
// (`DrawingBackflowService.syncApply`, the Sync jig's "CAD를 Rhino에 맞춤"). Nothing here writes a
// host by its own route.
import { existsSync } from 'node:fs';
import { DomainError } from '../contracts/errors.ts';
import type { DocumentLink, DocumentLinks } from '../core/document-links.ts';
import { isItemList } from '../core/model-store.ts';
import type { ProjectFolders } from '../core/project-folders.ts';
import {
  readDismissed,
  SyncPairStore,
  writeDismissed,
  type ResolvedPair,
} from '../core/sync-pairs.ts';
import { workspaceOf } from '../core/workspace-config.ts';
import type { Workspace } from '../core/workspace.ts';
import { pathKey } from '../core/xref-graph.ts';
import { runSync } from '../jigs/sync.ts';
import type { DrawingBackflowService } from './drawing-backflow.ts';
import { linkRequests } from './link-removal.ts';
import { matchLinks, type OpenDocument } from './live-links.ts';
import { ProposalWatch, type PairSideState, type ProposalActionEvent } from './proposal-watch.ts';
import type { PairPreparation } from './sync-pair-routes.ts';

export interface ProposalWiringOptions {
  dataDirectory: string;
  folders: ProjectFolders;
  isProject: (projectId: string) => boolean;
  links: Pick<DocumentLinks, 'list'>;
  workspace: Workspace;
  /** The documents open in connected hosts now (the links list's read). */
  openDocuments: () => Promise<readonly OpenDocument[]>;
  backflow: Pick<DrawingBackflowService, 'syncApply' | 'baseline'>;
  record?: (event: ProposalActionEvent) => void;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

const hostOf = (row: { result?: { host?: unknown } | null }) =>
  (typeof row.result?.host === 'string' && row.result.host) || 'rhino';

export function createProposalWiring(options: ProposalWiringOptions) {
  const { links, workspace } = options;
  const pairs = new SyncPairStore({
    dataDirectory: options.dataDirectory,
    workspaceOf: (projectId) =>
      workspaceOf(options.folders, projectId, { isProject: options.isProject }),
  });
  /** The linked file of a path (the designating PC's link id first, then by path). */
  const linkFor = (projectId: string, path: string, hint?: string): DocumentLink | undefined => {
    const all = links.list(projectId);
    const key = pathKey(path);
    return (
      all.find((link) => link.id === hint && (!link.path || pathKey(link.path) === key)) ??
      all.find((link) => !!link.path && pathKey(link.path) === key)
    );
  };
  const latestSync = (projectId: string, link: DocumentLink | undefined) => {
    if (!link) return null;
    const own = linkRequests(link, workspace.list(projectId)).filter(
      (row) => row.state === 'succeeded' && hostOf(row) === link.host,
    );
    return own.at(-1)?.id ?? null;
  };
  const side = (projectId: string, path: string, hint?: string): PairSideState => {
    const link = linkFor(projectId, path, hint);
    return {
      exists: existsSync(path),
      linkId: link?.id ?? null,
      syncId: latestSync(projectId, link),
    };
  };
  const source = (projectId: string, id: string, host: 'rhino' | 'zwcad') => {
    const saved = workspace.lazy(projectId, id);
    if (saved.state !== 'succeeded' || !saved.result || !isItemList(saved.result.scene))
      throw new DomainError('STALE_REFERENCE');
    if ((saved.result.host || 'rhino') !== host) throw new DomainError('TARGET_MISMATCH');
    return saved.result as Record<string, unknown>;
  };
  const watch = new ProposalWatch({
    pairs: (projectId) => pairs.list(projectId),
    sides: async (projectId, pair: ResolvedPair) => ({
      model: side(projectId, pair.absolute.model, pair.linkIds?.model),
      drawing: side(projectId, pair.absolute.drawing, pair.linkIds?.drawing),
    }),
    open: async (projectId, linkId) => {
      const documents = await options.openDocuments().catch(() => [] as OpenDocument[]);
      const matched = matchLinks(links.list(projectId), documents);
      const document = matched.get(linkId)?.document as
        | (OpenDocument & { busy?: unknown; hostBusy?: unknown })
        | undefined;
      const running = workspace
        .list(projectId)
        .some(
          (row) =>
            (row.state === 'queued' || row.state === 'running') && row.input.linkId === linkId,
        );
      return { open: !!document, busy: !!document?.hostBusy || !!document?.busy || running };
    },
    compute: (projectId, modelSync, drawingSync, relation) =>
      runSync(source(projectId, modelSync, 'rhino'), source(projectId, drawingSync, 'zwcad'), {
        candidate: {
          rotation: relation.rotation,
          translation: relation.translation,
          dz: relation.dz,
        },
      }),
    linkOf: (projectId, requestId) => {
      try {
        const linkId = workspace.summary(projectId, requestId).input.linkId;
        return typeof linkId === 'string' ? linkId : undefined;
      } catch {
        return undefined;
      }
    },
    dismissed: {
      read: (projectId) => readDismissed(options.dataDirectory, projectId),
      write: (projectId, value) => writeDismissed(options.dataDirectory, projectId, value),
    },
    // The Sync jig's two Syncs, as `POST …/drawing/backflow/sync` resolves them.
    apply: async (projectId, input) => {
      const rows = workspace.list(projectId);
      const of = (id: string) => rows.find((row) => row.id === id && row.state === 'succeeded');
      const r = of(input.rhino),
        c = of(input.cad);
      if (!r || !c) throw new DomainError('STALE_REFERENCE');
      const document = (c.result?.sourceDocument ?? {}) as { path?: unknown };
      if (typeof r.input.linkId !== 'string' || typeof document.path !== 'string')
        throw new DomainError('ZWCAD_ATTACHED_EDIT_UNAVAILABLE');
      return options.backflow.syncApply(projectId, {
        ...input,
        linkId: r.input.linkId,
        path: document.path,
      });
    },
    ...(options.record ? { record: options.record } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  /**
   * Whether two files may become a pair (SPEC-01.13 11: compared with the Sync jig in this project):
   * the drawing has pairs recorded from the Sync jig ([짝 기록]). The relation is the one their two
   * latest Syncs give when it is not ambiguous.
   */
  const prepare = async (
    projectId: string,
    files: { model: string; drawing: string },
  ): Promise<PairPreparation> => {
    let compared = false;
    try {
      compared = !!options.backflow.baseline(projectId, files.drawing);
    } catch {
      compared = false;
    }
    const model = linkFor(projectId, files.model);
    const drawing = linkFor(projectId, files.drawing);
    const linkIds = {
      ...(model ? { model: model.id } : {}),
      ...(drawing ? { drawing: drawing.id } : {}),
    };
    let relation: PairPreparation['relation'];
    const modelSync = latestSync(projectId, model),
      drawingSync = latestSync(projectId, drawing);
    if (compared && modelSync && drawingSync)
      try {
        const { alignment } = runSync(
          source(projectId, modelSync, 'rhino'),
          source(projectId, drawingSync, 'zwcad'),
        );
        if (!alignment.ambiguous && alignment.pairs > 0)
          relation = {
            rotation: alignment.rotation,
            translation: alignment.translation,
            dz: alignment.dz,
          };
      } catch {
        relation = undefined;
      }
    return {
      compared,
      ...(relation ? { relation } : {}),
      ...(Object.keys(linkIds).length ? { linkIds } : {}),
    };
  };
  return { pairs, watch, prepare };
}
