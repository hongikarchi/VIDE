// AI 분류 제안의 요약과 답 검사 (SPEC-15.4 1~3, ARCH-03 §8.6, PLAN-48 T-237). The AI sees only the
// layer table and group summaries of the objects without a role — layer, object kind, closed,
// level, size class, height class, count and attribute names — never coordinates. Its answer is a
// proposal per layer or group; a proposal naming a role outside the list, a layer or group that is
// not in the summary, or a floor label that is not one is dropped with the reason. Nothing here
// decides: a person accepts, changes or drops each proposal (SPEC-15.4 3). Pure.

import {
  COMPLIANCE_ROLE_LABELS,
  COMPLIANCE_ROLES,
  floorLabelSchema,
  type ClassifiedModel,
  type ComplianceRoleName,
} from '../../../contracts/compliance.ts';
import { isComplianceRole } from './conventions.ts';
import { unusedShapeOf, type RowFacts } from './read-model.ts';

/** One group of objects without a role (same layer, shape, closedness, level, size and height). */
export interface UnroledGroup {
  id: string;
  layer: string;
  /** `closed-solid` · `open-solid` · `region` · `curve` · `point` · `other`. */
  kind: string;
  nativeType: string;
  closed: boolean;
  level: boolean;
  /** Plan size class, `2.5 × 5.0 m` (larger side last); null for points. */
  size: string | null;
  /** Height class above the lowest object of the model, `0.0–3.0 m`. */
  height: string | null;
  count: number;
  attributes: string[];
  objectIds: string[];
}

/** Round a length to a class: 0.1 m below 10 m, 1 m below 100 m, else 10 m. */
const sizeClass = (d: number) => {
  const step = d < 10 ? 0.1 : d < 100 ? 1 : 10;
  return (Math.round(d / step) * step).toFixed(step < 1 ? 1 : 0);
};
/** Heights in 0.5 m classes. */
const heightClass = (z: number) => (Math.round(z * 2) / 2).toFixed(1);

/**
 * The objects without a role (`역할 없음` and hidden ones, never 고르지 않은 대안 or another jig's
 * objects), grouped. `facts` from the same read as `model`.
 */
export function unroledGroups(model: ClassifiedModel, facts: readonly RowFacts[]): UnroledGroup[] {
  const open = new Set(
    model.unclassified
      .filter((u) => u.role === null && (u.reason === '역할 없음' || u.reason === '숨김'))
      .map((u) => u.objectId),
  );
  const zMin = Math.min(
    ...facts.filter((f) => f.bounds).map((f) => f.bounds!.min[2]),
    Number.POSITIVE_INFINITY,
  );
  const base = Number.isFinite(zMin) ? zMin : 0;
  const groups = new Map<string, UnroledGroup>();
  for (const f of facts) {
    if (!open.has(f.objectId)) continue;
    const kind = unusedShapeOf(f.shape);
    const closed = kind === 'closed-solid' || kind === 'region';
    const level = kind === 'region' || (f.shape.kind === 'bad' && f.shape.reason !== '평면이 아님');
    const b = f.bounds;
    const size =
      b && kind !== 'point'
        ? [b.max[0] - b.min[0], b.max[1] - b.min[1]]
            .sort((x, y) => x - y)
            .map(sizeClass)
            .join(' × ') + ' m'
        : null;
    const height = b ? `${heightClass(b.min[2] - base)}–${heightClass(b.max[2] - base)} m` : null;
    const attributes = Object.keys(f.attributes).sort().slice(0, 20);
    const key = JSON.stringify([
      f.layer,
      kind,
      f.nativeType,
      closed,
      level,
      size,
      height,
      attributes,
    ]);
    let group = groups.get(key);
    if (!group)
      groups.set(
        key,
        (group = {
          id: '',
          layer: f.layer,
          kind,
          nativeType: f.nativeType,
          closed,
          level,
          size,
          height,
          count: 0,
          attributes,
          objectIds: [],
        }),
      );
    group.count++;
    group.objectIds.push(f.objectId);
  }
  return [...groups.values()]
    .sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : b.count - a.count))
    .map((g, i) => ({ ...g, id: `G${i + 1}` }));
}

