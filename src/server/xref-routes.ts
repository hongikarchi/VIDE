import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { XrefService } from './xref.ts';

/**
 * 도면 관계 (SPEC-01.11 11, ARCH-01 「도면 xref 관계(T-200)」): `GET …/xref` (the tree and the job),
 * `POST …/xref/read` ([다시 읽기]) and `POST …/xref/apply {root}` ([모델에 반영]). Both start a job
 * and answer the state at once; they run only at this PC (its folders and its ZWCAD).
 */
export const xrefStatuses: Record<string, number> = {
  NO_PROJECT_FOLDER: 409,
  NO_ZWCAD: 409,
};
const applySchema = z.object({ root: z.string().min(1).max(1024) }).strict();

export async function xrefRoutes(
  url: URL,
  method: string | undefined,
  {
    xref,
    project,
    body,
    send,
    remote,
  }: {
    xref: XrefService;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/xref(?:\/(read|apply))?$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  if (method === 'GET' && !action) {
    send(200, xref.status(projectId));
    return true;
  }
  if (method !== 'POST' || !action) return false;
  if (remote) throw new DomainError('FORBIDDEN');
  if (action === 'read') send(200, await xref.read(projectId));
  else send(200, await xref.apply(projectId, applySchema.parse(await body()).root));
  return true;
}
