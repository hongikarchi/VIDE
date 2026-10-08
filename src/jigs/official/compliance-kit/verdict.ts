// 상태 규칙 (SPEC-15.9, PLAN-48 T-238): 경우 (one of them is right) and 구간 (all must hold) kept
// apart, the 32-case cap, the 가정 mark, unused objects keeping a row from 적합 (SPEC-15.9 7) and the
// comparison without rounding (SPEC-15.9 8; the text gets as many digits as it needs).

import {
  COMPLIANCE_ROLE_LABELS,
  checkGroup,
  type ComplianceCheckId,
  type ComplianceItem,
  type ComplianceRoleName,
  type ComplianceState,
  type Exceedance,
  type NumberSource,
} from '../../../contracts/compliance.ts';
import { basisOf, regNumber, type LimitRead } from './limits-read.ts';

export const MAX_CASES = 32;

/** One reading of the row's uncertain inputs; `keys` names the axis values (ground, roof, …). */
export interface Outcome {
  label: string;
  keys: Record<string, string>;
  state: ComplianceState;
  planned: number | null;
  limit: number | null;
  reason?: string;
}

/** Why a mixed result depends on an axis (SPEC-15.9 2). */
export const AXIS_REASONS: Record<string, string> = {
  ground: '기준 지반 후보에 따라 결과가 갈림',
  site: '대지면적(공부·계산)에 따라 결과가 갈림',
  roof: '옥탑 등의 산입 여부',
  roofLandscape: '옥상 등 조경의 산입',
  overlap: '공개공지와 겹친 조경의 산입',
  variant: '판단 필요 항목을 넣은 외피와 뺀 외피의 결과가 다름',
  floors: '층 번호가 이어지지 않음',
};

const STATE_ORDER: ComplianceState[] = ['위반', '사람 입력 필요', '검사 불가', '판단 필요', '적합'];

/** 구간: any 위반 → 위반, then 사람 입력 필요, 검사 불가, 판단 필요; 적합 only when all are. */
export function worstOf(states: readonly ComplianceState[]): ComplianceState {
  for (const s of STATE_ORDER) if (states.includes(s)) return s;
  return '적합';
}

/** 경우: all 적합 → 적합, all 위반 → 위반, else 판단 필요 (missing inputs first). */
export function combine(
  outcomes: readonly Outcome[],
  axisReasons: Record<string, string> = AXIS_REASONS,
): { state: ComplianceState; reasons: string[] } {
  if (!outcomes.length) return { state: '검사 불가', reasons: ['계산할 경우 없음'] };
  if (outcomes.length > MAX_CASES)
    return { state: '판단 필요', reasons: ['미확정 입력이 너무 많음'] };
  const states = outcomes.map((o) => o.state);
  if (states.every((s) => s === '적합')) return { state: '적합', reasons: [] };
  if (states.every((s) => s === '위반')) return { state: '위반', reasons: [] };
  const own = [
    ...new Set(outcomes.filter((o) => o.state !== '적합').map((o) => o.reason ?? '')),
  ].filter(Boolean);
  for (const s of ['사람 입력 필요', '검사 불가'] as const)
    if (states.includes(s))
      return {
        state: s,
        reasons: [...new Set(outcomes.filter((o) => o.state === s).map((o) => o.reason ?? s))],
      };
  const reasons: string[] = [];
  for (const axis of Object.keys(outcomes[0].keys)) {
    const flips = outcomes.some((a) =>
      outcomes.some(
        (b) =>
          a.state !== b.state &&
          a.keys[axis] !== b.keys[axis] &&
          Object.keys(a.keys).every((k) => k === axis || a.keys[k] === b.keys[k]),
      ),
    );
    if (flips) reasons.push(axisReasons[axis] ?? `${axis}에 따라 결과가 갈림`);
  }
  return { state: '판단 필요', reasons: [...new Set([...own, ...reasons])] };
}

