// 규제 조건 항목과 닫힌 규칙 목록 (SPEC-12.7·12.8·12.9, PLAN-45 T-209). Two products rules hold:
// "산식 발명 금지" — the only calculations are the rules listed here, and every number they use is a
// 규제 조건 item value with its source; no legal value (일조 10 m, 1.5 m, h/2, 민법 0.5 m …) is written
// in code — and "계획의존 결론 금지" — an item nobody has decided stays '사람 입력 필요' or '판단 필요'
// and is listed, never silently taken as 적용 or 미적용.
//
// Values come from two places: the person (jig settings, `regulationsFromParams`) and the SPEC-13
// legal result through the adapter slot (`legal-adapter.ts`, filled by T-220). A person's entry
// always wins; a legal value only fills an item the person left at '사람 입력 필요'.

/** 적용 여부 (SPEC-12.7 2). `null` = nobody has said yet. */
export type Applies = '적용' | '미적용' | '판단 필요' | null;
/** 확정 상태. '사람 입력 필요' = a value no machine can read yet (SPEC-12.16). */
export type ItemStatus = '확정' | '가정' | '판단 필요' | '사람 입력 필요';
/** 출처 구분 (SPEC-12.14), plus '없음' for an item with no value at all. */
export type Origin = '원본에서 읽음' | '도구로 계산함' | '사용자가 확정함' | 'AI가 추정함' | '없음';

export type RegulationGroup =
  | '밀도'
  | '높이'
  | '건축선'
  | '이격'
  | '일조'
  | '인센티브'
  | '용도'
  | '주차·공지';

export interface RegulationBasis {
  /** 근거 조항 (e.g. 조문 번호). */
  clause?: string;
  /** 원문 링크. */
  link?: string;
  note?: string;
}

/** One 규제 조건 item (SPEC-12.7 2): value, unit, 적용 여부, 근거, 출처, 확정 상태. */
export interface RegulationItem {
  id: RegulationId;
  group: RegulationGroup;
  title: string;
  value: number | string | null;
  unit: string;
  applies: Applies;
  status: ItemStatus;
  origin: Origin;
  basis: RegulationBasis | null;
  /** Where the value came from: a setting key (`param.roadSetback`) or a legal result id. */
  source: string;
  /** A boundary segment or corner the value is for; absent = the whole site. */
  target?: string;
}

interface ItemDef {
  group: RegulationGroup;
  title: string;
  unit: string;
  /** Numbers must be > 0 (a 0 means nobody entered it); otherwise ≥ 0 is a value. */
  positive?: boolean;
  /** Choice items: the allowed values (the first is '사람 입력 필요'). */
  choices?: readonly string[];
}

/**
 * The closed item list of SPEC-12.7 2. Items without a setting yet (인센티브, 용도, 주차·공지,
 * 용적률) are read by T-211~T-213; the ids are fixed here so the SPEC-13 adapter maps onto one list.
 */
