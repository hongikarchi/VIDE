// 패널링 기준 면 경로 (SPEC-16.3·16.12, ARCH-03 §9.1, PLAN-49 T-251). The human step '기준 면 고르기':
// [고른 면 쓰기] takes the object the person selected in the linked Rhino document, reads its faces
// with the official read template through `direct-read` (no undo record, nothing written) and keeps
// the sample as the instance's `host-surface` input copy; [다시 읽기] reads the kept faces again
// (optionally on a finer grid). Settings never call Rhino. The state route compares the object's
// row in the link's Live Sync model with the one at read time: another geometry → '기준 면이 바뀜'.
// Reading touches the host: this PC only (remote sessions 403). A read the host refuses keeps the
// earlier sample and answers `{ok:false, code, message}`.
//
//   GET  /api/v1/projects/:id/paneling/surface?instanceId=&key=   → state of the kept sample
//   POST …/paneling/surface/read {instanceId, key?, mode:'pick'|'reread', linkId?, objectId?, faces?, grid?}

import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import type { Workspace } from '../core/workspace.ts';
import { isFileLink, type DocumentLinks } from '../core/document-links.ts';
import { isItemList } from '../core/model-store.ts';
import type { SurfaceSample } from '../contracts/paneling.ts';
import type { SdkExecution } from './sdk-execution.ts';
import { jigRuntimeFor } from './jig-routes.ts';
import {
  FACE_LIMIT,
  MAX_GRID,
  decodeHashes,
  decodeSurfaceSample,
  gridFor,
  parseGrid,
  readFailure,
  sampleSummary,
  surfaceReadBody,
  templateFailure,
  type GridAnswer,
  type ReadFailure,
} from './paneling-read.ts';

export const panelingStatuses: Record<string, number> = {
  HOST_NOT_CONNECTED: 409,
};

export interface PanelingRouteContext {
  workspace: Workspace;
  dataDirectory: string;
  body: () => Promise<Record<string, unknown>>;
  send: (status: number, data: unknown) => void;
  remote: boolean;
  links?: DocumentLinks;
  sdk?: Pick<SdkExecution, 'readDirect' | 'selection'> & Partial<Pick<SdkExecution, 'fingerprint'>>;
  now?: () => Date;
}

const id = z.string().min(1).max(200);
const readInput = z
  .object({
    instanceId: id,
    key: z.string().max(100).optional(),
    /** `pick`: the object selected in Rhino now (or `objectId`); `reread`: the kept faces again. */
    mode: z.enum(['pick', 'reread']).default('pick'),
    linkId: id.optional(),
    objectId: z.string().uuid().optional(),
    /** Faces of a polysurface to read (Rhino face index); absent = every face. */
    faces: z.array(z.number().int().nonnegative()).min(1).max(FACE_LIMIT).optional(),
    /** Sample grid per face; absent = 128 (or less so every face fits the read limit). */
    grid: z.number().int().min(2).max(MAX_GRID).optional(),
  })
  .strict();

const runtimeOf = (ctx: PanelingRouteContext) => jigRuntimeFor(ctx.workspace, ctx.dataDirectory);

async function surfaceInput(
  ctx: PanelingRouteContext,
  projectId: string,
  instanceId: string,
  key?: string,
) {
  const inputs = await runtimeOf(ctx).inputsOf(projectId, instanceId);
  const input = inputs.find(
    (i) => i.kind === 'host-surface' && (key === undefined || i.key === key),
  );
  if (!input) throw new DomainError('NOT_FOUND');
  return input;
}

