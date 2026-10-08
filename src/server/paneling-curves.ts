// 패널링 타일 곡선·어트랙터 (SPEC-16.13 3·4, ARCH-03 §9.1, PLAN-49 T-260). The human steps '타일
// 고르기' and '어트랙터 고르기': [고른 곡선 쓰기] / [고른 점·곡선 쓰기] read the points and curves
// selected in the linked Rhino document with the official read template `vide.read.curves@1`
// through `direct-read` (no undo record, nothing written) and keep the read as the instance's
// `host-curves` input copy; [지우기] removes it. A tile must be closed curves drawn parallel to XY
// (checked here with the kit's own rule); a refused read keeps the earlier copy.
//
//   GET  /api/v1/projects/:id/paneling/curves?instanceId=&key=   → the kept copy's reference
//   POST …/paneling/curves/read {instanceId, key, mode:'pick'|'clear', linkId?, objectIds?}

import { z } from 'zod';
import { DomainError } from '../core/store.ts';
import { isFileLink } from '../core/document-links.ts';
import { renderTemplate } from '../jigs/bake/templates.ts';
import {
  CURVE_ITEM_LIMIT,
  CURVE_TOTAL_LIMIT,
  curveSetSchema,
  type CurveSet,
} from '../contracts/paneling.ts';
import { tileFromCurves } from '../jigs/official/paneling-kit/tile.ts';
import { jigRuntimeFor } from './jig-routes.ts';
import { readFailure, templateFailure, type ReadFailure } from './paneling-read.ts';
import type { PanelingRouteContext } from './paneling-routes.ts';

export const CURVES_TEMPLATE = 'vide.read.curves@1';

/** Reasons beyond the surface read's (SPEC-16.13). */
export const CURVE_FAILURES: Record<string, string> = {
  CURVE_NOT_FOUND: '고른 점·곡선을 찾지 못했습니다',
  NOT_A_CURVE: '점·곡선이 아닌 객체가 있습니다 · 점과 곡선만 고르세요',
  CURVE_LIMIT: `점·곡선은 한 번에 ${CURVE_ITEM_LIMIT}개까지 고릅니다`,
  CURVE_POINT_LIMIT: '곡선 하나의 점이 4,096개를 넘습니다 · 곡선을 단순하게 바꾸세요',
  CURVE_TOTAL_LIMIT: `고른 곡선의 점이 모두 ${CURVE_TOTAL_LIMIT.toLocaleString('en-US')}개를 넘습니다 · 곡선을 줄이거나 단순하게 바꾸세요`,
  PICK_NONE: 'Rhino에서 점·곡선을 고른 뒤 다시 누르세요',
  NOT_TILE: '타일 곡선이 아님',
};

/** The data block: template name, count, object ids (little endian, UTF-8). */
export function curvesReadBlock(objectIds: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const i32 = (v: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    parts.push(b);
  };
  const str = (s: string) => {
    const bytes = Buffer.from(s, 'utf8');
    i32(bytes.length);
    parts.push(bytes);
  };
  str(CURVES_TEMPLATE);
  i32(objectIds.length);
  for (const id of objectIds) str(id);
  return Buffer.concat(parts);
}
export const curvesReadBody = (objectIds: readonly string[]) =>
  renderTemplate(CURVES_TEMPLATE, curvesReadBlock(objectIds)).code;