export const REGULATION_ITEMS = {
  zone: { group: '밀도', title: '용도지역', unit: '' },
  coverage: { group: '밀도', title: '건폐율 상한', unit: '비율', positive: true },
  farBase: { group: '밀도', title: '기준 용적률', unit: '비율', positive: true },
  farAllowed: { group: '밀도', title: '허용 용적률', unit: '비율', positive: true },
  farMax: { group: '밀도', title: '상한 용적률', unit: '비율', positive: true },
  heightMax: { group: '높이', title: '최고 높이', unit: 'm', positive: true },
  streetHeight: { group: '높이', title: '가로구역 최고 높이', unit: 'm', positive: true },
  altitudeHeight: { group: '높이', title: '고도지구 높이', unit: 'm', positive: true },
  floorsMax: { group: '높이', title: '지상 층수 상한', unit: '층', positive: true },
  roadSetback: { group: '건축선', title: '도로 후퇴 거리', unit: 'm' },
  chamferLength: { group: '건축선', title: '가각 전제 길이', unit: 'm', positive: true },
  limitLine: { group: '건축선', title: '건축한계선·지정선(그린 선)', unit: '' },
  openSpaceRoad: { group: '이격', title: '대지 안의 공지(건축선에서)', unit: 'm' },
  openSpaceAdjacent: { group: '이격', title: '대지 안의 공지(인접 대지 경계선에서)', unit: 'm' },
  civilSetback: { group: '이격', title: '민법상 이격 거리', unit: 'm' },
  otherSetback: { group: '이격', title: '기타 이격(그린 선에서 거리)', unit: 'm' },
  sun: { group: '일조', title: '정북 일조 적용 여부', unit: '' },
  sunBaseHeight: { group: '일조', title: '기준 높이', unit: 'm', positive: true },
  sunNearDistance: { group: '일조', title: '기준 높이 이하 거리', unit: 'm' },
  sunRatio: {
    group: '일조',
    title: '초과 부분의 높이 대비 비율(거리 = 비율 × 높이)',
    unit: '',
    positive: true,
  },
  sunDatumRoad: {
    group: '일조',
    title: '기준선 위치(정북이 도로일 때)',
    unit: '',
    choices: ['ask', 'across-road', 'boundary'],
  },
  sunDistance: {
    group: '일조',
    title: '일조 거리의 정의',
    unit: '',
    choices: ['ask', 'euclidean', 'north'],
  },
  incentive: { group: '인센티브', title: '인센티브 항목', unit: '' },
  allowedUses: { group: '용도', title: '허용 용도', unit: '' },
  floorUses: { group: '용도', title: '층별 용도 제한', unit: '' },
  parkingRule: { group: '주차·공지', title: '용도별 주차 산정 기준', unit: '' },
  landscapeRatio: { group: '주차·공지', title: '조경 면적 비율', unit: '비율' },
  publicOpenSpace: { group: '주차·공지', title: '공개공지 대상 여부와 면적 비율', unit: '비율' },
} as const satisfies Record<string, ItemDef>;
export type RegulationId = keyof typeof REGULATION_ITEMS;

/** Labels of the choice values (the screen and the reports show these). */
export const CHOICE_LABELS: Record<string, string> = {
  ask: '사람 입력 필요',
  apply: '적용',
  none: '미적용',
  undecided: '판단 필요',
  'across-road': '도로 건너편 경계',
  boundary: '대지 경계(도로 쪽)',
  euclidean: '기준선까지의 최단 거리',
  north: '정북 방향으로 잰 거리',
};

/** State settings (`<item>State`) and the 적용 여부 they mean. */
const STATE: Record<string, { applies: Applies; status: ItemStatus }> = {
  ask: { applies: null, status: '사람 입력 필요' },
  apply: { applies: '적용', status: '확정' },
  none: { applies: '미적용', status: '확정' },
  undecided: { applies: '판단 필요', status: '판단 필요' },
};

/**
 * Settings that carry 규제 조건 (jig `vide/buildable-mass`): each numeric item has a value setting
 * and a state setting (`<key>State`: ask · apply · none · undecided). Items that share one state
 * (the 일조 values follow `sunState`) name it here.
 */
export const PARAM_ITEMS: { key: RegulationId; state: string }[] = [
  { key: 'coverage', state: 'coverageState' },
  { key: 'heightMax', state: 'heightMaxState' },
  { key: 'streetHeight', state: 'streetHeightState' },
  { key: 'altitudeHeight', state: 'altitudeHeightState' },
  { key: 'floorsMax', state: 'floorsMaxState' },
  { key: 'roadSetback', state: 'roadSetbackState' },
  { key: 'chamferLength', state: 'chamferLengthState' },
  { key: 'openSpaceRoad', state: 'openSpaceRoadState' },
  { key: 'openSpaceAdjacent', state: 'openSpaceAdjacentState' },
  { key: 'civilSetback', state: 'civilSetbackState' },
  { key: 'otherSetback', state: 'otherSetbackState' },
  { key: 'sun', state: 'sunState' },
  { key: 'sunBaseHeight', state: 'sunState' },
  { key: 'sunNearDistance', state: 'sunState' },
  { key: 'sunRatio', state: 'sunState' },
  { key: 'sunDatumRoad', state: 'sunState' },
  { key: 'sunDistance', state: 'sunState' },
];

