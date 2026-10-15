// 프로젝트 기록 on the page (PLAN-53 T-323·T-325, ARCH-01 §5 「프로젝트 기록」): the engine's
// records, 부위 사전 and milestones routes, and the plain-language names the 기록 tab shows
// (Design §07: no internal state, source or type codes on screen).
import { api, errors } from './gateway.ts';
import type {
  MilestoneRow,
  PartMapping,
  PartRow,
  PartStatus,
  RecordFilters,
  RecordListResponse,
  RecordRow,
  RecordSource,
  RecordState,
  RecordType,
} from '../contracts/records.ts';

export type {
  MilestoneRow,
  PartBreak,
  PartMapping,
  PartRow,
  PartStatus,
  RecordFilters,
  RecordListResponse,
  RecordRow,
  RecordSource,
  RecordState,
  RecordType,
} from '../contracts/records.ts';

const base = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;
const one = (projectId: string, id: string) =>
  `${base(projectId)}/records/${encodeURIComponent(id)}`;
/** Codes the 기록 tab words itself (no app-wide notice). */
const QUIET = [
  'RECORD_LINK_CYCLE',
  'RECORD_MARKS_MISMATCH',
  'RECORD_SUPERSEDED',
  'RECORD_SOURCE_DUPLICATE',
] as const;

/** The query string of the list filters (the same for the list and the exports). */
export function filterQuery(filters: RecordFilters, extra: Record<string, string> = {}) {
  const params = new URLSearchParams();
  if (filters.state?.length) params.set('state', filters.state.join(','));
  if (filters.type?.length) params.set('type', filters.type.join(','));
  if (filters.source?.length) params.set('source', filters.source.join(','));
  for (const key of ['part', 'chapter', 'from', 'to', 'q'] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.offset !== undefined) params.set('offset', String(filters.offset));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const text = params.toString();
  return text ? `?${text}` : '';
}

export const listRecords = (projectId: string, filters: RecordFilters = {}) =>
  api(`${base(projectId)}/records${filterQuery(filters)}`, 'GET', undefined, {
    quiet: ['NOT_FOUND', 'PROJECT_GONE'],
  }) as Promise<RecordListResponse>;

const record = async (promise: Promise<unknown>) =>
  ((await promise) as { record: RecordRow }).record;

export const getRecord = (projectId: string, id: string) => record(api(one(projectId, id)));
export const patchRecord = (
  projectId: string,
  id: string,
  patch: { text?: string; type?: RecordType; parts?: string[]; chapter?: string | null },
) => record(api(one(projectId, id), 'PATCH', patch, { quiet: QUIET }));
export const correctRecord = (
  projectId: string,
  id: string,
  input: { text: string; type?: RecordType },
) => record(api(`${one(projectId, id)}/correct`, 'POST', input, { quiet: QUIET }));
export const setRecordState = (projectId: string, id: string, state: RecordState) =>
  record(api(`${one(projectId, id)}/state`, 'POST', { state }));
export const setRecordStates = async (projectId: string, ids: string[], state: RecordState) =>
  ((await api(`${base(projectId)}/records/state`, 'POST', { ids, state })) as { changed: number })
    .changed;
/** `from` led to `to` (from → to). */
export const linkRecords = (projectId: string, from: string, to: string) =>
  record(api(`${one(projectId, from)}/links`, 'POST', { to }, { quiet: QUIET }));
export const unlinkRecords = (projectId: string, from: string, to: string) =>
  record(api(`${one(projectId, from)}/links/${encodeURIComponent(to)}`, 'DELETE'));
/** One record per line (the export's text answer, not JSON). */
export async function exportLines(projectId: string, filters: RecordFilters): Promise<string> {
  const response = await fetch(
    `api/v1${base(projectId)}/records/export${filterQuery(filters, { format: 'jsonl' })}`,
  );
  if (!response.ok) throw new Error(errors.REQUEST_FAILED ?? '내려받지 못했습니다.');
  return response.text();
}
export const importMarks = async (projectId: string, ids: string[], marks: string) =>
  (
    (await api(`${base(projectId)}/records/import`, 'POST', { ids, marks }, { quiet: QUIET })) as {
      changed: number;
    }
  ).changed;

// ---- 부위 사전 and milestones ----

export const listParts = async (projectId: string) =>
  ((await api(`${base(projectId)}/parts`)) as { parts: PartRow[] }).parts;
export interface PartFields {
  name?: string;
  grp?: string | null;
  roleFrom?: string | null;
  roleTo?: string | null;
  chapter?: string | null;
  mapping?: PartMapping[];
  seenAt?: string | null;
}
export const addPart = async (projectId: string, input: PartFields & { name: string }) =>
  ((await api(`${base(projectId)}/parts`, 'POST', input)) as { part: PartRow }).part;
