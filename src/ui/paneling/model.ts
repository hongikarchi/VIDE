// 패널링 화면의 순수 부분 (SPEC-16.4·16.5·16.8·16.10·16.11, Design SCR-33, PLAN-49 T-253): what the
// screen makes of one instance of `vide/paneling` — the three stages and their settings, each
// setting's 출처 and its '물어볼 것'·'가정' tag, whether a stage may be made in Rhino (the contract's
// `makeAllowed`), the head numbers, the panels as 3D mesh items coloured by the chosen 색 기준, the
// schedule rows, the CSV of `SCHEDULE_COLUMNS` and the question-card items of a stage's missing
// values. No geometry is computed here: every number is the engine's step output, checked against
// `src/contracts/paneling.ts` before it is drawn. Pure (the contract's zod only) for Node tests.

import {
  makeAllowed,
  memberSetSchema,
  panelLayoutSchema,
  panelTypingSchema,
  PANELING_SETTING_WHEN,
  SCHEDULE_COLUMNS,
  panelingSettingInUse,
  type Member,
  type MemberSet,
  type Panel,
  type PanelingStage,
  type PanelLayout,
  type PanelTyping,
  type SettingSource,
} from '../../contracts/paneling.ts';
import {
  fan,
  toDisplay,
  unitText,
  formatNumber,
  type PanelSetting,
} from '../jig-panel/bindings.ts';
import { OVERLAY_CATEGORIES, type OverlayItem, type OverlayTone } from '../viewport.ts';

export type { MemberSet, PanelLayout, PanelTyping, PanelingStage };

// ── 단계 ───────────────────────────────────────────────────────────────────────────────────

export interface StageMeta {
  id: PanelingStage;
  no: number;
  title: string;
  /** The stage's [Rhino에 만들기] words (SPEC-16.9 1). */
  make: string;
  /** The jig's make declaration the button runs (`jig.json` `bake[].id`, PLAN-49 T-255·T-257). */
  bake: string;
  /** Further declarations the same button runs (2단계 the joint lines; 3단계 the marks and cuts). */
  also?: readonly string[];
}
export const STAGES: readonly StageMeta[] = [
  {
    id: 'preview',
    no: 1,
    title: '미리보기',
    make: '미리보기 만들기',
    bake: 'preview',
    also: ['openings'],
  },
  { id: 'members', no: 2, title: '부재', make: '부재 만들기', bake: 'members', also: ['joints'] },
  {
    id: 'optimize',
    no: 3,
    title: '최적화·타입화',
    make: '타입 만들기',
    bake: 'types',
    also: ['connections', 'cuts', 'cut-numbers'],
  },
];
export const stageMeta = (id: PanelingStage) => STAGES.find((s) => s.id === id)!;

/** The 3D layer of the panels (SPEC-16.8). */
export const OVERLAY_PANELS = 'paneling-panels';

/**
 * Settings of each stage by key (SPEC-16.4 1 표; the contract's settings flattened: `size` →
 * `width`·`height`, `direction` → `axis`·`startCorner`·`flip`, `boundary` → `boundaryRule`·`mergeBelow`,
 * `stock` → `stockWidth`·`stockHeight`). A setting of another key falls to its group's words.
 */
const STAGE_KEYS: Record<PanelingStage, readonly string[]> = {
  preview: [
    'pattern',
    'width',
    'height',
    'measure',
    'projection',
    'axis',
    'startCorner',
    'flip',
    'boundaryRule',
    'mergeBelow',
    'jitter',
    'seed',
    'openNear',
    'openFar',
    'openRadius',
    'openLevels',
  ],
  members: ['thickness', 'thicknessSide', 'joint', 'boundaryJoint', 'stockWidth', 'stockHeight'],
  optimize: ['flatnessTol', 'planarize', 'typeTol', 'maxTypes', 'flatRadius', 'nodeAngleStep'],
};
/** 3단계 settings folded under '더 보기' (Design SCR-33). */
export const MORE_KEYS: ReadonlySet<string> = new Set(['flatRadius', 'nodeAngleStep']);
/** Settings read only with another value (SPEC-16.4 1: 합치기 기준 · 투영 평면), shared with the
 *  engine's `paneling-confirmed` so the screen and the gate count alike. */
export const WHEN = PANELING_SETTING_WHEN;