/** The contract's 경우 list (only when there is more than one reading). */
export function casesOf(outcomes: readonly Outcome[], lower = false): ComplianceItem['cases'] {
  if (outcomes.length <= 1) return [];
  return outcomes.slice(0, MAX_CASES).map((o) => {
    const binary: '적합' | '위반' =
      o.state === '적합'
        ? '적합'
        : o.state === '위반'
          ? '위반'
          : o.planned !== null &&
              o.limit !== null &&
              (lower ? o.planned >= o.limit : o.planned <= o.limit)
            ? '적합'
            : '위반';
    const label = binary === o.state ? o.label : `${o.label} (${o.state})`;
    return { label: label.slice(0, 160), state: binary, planned: o.planned, limit: o.limit };
  });
}

/** Cartesian product of axes, each a list of `{key, label, …}` values. */
export function product<T extends Record<string, unknown>>(
  axes: { name: string; values: ({ key: string; label: string } & T)[] }[],
): {
  keys: Record<string, string>;
  labels: string[];
  picks: Record<string, T & { key: string; label: string }>;
}[] {
  let out: {
    keys: Record<string, string>;
    labels: string[];
    picks: Record<string, T & { key: string; label: string }>;
  }[] = [{ keys: {}, labels: [], picks: {} }];
  for (const axis of axes) {
    if (!axis.values.length) continue;
    const next: typeof out = [];
    for (const o of out)
      for (const v of axis.values)
        next.push({
          keys: { ...o.keys, [axis.name]: v.key },
          labels: v.label ? [...o.labels, v.label] : o.labels,
          picks: { ...o.picks, [axis.name]: v },
        });
    out = next;
  }
  return out;
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────

export interface RowLimit {
  value: number;
  unit: string;
  read: LimitRead;
}

export interface RowDraft {
  id: ComplianceCheckId;
  title: string;
  state: ComplianceState;
  reasons: string[];
  planned: { value: number; unit: string } | null;
  limit: RowLimit | null;
  basis: LimitRead[];
  numbers: NumberSource[];
  cases: ComplianceItem['cases'];
  parts: ComplianceItem['parts'];
  objectIds: string[];
  exceedances: Exceedance[];
  unconfirmed: string[];
  /** Roles whose unused or hidden objects keep the row from 적합 (SPEC-15.9 7). */
  roles: ComplianceRoleName[];
  /** A required minimum (주차·조경·공개공지): 적합 when planned ≥ limit; margin = planned − limit. */
  lower: boolean;
}

export function draft(id: ComplianceCheckId, title: string, roles: ComplianceRoleName[]): RowDraft {
  return {
    id,
    title,
    state: '검사 불가',
    reasons: [],
    planned: null,
    limit: null,
    basis: [],
    numbers: [],
    cases: [],
    parts: [],
    objectIds: [],
    exceedances: [],
    unconfirmed: [],
    roles,
    lower: false,
  };
}

export const setState = (r: RowDraft, state: ComplianceState, ...reasons: string[]) => {
  r.state = state;
  r.reasons.push(...reasons.filter(Boolean));
  return r;
};

/** Record the 규제 조건 items a row read: their numbers, 근거, and 가정·판단 필요 marks. */
export function useItems(r: RowDraft, reads: readonly LimitRead[], unit?: string) {
  for (const read of reads) {
    if (!read.item) continue;
    if (!r.numbers.some((n) => n.ref === regNumber(read).ref))
      r.numbers.push(regNumber(read, unit));
    if (!r.basis.some((b) => b.id === read.id && b.target === read.target)) r.basis.push(read);
    if (read.assumed || read.kind === 'undecided-value' || read.kind === 'undecided-applies')
      r.unconfirmed.push(read.reason);
  }
}

/** Objects that keep rows from 적합 (SPEC-15.9 7). */
export interface Blockers {
  unusable: Map<ComplianceRoleName, string[]>;
  hidden: Map<ComplianceRoleName, string[]>;
  roleless: string[];
}

// ── Text (SPEC-15.9 8) ────────────────────────────────────────────────────────────────────────

const DIGITS: Record<string, number> = { 비율: 2, m: 2, '㎡': 2, '㎥': 3, 대: 0, 층: 0 };

export function textOf(value: number, unit: string, digits = DIGITS[unit] ?? 2): string {
  if (unit === '비율') return `${(value * 100).toFixed(digits)}%`;
  const n = value.toFixed(digits);
  return unit ? `${n} ${unit}` : n;
}

/** Texts of planned and limit with enough digits that rounding never makes them look equal. */
export function textsOf(planned: number | null, limit: number | null, unit: string) {
  let d = DIGITS[unit] ?? 2;
  const text = (v: number | null) => (v === null ? '' : textOf(v, unit, d));
  while (
    planned !== null &&
    limit !== null &&
    planned !== limit &&
    text(planned) === text(limit) &&
    d < 10
  )
    d++;
  return { planned: text(planned), limit: text(limit) };
}

const uniq = (list: readonly string[]) => [...new Set(list.filter(Boolean))];

/** The contract row, after SPEC-15.9 7 (unused, hidden and roleless objects) and its own checks. */
export function finalize(r: RowDraft, blockers: Blockers): ComplianceItem {
  let state = r.state;
  const reasons = [...r.reasons];
  if (state === '적합') {
    const unusable = r.roles.flatMap((role) =>
      (blockers.unusable.get(role) ?? []).length
        ? [
            `쓰지 못한 ${COMPLIANCE_ROLE_LABELS[role]} 객체 ${blockers.unusable.get(role)!.length}개`,
          ]
        : [],
    );
    const hidden = r.roles.flatMap((role) =>
      (blockers.hidden.get(role) ?? []).length
        ? [
            `숨긴 ${COMPLIANCE_ROLE_LABELS[role]} 객체 ${blockers.hidden.get(role)!.length}개 — 포함해서 다시 체크하거나 검사에서 빼세요`,
          ]
        : [],
    );
    if (unusable.length || hidden.length) {
      state = '검사 불가';
      reasons.push(...unusable, ...hidden);
      for (const role of r.roles)
        r.objectIds.push(
          ...(blockers.unusable.get(role) ?? []),
          ...(blockers.hidden.get(role) ?? []),
        );
    } else if (blockers.roleless.length) {
      state = '판단 필요';
      reasons.push(
        `역할 없는 객체 ${blockers.roleless.length}개 — 역할을 정하거나 검사에서 빼세요`,
      );
    }
  }
  const isVolume =
    r.id.startsWith('zone:') || r.id === 'sun' || r.id === 'envelope' || r.id === 'outside-site';
  if (state === '적합' && !isVolume && (!r.planned || !r.limit)) {
    state = '검사 불가';
    reasons.push('계획 값 또는 한계 값 없음');
  }
  if (state === '적합' && r.limit && r.limit.read.status === '사람 입력 필요') {
    state = '사람 입력 필요';
    reasons.push(r.limit.read.reason);
  }
  if (state !== '적합' && !uniq(reasons).length) reasons.push(state);
  const unit = r.limit?.unit ?? r.planned?.unit ?? '';
  const texts = textsOf(r.planned?.value ?? null, r.limit?.value ?? null, unit);
  const plannedText = r.planned
    ? r.limit
      ? texts.planned
      : textOf(r.planned.value, r.planned.unit)
    : '';
  return {
    id: r.id,
    group: checkGroup(r.id),
    title: r.title.slice(0, 120),
    state,
    reason: uniq(reasons).join('; ').slice(0, 400),
    planned: r.planned
      ? { value: r.planned.value, unit: r.planned.unit, text: plannedText.slice(0, 120) }
      : null,
    limit: r.limit
      ? {
          value: r.limit.value,
          unit: r.limit.unit,
          text: texts.limit.slice(0, 120),
          itemId: r.limit.read.id.slice(0, 60),
          status: r.limit.read.status,
          origin: (r.limit.read.item?.origin ?? '없음').slice(0, 40),
        }
      : null,
    margin:
      r.planned && r.limit && !isVolume
        ? r.lower
          ? r.planned.value - r.limit.value
          : r.limit.value - r.planned.value
        : null,
    basis: r.basis
      .map(basisOf)
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .slice(0, 20),
    numbers: r.numbers.slice(0, 60),
    cases: r.cases.slice(0, MAX_CASES),
    parts: r.parts.slice(0, 64),
    objectIds: [...new Set(r.objectIds)].slice(0, 20000),
    exceedances: r.exceedances.slice(0, 500),
    unconfirmed: uniq(r.unconfirmed)
      .map((u) => u.slice(0, 200))
      .slice(0, 40),
  };
}