const ROLE_FILE = 'compliance-roles.json';
/** Workspace request limit for one attached file is 50,000 characters. */
const ROLE_FILE_MAX = 48000;
/** Shapes each role takes, as the AI is told (SPEC-15.3 2). */
const ROLE_SHAPES: Record<ComplianceRoleName, string> = {
  mass: '닫힌 솔리드',
  floor: '수평인 닫힌 평면 곡선 또는 한 층 높이의 닫힌 솔리드',
  'building-area': '수평인 닫힌 평면 곡선',
  rooftop: '닫힌 솔리드',
  parking: '닫힌 평면 곡선 또는 블록 삽입(구획 하나 = 1대)',
  landscape: '수평인 닫힌 평면 곡선',
  'landscape-roof': '수평인 닫힌 평면 곡선',
  'open-space': '수평인 닫힌 평면 곡선',
  ignore: '무엇이든(어떤 검사에도 들어가지 않음)',
};

/**
 * The one-shot request of [역할 제안 받기] (same form as `inputRolesRequest`): one attached JSON with
 * the role list, the layer table and the groups; no coordinates. The caller adds id, provider, model.
 */
export function complianceRolesRequest(input: {
  groups: readonly UnroledGroup[];
  /** Layer table of the document: name and object count. */
  layers: readonly { name: string; count: number }[];
}) {
  let groups = input.groups.length;
  let text = '';
  for (;;) {
    text = JSON.stringify({
      roles: COMPLIANCE_ROLES.map((role) => ({
        role,
        title: COMPLIANCE_ROLE_LABELS[role],
        shape: ROLE_SHAPES[role],
      })),
      layers: [...input.layers]
        .sort((a, b) => b.count - a.count)
        .slice(0, 400)
        .map((l) => ({ name: l.name.slice(0, 200), count: l.count })),
      groups: input.groups.slice(0, groups).map((g) => ({
        id: g.id,
        layer: g.layer.slice(0, 200),
        kind: g.kind,
        type: g.nativeType,
        closed: g.closed,
        level: g.level,
        size: g.size,
        height: g.height,
        count: g.count,
        attributes: g.attributes,
      })),
    });
    if (text.length <= ROLE_FILE_MAX || groups <= 20) break;
    groups = Math.floor(groups / 2);
  }
  return {
    body: `법규 체크 역할 분류: 첨부 ${ROLE_FILE}의 groups(역할이 정해지지 않은 객체 묶음)마다 roles 가운데 어느 검사 역할인지 제안해 줘. 근거는 레이어 이름·객체 종류·닫힘·수평·크기·높이 구간·개수·속성 이름과 역할이 받는 모양뿐이야. 레이어 하나의 묶음이 모두 같은 역할이면 {"layer":"레이어 이름"}으로, 아니면 {"group":"G번호"}로 가리켜. 첨부에 없는 레이어·묶음·역할은 쓰지 말고, 좌표·치수·법규 판단은 만들지 마. 모르겠으면 그 묶음은 빼. 층을 알 수 있으면 floor(1F, 2F, B1 꼴), 용도를 알 수 있으면 use를 붙여. 답은 JSON 하나만: {"proposals":[{"group":"G1","role":"역할 키","floor":null,"use":null,"reason":"이유 한 줄"}]}`,
    files: [{ name: ROLE_FILE, text }],
    permission: 'review' as const,
    pins: [],
    sketches: [],
    jig: {
      kind: 'compliance-roles' as const,
      groups: input.groups.slice(0, groups).map((g) => g.id),
    },
  };
}

