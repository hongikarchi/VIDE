import { DomainError } from '../core/store.ts';
import type { FolderCopyState } from './workspace-outputs.ts';

/**
 * 폴더 사본의 상태와 [버리기] (SPEC-10.10 3·4, ARCH-01 「작업 폴더(PLAN-52)」 '폴더에서 바뀜' 판정,
 * PLAN-54 T-356): `GET /api/v1/projects/:id/workspace/folder-copies` → `{copies: [{key, path,
 * state: 'written'|'changed-in-folder'|'not-written', writtenAt}]}` and
 * `POST …/workspace/folder-copies/discard {key}` → `{copy}` (the copy written again from its
 * source). A remote session reads the states but never rewrites a file on this PC (`FORBIDDEN`).
 */
export const folderCopyStatuses: Record<string, number> = {
  COPY_NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
};

export interface FolderCopyRouteDeps {
  copies: {
    folderCopies(projectId: string): Promise<FolderCopyState[]>;
    discardFolderCopy(
      projectId: string,
      key: string,
      regenerate?: (key: string) => Promise<unknown>,
    ): Promise<FolderCopyState>;
  };
  /** Throws NOT_FOUND for an unknown project. */
  project: (projectId: string) => unknown;
  /** After a restart, makes the source write `key` again (notes refresh, 일정 items). */
  regenerate?: (projectId: string, key: string) => Promise<unknown>;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, value: unknown) => void;
  remote: boolean;
}

/** True when the route was this one. */
export async function folderCopyRoutes(
  url: URL,
  method: string | undefined,
  deps: FolderCopyRouteDeps,
): Promise<boolean> {
  const match = /^\/api\/v1\/projects\/([^/]+)\/workspace\/folder-copies(\/discard)?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, discard] = match;
  deps.project(projectId);
  if (!discard && method === 'GET') {
    deps.send(200, { copies: await deps.copies.folderCopies(projectId) });
    return true;
  }
  if (discard && method === 'POST') {
    if (deps.remote) throw new DomainError('FORBIDDEN');
    const { key } = await deps.body();
    if (typeof key !== 'string' || !key || key.length > 300) throw new DomainError('INVALID_INPUT');
    const copy = await deps.copies.discardFolderCopy(
      projectId,
      key,
      deps.regenerate ? (k) => deps.regenerate!(projectId, k) : undefined,
    );
    deps.send(200, { copy });
    return true;
  }
  throw new DomainError('METHOD_NOT_ALLOWED');
}
