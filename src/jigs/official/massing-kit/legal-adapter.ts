// The SPEC-13 adapter (PLAN-45 T-209 「규제 조건 항목 스키마」, PLAN-46 T-220, ARCH-03 §8.2): the
// legal jig's output `legal.constraints` (schema `vide.legal.constraints@1`, made by the engine from
// the project's cLAWde answers) → 규제 조건 items of `rules.ts`. Only constraints whose every article
// is cited arrive here; each keeps its 근거 조항, the service's 출처 표시 ('서비스 확정' · '서비스 해석')
// and 적용 여부 as they are (SPEC-12.14). A '판단 필요' stays '판단 필요'. No number is computed: a
// constraint fills the item its key names in the closed table below, with the service's value and
// unit; a key not in the table, or in another unit, is listed as not connected and fills nothing.
// The person's entry still wins (`mergeRegulations`).

import type {
  LegalConstraint,
  LegalConstraintsOutput,
  LegalConstraintLeft,
} from '../../../contracts/legal.ts';
import {
  REGULATION_ITEMS,
  type ItemStatus,
  type RegulationId,
  type RegulationItem,
} from './rules.ts';

export interface LegalAdapterResult {
  /** True when a legal result is wired in (even one with no usable constraint). */
  available: boolean;
  /** Why there are no items, shown as-is ('' when there are). */
  reason: string;
  items: RegulationItem[];
  /** Constraints of the result that fill no item (unknown key, other unit, bad value). */
  unmapped?: { key: string; answer: string; reason: string }[];
  /** What the engine left out of the result (not fully cited, '다시 확인 필요', 판단 불가). */
  left?: LegalConstraintLeft[];
}

interface KeyDef {
  id: RegulationId;
  /** The units the service may give for this item (the item keeps its own unit). */
  units: readonly string[];
  /**
   * The group's 적용 여부 item the same answer decides (일조: `sun`). It takes the answer's 적용 여부
   * and articles, never a value of its own.
   */
  applies?: RegulationId;
}

const RATIO = ['ratio', '비율'] as const;
/**
 * cLAWde constraint keys → 규제 조건 items (the closed table; the service's key vocabulary is its
 * own, ARCH-01 「cLAWde 연결 계약」). A key is a name, not a formula: the value is taken as given.
 */