/** A proposal that passed the answer check, before it gets an id and is stored. */
export interface CheckedProposal {
  scope: 'layer' | 'group';
  layer: string;
  objectIds: string[];
  role: ComplianceRoleName;
  floor: string | null;
  use: string | null;
  reason: string;
}
export interface ProposalRejection {
  why: 'NOT_JSON' | 'UNKNOWN_ROLE' | 'UNKNOWN_LAYER' | 'UNKNOWN_GROUP' | 'NO_TARGET' | 'DUPLICATE';
  /** What the dropped proposal pointed at (`G3`, a layer name, a role). */
  target?: string;
  /** Korean line for the screen. */
  text: string;
}
const WHY_TEXT: Record<ProposalRejection['why'], string> = {
  NOT_JSON: 'AI 답이 JSON이 아니어서 제안을 쓰지 않았습니다',
  UNKNOWN_ROLE: '목록에 없는 역할이라 버렸습니다',
  UNKNOWN_LAYER: '역할 없는 객체가 없는 레이어라 버렸습니다',
  UNKNOWN_GROUP: '없는 묶음이라 버렸습니다',
  NO_TARGET: '가리키는 레이어나 묶음이 없어 버렸습니다',
  DUPLICATE: '같은 객체를 두 번 제안해 뒤의 것을 버렸습니다',
};

/** The JSON object in an answer: a fenced block, else the outermost braces. */
function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  for (const candidate of [fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)])
    if (candidate?.trim())
      try {
        return JSON.parse(candidate);
      } catch {
        /* Try the next form. */
      }
  return undefined;
}

/** Gate of the AI answer: only listed roles, only layers and groups of the summary. */
export function checkComplianceRoles(
  text: string,
  groups: readonly UnroledGroup[],
): { proposals: CheckedProposal[]; rejected: ProposalRejection[] } {
  const proposals: CheckedProposal[] = [];
  const rejected: ProposalRejection[] = [];
  const reject = (why: ProposalRejection['why'], target?: string) =>
    rejected.push({ why, ...(target ? { target } : {}), text: WHY_TEXT[why] });
  const answer = jsonIn(text) as { proposals?: unknown } | undefined;
  if (!answer || !Array.isArray(answer.proposals)) {
    reject('NOT_JSON');
    return { proposals, rejected };
  }
  const byId = new Map(groups.map((g) => [g.id, g]));
  const byLayer = new Map<string, UnroledGroup[]>();
  for (const g of groups) byLayer.set(g.layer, [...(byLayer.get(g.layer) ?? []), g]);
  const taken = new Set<string>();
  for (const item of answer.proposals.slice(0, 400)) {
    const entry = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const role = typeof entry.role === 'string' ? entry.role.trim() : '';
    if (!isComplianceRole(role)) {
      reject('UNKNOWN_ROLE', role || undefined);
      continue;
    }
    let scope: CheckedProposal['scope'];
    let layer: string;
    let members: UnroledGroup[];
    if (typeof entry.group === 'string') {
      const group = byId.get(entry.group.trim());
      if (!group) {
        reject('UNKNOWN_GROUP', entry.group);
        continue;
      }
      scope = 'group';
      layer = group.layer;
      members = [group];
    } else if (typeof entry.layer === 'string') {
      const list = byLayer.get(entry.layer);
      if (!list) {
        reject('UNKNOWN_LAYER', entry.layer);
        continue;
      }
      scope = 'layer';
      layer = entry.layer;
      members = list;
    } else {
      reject('NO_TARGET');
      continue;
    }
    const objectIds = members.flatMap((g) => g.objectIds);
    if (objectIds.some((id) => taken.has(id))) {
      reject('DUPLICATE', scope === 'group' ? String(entry.group) : layer);
      continue;
    }
    for (const id of objectIds) taken.add(id);
    const floor =
      typeof entry.floor === 'string' && floorLabelSchema.safeParse(entry.floor.trim()).success
        ? entry.floor.trim()
        : null;
    const use =
      typeof entry.use === 'string' && entry.use.trim() ? entry.use.trim().slice(0, 60) : null;
    const reason =
      (typeof entry.reason === 'string' ? entry.reason : '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300) || 'AI 제안';
    proposals.push({ scope, layer, objectIds, role, floor, use, reason });
  }
  return { proposals, rejected };
}