const def = (id: RegulationId): ItemDef => REGULATION_ITEMS[id];

/** An item nobody has entered: '사람 입력 필요', no value, no source. */
export function emptyItem(id: RegulationId, target?: string): RegulationItem {
  const d = def(id);
  return {
    id,
    group: d.group,
    title: d.title,
    value: null,
    unit: d.unit,
    applies: null,
    status: '사람 입력 필요',
    origin: '없음',
    basis: null,
    source: '',
    ...(target ? { target } : {}),
  };
}

/**
 * 규제 조건 from the jig settings. A state of `apply`/`undecided` with a value nobody entered (0 for
 * an item that must be positive, or a choice still at `ask`) stays '사람 입력 필요' for that value.
 */
export function regulationsFromParams(params: Record<string, unknown>): RegulationItem[] {
  const out: RegulationItem[] = [];
  for (const { key, state } of PARAM_ITEMS) {
    const d = def(key);
    const s = STATE[String(params[state] ?? 'ask')] ?? STATE.ask;
    const item = emptyItem(key);
    if (s.applies === null) {
      out.push(item);
      continue;
    }
    item.applies = s.applies;
    item.status = s.status;
    item.origin = '사용자가 확정함';
    item.source = `param.${state}`;
    if (key !== 'sun') {
      const raw = params[key];
      item.source = `param.${key}`;
      if (d.choices) {
        const choice = String(raw ?? 'ask');
        if (choice === 'ask' || !d.choices.includes(choice)) {
          item.status = '사람 입력 필요';
          item.origin = '없음';
        } else item.value = choice;
      } else {
        const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : NaN;
        if (!Number.isFinite(value) || value < 0 || (d.positive && !(value > 0))) {
          item.status = '사람 입력 필요';
          item.origin = '없음';
        } else item.value = value;
      }
    } else item.value = s.applies;
    out.push(item);
  }
  return out;
}

/**
 * Merge a person's items with the legal result's: the person's entry wins; a legal item fills one
 * the person left at '사람 입력 필요'. Differences are returned, never applied silently
 * (SPEC-12.16 법규 결과 없음 · SPEC-07.6).
 */
export function mergeRegulations(person: RegulationItem[], legal: RegulationItem[]) {
  const keyOf = (i: RegulationItem) => `${i.id}@${i.target ?? ''}`;
  const byKey = new Map(person.map((i) => [keyOf(i), i]));
  const differences: { id: RegulationId; target?: string; person: unknown; legal: unknown }[] = [];
  for (const item of legal) {
    const mine = byKey.get(keyOf(item));
    if (!mine || mine.status === '사람 입력 필요') byKey.set(keyOf(item), item);
    else if (mine.value !== item.value || mine.applies !== item.applies)
      differences.push({
        id: item.id,
        ...(item.target ? { target: item.target } : {}),
        person: mine.value ?? mine.applies,
        legal: item.value ?? item.applies,
      });
  }
  return { items: [...byKey.values()], differences };
}

/** Lookup in a 규제 조건 list: the item for a target (segment, corner) first, then the site's. */
export function itemOf(items: readonly RegulationItem[], id: RegulationId, target?: string) {
  return (
    (target ? items.find((i) => i.id === id && i.target === target) : undefined) ??
    items.find((i) => i.id === id && !i.target) ??
    emptyItem(id, target)
  );
}

/** A usable number: 적용 or 판단 필요 with a value. */
export const numberOf = (item: RegulationItem): number | null =>
  (item.applies === '적용' || item.applies === '판단 필요') && typeof item.value === 'number'
    ? item.value
    : null;

/** Items whose state leaves the result 미확정 (SPEC-12.7 7). */
export const isUnconfirmed = (item: RegulationItem) =>
  item.status === '판단 필요' || item.status === '가정';

