import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { DrawingBackflowService } from './drawing-backflow.ts';

/**
 * 역반영 차이 계산 (SPEC-14.10, ARCH-01 「도면 역반영(PLAN-47)」), at this PC only:
 * `POST …/drawing/backflow {root, link, relation, pairs?, scope?}` (the rows; reads only),
 * `POST …/drawing/backflow/pairs {root, link, pairs}` (Sync jig matched rows become baselines) and
 * `GET …/drawing/backflow?path=` (a file's baseline in short; null when none).
 */
const path = z.string().min(1).max(1024);
const finite = z.number().finite();
const pair = z
  .object({
    sourceId: z.string().min(1).max(200),
    path,
    handle: z.string().regex(/^[0-9a-f]{1,16}$/i),
  })
  .strict();
const relation = z
  .object({ rotation: finite, translation: z.tuple([finite, finite]), dz: finite })
  .strict();
const diffSchema = z
  .object({
    root: path,
    link: z.string().min(1).max(200),
    relation,
    pairs: z.array(pair).max(20000).optional(),
    scope: z.array(z.string().min(1).max(512)).max(5000).optional(),
  })
  .strict();
const pairsSchema = z
  .object({ root: path, link: z.string().min(1).max(200), pairs: z.array(pair).min(1).max(20000) })
  .strict();

export async function drawingBackflowRoutes(
  url: URL,
  method: string | undefined,
  {
    backflow,
    project,
    body,
    send,
    remote,
  }: {
    backflow: DrawingBackflowService;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/drawing\/backflow(?:\/(pairs))?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  if (method === 'GET' && !action) {
    send(200, { baseline: backflow.baseline(projectId, url.searchParams.get('path')) });
    return true;
  }
  if (method !== 'POST') return false;
  // This PC's drawings and hosts only.
  if (remote) throw new DomainError('FORBIDDEN');
  if (action === 'pairs')
    send(200, await backflow.establish(projectId, pairsSchema.parse(await body())));
  else send(200, await backflow.diff(projectId, diffSchema.parse(await body())));
  return true;
}
