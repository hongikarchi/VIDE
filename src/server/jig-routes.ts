// JIG routes (ARCH-03 §7); server.ts hands requests here first. For now only the temporary run
// path of the S-06 diagnosis (PLAN-23 T-044, '공식 엔진의 임시 실행 경로'): list the layers of stored
// Syncs, then run the pure `diagnose` step on the chosen role layers. Both read the project's
// stored Sync results only and write nothing — no host command, no request, no candidate. T-051
// moves the step to the v3 runner with jig input reads and removes these routes.

import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { diagnose, type DiagnoseInputs } from '../../extensions/jigs/s06-frame/steps/diagnose.ts';
import { ROLE_KEYS } from '../../extensions/jigs/s06-frame/steps/labels.ts';
import {
  documentName,
  guessRoles,
  roleRows,
  syncLayers,
} from '../../extensions/jigs/s06-frame/steps/sync-input.ts';

export interface JigRouteContext {
  workspace: Workspace;
  body: (request: IncomingMessage) => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
}

/** Most Syncs one diagnosis reads (linked documents) and objects it takes over all roles. */
const MAX_SOURCES = 8;
const MAX_OBJECTS = 50000;

const pick = z.object({ syncId: z.string().min(1).max(200), layer: z.string().max(500) }).strict();
const diagnoseInput = z
  .object({
    sources: z.array(z.string().min(1).max(200)).min(1).max(MAX_SOURCES),
    roles: z
      .object(
        Object.fromEntries(ROLE_KEYS.map((role) => [role, z.array(pick).max(8).optional()])) as {
          [K in (typeof ROLE_KEYS)[number]]: z.ZodOptional<z.ZodArray<typeof pick>>;
        },
      )
      .strict(),
    params: z
      .object({
        spanMax: z.number().positive().max(100).optional(),
        splitTol: z.number().min(0).max(5).optional(),
        columnSize: z.number().positive().max(5).optional(),
        capClearance: z.number().min(0).max(10).optional(),
        openCutRule: z.enum(['consult', 'forbid']).optional(),
        openCutSize: z.number().positive().max(20).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Answer a jig route; false when the request is not one. */
export async function jigRoutes(
  url: URL,
  request: IncomingMessage,
  { workspace, body, send }: JigRouteContext,
): Promise<boolean> {
  const route = /^\/api\/v1\/projects\/([^/]+)\/jigs\/structure\/(layers|diagnose)$/.exec(
    url.pathname,
  );
  if (!route) return false;
  const [, projectId, action] = route;
  // One stored Sync with its display geometry; a Sync that is not finished cannot be read.
  const results = new Map<string, Record<string, unknown>>();
  const syncResult = (id: string) => {
    const known = results.get(id);
    if (known) return known;
    const saved = workspace.get(projectId, id);
    if (saved.state !== 'succeeded' || !saved.result || !Array.isArray(saved.result.scene))
      throw new DomainError('STALE_REFERENCE');
    const result = saved.result as Record<string, unknown>;
    results.set(id, result);
    return result;
  };

  if (action === 'layers' && request.method === 'GET') {
    const ids = [...new Set((url.searchParams.get('syncIds') ?? '').split(',').filter(Boolean))];
    if (!ids.length || ids.length > MAX_SOURCES) throw new DomainError('INVALID_INPUT');
    const sources = ids.map((syncId) => {
      const result = syncResult(syncId);
      return { syncId, document: documentName(result), layers: syncLayers(result) };
    });
    send(200, { sources, guess: guessRoles(sources) });
    return true;
  }
  if (action === 'diagnose' && request.method === 'POST') {
    const input = diagnoseInput.parse(await body(request));
    const inputs: DiagnoseInputs = { definitions: {} };
    let objects = 0;
    for (const role of ROLE_KEYS) {
      const picks = input.roles[role];
      if (!picks) continue;
      const rows: NonNullable<DiagnoseInputs[typeof role]> = [];
      for (const syncId of new Set(picks.map((p) => p.syncId))) {
        if (!input.sources.includes(syncId)) throw new DomainError('INVALID_INPUT');
        const layers = picks.filter((p) => p.syncId === syncId).map((p) => p.layer);
        const read = roleRows(syncResult(syncId), syncId, layers);
        rows.push(...read.rows);
        inputs.definitions![syncId] = { ...inputs.definitions![syncId], ...read.definitions };
      }
      objects += rows.length;
      if (objects > MAX_OBJECTS) throw new DomainError('INPUT_TOO_LARGE');
      inputs[role] = rows;
    }
    const start = performance.now();
    const output = diagnose(inputs, input.params);
    send(200, {
      ...output,
      ms: Math.round(performance.now() - start),
      sources: input.sources.map((syncId) => ({
        syncId,
        document: documentName(syncResult(syncId)),
      })),
    });
    return true;
  }
  return false;
}
