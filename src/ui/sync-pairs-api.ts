// 동기화 쌍과 갱신 제안 on the page (PLAN-54 T-349·T-351, ARCH-01 '동기화 쌍과 갱신 제안'): the
// engine's pair and card routes, read with zod, and the plain words the screens show for them
// (Design §07: no pair id, object id or fingerprint on screen).
import { z } from 'zod';
import { api } from './gateway.ts';

const point = z.tuple([z.number(), z.number(), z.number()]);
const line = z.tuple([point, point]);
export const proposalRowSchema = z
  .object({
    id: z.string(),
    state: z.enum(['offset', 'rhino-only', 'cad-only']),
    rhino: z
      .object({
        id: z.string(),
        nativeId: z.string(),
        layer: z.string(),
        name: z.string().optional(),
        type: z.string(),
        rule: z.literal('section').optional(),
      })
      .passthrough()
      .optional(),
    cad: z
      .object({ id: z.string(), nativeId: z.string(), layer: z.string(), type: z.string() })
      .passthrough()
      .optional(),
    deviation: z.number().optional(),
    length: z.number().optional(),
    key: z.string(),
    overlay: z.object({ now: line.optional(), after: line.optional() }).optional(),
  })
  .passthrough();
export const proposalSchema = z
  .object({
    id: z.string(),
    pairId: z.string(),
    changedSide: z.enum(['model', 'drawing']),
    changedAt: z.string(),
    rows: z.array(proposalRowSchema),
    refused: z.array(
      z.object({
        rowId: z.string(),
        reason: z.enum(['unsupported', 'conflict', 'broken']),
        code: z.string(),
      }),
    ),
    computedAt: z.string(),
    basis: z.object({ modelSync: z.string(), drawingSync: z.string() }),
    names: z.object({ model: z.string(), drawing: z.string() }),
    blocked: z.literal('unclear').optional(),
  })
  .passthrough();
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalRow = z.infer<typeof proposalRowSchema>;

