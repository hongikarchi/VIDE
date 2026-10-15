import type { Store } from '../core/store.ts';
import type { ProjectFolders } from '../core/project-folders.ts';
import { collectWorkspaceMap, type MapIo, type WorkspaceMap } from './workspace-map.ts';

/**
 * 파일 지도 (PLAN-52 T-318, ARCH-01 「작업 폴더(PLAN-52)」): `GET /api/v1/projects/:p/workspace/map`
 * → `{nodes, links, events, generatedAt, root, truncated}` (src/server/workspace-map.ts). The
 * answer is kept a few seconds per project so the screen and the composer's preview do not list
 * the folders again on every keystroke; `?fresh` reads again.
 */
export interface WorkspaceMapRouteDeps {
  store: Store;
  folders: ProjectFolders;
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  isProject: (projectId: string) => boolean;
  dataDirectory: string | undefined;
  send: (status: number, value: unknown) => void;
  io?: MapIo;
}

const KEEP_MS = 15_000;
const cache = new WeakMap<Store, Map<string, { at: number; map: Promise<WorkspaceMap> }>>();

/** The map of a project, read again after KEEP_MS or when `fresh`. */
export function workspaceMapOf(
  deps: Omit<WorkspaceMapRouteDeps, 'send' | 'project'>,
  projectId: string,
  fresh = false,
): Promise<WorkspaceMap> {
  let kept = cache.get(deps.store);
  if (!kept) cache.set(deps.store, (kept = new Map()));
  const hit = kept.get(projectId);
  if (hit && !fresh && Date.now() - hit.at < KEEP_MS) return hit.map;
  const map = collectWorkspaceMap(
    {
      store: deps.store,
      folders: deps.folders,
      isProject: deps.isProject,
      dataDirectory: deps.dataDirectory,
      ...(deps.io ? { io: deps.io } : {}),
    },
    projectId,
  );
  kept.set(projectId, { at: Date.now(), map });
  map.catch(() => kept.delete(projectId));
  return map;
}

export async function workspaceMapRoutes(
  url: URL,
  method: string | undefined,
  deps: WorkspaceMapRouteDeps,
): Promise<boolean> {
  const match = /^\/api\/v1\/projects\/([^/]+)\/workspace\/map$/.exec(url.pathname);
  if (!match || method !== 'GET') return false;
  const projectId = decodeURIComponent(match[1]!);
  deps.project(projectId);
  deps.send(200, await workspaceMapOf(deps, projectId, url.searchParams.has('fresh')));
  return true;
}