/** The object's display `geometryHash` in the newest stored Sync of the link (Live Sync keeps it current). */
export function syncHashOf(
  workspace: Workspace,
  projectId: string,
  linkId: string,
  objectId: string,
): { found: boolean; hash: string | null } {
  const latest = workspace
    .list(projectId)
    .filter((entry) => entry.state === 'succeeded' && entry.input.linkId === linkId)
    .at(-1);
  if (!latest) return { found: false, hash: null };
  const wanted = objectId.toLowerCase();
  const pick = (row: unknown) => {
    const hash = (row as { geometryHash?: unknown } | undefined)?.geometryHash;
    return { found: true, hash: typeof hash === 'string' ? hash : null };
  };
  const view = workspace.model(projectId, latest.id);
  if (view) {
    const row = view.scene(objectId) ?? view.scene(wanted);
    return row === undefined ? { found: false, hash: null } : pick(row);
  }
  const result = workspace.lazy(projectId, latest.id).result;
  if (!result || !isItemList(result.scene)) return { found: false, hash: null };
  for (const row of result.scene)
    if (String(row.nativeId ?? '').toLowerCase() === wanted) return pick(row);
  return { found: false, hash: null };
}

/** '기준 면이 바뀜' (SPEC-16.3 3): the Live Sync row differs from the one at read time. */
function changedState(
  ctx: PanelingRouteContext,
  projectId: string,
  kept: { linkId: string; objectId: string; syncHash: string | null },
) {
  // Without a Live Sync row at read time there is nothing to compare with.
  if (kept.syncHash === null) return { watching: false, changed: null };
  const now = syncHashOf(ctx.workspace, projectId, kept.linkId, kept.objectId);
  if (!now.found)
    return {
      watching: true,
      changed: { reason: 'missing', message: '기준 면이 Live Sync 모델에 없습니다 · 다시 읽기' },
    };
  if (now.hash !== kept.syncHash)
    return {
      watching: true,
      changed: { reason: 'geometry', message: '기준 면이 바뀜 · 다시 읽기' },
    };
  return { watching: true, changed: null };
}

export async function surfaceState(
  ctx: PanelingRouteContext,
  projectId: string,
  instanceId: string,
  key?: string,
) {
  const input = await surfaceInput(ctx, projectId, instanceId, key);
  const kept = runtimeOf(ctx).hostSurface(projectId, instanceId, input.key);
  if (!kept) return { key: input.key, picked: null, summary: null, watching: false, changed: null };
  const { sample, ref: _ref, ...reference } = kept;
  return {
    key: input.key,
    picked: reference,
    summary: sampleSummary(sample as SurfaceSample),
    ...changedState(ctx, projectId, reference),
  };
}

const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

/** [고른 면 쓰기] / [다시 읽기]: read the faces and keep the sample; a refusal keeps the earlier one. */
export async function readSurface(
  ctx: PanelingRouteContext,
  projectId: string,
  request: z.infer<typeof readInput>,
): Promise<
  | {
      ok: true;
      key: string;
      picked: Record<string, unknown>;
      summary: ReturnType<typeof sampleSummary>;
    }
  | ({ ok: false; key: string } & ReadFailure)