export const pairSchema = z
  .object({
    id: z.string(),
    absolute: z.object({ model: z.string(), drawing: z.string() }),
    names: z.object({ model: z.string(), drawing: z.string() }),
    status: z.enum([
      'ok',
      'file-missing',
      'no-relation',
      'not-synced',
      'link-closed',
      'both-changed',
      'error',
    ]),
    code: z.string().optional(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .passthrough();
export type SyncPairView = z.infer<typeof pairSchema>;

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
/** Codes the card and the map strip word themselves. */
export const PROPOSAL_QUIET = [
  'PROPOSAL_STALE',
  'PROPOSAL_NOT_FOUND',
  'PROPOSAL_DIRECTION_PENDING',
  'PAIR_LINK_CLOSED',
  'HOST_BUSY',
  'DELETE_CONFIRMATION_REQUIRED',
  'PAIR_EXISTS',
  'PAIR_NOT_COMPARED',
  'PAIR_NOT_FOUND',
  'FORBIDDEN',
  'OUTPUT_UNCLEAR',
  'ROW_NOT_SELECTABLE',
] as const;

export async function listProposals(projectId: string): Promise<Proposal[]> {
  const value = z
    .object({ proposals: z.array(proposalSchema) })
    .parse(await api(`${base(projectId)}/proposals`, 'GET', undefined, { quiet: PROPOSAL_QUIET }));
  return value.proposals;
}
export const applyResultSchema = z
  .object({
    proposal: proposalSchema.nullable(),
    result: z
      .object({
        state: z.enum(['applied', 'confirm', 'failed', 'unclear']),
        id: z.string().optional(),
        code: z.string().optional(),
        files: z.array(z.object({ rows: z.array(z.string()).optional() }).passthrough()).optional(),
        refused: z.array(z.object({ id: z.string(), code: z.string() })).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export async function applyProposal(
  projectId: string,
  proposalId: string,
  body: { rows?: string[]; confirmDeletes?: boolean },
) {
  return applyResultSchema.parse(
    await api(`${base(projectId)}/proposals/${proposalId}/apply`, 'POST', body, {
      quiet: PROPOSAL_QUIET,
    }),
  );
}
export async function dismissProposal(projectId: string, proposalId: string) {
  await api(
    `${base(projectId)}/proposals/${proposalId}/dismiss`,
    'POST',
    {},
    {
      quiet: PROPOSAL_QUIET,
    },
  );
}
export async function laterProposal(projectId: string, proposalId: string) {
  await api(
    `${base(projectId)}/proposals/${proposalId}/later`,
    'POST',
    {},
    {
      quiet: PROPOSAL_QUIET,
    },
  );
}

export async function listPairs(projectId: string): Promise<SyncPairView[]> {
  return z
    .object({ pairs: z.array(pairSchema) })
    .parse(
      await api(`${base(projectId)}/workspace/pairs`, 'GET', undefined, { quiet: PROPOSAL_QUIET }),
    ).pairs;
}
export async function designatePair(projectId: string, files: { model: string; drawing: string }) {
  return api(`${base(projectId)}/workspace/pairs`, 'POST', files, { quiet: PROPOSAL_QUIET });
}
export async function removePair(projectId: string, pairId: string) {
  // 204: no body; the page's api reads JSON, so this one call uses fetch directly.
  const response = await fetch(`api/v1${base(projectId)}/workspace/pairs/${pairId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => null)) as { code?: string } | null;
    throw Object.assign(new Error(value?.code ?? 'REQUEST_FAILED'), {
      code: value?.code ?? 'REQUEST_FAILED',
    });
  }
}

const samePath = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase();
/** The designated pair of two files, when there is one. */
export const pairOf = (
  pairs: readonly SyncPairView[],
  model?: string | null,
  drawing?: string | null,
) =>
  pairs.find(
    (pair) => samePath(pair.absolute.model, model) && samePath(pair.absolute.drawing, drawing),
  );

// ---------------------------------------------------------------------------------------------
// Words (Design SCR-47, §07)

const mm = (metres: number) => `${Math.round(metres * 10000) / 10} mm`;
const STATE_TEXT: Record<ProposalRow['state'], string> = {
  offset: '오차',
  'rhino-only': 'Rhino에만',
  'cad-only': 'CAD에만',
};
/** The Sync jig's row format: 행 번호 · 분류 · 바뀌는 값. */
export function rowText(row: ProposalRow, side: Proposal['changedSide']) {
  const what = row.rhino
    ? `${row.rhino.name && row.rhino.name !== 'Object' ? row.rhino.name + ' · ' : ''}${row.rhino.layer || row.rhino.type}`
    : row.cad
      ? row.cad.layer
      : '';
  const value =
    row.state === 'offset'
      ? `위치 ${row.deviation === undefined ? '' : mm(row.deviation)}`
      : row.state === 'rhino-only'
        ? side === 'model'
          ? '도면에 추가'
          : '모델에서 지움'
        : side === 'model'
          ? '도면에서 지움'
          : '모델에 추가';
  return `${row.id} · ${STATE_TEXT[row.state]} · ${what} · ${value}`;
}
export const REFUSAL_TEXT: Record<Proposal['refused'][number]['reason'], string> = {
  unsupported: '지원 안 함',
  conflict: '충돌',
  broken: '끊김',
};
export const PAIR_STATUS_TEXT: Partial<Record<SyncPairView['status'], string>> = {
  'file-missing': '파일 없음',
  'no-relation': '위치 관계 없음 — Sync jig에서 위치 관계를 확인하세요',
  'not-synced': '아직 동기화하지 않은 파일이 있습니다',
  'link-closed': '연결이 닫혀 있습니다',
  'both-changed': '양쪽 변경 — 어느 쪽을 고칠지 Sync jig에서 정하세요',
  error: '계산하지 못했습니다',
};
export function timeText(at: string) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
