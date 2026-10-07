import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { DrawingSheetsService } from './drawing-sheets.ts';

/**
 * 도곽 미리보기 (SPEC-14.15, PLAN-47 T-235, ARCH-01 「도면 역반영(PLAN-47)」):
 * `GET …/drawing/sheets` (drawings, settings, .ctb choices, the last result and the job),
 * `POST …/drawing/sheets/read {root}` ([도곽 찾기], a job), `GET …/drawing/sheets/preview?sheet=`
 * (the display rows inside one sheet), `GET …/drawing/sheets/plot-style` (the table to plot with),
 * `PUT …/drawing/sheets/settings {blocks?, ctb?}` and `POST …/drawing/sheets/pick {block}`.
 * Changes and reads run only at this PC (its folders and its ZWCAD); remote sessions only look.
 */
const readSchema = z.object({ root: z.string().min(1).max(1024) }).strict();
const pickSchema = z.object({ block: z.string().min(1).max(255) }).strict();
const settingsSchema = z
  .object({
    blocks: z.array(z.string().min(1).max(255)).max(200).optional(),
    ctb: z.string().min(1).max(1024).nullable().optional(),
  })
  .strict();

export async function drawingSheetsRoutes(
  url: URL,
  method: string | undefined,
  {
    sheets,
    project,
    body,
    send,
    remote,
  }: {
    sheets: DrawingSheetsService;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match =
    /^\/api\/v1\/projects\/([^/]+)\/drawing\/sheets(?:\/(read|preview|plot-style|settings|pick))?$/.exec(
      url.pathname,
    );
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  if (method === 'GET' && !action) {
    send(200, await sheets.status(projectId));
    return true;
  }
  if (method === 'GET' && action === 'preview') {
    const id = url.searchParams.get('sheet');
    if (!id) throw new DomainError('NOT_FOUND');
    send(200, await sheets.preview(projectId, id));
    return true;
  }
  if (method === 'GET' && action === 'plot-style') {
    send(200, await sheets.plotStyle(projectId));
    return true;
  }
  if (remote && (method === 'POST' || method === 'PUT')) throw new DomainError('FORBIDDEN');
  if (method === 'POST' && action === 'read') {
    send(200, await sheets.read(projectId, readSchema.parse(await body()).root));
    return true;
  }
  if (method === 'POST' && action === 'pick') {
    send(200, await sheets.pick(projectId, pickSchema.parse(await body()).block));
    return true;
  }
  if (method === 'PUT' && action === 'settings') {
    send(200, await sheets.saveSettings(projectId, settingsSchema.parse(await body())));
    return true;
  }
  return false;
}
