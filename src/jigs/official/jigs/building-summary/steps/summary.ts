// ② 건축개요 (SPEC-12.13 2·3·5, SPEC-12.14): the overview in the office layout of the past studies
// (S-03: 항목 · 세부 · 값 · 평 · 비고 — 대지 위치, 지역·지구, 대지면적, 공사종별, 규모·용도, 도로,
// 건축면적, 연면적 지상·지하·합계, 용적률 산정 연면적, 건폐율, 용적률, 높이, 조경, 공개공지, 주차,
// 구조) and the 층별 면적표, each cell with its 출처 (계산 · 공부 · 사람 입력 · 법규 결과) and, for a
// legal value, its 확정 상태 and 근거. Nothing is calculated here beyond copying: areas, ratios,
// counts and limits are the numbers the earlier jigs computed or the person entered; an empty one is
// '사람 입력 필요'. The 평 column is a unit conversion beside the ㎡ value.

import type { ChosenHandoff } from '../../../massing-kit/handoff.ts';
import type { RegulationItem } from '../../../massing-kit/rules.ts';
import {
  DISCLAIMER,
  ORIGIN,
  cellText,
  pyOf,
  type FloorRow,
  type MassInput,
  type OriginLabel,
  type OverviewRow,
  type SiteInput,
  type SiteSummary,
  type Unit,
} from './common.ts';
import type { SourcesOutput } from './sources.ts';

interface StepOverride {
  target: { kind: string; identity: Record<string, string | number> };
  op: string;
  fields: Record<string, unknown>;
  by?: 'user' | 'ai';
}

export const STRUCTURES: Record<string, string> = {
  rc: '철근콘크리트조',
  steel: '철골조',
  src: '철골철근콘크리트조',
  mixed: '철골·철근콘크리트 혼합구조',
  wood: '목조',
  masonry: '조적조',
  other: '기타',
};
export const CONSTRUCTION_TYPES: Record<string, string> = {
  new: '신축',
  extension: '증축',
  rebuild: '개축',
  reconstruction: '재축',
  relocation: '이전',
  repair: '대수선',
  change: '용도변경',
};
export const PARKING_METHODS: Record<string, string> = {
  ground: '지상 자주식',
  underground: '지하 자주식',
  mechanical: '기계식',
};

export interface SummaryOutput {
  disclaimer: string;
  alternative: string;
  overview: OverviewRow[];
  floors: FloorRow[];
  /** Sums of the floor rows (the check compares them with the totals). */
  floorSum: { above: number; below: number; total: number; farArea: number; exclusion: number };
  gfaTotal: number;
  far: number;
  coverage: number;
  unconfirmed: { title: string; status: string }[];
  unconfirmedCount: number;
  needsInput: string[];
  needsInputCount: number;
  unchecked: string[];
  assumptions: string[];
  problems: string[];
}

const MISSING = { text: '사람 입력 필요', origin: ORIGIN.missing } as const;

const textOf = (overrides: readonly StepOverride[] | undefined, field: string) => {
  const problems: string[] = [];
  let text: string | null = null;
  for (const o of overrides ?? []) {
    if (o?.target?.kind !== 'summary-text' || o.op !== 'set') continue;
    if (String(o.target.identity?.field ?? '') !== field) continue;
    if (o.by === 'ai') {
      problems.push(`${field}: AI가 제안한 글은 사람이 받아야 들어갑니다`);
      continue;
    }
    const value = typeof o.fields.text === 'string' ? o.fields.text.trim().slice(0, 200) : '';
    text = value || null;
  }
  return { text, problems };
};

/** 출처 of a 규제 조건 item: the person's entry in the mass jig, or the legal result as it came. */
const originOfItem = (item: RegulationItem): OriginLabel => {
  if (item.origin === '없음' || item.status === '사람 입력 필요') return ORIGIN.missing;
  if (item.source.startsWith('param.') || item.source.startsWith('override.')) return ORIGIN.person;
  if (item.origin === '도구로 계산함') return ORIGIN.computed;
  return ORIGIN.legal;
};
const basisOfItem = (item: RegulationItem) =>
  [item.basis?.clause, item.basis?.link, item.basis?.note].filter(Boolean).join(' · ') ||
  (originOfItem(item) === ORIGIN.person ? '건축 가능 영역·매스에서 사람이 넣은 값' : '');

