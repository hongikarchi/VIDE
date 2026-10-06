import { z } from 'zod';
import { requestInputSchema } from '../contracts/workspace.ts';
import { draftPinSchema } from './workspace-data.ts';
import type { DraftState } from './model.ts';

// Drafts can be empty; execution input validation remains at submission time. Unknown fields of
// older drafts (the composer's former `applyToSource`) are dropped when they are read.
const draftSchema = z.object({
  executionLimits: requestInputSchema.shape.executionLimits,
  body: z.string(),
  instructions: z.array(z.string()).default([]),
  host: z.enum(['rhino', 'zwcad']).default('rhino'),
  pins: z.array(draftPinSchema),
  sketches: requestInputSchema.shape.sketches,
  files: requestInputSchema.shape.files,
  // Path chips (SPEC-01.12 6): the token text and the path it stands for.
  paths: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        kind: z.enum(['file', 'folder']),
        path: z.string().min(1).max(1024),
        attached: z.string().max(100).optional(),
      }),
    )
    .default([]),
  model: z.string().min(1).max(110),
  effort: z.string().min(1).max(30),
  permission: z.enum(['review', 'candidate']),
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
      throw Error('이전 연계 요청의 기준 후보를 확인할 수 없습니다.');
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
    // A display Sync listed without its rows (T-123): the engine checks the pin when it is sent.
    if (
      !basis?.hostExecuted ||
      (!basis.objectsOmitted && !basis.objects?.some((object) => object.id === pin.id))
    )
      throw Error('초안에 첨부된 객체의 기준을 확인할 수 없습니다.');
  }
  return {
    ...draft,
    selected: null,
    baseRequestId: draft.baseRequestId ?? undefined,
    messages,
  };
}

/**
 * Drafts are kept per conversation (SPEC-02.19 1, 2026-10-02): `vide:draft:<project>:<conversation>`,
 * `default` for the project's default conversation. The single draft of earlier versions
 * (`vide:draft:<project>`) becomes the default conversation's once.
 */
export const draftKey = (projectId: string, conversation: string | null) =>
  `vide:draft:${projectId}:${conversation ?? 'default'}`;
export function migrateProjectDraft(projectId: string) {
  try {
    const legacy = 'vide:draft:' + projectId;
    const old = localStorage.getItem(legacy);
    if (old === null) return;
    if (localStorage.getItem(draftKey(projectId, null)) === null)
      localStorage.setItem(draftKey(projectId, null), old);
    localStorage.removeItem(legacy);
  } catch {
    /* Storage may be unavailable. */
  }
}
/** A sent draft that is no longer on screen: its input goes, its mode and effort stay. */
export function clearStoredDraft(key: string) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const draft = JSON.parse(raw) as Record<string, unknown>;
    Object.assign(draft, {
      body: '',
      instructions: [],
      pins: [],
      sketches: [],
      files: [],
      paths: [],
      linkedTargets: undefined,
      coordinateBasis: undefined,
    });
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* Storage may be unavailable or the draft unreadable; it is checked again when restored. */
  }
}
export function removeDraft(projectId: string, conversation: string) {
  try {
    localStorage.removeItem(draftKey(projectId, conversation));
  } catch {
    /* Storage may be unavailable. */
  }
}
/** Every draft of a deleted project, and its remembered conversation tab. */
export function removeProjectDrafts(projectId: string) {
  try {
    const prefix = 'vide:draft:' + projectId;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && (key === prefix || key.startsWith(prefix + ':'))) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    localStorage.removeItem(conversationKey(projectId));
  } catch {
    /* Storage may be unavailable. */
  }
}
/** The conversation tab last viewed in a project, reopened after a restart (null = default). */
const conversationKey = (projectId: string) => 'vide:conversation:' + projectId;
export function lastConversation(projectId: string): string | null {
  try {
    const id = localStorage.getItem(conversationKey(projectId));
    return id && /^\S{1,200}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
export function rememberConversation(projectId: string, conversation: string | null) {
  try {
    if (conversation) localStorage.setItem(conversationKey(projectId), conversation);
    else localStorage.removeItem(conversationKey(projectId));
  } catch {
    /* Preference only. */
  }
}
