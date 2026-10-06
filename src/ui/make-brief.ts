// The 시작 양식 of a new jig (PLAN-40 T-185, SPEC-07.16 step 0, Design SCR-16): what the person
// fills before a draft exists, the first turn assembled from it, the plan card it gives until
// [만들기 시작], and where this browser keeps it per draft. Pure, except the storage helpers.
import type { DraftDetail, DraftStart } from './make-api.ts';

export type BriefInput = 'layers' | 'assembly' | 'zone' | 'table' | 'facts' | 'jig';
export type BriefOutput =
  | 'preview'
  | 'curve'
  | 'sweep'
  | 'extrude'
  | 'textdot'
  | 'table'
  | 'report'
  | 'handoff';
export type BriefParamType = 'length' | 'angle' | 'count' | 'ratio' | 'choice';
export type BriefBy = 'code' | 'library' | 'ai' | 'human';

export interface BriefParam {
  name: string;
  type: BriefParamType;
  unit: string;
  value: string;
  min: string;
  max: string;
  basis: 'confirmed' | 'assumed';
}
export interface BriefStep {
  name: string;
  by: BriefBy;
  note: string;
}
export interface BriefCheck {
  text: string;
  level: 'block' | 'warn';
}
export interface Brief {
  purpose: string;
  when: string;
  notWhen: string;
  inputs: BriefInput[];
  /** Geometry read from host layers (호스트 레이어). */
  layerShapes: string[];
  /** Shapes a person draws (그리는 구역). */
  zoneShapes: string[];
  params: BriefParam[];
  steps: BriefStep[];
  outputs: BriefOutput[];
  checks: BriefCheck[];
  start: DraftStart;
}

/** Labels in the words of the screen; the manifest kinds go to the AI in brackets. */
export const INPUTS: readonly { key: BriefInput; label: string; kind: string }[] = [
  { key: 'layers', label: '호스트 레이어', kind: 'sync-layers' },
  { key: 'assembly', label: '역할별로 모으는 입력', kind: 'assembly' },
  { key: 'zone', label: '사람이 그리는 구역', kind: 'zone' },
  { key: 'table', label: '표 파일', kind: 'table-file' },
  { key: 'facts', label: '프로젝트 자료', kind: 'facts' },
  { key: 'jig', label: '다른 jig 결과', kind: 'jig-output' },
];
export const LAYER_SHAPES = ['곡선', '점', '솔리드', '블록', '문자'] as const;
export const ZONE_SHAPES = ['폴리곤', '선'] as const;
export const PARAM_TYPES: readonly { key: BriefParamType; label: string; unit: string }[] = [
  { key: 'length', label: '길이', unit: 'm' },
  { key: 'angle', label: '각도', unit: '°' },
  { key: 'count', label: '개수', unit: '개' },
  { key: 'ratio', label: '비율', unit: '' },
  { key: 'choice', label: '선택', unit: '' },
];
export const STEP_BY: readonly { key: BriefBy; label: string }[] = [
  { key: 'code', label: '계산' },
  { key: 'library', label: '라이브러리' },
  { key: 'ai', label: 'AI 판정' },
  { key: 'human', label: '사람 확인' },
];
export const OUTPUTS: readonly { key: BriefOutput; label: string; group?: string }[] = [
  { key: 'preview', label: '3D 미리보기선' },
  { key: 'curve', label: '곡선', group: 'Rhino에 만들기' },
  { key: 'sweep', label: '보 스윕', group: 'Rhino에 만들기' },
  { key: 'extrude', label: '기둥 돌출', group: 'Rhino에 만들기' },
  { key: 'textdot', label: '문자점', group: 'Rhino에 만들기' },
  { key: 'table', label: '표' },
  { key: 'report', label: '보고서' },
  { key: 'handoff', label: '다른 jig로 넘김' },
];
/** Example sentences the 언제 쓰나 / 쓰지 않나 chips put in. */
export const WHEN_EXAMPLES = [
  '계획안 검토 단계에서 배치를 빠르게 바꿔 볼 때',
  '도면을 넘기기 전에 기준을 한 번에 확인할 때',
  '같은 규칙을 여러 동·층에 되풀이할 때',
] as const;
export const NOT_WHEN_EXAMPLES = [
  '구조 계산서가 필요한 최종 검토',
  '법규 판단이 걸린 확정 결정',
  '한 번만 손으로 그리면 되는 일',
] as const;