export function stageOf(setting: Pick<PanelSetting, 'key' | 'group'>): PanelingStage | undefined {
  for (const stage of STAGES) if (STAGE_KEYS[stage.id].includes(setting.key)) return stage.id;
  const group = setting.group ?? '';
  if (/^\s*1\b|미리보기/.test(group)) return 'preview';
  if (/^\s*2\b|부재/.test(group)) return 'members';
  if (/^\s*3\b|최적화|타입/.test(group)) return 'optimize';
  return undefined;
}
export function settingsOfStage(settings: readonly PanelSetting[], stage: PanelingStage) {
  const order = STAGE_KEYS[stage];
  const rank = (s: PanelSetting) => {
    const i = order.indexOf(s.key);
    return i < 0 ? order.length : i;
  };
  return settings.filter((s) => stageOf(s) === stage).sort((a, b) => rank(a) - rank(b));
}
/** Stages up to and including this one. */
export const stagesUpTo = (stage: PanelingStage) =>
  STAGES.slice(0, STAGES.findIndex((s) => s.id === stage) + 1).map((s) => s.id);

// ── 값의 출처 (SPEC-16.4 4) ───────────────────────────────────────────────────────────────────

/** The engine's `by` of a setting as the contract's 출처; an AI value nobody confirmed is still
 *  '가정' (SPEC-16.4 3·4, same rule as the engine's `sourceOfParam`). */
export function sourceOf(setting: Pick<PanelSetting, 'by' | 'status'>): SettingSource {
  if (setting.by === 'ai') return setting.status === 'confirmed' ? 'ai-accepted' : 'assumed';
  switch (setting.by) {
    case 'default':
      return 'assumed';
    case 'decision':
      return 'question';
    case 'fact':
      return 'project-fact';
    default:
      return 'person';
  }
}
/**
 * A setting's tag: '물어볼 것' while its stage was not computed with it, '가정' once a result used
 * the recommended value; none when a person gave or took the value (SPEC-16.4 2·3).
 */
export function tagOf(setting: PanelSetting, computed: boolean): 'ask' | 'assumed' | undefined {
  if (sourceOf(setting) !== 'assumed') return undefined;
  return computed ? 'assumed' : 'ask';
}
/** Is a setting read now (a 합치기 기준 only with 합치기, a 투영 평면 only with 투영)? */
export function settingInUse(
  setting: Pick<PanelSetting, 'key'>,
  values: Readonly<Record<string, unknown>>,
) {
  return panelingSettingInUse(setting.key, (key) => values[key]);
}
/** Settings shown even when not counted: the two opening ratios turn the opening on (SPEC-16.13 4). */
export const SHOWN_ALWAYS: ReadonlySet<string> = new Set(['openNear', 'openFar']);
/** Is a setting on screen now (in use, or one that turns others on)? */
export const settingShown = (
  setting: Pick<PanelSetting, 'key'>,
  values: Readonly<Record<string, unknown>>,
) => SHOWN_ALWAYS.has(setting.key) || settingInUse(setting, values);
/** Settings of these stages still on the recommended value (in use only). */
export function assumedOf(
  settings: readonly PanelSetting[],
  stages: readonly PanelingStage[],
  values: Readonly<Record<string, unknown>>,
) {
  return settings.filter(
    (s) => stages.includes(stageOf(s)!) && sourceOf(s) === 'assumed' && settingInUse(s, values),
  );
}

/** May this stage be made now (SPEC-16.4 3, contract `makeAllowed`), and if not, why. */
export function makeGate(
  stage: PanelingStage,
  settings: readonly PanelSetting[],
  values: Readonly<Record<string, unknown>>,
  options: { computed: boolean; stale: boolean; failed?: boolean },
): { allowed: boolean; assumed: number; reason?: string } {
  const sourced = (id: PanelingStage) =>
    Object.fromEntries(
      settingsOfStage(settings, id)
        .filter((s) => settingInUse(s, values))
        .map((s) => [s.key, { source: sourceOf(s) }]),
    );
  const allowedBySource = makeAllowed(stage, {
    preview: sourced('preview'),
    ...(stage === 'preview' ? {} : { members: sourced('members') }),
    ...(stage === 'optimize' ? { optimize: sourced('optimize') } : {}),
  });
  const assumed = stage === 'preview' ? 0 : assumedOf(settings, stagesUpTo(stage), values).length;
  if (!options.computed)
    return { allowed: false, assumed, reason: '이 단계를 계산한 뒤 만들 수 있습니다' };
  if (options.stale)
    return { allowed: false, assumed, reason: '다시 계산 필요 · 계산한 뒤 만들 수 있습니다' };
  if (!allowedBySource)
    return { allowed: false, assumed, reason: `가정 값 ${assumed}개를 확인하면 만들 수 있습니다` };
  return { allowed: true, assumed };
}

