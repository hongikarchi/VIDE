// 용도 배분 (SPEC-12.11, PLAN-45 T-212): the use of each floor (or shares of a floor) is a table a
// person sets — 수정 사항 `{kind: 'use-floor', identity: {floor, alternative?}}`, fields `{use}` or
// `{uses: [{use, ratio}]}`; by default every floor is the 주용도. An AI draft enters the table only
// through the person's acceptance (`applyUseDraft` after the human step), which writes the same
// 수정 사항 as the person with `by: 'user'` and a note; an override still marked `by: 'ai'` is
// refused here. Each floor's uses are compared with the 허용 용도 and the 층별 용도 제한 items:
// not listed → '초과'; an item at '판단 필요' or nobody's entry → '미검토' (SPEC-12.11).

import { itemOf, listOf, type RegulationItem, type StepOverride } from './rules.ts';
import type { Alternative, AltFloor } from './alternatives.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface UseShare {
  use: string;
  ratio: number;
}
export interface FloorUse {
  floor: string;
  area: number;
  farArea: number;
  uses: (UseShare & { area: number; farArea: number })[];
  /** Where the floor's uses come from: 주용도(기본) · 사용자가 확정함 · AI 초안을 사람이 받음. */
  origin: string;
  verdict: '적합' | '초과' | '미검토';
  reason: string;
}
export interface UseTotal {
  use: string;
  above: number;
  below: number;
  total: number;
  farArea: number;
}

/** The person's use table (수정 사항), refusing AI-marked and malformed rows. */
export function useTable(overrides: readonly StepOverride[]) {
  const rows = new Map<string, { uses: UseShare[]; origin: string }>();
  const problems: string[] = [];
  for (const o of overrides) {
    if (o?.target?.kind !== 'use-floor' || o.op !== 'set') continue;
    const floor = String(o.target.identity.floor ?? '');
    const alt =
      o.target.identity.alternative === undefined ? '' : String(o.target.identity.alternative);
    if (!floor) {
      problems.push('용도 배분: 층이 없는 행');
      continue;
    }
    if (o.by === 'ai') {
      problems.push(`용도 배분 ${floor}: AI 초안은 사람이 받아야 표에 들어갑니다`);
      continue;
    }
    let uses: UseShare[] | null = null;
    if (typeof o.fields.use === 'string' && o.fields.use) uses = [{ use: o.fields.use, ratio: 1 }];
    else if (Array.isArray(o.fields.uses)) {
      const list = (o.fields.uses as { use?: unknown; ratio?: unknown }[]).map((u) => ({
        use: typeof u?.use === 'string' ? u.use : '',
        ratio: Number(u?.ratio),
      }));
      const sum = list.reduce((s, u) => s + u.ratio, 0);
      if (list.length && list.every((u) => u.use && u.ratio > 0) && Math.abs(sum - 1) <= 1e-6)
        uses = list;
    }
    if (!uses) {
      problems.push(`용도 배분 ${floor}: 용도 하나 또는 비율 합 1인 용도 목록이 필요합니다`);
      continue;
    }
    rows.set(`${alt}@${floor}`, {
      uses,
      origin: o.note && /AI 초안/.test(o.note) ? 'AI 초안을 사람이 받음' : '사용자가 확정함',
    });
  }
  return { rows, problems };
}

function judge(use: string, floor: string, items: readonly RegulationItem[]) {
  const reasons: string[] = [];
  let verdict: FloorUse['verdict'] = '적합';
  const check = (item: RegulationItem) => {
    if (item.applies === '미적용') return;
    const list = listOf(item);
    if (item.applies === '판단 필요' || item.applies === null || !list) {
      if (verdict !== '초과') verdict = '미검토';
      reasons.push(
        `${item.title} ${item.applies === '판단 필요' ? '판단 필요' : '사람 입력 필요'}`,
      );
      return;
    }
    if (!list.includes(use)) {
      verdict = '초과';
      reasons.push(`${use}: ${item.title}에 없음`);
    }
  };
  check(itemOf(items, 'allowedUses'));
  const perFloor = items.find((i) => i.id === 'floorUses' && i.target === floor);
  if (perFloor) check(perFloor);
  return { verdict, reasons };
}

const RANK = { 적합: 0, 미검토: 1, 초과: 2 } as const;