const answerSchema = z
  .object({
    schema: z.literal(CURVES_TEMPLATE),
    toMeters: z.number().positive(),
    absTol: z.number().nonnegative(),
    items: z
      .array(
        z
          .object({
            objectId: z.string(),
            kind: z.enum(['point', 'polyline']),
            closed: z.boolean(),
            flatXY: z.boolean(),
            points: z.array(z.number()),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

/** The template's answer as the shared `CurveSet` (flat xyz arrays → points). */
export function decodeCurveSet(
  value: unknown,
  source: { linkId: string; documentKey: string; readAt: string },
): CurveSet {
  const answer = answerSchema.safeParse(value);
  if (!answer.success) throw Object.assign(new Error('READ_INVALID'), { code: 'READ_INVALID' });
  const set = {
    schema: 'vide.paneling.curves@1' as const,
    source: { ...source, toMeters: answer.data.toMeters, absTol: answer.data.absTol },
    items: answer.data.items.map((item) => {
      const points: [number, number, number][] = [];
      for (let k = 0; k + 2 < item.points.length; k += 3)
        points.push([item.points[k], item.points[k + 1], item.points[k + 2]]);
      return {
        objectId: item.objectId.toLowerCase(),
        kind: item.kind,
        closed: item.closed,
        flatXY: item.flatXY,
        points,
      };
    }),
  };
  const parsed = curveSetSchema.safeParse(set);
  if (!parsed.success) throw Object.assign(new Error('READ_INVALID'), { code: 'READ_INVALID' });
  return parsed.data;
}

const failureOf = (code: string, detail?: string): ReadFailure =>
  CURVE_FAILURES[code]
    ? { code, message: detail ? `${CURVE_FAILURES[code]} · ${detail}` : CURVE_FAILURES[code] }
    : readFailure(code, detail);

const id = z.string().min(1).max(200);
export const curvesReadInput = z
  .object({
    instanceId: id,
    key: z.string().min(1).max(100),
    mode: z.enum(['pick', 'clear']).default('pick'),
    linkId: id.optional(),
    objectIds: z.array(z.string().uuid()).min(1).max(CURVE_ITEM_LIMIT).optional(),
  })
  .strict();

const runtimeOf = (ctx: PanelingRouteContext) => jigRuntimeFor(ctx.workspace, ctx.dataDirectory);

async function curvesInput(
  ctx: PanelingRouteContext,
  projectId: string,
  instanceId: string,
  key: string,
) {
  const inputs = await runtimeOf(ctx).inputsOf(projectId, instanceId);
  const input = inputs.find((i) => i.kind === 'host-curves' && i.key === key);
  if (!input || input.kind !== 'host-curves') throw new DomainError('NOT_FOUND');
  return input;
}

const referenceOf = (kept: {
  linkId: string;
  objectIds: string[];
  count: number;
  readAt: string;
}) => ({
  linkId: kept.linkId,
  objectIds: kept.objectIds,
  count: kept.count,
  readAt: kept.readAt,
});

/** The kept copy of every `host-curves` input (or one), for the cards. */
export async function curvesState(
  ctx: PanelingRouteContext,
  projectId: string,
  instanceId: string,
  key?: string,
) {
  const rt = runtimeOf(ctx);
  const inputs = (await rt.inputsOf(projectId, instanceId)).filter(
    (i) => i.kind === 'host-curves' && (key === undefined || i.key === key),
  );
  if (key !== undefined && !inputs.length) throw new DomainError('NOT_FOUND');
  return {
    inputs: inputs.map((input) => {
      const kept = rt.hostCurves(projectId, instanceId, input.key);
      return {
        key: input.key,
        title: input.title,
        accept: input.kind === 'host-curves' ? input.accept : undefined,
        picked: kept ? referenceOf(kept) : null,
      };
    }),
  };
}

/** [고른 곡선 쓰기] / [지우기]: read the selection and keep it; a refusal keeps the earlier copy. */
export async function readCurves(
  ctx: PanelingRouteContext,
  projectId: string,
  request: z.infer<typeof curvesReadInput>,
): Promise<
  | { ok: true; key: string; picked: ReturnType<typeof referenceOf> | null }
  | ({ ok: false; key: string } & ReadFailure)
> {
  const rt = runtimeOf(ctx);
  const input = await curvesInput(ctx, projectId, request.instanceId, request.key);
  const refuse = (code: string, detail?: string) => ({
    ok: false as const,
    key: input.key,
    ...failureOf(code, detail),
  });
  if (request.mode === 'clear') {
    await rt.setHostCurves(projectId, request.instanceId, input.key, null);
    return { ok: true, key: input.key, picked: null };
  }
  const rhino = (ctx.links?.list(projectId) ?? []).filter((l) => l.host === 'rhino' && !l.hidden);
  const linkId = request.linkId ?? (rhino.length === 1 ? rhino[0].id : undefined);
  if (!linkId || !ctx.links || !ctx.sdk) return refuse('HOST_NOT_CONNECTED');
  const link = ctx.links.get(projectId, linkId);
  if (link.host !== 'rhino') throw new DomainError('INVALID_INPUT');
  if (isFileLink(link)) return refuse('ATTACHED_ONLY');
  const target = { instance: link.instance, documentId: link.documentId };
  try {
    let objectIds = request.objectIds;
    if (!objectIds) {
      const selected = await ctx.sdk.selection(target);
      if (!selected.length) return refuse('PICK_NONE');
      if (selected.length > CURVE_ITEM_LIMIT) return refuse('CURVE_LIMIT');
      objectIds = selected;
    }
    objectIds = [...new Set(objectIds.map((o) => o.toLowerCase()))];
    const result = await ctx.sdk.readDirect(target, curvesReadBody(objectIds));
    if (!result.ok) {
      const lead = /^([A-Z_]+):/.exec(result.message ?? '')?.[1];
      if (result.code === 'EXECUTION_FAILED' && lead && CURVE_FAILURES[lead]) return refuse(lead);
      return { ok: false, key: input.key, ...templateFailure(result) };
    }
    const readAt = (ctx.now?.() ?? new Date()).toISOString();
    const curves = decodeCurveSet(result.value, { linkId: link.id, documentKey: link.id, readAt });
    // A tile is checked by the same rule the layout uses (SPEC-16.13 3 받기).
    if (input.accept === 'tile')
      try {
        tileFromCurves(curves);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { ok: false, key: input.key, code: 'NOT_TILE', message: text };
      }
    const kept = await rt.setHostCurves(projectId, request.instanceId, input.key, {
      curves,
      linkId: link.id,
      objectIds,
      count: curves.items.length,
      readAt,
    });
    return { ok: true, key: input.key, picked: kept ? referenceOf(kept) : null };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined;
    if (code && !(error instanceof DomainError)) return refuse(code, code);
    throw error;
  }
}
