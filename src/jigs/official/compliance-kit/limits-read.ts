// 한계 항목 읽기 (SPEC-15.5 6, PLAN-48 T-238): what one 규제 조건 item gives a row, by 적용 여부,
// 확정 상태 and 출처 구분 — the same table for every row. VIDE never changes an item's value or unit
// and never fills an empty item from another; an 'AI가 추정함' value is no limit (AC-14).

import {
  REGULATION_ITEMS,
  emptyItem,
  type RegulationId,
  type RegulationItem,
} from '../massing-kit/rules.ts';
import type { NumberSource, RegulationItemData } from '../../../contracts/compliance.ts';

export type LimitKind = 'value' | 'none' | 'na' | 'undecided-applies' | 'undecided-value';

export interface LimitRead {
  id: string;
  target: string | null;
  item: RegulationItemData | null;
  title: string;
  kind: LimitKind;
  /** The value when the item gives one (kinds value · undecided-applies · undecided-value). */
  value: number | string | string[] | null;
  /** 확정 상태 as the result shows it ('사람 입력 필요' for kind none). */
  status: '확정' | '가정' | '판단 필요' | '사람 입력 필요';
  assumed: boolean;
  /** Why the item is not a plain limit (empty for a 확정 value). */
  reason: string;
}

const defOf = (id: string) =>
  (REGULATION_ITEMS as Record<string, { title: string; unit: string } | undefined>)[id];

export const titleOf = (id: string, item?: RegulationItemData | null) =>
  item?.title ?? defOf(id)?.title ?? id;

/** One item read by SPEC-15.5 6. */
export function readItem(id: string, item: RegulationItemData | null | undefined): LimitRead {
  const title = titleOf(id, item);
  const base = {
    id,
    target: item?.target ?? null,
    item: item ?? null,
    title,
    value: null,
    assumed: false,
  };
  const none = (reason: string): LimitRead => ({
    ...base,
    kind: 'none',
    status: '사람 입력 필요',
    reason,
  });
  if (!item) return none(`${title} 사람 입력 필요`);
  const label = item.target ? `${title}(${item.target})` : title;
  if (item.origin === 'AI가 추정함') return none(`${label}: AI 추정 값은 사람이 확정해야 함`);
  if (item.applies === '미적용')
    return { ...base, kind: 'na', status: item.status, reason: `${label} 미적용` };
  const def = defOf(id);
  if (def && def.unit !== item.unit)
    return none(`${label}: 단위가 다름(${item.unit || '없음'} ≠ ${def.unit || '없음'})`);
  if (
    item.applies === null ||
    item.status === '사람 입력 필요' ||
    item.value === null ||
    item.value === 'ask'
  )
    return none(`${label} 사람 입력 필요`);
  const value = item.value;
  if (item.applies === '판단 필요')
    return {
      ...base,
      value,
      kind: 'undecided-applies',
      status: '판단 필요',
      reason: `${label} 적용 여부 판단 필요`,
    };
  if (item.status === '판단 필요')
    return {
      ...base,
      value,
      kind: 'undecided-value',
      status: '판단 필요',
      reason: `${label} 값 판단 필요`,
    };
  if (item.status === '가정')
    return {
      ...base,
      value,
      kind: 'value',
      status: '가정',
      assumed: true,
      reason: `가정 값 기준: ${label}`,
    };
  return { ...base, value, kind: 'value', status: '확정', reason: '' };
}

/** The item for a target first, then the site-wide one (as massing-kit `itemOf`). */
export function lookup(regs: readonly RegulationItemData[], id: string, target?: string | null) {
  return (
    (target ? regs.find((i) => i.id === id && i.target === target) : undefined) ??
    regs.find((i) => i.id === id && !i.target) ??
    null
  );
}

export const readLimit = (regs: readonly RegulationItemData[], id: string, target?: string) =>
  readItem(id, lookup(regs, id, target));

/** Every item of one id (the site-wide one and each target). */
export const readAll = (regs: readonly RegulationItemData[], id: string): LimitRead[] => {
  const all = regs.filter((i) => i.id === id);
  return all.length ? all.map((i) => readItem(id, i)) : [readItem(id, null)];
};

/** A number from a read (null for non-numbers and kinds without a value). */
export const numOf = (r: LimitRead): number | null =>
  (r.kind === 'value' || r.kind === 'undecided-applies' || r.kind === 'undecided-value') &&
  typeof r.value === 'number'
    ? r.value
    : null;

/**
 * The items massing-kit functions receive (`legalParking`, `landscapeAreas`, `openSpaceRequirement`,
 * `farTargets`): an item that gives no limit by SPEC-15.5 6 (AI 추정, 단위가 다름, `ask`) becomes the
 * empty item, so those functions see '사람 입력 필요' rather than a value nobody confirmed.
 */
export function filteredItems(regs: readonly RegulationItemData[]): RegulationItem[] {
  return regs.map((item) => {
    const r = readItem(item.id, item);
    if (r.kind === 'none' && item.id in REGULATION_ITEMS)
      return emptyItem(item.id as RegulationId, item.target);
    return item as RegulationItem;
  });
}

/** `regulation:<id>[@<target>]`. */
export const regRef = (r: { id: string; target: string | null }) =>
  `regulation:${r.id}${r.target ? `@${r.target}` : ''}`;

export function regNumber(r: LimitRead, unit?: string): NumberSource {
  return {
    label: (r.target ? `${r.title}(${r.target})` : r.title).slice(0, 120),
    value: typeof r.value === 'number' ? r.value : null,
    unit: (unit ?? r.item?.unit ?? '').slice(0, 20),
    kind: '규제 조건',
    ref: regRef(r).slice(0, 200),
    note: (r.item
      ? `${r.item.applies ?? '적용 여부 없음'} · ${r.item.status} · ${r.item.origin}${
          typeof r.value === 'string' ? ` · ${r.value}` : ''
        }`
      : '항목 없음'
    ).slice(0, 300),
  };
}

/** 근거 조항 of an item as the result shows it (SPEC-15.9 4). VIDE adds no clause. */
export function basisOf(r: LimitRead) {
  if (!r.item) return null;
  const answer = /^legal\.([^:]+):/.exec(r.item.source)?.[1] ?? null;
  return {
    clause: (r.item.basis?.clause?.trim() || '근거 없음').slice(0, 400),
    link: r.item.basis?.link ?? null,
    answer: answer ? (/^\d+$/.test(answer) ? `L${answer}` : answer).slice(0, 20) : null,
  };
}