// ── The closed rule list ────────────────────────────────────────────────────────────────────────

export type RuleId =
  | 'road-setback'
  | 'chamfer'
  | 'limit-line'
  | 'open-space-road'
  | 'open-space-adjacent'
  | 'civil'
  | 'sun-ground'
  | 'other'
  | 'extrusion'
  | 'sun-slope'
  | 'height-limit';

export interface RuleDef {
  id: RuleId;
  title: string;
  /** SPEC section of the rule. */
  spec: string;
  /** The 규제 조건 items it reads. */
  reads: RegulationId[];
  /** Plan geometry (2D 제한선) or envelope (3D). */
  dimension: '2d' | '3d';
  /** What the distance is measured from. */
  from: string;
}

/**
 * SPEC-12.8·12.9: the only calculations of `vide/massing-kit`. A limit not in this list is drawn by
 * a person (건축한계선, 기타 이격 기준선) and enters through `limit-line` or `other`.
 */
export const RULES: readonly RuleDef[] = [
  {
    id: 'road-setback',
    title: '건축선 후퇴',
    spec: 'SPEC-12.8 1',
    reads: ['roadSetback'],
    dimension: '2d',
    from: '도로와 맞닿은 대지 경계 구간',
  },
  {
    id: 'chamfer',
    title: '가각',
    spec: 'SPEC-12.8 1',
    reads: ['chamferLength'],
    dimension: '2d',
    from: '두 도로 구간이 만나는 볼록한 모퉁이',
  },
  {
    id: 'limit-line',
    title: '건축한계선',
    spec: 'SPEC-12.8 1',
    reads: ['limitLine'],
    dimension: '2d',
    from: '사람이 그린 선(도로 쪽을 뺌)',
  },
  {
    id: 'open-space-road',
    title: '대지 안의 공지(건축선)',
    spec: 'SPEC-12.8 1',
    reads: ['openSpaceRoad', 'roadSetback'],
    dimension: '2d',
    from: '건축선(도로 구간 + 후퇴 거리)',
  },
  {
    id: 'open-space-adjacent',
    title: '대지 안의 공지(인접 대지 경계선)',
    spec: 'SPEC-12.8 1',
    reads: ['openSpaceAdjacent'],
    dimension: '2d',
    from: '인접 대지와 맞닿은 구간',
  },
  {
    id: 'civil',
    title: '민법상 이격',
    spec: 'SPEC-12.8 1',
    reads: ['civilSetback'],
    dimension: '2d',
    from: '인접 대지와 맞닿은 구간',
  },
  {
    id: 'sun-ground',
    title: '정북 일조(지면)',
    spec: 'SPEC-12.8 1',
    reads: ['sun', 'sunNearDistance', 'sunDatumRoad', 'sunDistance'],
    dimension: '2d',
    from: '일조 기준선',
  },
  {
    id: 'other',
    title: '기타 이격',
    spec: 'SPEC-12.8 1',
    reads: ['otherSetback'],
    dimension: '2d',
    from: '사람이 그린 기타 이격 기준선',
  },
  {
    id: 'extrusion',
    title: '돌출 외피',
    spec: 'SPEC-12.9 1',
    reads: ['heightMax', 'streetHeight', 'altitudeHeight', 'floorsMax'],
    dimension: '3d',
    from: '2D 가능 영역',
  },
  {
    id: 'sun-slope',
    title: '일조 사선',
    spec: 'SPEC-12.9 2',
    reads: ['sun', 'sunBaseHeight', 'sunNearDistance', 'sunRatio', 'sunDatumRoad', 'sunDistance'],
    dimension: '3d',
    from: '일조 기준선',
  },
  {
    id: 'height-limit',
    title: '높이 제한',
    spec: 'SPEC-12.9 3',
    reads: ['heightMax', 'streetHeight', 'altitudeHeight', 'floorsMax'],
    dimension: '3d',
    from: '지면',
  },
];
export const ruleOf = (id: RuleId) => RULES.find((r) => r.id === id)!;