> {
  const rt = runtimeOf(ctx);
  const input = await surfaceInput(ctx, projectId, request.instanceId, request.key);
  const previous = rt.hostSurface(projectId, request.instanceId, input.key);
  const refuse = (code: string, detail?: string) => ({
    ok: false as const,
    key: input.key,
    ...readFailure(code, detail),
  });
  if (request.mode === 'reread' && !previous) return refuse('NOT_PICKED');
  const rhino = (ctx.links?.list(projectId) ?? []).filter((l) => l.host === 'rhino' && !l.hidden);
  const linkId =
    request.linkId ??
    (request.mode === 'reread' ? previous?.linkId : undefined) ??
    (rhino.length === 1 ? rhino[0].id : undefined);
  if (!linkId || !ctx.links || !ctx.sdk) return refuse('HOST_NOT_CONNECTED');
  const link = ctx.links.get(projectId, linkId);
  if (link.host !== 'rhino') throw new DomainError('INVALID_INPUT');
  // The hidden-worker path (file links) is the documented alternative; this ticket reads attached
  // documents only (PLAN-49 T-251 현재 상태).
  if (isFileLink(link)) return refuse('ATTACHED_ONLY');
  const target = { instance: link.instance, documentId: link.documentId };
  const sdk = ctx.sdk;
  try {
    let objectId = request.objectId;
    if (request.mode === 'reread') objectId ??= previous!.objectId;
    if (!objectId) {
      const selected = await sdk.selection(target);
      if (!selected.length) return refuse('PICK_NONE');
      if (selected.length > 1) return refuse('PICK_MANY');
      objectId = selected[0];
    }
    objectId = objectId.toLowerCase();
    const run = async (body: string) => {
      const result = await sdk.readDirect(target, body);
      if (!result.ok)
        throw Object.assign(new Error(result.code), { read: templateFailure(result) });
      return result.value;
    };
    // Which faces: asked, kept (re-read), or every face of the object (counted by a hashes read).
    let faces =
      request.faces ??
      (request.mode === 'reread' && previous?.objectId === objectId ? previous.faces : undefined);
    let all = false;
    if (!faces) {
      const hashes = decodeHashes(
        await run(surfaceReadBody({ mode: 'hashes', objectId, faceIndex: -1, grid: 2 })),
      );
      faces = hashes.map((_h, i) => i);
      all = true;
    }
    faces = [...new Set(faces)].sort((a, b) => a - b);
    const grid = gridFor(faces.length, request.grid);
    const answers: GridAnswer[] = [];
    if (all && faces.length > 1)
      answers.push(
        parseGrid(await run(surfaceReadBody({ mode: 'grid', objectId, faceIndex: -1, grid }))),
      );
    else
      for (const faceIndex of faces)
        answers.push(
          parseGrid(await run(surfaceReadBody({ mode: 'grid', objectId, faceIndex, grid }))),
        );
    const readAt = (ctx.now?.() ?? new Date()).toISOString();
    const revision = await sdk.fingerprint?.(target).catch(() => undefined);
    const revisionKey = `${link.instance}|${link.documentId}|${revision?.revision ?? readAt}`;
    const sample = decodeSurfaceSample(answers, {
      linkId: link.id,
      documentKey: link.id,
      objectId,
      revisionKey,
      readAt,
      path: 'attached-template',
    });
    const sync = syncHashOf(ctx.workspace, projectId, link.id, objectId);
    const kept = await rt.setHostSurface(projectId, request.instanceId, input.key, {
      sample,
      linkId: link.id,
      documentKey: link.id,
      objectId,
      faces: sample.faces.map((f) => f.faceIndex),
      faceHashes: sample.faces.map((f) => f.geometryHash),
      revisionKey,
      grid,
      readAt,
      syncHash: sync.hash,
    });
    const { ref: _ref, ...picked } = kept;
    return { ok: true, key: input.key, picked, summary: sampleSummary(sample) };
  } catch (error) {
    const read = (error as { read?: ReadFailure }).read;
    if (read) return { ok: false, key: input.key, ...read };
    const code = errorCode(error);
    if (code && !(error instanceof DomainError)) return refuse(code, code);
    throw error;
  }
}

export async function panelingRoutes(
  url: URL,
  method: string | undefined,
  ctx: PanelingRouteContext,
) {
  const match = /^\/api\/v1\/projects\/([^/]+)\/paneling\/surface(\/read)?$/.exec(url.pathname);
  if (!match) return false;
  const [, projectId, read] = match;
  ctx.workspace.store.project(projectId);
  if (!read && method === 'GET') {
    const instanceId = url.searchParams.get('instanceId');
    if (!instanceId) throw new DomainError('INVALID_INPUT');
    ctx.send(
      200,
      await surfaceState(ctx, projectId, instanceId, url.searchParams.get('key') ?? undefined),
    );
    return true;
  }
  if (read && method === 'POST') {
    // Reading the host and replacing the input copy: this PC only (ARCH-01 §1.3).
    if (ctx.remote) throw new DomainError('FORBIDDEN');
    ctx.send(200, await readSurface(ctx, projectId, readInput.parse(await ctx.body())));
    return true;
  }
  return false;
}