// ── 결과 읽기 ────────────────────────────────────────────────────────────────────────────────

export type Read<T> = { kind: 'none' } | { kind: 'ok'; value: T } | { kind: 'invalid' };
const reader =
  <T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }) =>
  (value: unknown): Read<T> => {
    if (value === undefined || value === null) return { kind: 'none' };
    const parsed = schema.safeParse(value);
    return parsed.success ? { kind: 'ok', value: parsed.data as T } : { kind: 'invalid' };
  };
export const readLayout = reader<PanelLayout>(panelLayoutSchema);
export const readMembers = reader<MemberSet>(memberSetSchema);
export const readTyping = reader<PanelTyping>(panelTypingSchema);
export const valueOf = <T>(read: Read<T>) => (read.kind === 'ok' ? read.value : undefined);

// ── 수 ────────────────────────────────────────────────────────────────────────────────────────

const mm = (m: number, decimals = 0) =>
  (m * 1000).toLocaleString('ko-KR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
const m2 = (value: number) => formatNumber(Number(value.toFixed(2)));
export const mmText = (m: number | null | undefined, decimals = 0) =>
  m === null || m === undefined ? '—' : `${mm(m, decimals)} mm`;

/** A non-boundary panel whose width or height is more than 15 % off the module (SPEC-16.5 4). */
export function offTarget(panel: Panel, module: readonly [number, number]) {
  if (panel.boundary || panel.failure) return false;
  return (
    Math.abs(panel.width - module[0]) > 0.15 * module[0] ||
    Math.abs(panel.height - module[1]) > 0.15 * module[1]
  );
}

export interface HeadCell {
  label: string;
  value?: string;
  unit?: string;
  note?: string;
  /** A failure count above zero (`--ng` badge). */
  bad?: boolean;
}
/** The head numbers of a stage (Design SCR-33 머리 수치). */
export function headCells(
  stage: PanelingStage,
  results: { layout?: PanelLayout; members?: MemberSet; typing?: PanelTyping },
): HeadCell[] {
  const { layout, members, typing } = results;
  if (stage === 'preview') {
    const r = layout?.sizeRange;
    const range = (a: number, b: number) =>
      `${formatNumber(Number(a.toFixed(2)))}~${formatNumber(Number(b.toFixed(2)))}`;
    return [
      { label: '패널', value: layout ? String(layout.counts.total) : undefined },
      { label: '경계', value: layout ? String(layout.counts.boundary) : undefined },
      { label: '목표와 다름', value: layout ? String(layout.counts.offTarget) : undefined },
      {
        label: '크기',
        value: layout && r ? `${range(r.minW, r.maxW)} × ${range(r.minH, r.maxH)}` : undefined,
        unit: 'm',
        note: layout ? `면적 합 ${m2(r!.area)} m²` : undefined,
      },
      {
        label: '실패',
        value: layout ? String(layout.counts.failed) : undefined,
        bad: !!layout && layout.counts.failed > 0,
        note:
          layout && (layout.counts.dropped || layout.counts.pole)
            ? [
                layout.counts.dropped ? `뺀 패널 ${layout.counts.dropped}` : '',
                layout.counts.pole ? `극점 패널 ${layout.counts.pole}` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined,
      },
    ];
  }
  if (stage === 'members') {
    const failed = members?.members.filter((m) => m.failure).length ?? 0;
    return [
      {
        label: '부재',
        value: members ? String(members.members.length - failed) : undefined,
      },
      { label: '판재 초과', value: members ? String(members.overStock.length) : undefined },
      {
        label: '줄눈 고르지 않음',
        value: members ? String(members.members.filter((m) => m.jointUneven).length) : undefined,
      },
      { label: '실패', value: members ? String(failed) : undefined, bad: failed > 0 },
    ];
  }
  const failed = typing?.panels.filter((p) => p.failure).length ?? 0;
  const flat = typing?.panels.reduce((max, p) => Math.max(max, p.flatness), 0);
  return [
    { label: '타입', value: typing ? String(typing.types.length) : undefined },
    { label: '노드 타입', value: typing ? String(typing.nodes.length) : undefined },
    { label: '줄눈 타입', value: typing ? String(typing.joints.length) : undefined },
    {
      label: '평면도 최대',
      value: typing && flat !== undefined ? mm(flat, 1) : undefined,
      unit: 'mm',
    },
    {
      label: '허용 오차 넘음',
      value: typing ? String(typing.overTypeTol.length) : undefined,
      bad: !!typing && typing.overTypeTol.length > 0,
      note: failed ? `실패 ${failed}` : undefined,
    },
  ];
}

/** Lines over the result (SPEC-16.3 2, 16.5 1·6, 16.7 4). */
export function headNotices(
  results: { layout?: PanelLayout; typing?: PanelTyping },
  target?: readonly [number, number],
): string[] {
  const out: string[] = [];
  const { layout, typing } = results;
  if (layout?.coarseSample) out.push('표본이 거칩니다 · 촘촘하게 다시 읽기');
  if (
    layout &&
    target &&
    (Math.abs(layout.module[0] - target[0]) > 1e-6 || Math.abs(layout.module[1] - target[1]) > 1e-6)
  )
    out.push(
      `닫힌 면에 맞춰 크기를 ${mm(layout.module[0])} × ${mm(layout.module[1])} mm로 바꿨습니다`,
    );
  if (layout && layout.counts.total > 5000) out.push('패널이 많아 손을 뗄 때 계산합니다');
  if (typing?.maxTypesUnmet)
    out.push(`최대 타입 수를 지킬 수 없습니다 · 꼭짓점 수가 달라 최소 ${typing.maxTypesUnmet}개`);
  return out;
}

// ── 3D 겹침과 색 기준 (SPEC-16.8) ─────────────────────────────────────────────────────────────

export type ColorBy = 'deviation' | 'failure' | 'type' | 'class' | 'flatness' | 'opening';
export const COLOR_BY: readonly { id: ColorBy; label: string }[] = [
  { id: 'deviation', label: '편차' },
  { id: 'failure', label: '실패' },
  { id: 'type', label: '타입' },
  { id: 'class', label: '곡률 등급' },
  { id: 'flatness', label: '평면도' },
  { id: 'opening', label: '개구율' },
];
/** 개구율 colour classes from the layout's own target ratios (SPEC-16.13 4): one class per ratio
 *  when they are few (단계 수 n ≥ 2 gives n), else five equal bands between the smallest and the
 *  largest; none without openings. */
const OPENING_BANDS = 5;
interface OpeningScale {
  /** The distinct ratios (0.1 % steps) when each has its own class, else null. */
  levels: number[] | null;
  lo: number;
  hi: number;
}
const openingScales = new WeakMap<PanelLayout, OpeningScale | null>();
export function openingScale(layout: PanelLayout | undefined): OpeningScale | null {
  if (!layout) return null;
  if (openingScales.has(layout)) return openingScales.get(layout)!;
  const ratios = [
    ...new Set(
      layout.panels.flatMap((p) => (p.opening ? [Math.round(p.opening.ratio * 1000) / 1000] : [])),
    ),
  ].sort((a, b) => a - b);
  const scale = ratios.length
    ? {
        levels: ratios.length <= OVERLAY_CATEGORIES ? ratios : null,
        lo: ratios[0],
        hi: ratios[ratios.length - 1],
      }
    : null;
  openingScales.set(layout, scale);
  return scale;
}
function openingBand(scale: OpeningScale, ratio: number): number {
  const r = Math.round(ratio * 1000) / 1000;
  if (scale.levels) return Math.max(0, scale.levels.indexOf(r));
  const span = scale.hi - scale.lo;
  return span > 0
    ? Math.min(OPENING_BANDS - 1, Math.floor(((r - scale.lo) / span) * OPENING_BANDS))
    : 0;
}
/** The 색 기준 a stage starts with. */
export const defaultColorBy = (stage: PanelingStage): ColorBy =>
  stage === 'preview' ? 'deviation' : stage === 'members' ? 'failure' : 'type';

export const CLASS_TEXT = { flat: '평면', single: '단곡', double: '복곡' } as const;
const CLASS_TONE: Record<'flat' | 'single' | 'double', OverlayTone> = {
  flat: 'ov-cat-1',
  single: 'ov-cat-2',
  double: 'ov-cat-4',
};

export interface Results {
  layout?: PanelLayout;
  members?: MemberSet;
  typing?: PanelTyping;
}
interface Indexed {
  member: Map<string, Member>;
  typed: Map<string, PanelTyping['panels'][number]>;
  typeRank: Map<string, number>;
  overStock: Set<string>;
  overTol: Set<string>;
}
const NO_LAYOUT = {};
const indexCache = new WeakMap<
  object,
  { members?: MemberSet; typing?: PanelTyping; index: Indexed }
>();
/** Lookups of one result set, kept while the step outputs stay the same objects. */
function indexOf(results: Results): Indexed {
  const key = results.layout ?? NO_LAYOUT;
  const hit = indexCache.get(key);
  if (hit && hit.members === results.members && hit.typing === results.typing) return hit.index;
  const index: Indexed = {
    member: new Map((results.members?.members ?? []).map((m) => [m.panelId, m])),
    typed: new Map((results.typing?.panels ?? []).map((p) => [p.panelId, p])),
    typeRank: new Map((results.typing?.types ?? []).map((t, i) => [t.type, i])),
    overStock: new Set(results.members?.overStock ?? []),
    overTol: new Set(results.typing?.overTypeTol ?? []),
  };
  indexCache.set(key, { members: results.members, typing: results.typing, index });
  return index;
}

/** The failure of a panel at any stage reached so far (layout, member or typing). */
export function failureOf(panelId: string, panel: Panel | undefined, results: Results) {
  const index = indexOf(results);
  return panel?.failure ?? index.member.get(panelId)?.failure ?? index.typed.get(panelId)?.failure;
}

/** The tone of one panel under a 색 기준. */
export function toneOf(
  panel: Panel,
  results: Results,
  colorBy: ColorBy,
  options: { flatnessTol?: number; index?: Indexed } = {},
): OverlayTone {
  const index = options.index ?? indexOf(results);
  const failure =
    panel.failure ?? index.member.get(panel.id)?.failure ?? index.typed.get(panel.id)?.failure;
  if (failure) return 'ov-clash';
  const module = results.layout?.faceModules?.find((f) => f.faceIndex === panel.faceIndex)
    ?.module ??
    results.layout?.module ?? [panel.width, panel.height];
  switch (colorBy) {
    case 'deviation':
      // Voronoi and tile panels are not of one size (counts.offTarget 0, SPEC-16.13).
      return results.layout?.counts.offTarget !== 0 && offTarget(panel, module)
        ? 'warn'
        : panel.boundary
          ? 'ov-grid'
          : 'ov-existing';
    case 'failure':
      return index.overStock.has(panel.id) || index.member.get(panel.id)?.jointUneven
        ? 'warn'
        : 'ov-existing';
    case 'type': {
      const typed = index.typed.get(panel.id);
      const rank = typed ? index.typeRank.get(typed.type) : undefined;
      if (rank === undefined) return 'ov-existing';
      return rank < OVERLAY_CATEGORIES ? (`ov-cat-${rank + 1}` as OverlayTone) : 'na';
    }
    case 'class': {
      const typed = index.typed.get(panel.id);
      return typed ? CLASS_TONE[typed.class] : 'ov-existing';
    }
    case 'flatness': {
      const typed = index.typed.get(panel.id);
      const tol = options.flatnessTol;
      if (!typed || !tol) return 'ov-existing';
      return typed.flatness <= tol ? 'ok' : typed.flatness <= 2 * tol ? 'warn' : 'ng';
    }
    case 'opening': {
      const scale = openingScale(results.layout);
      return panel.opening && scale
        ? (`ov-cat-${(openingBand(scale, panel.opening.ratio) % OVERLAY_CATEGORIES) + 1}` as OverlayTone)
        : 'ov-existing';
    }
  }
}

/** One mesh item per panel: its member's closed mesh in stage 2, else its corners as a fan. */
export function panelItems(
  results: Results,
  colorBy: ColorBy,
  options: { stage: PanelingStage; flatnessTol?: number },
): OverlayItem[] {
  const layout = results.layout;
  if (!layout) return [];
  const index = indexOf(results);
  const items: OverlayItem[] = [];
  for (const panel of layout.panels) {
    const tone = toneOf(panel, results, colorBy, { flatnessTol: options.flatnessTol, index });
    const solid = options.stage === 'members' ? index.member.get(panel.id)?.solid : null;
    const mesh = solid && solid.v.length >= 9 ? solid : fan(panel.corners);
    items.push({ id: panel.id, tone, kind: 'mesh', v: mesh.v, f: mesh.f });
  }
  return items;
}

export interface LegendRow {
  tone: OverlayTone;
  text: string;
  count: number;
}
/** The legend of a 색 기준 with counts. */
export function legendOf(
  results: Results,
  colorBy: ColorBy,
  options: { flatnessTol?: number } = {},
): LegendRow[] {
  const layout = results.layout;
  if (!layout) return [];
  const index = indexOf(results);
  const counts = new Map<OverlayTone, number>();
  for (const panel of layout.panels) {
    const tone = toneOf(panel, results, colorBy, { ...options, index });
    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }
  const n = (tone: OverlayTone) => counts.get(tone) ?? 0;
  const rows: LegendRow[] = [];
  const push = (tone: OverlayTone, text: string) => {
    if (n(tone)) rows.push({ tone, text, count: n(tone) });
  };
  switch (colorBy) {
    case 'deviation':
      push('ov-existing', '목표 크기');
      push('ov-grid', '경계 패널');
      push('warn', '목표와 다름');
      break;
    case 'failure':
      push('ov-existing', '정상');
      push('warn', '판재 초과 · 줄눈 고르지 않음');
      break;
    case 'type':
      (results.typing?.types ?? []).slice(0, OVERLAY_CATEGORIES).forEach((type, i) => {
        push(`ov-cat-${i + 1}` as OverlayTone, type.type);
      });
      push('na', `그 밖 ${Math.max(0, (results.typing?.types.length ?? 0) - OVERLAY_CATEGORIES)}`);
      push('ov-existing', '타입 전');
      break;
    case 'class':
      push(CLASS_TONE.flat, CLASS_TEXT.flat);
      push(CLASS_TONE.single, CLASS_TEXT.single);
      push(CLASS_TONE.double, CLASS_TEXT.double);
      push('ov-existing', '타입 전');
      break;
    case 'flatness':
      push('ok', '허용 오차 이하');
      push('warn', '허용 오차의 2배 이하');
      push('ng', '허용 오차의 2배 넘음');
      push('ov-existing', '타입 전');
      break;
    case 'opening': {
      const scale = openingScale(layout);
      const pct = (x: number) => `${Math.round(x * 1000) / 10}`;
      if (scale?.levels)
        scale.levels.forEach((r, b) =>
          push(`ov-cat-${(b % OVERLAY_CATEGORIES) + 1}` as OverlayTone, `개구율 ${pct(r)}%`),
        );
      else if (scale)
        for (let b = 0; b < OPENING_BANDS; b++) {
          const lo = scale.lo + ((scale.hi - scale.lo) * b) / OPENING_BANDS,
            hi = scale.lo + ((scale.hi - scale.lo) * (b + 1)) / OPENING_BANDS;
          push(`ov-cat-${b + 1}` as OverlayTone, `개구율 ${pct(lo)}~${pct(hi)}%`);
        }
      push('ov-existing', '개구 없음');
      break;
    }
  }
  push('ov-clash', '실패');
  return rows;
}

// ── 일람표 (SPEC-16.7 7, 16.11) ──────────────────────────────────────────────────────────────

export interface PanelRow {
  id: string;
  type: string | null;
  typeRank: number | null;
  cls: 'flat' | 'single' | 'double' | null;
  /** Plate size (2단계) or panel size (1단계), metres. */
  size: [number, number];
  plate: boolean;
  flatness: number | null;
  status: '정상' | '실패' | '판재 초과' | '허용 오차 넘음' | '줄눈 고르지 않음';
  reason: string;
}
export function panelRows(results: Results): PanelRow[] {
  const layout = results.layout;
  if (!layout) return [];
  const index = indexOf(results);
  return layout.panels.map((panel) => {
    const member = index.member.get(panel.id);
    const typed = index.typed.get(panel.id);
    const failure = panel.failure ?? member?.failure ?? typed?.failure ?? null;
    const status: PanelRow['status'] = failure
      ? '실패'
      : index.overStock.has(panel.id)
        ? '판재 초과'
        : index.overTol.has(panel.id)
          ? '허용 오차 넘음'
          : member?.jointUneven
            ? '줄눈 고르지 않음'
            : '정상';
    return {
      id: panel.id,
      type: typed?.type ?? null,
      typeRank: typed ? (index.typeRank.get(typed.type) ?? null) : null,
      cls: typed?.class ?? null,
      size: member ? [member.flatSize[0], member.flatSize[1]] : [panel.width, panel.height],
      plate: !!member,
      flatness: typed?.flatness ?? null,
      status,
      reason:
        failure?.message ??
        (status === '판재 초과'
          ? '판재 한도를 넘습니다'
          : status === '허용 오차 넘음'
            ? `대표와 편차 ${mm(typed?.deviation ?? 0, 1)} mm`
            : status === '줄눈 고르지 않음' && member?.jointGap
              ? `줄눈 틈 ${mm(member.jointGap[0], 1)}~${mm(member.jointGap[1], 1)} mm`
              : ''),
    };
  });
}

type Cell = string | number | null | undefined;
const csvCell = (value: Cell) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
const len = (m: number | null | undefined) =>
  m === null || m === undefined ? null : (m * 1000).toFixed(1);
const area = (value: number | null | undefined) =>
  value === null || value === undefined ? null : value.toFixed(3);
const angle = (value: number) => value.toFixed(1);
export type ScheduleKind = keyof typeof SCHEDULE_COLUMNS;
export const SCHEDULE_TITLES: Record<ScheduleKind, string> = {
  panels: '패널',
  types: '타입',
  nodes: '노드',
  joints: '줄눈',
};

/** One schedule as CSV: the contract's Korean head, rows in panel/type order, UTF-8 BOM. */
export function scheduleCsv(kind: ScheduleKind, results: Results): string {
  const columns = SCHEDULE_COLUMNS[kind];
  const index = indexOf(results);
  let rows: Record<string, Cell>[] = [];
  if (kind === 'panels') {
    const statuses = new Map(panelRows(results).map((row) => [row.id, row]));
    rows = (results.layout?.panels ?? []).map((panel) => {
      const member = index.member.get(panel.id);
      const typed = index.typed.get(panel.id);
      const row = statuses.get(panel.id)!;
      return {
        id: panel.id,
        face: panel.faceIndex,
        row: panel.row,
        col: panel.col,
        boundary: panel.boundary ? '경계' : '',
        type: typed?.type,
        class: typed ? CLASS_TEXT[typed.class] : null,
        width: len(panel.width),
        height: len(panel.height),
        plateWidth: len(member?.flatSize[0]),
        plateHeight: len(member?.flatSize[1]),
        thickness: len(member?.thickness),
        area: area(panel.area),
        opening: panel.opening ? (panel.opening.ratio * 100).toFixed(1) : null,
        flatness: len(typed?.flatness),
        planarGap: len(typed?.planarGap),
        offSurface: len(typed?.offSurface),
        jointGapMin: len(member?.jointGap?.[0]),
        jointGapMax: len(member?.jointGap?.[1]),
        sampleDeviation: null,
        status: row.status,
        reason: row.reason,
      };
    });
  } else if (kind === 'types') {
    rows = (results.typing?.types ?? []).map((type) => ({
      type: type.type,
      count: type.count,
      class: CLASS_TEXT[type.class],
      vertexCount: type.vertexCount,
      representative: type.representative,
      plateWidth: len(type.size[0]),
      plateHeight: len(type.size[1]),
      maxDeviation: len(type.maxDeviation),
      mirrorOf: type.mirrorOf,
    }));
  } else if (kind === 'nodes') {
    rows = (results.typing?.nodes ?? []).map((node) => ({
      type: node.type,
      count: node.count,
      valence: node.valence,
      angles: node.angles.map(angle).join(' / '),
    }));
  } else {
    rows = (results.typing?.joints ?? []).map((joint) => ({
      type: joint.type,
      count: joint.count,
      dihedral: `${angle(joint.dihedral[0])}~${angle(joint.dihedral[1])}`,
      length: len(joint.length),
      totalLength: joint.totalLength.toFixed(3),
    }));
  }
  const head = columns.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((row) => columns.map(([key]) => csvCell(row[key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}
/** What an export must say about itself (SPEC-16.11): assumed values left, a stale stage. */
export interface ExportMarks {
  assumed?: number;
  stale?: boolean;
}
/** The export's head words: '가정 값 n개 포함' · '다시 계산 필요' (empty when neither). */
export function exportMarks(marks: ExportMarks = {}): string[] {
  return [
    ...(marks.assumed ? [`가정 값 ${marks.assumed}개 포함`] : []),
    ...(marks.stale ? ['다시 계산 필요'] : []),
  ];
}
/**
 * `패널링-<표>-YYYYMMDD-HHmm[-가정 값 n개 포함][-다시 계산 필요].csv`: the CSV's first line is the
 * column head (Excel), so its marks go in the name (SPEC-16.11).
 */
export function exportName(kind: ScheduleKind, at = new Date(), marks: ExportMarks = {}) {
  const p = (n: number) => String(n).padStart(2, '0');
  const tail = exportMarks(marks)
    .map((m) => `-${m}`)
    .join('');
  return `패널링-${SCHEDULE_TITLES[kind]}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${tail}.csv`;
}

// ── 질문 카드 (SPEC-16.4 2, ADR-026 §4) ──────────────────────────────────────────────────────

export interface QuestionItem {
  id: string;
  title: string;
  options: { id: string; label: string; hint?: string; recommended?: boolean }[];
  allowFree: boolean;
}
/** The shown value of a setting with its unit ('1,200 mm', '사각 격자'). */
export function shownValue(setting: PanelSetting, value: unknown = setting.value): string {
  if (typeof value === 'number') {
    const unit = unitText(setting.displayUnit);
    return `${toDisplay(setting, value).toLocaleString('ko-KR', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;
  }
  if (typeof value === 'boolean') return value ? '켜짐' : '꺼짐';
  return setting.choices?.find((c) => c.value === value)?.label ?? String(value);
}
/**
 * One card per missing value of a stage: the recommended value first and chosen, the other
 * choices, and a free answer for numbers (Design SCR-33 질문 카드).
 */
export function stageQuestions(
  settings: readonly PanelSetting[],
  stage: PanelingStage,
  values: Readonly<Record<string, unknown>>,
): QuestionItem[] {
  return assumedOf(settingsOfStage(settings, stage), [stage], values).map((setting) => {
    const title = setting.basis?.question ?? `${setting.title}을(를) 정해 주세요`;
    if (setting.choices?.length) {
      const choices = [...setting.choices].sort(
        (a, b) => Number(b.value === setting.value) - Number(a.value === setting.value),
      );
      return {
        id: setting.key,
        title,
        options: choices.map((c) => ({
          id: `v:${c.value}`,
          label: c.label,
          ...(c.value === setting.value ? { recommended: true, hint: '추천값' } : {}),
        })),
        allowFree: false,
      };
    }
    if (typeof setting.value === 'boolean')
      return {
        id: setting.key,
        title,
        options: [true, false]
          .sort((a, b) => Number(b === setting.value) - Number(a === setting.value))
          .map((v) => ({
            id: `b:${v}`,
            label: v ? '켬' : '끔',
            ...(v === setting.value ? { recommended: true, hint: '추천값' } : {}),
          })),
        allowFree: false,
      };
    return {
      id: setting.key,
      title,
      options: [
        { id: 'recommended', label: shownValue(setting), hint: '추천값', recommended: true },
      ],
      allowFree: true,
    };
  });
}
/**
 * The value an answer gives (stored unit), or why it cannot be used. A free answer is read in
 * the display unit ('1200' → 1.2 m for a mm setting).
 */
export function answerValue(
  setting: PanelSetting,
  answer: { optionId?: string; text?: string },
): { value: number | string | boolean } | { error: string } {
  if (answer.optionId === 'recommended') return { value: setting.value };
  if (answer.optionId?.startsWith('v:')) return { value: answer.optionId.slice(2) };
  if (answer.optionId?.startsWith('b:')) return { value: answer.optionId === 'b:true' };
  const text = (answer.text ?? '').replaceAll(',', '').trim();
  const shown = Number(text);
  if (!text || !Number.isFinite(shown) || typeof setting.value !== 'number')
    return { error: `${setting.title}: 숫자를 적어 주세요` };
  const factor = toDisplay(setting, 1);
  const value = factor ? Number((shown / factor).toPrecision(12)) : shown;
  const range = setting.range;
  if (range && (value < range.min || value > range.max))
    return {
      error: `${setting.title}: ${shownValue(setting, range.min)}~${shownValue(setting, range.max)} 안에서 적어 주세요`,
    };
  return { value };
}

/** 2단계 판 크기 = 크기 − 줄눈 (Design SCR-33 '판 1,190 × 590 mm = 크기 − 줄눈'). */
export function plateHint(values: Readonly<Record<string, unknown>>): string | undefined {
  const w = values.width,
    h = values.height,
    j = values.joint;
  if (typeof w !== 'number' || typeof h !== 'number' || typeof j !== 'number') return undefined;
  return `판 ${mm(w - j)} × ${mm(h - j)} mm = 크기 − 줄눈`;
}