/** Uses of one alternative's floors and the totals by use. */
export function allocateUses(
  alt: Alternative,
  mainUse: string | null,
  table: ReturnType<typeof useTable>['rows'],
  items: readonly RegulationItem[],
) {
  const floorsOf = (list: readonly AltFloor[]): FloorUse[] =>
    list.map((f) => {
      const row = table.get(`${alt.id}@${f.floor}`) ?? table.get(`@${f.floor}`);
      const shares: UseShare[] = row?.uses ?? [{ use: mainUse ?? '주용도 미정', ratio: 1 }];
      let verdict: FloorUse['verdict'] = '적합';
      const reasons: string[] = [];
      for (const s of shares) {
        const j =
          mainUse || row
            ? judge(s.use, f.floor, items)
            : { verdict: '미검토' as const, reasons: ['주용도 미정'] };
        if (RANK[j.verdict] > RANK[verdict]) verdict = j.verdict;
        reasons.push(...j.reasons);
      }
      return {
        floor: f.floor,
        area: f.area,
        farArea: f.farArea,
        uses: shares.map((s) => ({
          ...s,
          area: r6(f.area * s.ratio),
          farArea: r6(f.farArea * s.ratio),
        })),
        origin: row?.origin ?? '주용도(기본)',
        verdict,
        reason: [...new Set(reasons)].join('; '),
      };
    });
  const floors = [...floorsOf(alt.floors), ...floorsOf(alt.basement)];
  const totals = new Map<string, UseTotal>();
  for (const f of floors) {
    const below = f.floor.startsWith('B');
    for (const u of f.uses) {
      const t = totals.get(u.use) ?? { use: u.use, above: 0, below: 0, total: 0, farArea: 0 };
      if (below) t.below += u.area;
      else t.above += u.area;
      t.total += u.area;
      t.farArea += u.farArea;
      totals.set(u.use, t);
    }
  }
  const byUse = [...totals.values()].map((t) => ({
    use: t.use,
    above: r6(t.above),
    below: r6(t.below),
    total: r6(t.total),
    farArea: r6(t.farArea),
  }));
  return { floors, byUse };
}

export interface UseDraftOverride {
  id: string;
  target: { kind: 'use-floor'; identity: { floor: string } };
  op: 'set';
  fields: { use: string } | { uses: UseShare[] };
  origin: 'chat';
  by: 'user';
  note: string;
}

/**
 * The AI draft accepted by a person (after the human step): each draft row becomes the person's
 * 수정 사항 with a stable id (`use-floor:<floor>`), so accepting again replaces the earlier rows.
 * Rows naming a floor no alternative has, or without a use, are refused and listed. The draft holds
 * uses only — never an area or a count (SPEC-12.15 하지 않는다).
 */
export function acceptUseDraft(draft: unknown, floors: ReadonlySet<string>) {
  const overrides: UseDraftOverride[] = [];
  const refused: string[] = [];
  const rows = Array.isArray((draft as { floors?: unknown })?.floors)
    ? ((draft as { floors: unknown[] }).floors as Record<string, unknown>[])
    : [];
  if (!rows.length) refused.push('초안에 층별 용도가 없습니다');
  for (const row of rows) {
    const floor = typeof row?.floor === 'string' ? row.floor : '';
    if (!floors.has(floor)) {
      refused.push(`${floor || '(층 없음)'}: 대안에 없는 층`);
      continue;
    }
    let fields: UseDraftOverride['fields'] | null = null;
    if (typeof row.use === 'string' && row.use) fields = { use: row.use };
    else if (Array.isArray(row.uses)) {
      const list = (row.uses as { use?: unknown; ratio?: unknown }[]).map((u) => ({
        use: typeof u?.use === 'string' ? u.use : '',
        ratio: Number(u?.ratio),
      }));
      const sum = list.reduce((s, u) => s + u.ratio, 0);
      if (list.length && list.every((u) => u.use && u.ratio > 0) && Math.abs(sum - 1) <= 1e-6)
        fields = { uses: list };
    }
    if (!fields) {
      refused.push(`${floor}: 용도가 없거나 비율 합이 1이 아님`);
      continue;
    }
    overrides.push({
      id: `use-floor:${floor}`,
      target: { kind: 'use-floor', identity: { floor } },
      op: 'set',
      fields,
      origin: 'chat',
      by: 'user',
      note: 'AI 초안을 사람이 받음',
    });
  }
  return { overrides, refused };
}
