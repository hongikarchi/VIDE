import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { DrawingBackflowService } from './drawing-backflow.ts';

/**
 * 역반영 (SPEC-14.10·14.11, ARCH-01 「도면 역반영(PLAN-47)」), at this PC only:
 * `POST …/drawing/backflow {root, link, relation, pairs?, scope?}` (the rows; reads only),
 * `POST …/drawing/backflow/pairs {root, link, pairs}` (Sync jig matched rows become baselines),
 * `GET …/drawing/backflow?path=` (a file's baseline in short; null when none),
 * `POST …/drawing/backflow/apply {diff, rows?, cover?, confirmDeletes?}` (applied, or the save card),
 * `POST …/drawing/backflow/apply/:id/confirm|cancel|undo` and
 * `POST …/drawing/backflow/sync {rhino, cad, relation, rows, confirmDeletes?}` (Sync jig "CAD를 Rhino에
 * 맞춤" on its open drawing).
 */
export const drawingBackflowStatuses: Record<string, number> = {
  DIFF_NOT_FOUND: 409,
  DIFF_NOT_SETTLED: 409,
  ROW_NOT_SELECTABLE: 422,
  DELETE_CONFIRMATION_REQUIRED: 409,
  SOURCE_CHANGED: 409,
  SOURCE_NOT_SYNCED: 409,
  APPLY_NOT_FOUND: 409,
  OUTPUT_EXISTS: 409,
  OUTPUT_UNCLEAR: 409,
  OUTPUT_VERSION_MISMATCH: 409,
  ZWCAD_PLUGIN_UPDATE_REQUIRED: 409,
  ZWCAD_ATTACHED_EDIT_UNAVAILABLE: 409,
  HIDDEN_HOST_TIMEOUT: 504,
  HIDDEN_HOST_STALLED: 504,
  HIDDEN_HOST_EXITED: 502,
};
const path = z.string().min(1).max(1024);
const finite = z.number().finite();
const id = z.string().regex(/^[a-f0-9]{24}$/);
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
const rowIds = z.array(z.string().regex(/^B\d{1,6}$/)).max(20000);
const applySchema = z
  .object({
    diff: id,
    rows: rowIds.optional(),
    cover: rowIds.optional(),
    confirmDeletes: z.boolean().optional(),
  })
  .strict();
const syncSchema = z
  .object({
    rhino: z.string().min(1).max(200),
    cad: z.string().min(1).max(200),
    relation,
    rows: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            state: z.enum(['match', 'offset', 'rhino-only', 'cad-only']),
            rhino: z.string().min(1).max(200).optional(),
            cad: z
              .string()
              .regex(/^[0-9a-f]{1,16}$/i)
              .optional(),
            layer: z.string().min(1).max(512).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
    confirmDeletes: z.boolean().optional(),
  })
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
    syncSources,
  }: {
    backflow: DrawingBackflowService;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
    /** The Sync jig's two Syncs: the Rhino link and the drawing's path (open in ZWCAD). */
    syncSources: (
      projectId: string,
      rhino: string,
      cad: string,
    ) => { linkId: string; path: string };
  },
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/drawing\/backflow(?:\/(pairs|apply|sync)(?:\/([a-f0-9]{24})\/(confirm|cancel|undo))?)?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, action, applyId, step] = match;
  project(projectId);
  if (method === 'GET' && !action) {
    send(200, { baseline: backflow.baseline(projectId, url.searchParams.get('path')) });
    return true;
  }
  if (method !== 'POST') return false;
  // This PC's drawings and hosts only; the save card is never confirmed remotely (SPEC-14.7 4).
  if (remote) throw new DomainError('FORBIDDEN');
  if (action === 'pairs')
    send(200, await backflow.establish(projectId, pairsSchema.parse(await body())));
  else if (action === 'apply' && applyId)
    send(
      200,
      step === 'confirm'
        ? await backflow.confirm(projectId, applyId)
        : step === 'cancel'
          ? await backflow.cancel(projectId, applyId)
          : await backflow.undo(projectId, applyId),
    );
  else if (action === 'apply')
    send(200, await backflow.apply(projectId, applySchema.parse(await body())));
  else if (action === 'sync') {
    const input = syncSchema.parse(await body());
    const sources = syncSources(projectId, input.rhino, input.cad);
    send(200, await backflow.syncApply(projectId, { ...input, ...sources }));
  } else if (!action) send(200, await backflow.diff(projectId, diffSchema.parse(await body())));
  else return false;
  return true;
}