export function summary(
  inputs: { mass?: MassInput; site?: SiteInput; steps?: { sources?: SourcesOutput } },
  params: Record<string, unknown>,
  overrides: StepOverride[] = [],
): SummaryOutput {
  const handoff = inputs.mass?.value as ChosenHandoff | null | undefined;
  const sources = inputs.steps?.sources;
  if (!handoff || !sources) throw new Error('고른 대안을 받지 못했습니다');
  const site = (inputs.site?.value ?? null) as SiteSummary | null;
  const alt = handoff.alternative;
  const row = handoff.row;
  const items = handoff.regulations.items;
  const massFrom = `${sources.mass.title} · ${alt.title}`;
  const siteFrom = sources.site ? `${sources.site.title} · 대지 요약` : '';
  const out: OverviewRow[] = [];
  const add = (r: Omit<OverviewRow, 'py'> & { py?: number | null }) =>
    out.push({ ...r, py: r.py ?? (r.unit === '㎡' && r.value !== null ? pyOf(r.value) : null) });
  const num = (
    key: string,
    item: string,
    sub: string,
    value: number | null,
    unit: Unit,
    origin: OriginLabel,
    basis: string,
    source: string,
    none: { text: string; origin: OverviewRow['origin'] } = MISSING,
  ) =>
    add({
      key,
      item,
      sub,
      value,
      unit,
      text: value === null ? none.text : cellText(value, unit),
      origin: value === null ? none.origin : origin,
      status: '',
      basis,
      source,
    });
  const text = (
    key: string,
    item: string,
    sub: string,
    value: string | null,
    origin: OriginLabel,
    basis: string,
    source: string,
  ) =>
    add({
      key,
      item,
      sub,
      value: null,
      unit: '',
      text: value ?? '사람 입력 필요',
      origin: value === null ? ORIGIN.missing : origin,
      status: '',
      basis,
      source,
    });
  const legal = (
    key: string,
    item: string,
    sub: string,
    reg: RegulationItem | undefined,
    unit: Unit,
  ) => {
    if (!reg) return;
    const applies = reg.applies === '적용' || reg.applies === '판단 필요';
    const value = applies && typeof reg.value === 'number' ? reg.value : null;
    add({
      key,
      item,
      sub,
      value,
      unit,
      text:
        reg.applies === '미적용'
          ? '미적용'
          : value === null
            ? '사람 입력 필요'
            : cellText(value, unit),
      origin:
        reg.applies === '미적용' ? '미적용' : value === null ? ORIGIN.missing : originOfItem(reg),
      status: reg.applies === '미적용' ? '확정' : reg.status,
      basis: basisOfItem(reg),
      source: `${massFrom} · 규제 조건`,
    });
  };
  const item = (id: string) => items.find((i) => i.id === id && !i.target);
  const named = textOf(overrides, 'buildingName');
  const remarks = textOf(overrides, 'remarks');

  // 대지
  text('name', '건물명', '', named.text, ORIGIN.person, '', '이 작업본');
  text(
    'location',
    '대지 위치',
    '',
    site
      ? [...site.addresses, ...(site.pnus.length ? [`PNU ${site.pnus.join(', ')}`] : [])].join(
          ' · ',
        ) || null
      : null,
    ORIGIN.record,
    site ? '공공 자료(대상 필지)' : (sources.siteReason ?? ''),
    siteFrom,
  );
  const zoneItem = item('zone');
  text(
    'zones',
    '지역·지구',
    '',
    site?.zones && site.zones !== '용도지역 미확인'
      ? site.zones
      : typeof zoneItem?.value === 'string' && zoneItem.value
        ? zoneItem.value
        : null,
    site?.zones && site.zones !== '용도지역 미확인'
      ? ORIGIN.record
      : zoneItem
        ? originOfItem(zoneItem)
        : ORIGIN.missing,
    site?.zones ? '토지이용계획(공공 자료)' : '',
    site?.zones ? siteFrom : massFrom,
  );
  num(
    'site-area-record',
    '대지면적',
    '공부',
    site?.officialArea_m2 ?? null,
    '㎡',
    ORIGIN.record,
    site ? '토지 특성 정보(공공 자료)' : '',
    siteFrom,
  );
  num(
    'site-area',
    '대지면적',
    '계산',
    handoff.site.area_m2,
    '㎡',
    ORIGIN.computed,
    '대지 경계 면적 — 건폐율·용적률의 분모',
    massFrom,
  );
  const structure = STRUCTURES[String(params.structure ?? '')] ?? null;
  const construction = CONSTRUCTION_TYPES[String(params.constructionType ?? '')] ?? null;
  text('construction', '공사종별', '', construction, ORIGIN.person, '', '이 작업본 설정값');
  text(
    'main-use',
    '주용도',
    '',
    handoff.plan.mainUse,
    ORIGIN.person,
    '건축 가능 영역·매스의 계획 조건',
    massFrom,
  );
  num(
    'floors-above',
    '규모',
    '지상',
    row.floorsAbove,
    '층',
    ORIGIN.computed,
    '고른 대안의 층수',
    massFrom,
  );
  num(
    'floors-below',
    '규모',
    '지하',
    row.floorsBelow,
    '층',
    ORIGIN.computed,
    '고른 대안의 층수',
    massFrom,
  );
  text(
    'roads',
    '도로 현황',
    '',
    site?.roads ?? null,
    ORIGIN.computed,
    site ? '지적 도로 필지와 대지 경계' : '',
    siteFrom,
  );
  // 면적
  num(
    'building-area',
    '건축면적',
    '',
    row.buildingArea,
    '㎡',
    ORIGIN.computed,
    '지상층 윤곽 합집합의 면적',
    massFrom,
  );
  num(
    'gfa-above',
    '연면적',
    '지상',
    row.gfaAbove,
    '㎡',
    ORIGIN.computed,
    '층별 바닥면적의 합',
    massFrom,
  );
  num(
    'gfa-below',
    '연면적',
    '지하',
    row.gfaBelow,
    '㎡',
    ORIGIN.computed,
    '층별 바닥면적의 합',
    massFrom,
  );
  num('gfa-total', '연면적', '합계', row.gfaTotal, '㎡', ORIGIN.computed, '지상 + 지하', massFrom);
  num(
    'far-area',
    '용적률 산정 연면적',
    '',
    row.farArea,
    '㎡',
    ORIGIN.computed,
    row.exclusion > 0 ? '지상 바닥면적 − 사람이 넣은 제외 면적' : '지상 바닥면적(제외 면적 없음)',
    massFrom,
  );
  // 밀도
  num(
    'coverage',
    '건폐율',
    '계획',
    row.coverage,
    '%',
    ORIGIN.computed,
    `건축면적 ÷ 대지면적(계산) — 법정 대비 ${row.coverageVerdict}`,
    massFrom,
  );
  legal('coverage-legal', '건폐율', '법정', item('coverage'), '%');
  num(
    'far',
    '용적률',
    '계획',
    row.far,
    '%',
    ORIGIN.computed,
    `용적률 산정 연면적 ÷ 대지면적(계산) — ${row.farCeilingSource || '법정'} 대비 ${row.farVerdict}`,
    massFrom,
  );
  legal('far-base', '용적률', '법정(기준)', item('farBase'), '%');
  legal('far-allowed', '용적률', '법정(허용)', item('farAllowed'), '%');
  legal('far-max', '용적률', '법정(상한)', item('farMax'), '%');
  // 높이
  num(
    'height',
    '높이',
    '계획',
    row.height,
    'm',
    ORIGIN.computed,
    '최상층 윗면 높이(층고의 합)',
    massFrom,
  );
  legal('height-max', '높이', '법정(최고 높이)', item('heightMax'), 'm');
  for (const [id, sub] of [
    ['streetHeight', '법정(가로구역)'],
    ['altitudeHeight', '법정(고도지구)'],
    ['floorsMax', '법정(층수)'],
  ] as const) {
    const reg = item(id);
    if (reg && reg.applies !== null)
      legal(`height-${id}`, '높이', sub, reg, id === 'floorsMax' ? '층' : 'm');
  }
  // 조경·공지·주차
  const land = handoff.landscape;
  num(
    'landscape-legal',
    '대지 안의 조경',
    '법정',
    land.legal,
    '㎡',
    ORIGIN.computed,
    land.legalStatus === '계산' ? '조경 면적 비율 × 대지면적(계산)' : land.legalStatus,
    massFrom,
  );
  num(
    'landscape-plan',
    '대지 안의 조경',
    '계획',
    land.planned > 0 ? land.planned : null,
    '㎡',
    ORIGIN.computed,
    land.planned > 0 ? `그린 조경 영역 — ${land.verdict}` : '조경 영역을 그리지 않음',
    massFrom,
  );
  const open = handoff.publicOpenSpace;
  const openNone = /미적용/.test(open.state);
  num(
    'open-space-required',
    '공개공지',
    '대상·필요 면적',
    open.required,
    '㎡',
    ORIGIN.computed,
    open.state,
    massFrom,
    openNone ? { text: '대상 아님(미적용)', origin: '미적용' } : MISSING,
  );
  num(
    'open-space-plan',
    '공개공지',
    '계획',
    open.planned,
    '㎡',
    ORIGIN.computed,
    open.planned !== null ? `${alt.title}이 비운 후보 면적` : '이 대안에 공개공지 없음',
    massFrom,
    open.required === null
      ? { text: '해당 없음', origin: openNone ? '미적용' : ORIGIN.missing }
      : MISSING,
  );
  const parking = handoff.parking;
  num(
    'parking-legal',
    '주차',
    '법정',
    parking.legal,
    '대',
    ORIGIN.computed,
    parking.status === '계산'
      ? '용도별 면적 ÷ 주차 산정 기준, 끝수 처리(규제 조건)'
      : parking.status,
    massFrom,
  );
  num(
    'parking-plan',
    '주차',
    '계획',
    parking.planned,
    '대',
    ORIGIN.person,
    parking.planned === null
      ? '계획 대수 없음 — 법정 대수로 봄'
      : '건축 가능 영역·매스의 계획 대수',
    massFrom,
    { text: '없음(법정 대수로 봄)', origin: ORIGIN.person },
  );
  const method = PARKING_METHODS[String(params.parkingMethod ?? '')] ?? null;
  const typeRow = parking.types?.find((t) => t.title === method);
  text(
    'parking-method',
    '주차',
    '방식',
    method ? `${method}${typeRow ? ` — ${typeRow.verdict}` : ''}` : null,
    ORIGIN.person,
    typeRow?.note ?? (method ? '이 대안의 주차 방식 대안을 계산하지 않음' : ''),
    '이 작업본 설정값',
  );
  text('structure', '구조', '', structure, ORIGIN.person, '', '이 작업본 설정값');
  text('remarks', '비고', '', remarks.text ?? '', ORIGIN.person, '', '이 작업본');
  // A remark nobody wrote is just empty, not a cell to fill.
  const last = out[out.length - 1];
  if (!remarks.text) Object.assign(last, { text: '', origin: ORIGIN.person });

  // 층별 면적표: 지하(깊은 층부터) → 지상, then the alternative's totals.
  const floorRows: FloorRow[] = [...handoff.basement]
    .sort((a, b) => a.index - b.index)
    .concat(handoff.floors)
    .map((f) => ({
      key: `floor:${f.floor}`,
      floor: f.floor,
      use: f.uses.length
        ? f.uses
            .map((u) => (u.ratio === 1 ? u.use : `${u.use} ${Math.round(u.ratio * 1000) / 10}%`))
            .join(', ')
        : '사람 입력 필요',
      area: f.area,
      exclusion: f.exclusion,
      farArea: f.farArea,
      py: pyOf(f.area),
      note: [
        f.exclusion > 0 ? `제외 근거: ${f.exclusionBasis || '근거 없음'}` : '',
        f.change,
        f.outside ? '외피 밖' : '',
        f.useVerdict && f.useVerdict !== '적합' ? `용도 ${f.useVerdict}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      kind: 'floor' as const,
    }));
  const sum = (list: FloorRow[], field: 'area' | 'farArea' | 'exclusion') =>
    Math.round(list.reduce((s, f) => s + f[field], 0) * 1e6) / 1e6;
  const above = floorRows.filter((f) => !f.floor.startsWith('B'));
  const below = floorRows.filter((f) => f.floor.startsWith('B'));
  const exclusionTotal =
    Math.round([...handoff.floors].reduce((s, f) => s + f.exclusion, 0) * 1e6) / 1e6;
  const totals: FloorRow[] = [
    {
      key: 'total:above',
      floor: '지상 합계',
      use: '',
      area: row.gfaAbove,
      exclusion: row.exclusion,
      farArea: row.farArea,
      py: pyOf(row.gfaAbove),
      note: '',
      kind: 'total',
    },
    {
      key: 'total:below',
      floor: '지하 합계',
      use: '',
      area: row.gfaBelow,
      exclusion: 0,
      farArea: 0,
      py: pyOf(row.gfaBelow),
      note: '지하층은 용적률 산정에서 뺌',
      kind: 'total',
    },
    {
      key: 'total:all',
      floor: '합계',
      use: '',
      area: row.gfaTotal,
      exclusion: row.exclusion,
      farArea: row.farArea,
      py: pyOf(row.gfaTotal),
      note: '',
      kind: 'total',
    },
  ];

  const unconfirmed = handoff.unconfirmed.map((u) => ({ title: u.title, status: u.status }));
  const needsInput = out
    .filter((r) => r.origin === ORIGIN.missing)
    .map((r) => `${r.item}${r.sub ? `(${r.sub})` : ''}`);
  return {
    disclaimer: DISCLAIMER,
    alternative: alt.title,
    overview: out,
    floors: [...floorRows, ...totals],
    floorSum: {
      above: sum(above, 'area'),
      below: sum(below, 'area'),
      total: sum(floorRows, 'area'),
      farArea: sum(floorRows, 'farArea'),
      exclusion: exclusionTotal,
    },
    gfaTotal: row.gfaTotal,
    far: row.far,
    coverage: row.coverage,
    unconfirmed,
    unconfirmedCount: unconfirmed.length,
    needsInput,
    needsInputCount: needsInput.length,
    unchecked: [
      ...unconfirmed.map((u) => `미확정 조건 · ${u.title} (${u.status})`),
      ...needsInput.map((n) => `사람 입력 필요 · ${n}`),
      '면적 산정 제외 면적의 적정성(사람이 넣은 값 그대로 씀)',
      '법정 값의 적용 여부와 해석(법규 검토·사람이 정함)',
    ],
    assumptions: [
      `고른 대안: ${alt.title} (${sources.mass.title}, 사람이 확정)`,
      ...(alt.farTargetSource ? [`목표 용적률의 출처: ${alt.farTargetSource}`] : []),
      '평은 ㎡ × 121/400으로 환산한 참고 값',
      '층별 바닥면적은 고른 대안의 층 윤곽 면적이며 벽체 중심선 면적 산정이 아님',
      ...(site ? [] : ['대지 요약을 받지 못해 대지 위치·지역·도로·공부 면적은 사람 입력 필요']),
    ],
    problems: [...named.problems, ...remarks.problems],
  };
}