export const LEGAL_KEYS: Readonly<Record<string, KeyDef>> = {
  'density.coverageRatio': { id: 'coverage', units: RATIO },
  'density.farBase': { id: 'farBase', units: RATIO },
  'density.farAllowed': { id: 'farAllowed', units: RATIO },
  'density.farMax': { id: 'farMax', units: RATIO },
  'height.max': { id: 'heightMax', units: ['m'] },
  'height.street': { id: 'streetHeight', units: ['m'] },
  'height.altitude': { id: 'altitudeHeight', units: ['m'] },
  'height.floorsAbove': { id: 'floorsMax', units: ['층', 'floors'] },
  'buildingLine.roadSetback': { id: 'roadSetback', units: ['m'] },
  'buildingLine.chamferLength': { id: 'chamferLength', units: ['m'] },
  'openSpace.fromBuildingLine': { id: 'openSpaceRoad', units: ['m'] },
  'openSpace.fromAdjacentLot': { id: 'openSpaceAdjacent', units: ['m'] },
  'setback.civil': { id: 'civilSetback', units: ['m'] },
  'sunlight.baseHeight': { id: 'sunBaseHeight', units: ['m'], applies: 'sun' },
  'sunlight.setbackUpTo10m': { id: 'sunNearDistance', units: ['m'], applies: 'sun' },
  'sunlight.setbackRatioAbove10m': { id: 'sunRatio', units: RATIO, applies: 'sun' },
  'landscape.ratio': { id: 'landscapeRatio', units: RATIO },
  'publicOpenSpace.ratio': { id: 'publicOpenSpace', units: RATIO },
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
function isConstraint(c: unknown): c is LegalConstraint {
  if (!isObject(c)) return false;
  return (
    typeof c.key === 'string' &&
    typeof c.value === 'number' &&
    typeof c.unit === 'string' &&
    Array.isArray(c.refs) &&
    c.refs.length > 0 &&
    Array.isArray(c.clauses) &&
    c.clauses.length > 0 &&
    (c.origin === '서비스 확정' || c.origin === '서비스 해석') &&
    (c.applies === '적용' || c.applies === '미적용' || c.applies === '판단 필요') &&
    typeof c.answer === 'string'
  );
}

const statusOf = (c: LegalConstraint): ItemStatus =>
  c.applies === '판단 필요' ? '판단 필요' : c.origin === '서비스 확정' ? '확정' : '가정';

function itemFrom(id: RegulationId, c: LegalConstraint, value: RegulationItem['value']) {
  const d = REGULATION_ITEMS[id];
  const link = c.clauses.find((clause) => clause.link)?.link;
  return {
    id,
    group: d.group,
    title: d.title,
    value,
    unit: d.unit,
    applies: c.applies,
    status: statusOf(c),
    origin: c.origin,
    basis: {
      clause: c.clauses.map((clause) => clause.text).join(', '),
      ...(link ? { link } : {}),
      note: `법규 답 ${c.answer} · ${c.key}`,
    },
    source: `legal.${c.answer}:${c.key}`,
  } satisfies RegulationItem;
}

/** Map the legal jig's `legal.constraints` output onto 규제 조건 items (SPEC-12.7 2, SPEC-13.8). */
export function regulationsFromLegal(result: unknown): LegalAdapterResult {
  if (result === undefined || result === null)
    return { available: false, reason: '법규 결과 없음', items: [] };
  const output = result as Partial<LegalConstraintsOutput>;
  if (
    !isObject(result) ||
    output.schema !== 'vide.legal.constraints@1' ||
    !Array.isArray(output.constraints)
  )
    return { available: false, reason: '법규 결과 형식이 맞지 않음', items: [] };
  const left = Array.isArray(output.left) ? output.left : [];
  const items: RegulationItem[] = [];
  const unmapped: NonNullable<LegalAdapterResult['unmapped']> = [];
  const groupApplies = new Map<RegulationId, LegalConstraint>();
  for (const raw of output.constraints as unknown[]) {
    if (!isConstraint(raw)) {
      const key = isObject(raw) && typeof raw.key === 'string' ? raw.key : '?';
      const answer = isObject(raw) && typeof raw.answer === 'string' ? raw.answer : '?';
      unmapped.push({ key, answer, reason: '근거·출처·적용 여부가 없는 제한' });
      continue;
    }
    const def = LEGAL_KEYS[raw.key];
    if (!def) {
      unmapped.push({
        key: raw.key,
        answer: raw.answer,
        reason: '규제 조건 항목에 연결되지 않은 키',
      });
      continue;
    }
    if (!def.units.includes(raw.unit)) {
      unmapped.push({ key: raw.key, answer: raw.answer, reason: `단위가 다름(${raw.unit})` });
      continue;
    }
    const item = REGULATION_ITEMS[def.id] as { positive?: boolean };
    if (!Number.isFinite(raw.value) || raw.value < 0 || (item.positive && !(raw.value > 0))) {
      unmapped.push({ key: raw.key, answer: raw.answer, reason: `쓸 수 없는 값(${raw.value})` });
      continue;
    }
    if (items.some((i) => i.id === def.id)) continue; // the newest answer came first
    items.push(itemFrom(def.id, raw, raw.value));
    if (def.applies && !groupApplies.has(def.applies)) groupApplies.set(def.applies, raw);
  }
  // The group's 적용 여부 (일조) from the answer that gave its values: its verdict, its articles.
  for (const [id, c] of groupApplies)
    if (!items.some((i) => i.id === id)) items.push(itemFrom(id, c, c.applies));
  return {
    available: true,
    reason: items.length ? '' : '법규 결과에 연결된 수치 제한 없음',
    items,
    unmapped,
    left,
  };
}