export const emptyBrief = (): Brief => ({
  purpose: '',
  when: '',
  notWhen: '',
  inputs: [],
  layerShapes: [],
  zoneShapes: [],
  params: [],
  steps: [],
  outputs: [],
  checks: [],
  start: 'blank',
});
export const emptyParam = (): BriefParam => ({
  name: '',
  type: 'length',
  unit: 'm',
  value: '',
  min: '',
  max: '',
  basis: 'assumed',
});
export const emptyStep = (): BriefStep => ({ name: '', by: 'code', note: '' });
export const emptyCheck = (): BriefCheck => ({ text: '', level: 'block' });

/** [계획 받기] needs the purpose; everything else may stay empty. */
export const briefReady = (brief: Brief) => brief.purpose.trim().length > 0;

const named = <T extends { name?: string; text?: string }>(rows: readonly T[]) =>
  rows.filter((row) => (row.name ?? row.text ?? '').trim());
const labelOf = <K extends string>(list: readonly { key: K; label: string }[], key: K) =>
  list.find((item) => item.key === key)?.label ?? key;

/** The rows the person actually filled (empty rows of the tables are left out). */
export function filled(brief: Brief) {
  return {
    params: named(brief.params),
    steps: named(brief.steps),
    checks: named(brief.checks),
  };
}

/**
 * The first turn of the make conversation (SPEC-07.16 step 0 → 1): the form in sentences, and the
 * ask to show the plan only. Empty parts are named so the AI fills them with assumptions.
 */
export function briefPrompt(brief: Brief): string {
  const { params, steps, checks } = filled(brief);
  const empty = '(비움 — 가정으로 채워 주세요)';
  const lines: string[] = [
    '새 jig를 만들려고 합니다. 아래 시작 양식으로 계획부터 보여 주세요.',
    '',
  ];
  lines.push(`■ 목적: ${brief.purpose.trim()}`);
  lines.push(`■ 언제 쓰나: ${brief.when.trim() || empty}`);
  lines.push(`■ 쓰지 않을 때: ${brief.notWhen.trim() || empty}`);
  lines.push('■ 무엇을 읽나:');
  if (!brief.inputs.length) lines.push(`- ${empty}`);
  for (const key of brief.inputs) {
    const input = INPUTS.find((item) => item.key === key)!;
    const shapes =
      key === 'layers' ? brief.layerShapes : key === 'zone' ? brief.zoneShapes : ([] as string[]);
    lines.push(`- ${input.label} [${input.kind}]${shapes.length ? `: ${shapes.join('·')}` : ''}`);
  }
  lines.push('■ 무엇을 조절하나 (설정값):');
  if (!params.length) lines.push(`- ${empty}`);
  for (const p of params) {
    const range = p.min || p.max ? ` · 범위 ${p.min || '?'}~${p.max || '?'}` : '';
    const value = p.value ? ` · 기본값 ${p.value}${p.unit}` : '';
    lines.push(
      `- ${p.name.trim()} · ${labelOf(PARAM_TYPES, p.type)}${p.unit ? ` (${p.unit})` : ''}${value}${range} · 근거 ${p.basis === 'confirmed' ? '확정' : '가정'}`,
    );
  }
  lines.push('■ 어떻게 판단하나 (계산 단계):');
  if (!steps.length) lines.push(`- ${empty}`);
  steps.forEach((s, i) =>
    lines.push(
      `${i + 1}. ${s.name.trim()} · 맡는 쪽 ${labelOf(STEP_BY, s.by)}${s.note.trim() ? ` · ${s.note.trim()}` : ''}`,
    ),
  );
  lines.push('■ 무엇을 내놓나:');
  const bake = OUTPUTS.filter((o) => o.group && brief.outputs.includes(o.key)).map((o) => o.label);
  const rest = OUTPUTS.filter((o) => !o.group && brief.outputs.includes(o.key)).map((o) => o.label);
  if (!bake.length && !rest.length) lines.push(`- ${empty}`);
  for (const label of rest) lines.push(`- ${label}`);
  if (bake.length) lines.push(`- Rhino에 만들기: ${bake.join('·')}`);
  lines.push('■ 무엇이면 통과인가:');
  if (!checks.length) lines.push(`- ${empty}`);
  for (const c of checks)
    lines.push(`- ${c.text.trim()} (${c.level === 'block' ? '어기면 막음' : '어기면 주의'})`);
  lines.push(
    `■ 시작점: ${brief.start === 'example-grid' ? '본보기(격자 예제)를 고쳐서' : '빈 초안에서'}`,
  );
  lines.push(
    '',
    '이번 턴에는 코드와 파일을 쓰지 말고, 입력·설정값·단계·화면·결과를 한 장의 계획으로 정리해 주세요. 비운 칸은 가정으로 채우고 가정이라고 적어 주세요. 정할 수 없는 것만 질문 카드로 물어 주세요. 제가 [만들기 시작]을 보내면 그때 작성합니다.',
  );
  return lines.join('\n');
}