export const setPart = async (projectId: string, id: string, input: PartFields) =>
  (
    (await api(`${base(projectId)}/parts/${encodeURIComponent(id)}`, 'PUT', input)) as {
      part: PartRow;
    }
  ).part;
export const removePart = (projectId: string, id: string) =>
  api(`${base(projectId)}/parts/${encodeURIComponent(id)}`, 'DELETE');

/** The parts' status, or undefined while the route is not there (quiet). */
export async function partsStatus(projectId: string): Promise<PartStatus[] | undefined> {
  try {
    const answer = (await api(`${base(projectId)}/parts/status`, 'GET', undefined, {
      quiet: ['NOT_FOUND', 'PROJECT_GONE', 'REQUEST_FAILED', 'INVALID_RESPONSE'],
    })) as { parts?: PartStatus[] };
    return Array.isArray(answer?.parts) ? answer.parts : undefined;
  } catch {
    return undefined;
  }
}

export const listMilestones = async (projectId: string) =>
  ((await api(`${base(projectId)}/milestones`)) as { milestones: MilestoneRow[] }).milestones;
export const addMilestone = async (projectId: string, input: { label: string; date: string }) =>
  ((await api(`${base(projectId)}/milestones`, 'POST', input)) as { milestone: MilestoneRow })
    .milestone;
export const removeMilestone = (projectId: string, id: string) =>
  api(`${base(projectId)}/milestones/${encodeURIComponent(id)}`, 'DELETE');

// ---- Linked files and their layers (for a part's mapping) ----

export interface LinkSummary {
  id: string;
  host: string;
  name: string;
  connection: unknown;
  lastSync: { requestId: string; at: string } | null;
}
export const listLinks = (projectId: string) =>
  api(`${base(projectId)}/links`, 'GET', undefined, {
    quiet: ['NOT_FOUND', 'PROJECT_GONE'],
  }) as Promise<LinkSummary[]>;
/**
 * The layer names of a link's latest Sync, read the way the jig screens read them
 * (`…/jigs/structure/layers?syncIds=`); [] when they cannot be read (the person types a name).
 */
export async function linkLayers(projectId: string, link: LinkSummary): Promise<string[]> {
  if (!link.lastSync) return [];
  try {
    const answer = (await api(
      `${base(projectId)}/jigs/structure/layers?syncIds=${encodeURIComponent(link.lastSync.requestId)}`,
      'GET',
      undefined,
      {
        quiet: [
          'NOT_FOUND',
          'STALE_REFERENCE',
          'INVALID_INPUT',
          'REQUEST_FAILED',
          'PROJECT_GONE',
          'INVALID_RESPONSE',
        ],
      },
    )) as { sources?: { layers?: { name?: unknown }[] }[] };
    return (answer.sources ?? [])
      .flatMap((source) => source.layers ?? [])
      .map((layer) => layer.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  } catch {
    return [];
  }
}

// ---- Words on screen (Design §07, SCR-44) ----

export const TYPE_ORDER: RecordType[] = ['R', 'I', 'K', 'E', 'D', '?'];
export const TYPE_NAME: Record<RecordType, string> = {
  R: '요구',
  I: '의도',
  K: '앎',
  E: '근거',
  D: '결정',
  '?': '미정',
};
export const TYPE_HINT: Record<RecordType, string> = {
  R: '요구 — 법·행정·건축주·이웃이 요구한 것',
  I: '의도 — 설계자가 원한 것',
  K: '앎 — 그 부위를 얼마나 알았나',
  E: '근거 — 실측·검토·계산처럼 확인된 것',
  D: '결정 — 역할·사양·형상이 바뀐 결정',
  '?': '미정 — 아직 유형을 고르지 않음',
};
export const STATE_ORDER: RecordState[] = ['candidate', 'kept', 'dropped'];
export const STATE_NAME: Record<RecordState, string> = {
  candidate: '후보',
  kept: '남김',
  dropped: '뺌',
};
export const SOURCE_NAME: Record<RecordSource, string> = {
  request: '요청',
  chat: '대화',
  note: '노트',
  journal: '일지',
  meeting: '회의록',
  sync: '동기화',
  jig: 'jig',
  checkout: '체크아웃',
  kakao: '카카오톡',
  mail: '메일',
  'site-report': '현장 보고',
  manual: '직접',
};
/** The words of the refusals the tab handles itself. */
export const REFUSAL: Record<string, string> = {
  RECORD_LINK_CYCLE: '이미 이어져 있어 거꾸로 이을 수 없습니다.',
  RECORD_MARKS_MISMATCH:
    '붙인 표시의 수가 지금 보이는 기록 수와 다릅니다. 같은 거르기에서 불러오세요.',
  RECORD_SUPERSEDED: '이미 정정된 기록입니다. 정정한 새 기록을 고치세요.',
  RECORD_SOURCE_DUPLICATE: '같은 출처의 기록이 이미 있습니다.',
};
