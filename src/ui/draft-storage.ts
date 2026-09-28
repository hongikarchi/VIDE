import { z } from 'zod';
import { requestInputSchema } from '../contracts/workspace.ts';
import { draftPinSchema } from './workspace-data.ts';
import type { DraftState } from './model.ts';

// Drafts can be empty; execution input validation remains at submission time.
const draftSchema = z.object({
  executionLimits: requestInputSchema.shape.executionLimits,
  body: z.string().max(20000),
  instructions: z.array(z.string().max(20000)).max(100).default([]),
  host: z.enum(['rhino', 'zwcad']).default('rhino'),
  pins: z.array(draftPinSchema).max(100),
  sketches: requestInputSchema.shape.sketches,
  files: requestInputSchema.shape.files,
  model: z.string().min(1).max(110),
  effort: z.string().min(1).max(30),
  permission: z.enum(['review', 'candidate']),
  applyToSource: z.boolean().optional(),
  baseRequestId: z.string().nullable().optional(),
  linkedTargets: requestInputSchema.shape.linkedTargets,
  coordinateBasis: requestInputSchema.shape.coordinateBasis,
});

export function draftSnapshot(state: DraftState) {
  return draftSchema.parse({ ...state, baseRequestId: state.baseRequestId ?? null });
}

export function restoreDraft(value: unknown, messages: DraftState['messages']) {
  const draft = draftSchema.parse(value);
  for (const target of draft.linkedTargets || []) {
    const basis = messages.find((message) => message.id === target.baseRequestId)?.request;
    if (
      basis?.state !== 'succeeded' ||
      !basis.result?.hostExecuted ||
      (basis.result.host || 'rhino') !== target.host
    )
      throw Error('연계 대상의 기준 후보를 확인할 수 없습니다.');
  }
  if (
    draft.baseRequestId &&
    !messages.some(
      (message) => message.id === draft.baseRequestId && message.request.result?.hostExecuted,
    )
  ) {
    throw Error('초안의 기준 후보가 이 프로젝트에 없습니다.');
  }
  // Preserve each pin's original basis. Never silently retarget it to the latest model.
  for (const pin of draft.pins) {
    const basis = messages.find((message) => message.id === pin.basis)?.request.result;
    if (!basis?.hostExecuted || !basis.objects?.some((object) => object.id === pin.id))
      throw Error('초안에 첨부된 객체의 기준을 확인할 수 없습니다.');
  }
  return {
    ...draft,
    applyToSource: false,
    selected: null,
    baseRequestId: draft.baseRequestId ?? undefined,
    messages,
  };
}