export interface BriefPlanItem {
  title: string;
  done: boolean;
  current?: boolean;
}
/** The plan card before [만들기 시작]: the form's parts, filled (✓) or left to the AI (○). */
export function briefPlan(brief: Brief): BriefPlanItem[] {
  const { params, steps, checks } = filled(brief);
  const parts: [string, number][] = [
    ['입력', brief.inputs.length],
    ['설정값', params.length],
    ['단계', steps.length],
    ['결과', brief.outputs.length],
    ['통과 조건', checks.length],
  ];
  const items: BriefPlanItem[] = [{ title: `목적 · ${brief.purpose.trim()}`, done: true }];
  for (const [title, count] of parts)
    items.push(
      count
        ? { title: `${title} ${count}개`, done: true }
        : { title: `${title} · AI가 가정`, done: false },
    );
  items.push({ title: '작성·시험 ([만들기 시작] 뒤)', done: false, current: true });
  return items;
}

// --- Where the authoring stands (the 만들기 tab's progress line and plan card) ---

export const PHASES = ['계획', '질문', '작성', '시험', '미리보기', '고정'] as const;
export type Phase = (typeof PHASES)[number];
/**
 * The files are as the starting point left them (PLAN-40 T-185): every file except `jig.json`
 * (the icon picker writes it) is no newer than the draft. Unknown times count as written.
 */
export function untouched(detail: DraftDetail) {
  const made = Date.parse(detail.draft.createdAt ?? '');
  if (!Number.isFinite(made)) return false;
  return detail.files.every((file) => {
    if (file.path === 'jig.json') return true;
    const at = Date.parse(file.updatedAt ?? '');
    return Number.isFinite(at) && at <= made + 5000;
  });
}
/**
 * Where the authoring stands, from what the engine reports about the draft. Before writing starts
 * ([만들기 시작] sent, or files written after the start) the starting point's files are not 작성.
 */
export function phaseOf(detail: DraftDetail, writing = !untouched(detail)): Phase {
  if (detail.preview) return '미리보기';
  if (detail.test || detail.validate) return '시험';
  if (writing && detail.files.some((file) => file.path.startsWith('steps/'))) return '작성';
  return '계획';
}
/**
 * The plan card: the engine's plan when it keeps one; before writing, the 시작 양식's parts (or
 * nothing done yet); otherwise what the draft already has.
 */
export function planOf(
  detail: DraftDetail,
  { writing = !untouched(detail), brief }: { writing?: boolean; brief?: Brief } = {},
): { title: string; done: boolean; current?: boolean }[] {
  if (detail.plan?.length) return detail.plan;
  if (!writing && brief) return briefPlan(brief);
  const m = detail.manifest;
  const has = (path: string) => detail.files.some((file) => file.path === path);
  const items = [
    { title: `입력 ${m.inputs.length}개`, done: m.inputs.length > 0 },
    { title: `설정값 ${m.params.length}개`, done: m.params.length > 0 },
    { title: `단계 ${m.steps.length}개`, done: m.steps.length > 0 },
    { title: '화면 (panel.json)', done: has('panel.json') },
    {
      title: '시험 자료',
      done: detail.files.some((file) => file.path.startsWith('fixtures/')),
    },
    { title: '결과 확인 (시험 통과)', done: !!detail.test?.ok },
  ];
  // The starting point's files are not done work before writing starts.
  const shown = writing ? items : items.map((item) => ({ ...item, done: false }));
  const current = shown.findIndex((item) => !item.done);
  return shown.map((item, i) => ({ ...item, current: i === current }));
}

// --- Per draft in this browser (a viewer convenience; the conversation holds the real plan). ---

export interface KeptBrief {
  /** Absent for a draft not started from the form (only [만들기 시작] is kept). */
  brief?: Brief;
  /** [만들기 시작] was sent from the plan card. */
  started: boolean;
}
const briefKey = (draftId: string) => `vide:make-brief:${draftId}`;
export function keptBrief(draftId: string): KeptBrief | undefined {
  try {
    const raw = localStorage.getItem(briefKey(draftId));
    if (!raw) return undefined;
    const value = JSON.parse(raw) as KeptBrief;
    return value && typeof value.started === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}
export function keepBrief(draftId: string, value: KeptBrief | undefined) {
  try {
    if (value) localStorage.setItem(briefKey(draftId), JSON.stringify(value));
    else localStorage.removeItem(briefKey(draftId));
  } catch {
    /* The plan card falls back to the draft's files. */
  }
}
