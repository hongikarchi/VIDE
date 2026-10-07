import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { MAX_READ, type DrawingLayerService } from './drawing-layers.ts';

/**
 * 도면 읽기와 레이어 대응 (SPEC-14.3, ARCH-01 「도면 역반영(PLAN-47)」):
 * `GET …/drawing/layers` (read drawings and the job), `GET …/drawing/layers?path=` (one drawing:
 * its read and table), `POST …/drawing/layers/read {paths}` (starts a read at this PC),
 * `PUT …/drawing/layers {path, sources, chosen?, revision?}` (the drawing's whole table) and
 * `POST …/drawing/layers/copy {from, to, sources?}` (another drawing's table to this one).
 */
export const drawingLayerStatuses: Record<string, number> = {
  NO_PROJECT_FOLDER: 409,
  NO_ZWCAD: 409,
  PATH_NOT_IN_PROJECT: 403,
  FILE_MISSING: 404,
  FILE_CHANGED: 409,
  DRAWING_NOT_READ: 409,
  READ_FAILED: 409,
  UNITS_NOT_MM: 409,
  LAYER_NOT_IN_DRAWING: 422,
};
const path = z.string().min(1).max(1024);
const layer = z.string().min(1).max(512);
const readSchema = z.object({ paths: z.array(path).min(1).max(MAX_READ) }).strict();
const mapSchema = z
  .object({
    path,
    sources: z.array(layer).max(5000),
    chosen: z.record(layer, layer.nullable()).optional(),
    revision: z.number().int().min(0).optional(),
  })
  .strict();
const copySchema = z
  .object({ from: path, to: path, sources: z.array(layer).max(5000).optional() })
  .strict();

export async function drawingLayerRoutes(
  url: URL,
  method: string | undefined,
  {
    layers,
    project,
    body,
    send,
    remote,
  }: {
    layers: DrawingLayerService;
    project: (projectId: string) => unknown;
    body: () => Promise<Record<string, unknown>>;
    send: (status: number, value: unknown) => void;
    remote: boolean;
  },
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/drawing\/layers(?:\/(read|copy))?$/.exec(
    url.pathname,
  );
  if (!match) return false;
  const [, projectId, action] = match;
  project(projectId);
  if (method === 'GET' && !action) {
    const one = url.searchParams.get('path');
    send(200, one ? await layers.drawing(projectId, one) : await layers.status(projectId));
    return true;
  }
  if (method === 'PUT' && !action) {
    send(200, await layers.saveMap(projectId, mapSchema.parse(await body())));
    return true;
  }
  if (method !== 'POST' || !action) return false;
  if (action === 'read') {
    // This PC's folders and its ZWCAD only.
    if (remote) throw new DomainError('FORBIDDEN');
    send(200, await layers.read(projectId, readSchema.parse(await body()).paths));
  } else send(200, await layers.copyMap(projectId, copySchema.parse(await body())));
  return true;
}
