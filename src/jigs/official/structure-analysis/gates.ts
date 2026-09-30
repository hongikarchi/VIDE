// Structure gates (ARCH-03 §11, SPEC-06): `combo-echo`, `unchecked-listed`, `analysis-confirmed`.
// The platform gate list calls these by name; each returns why it failed in one sentence.

import type {
  MarkLedger,
  StructureModelInput,
  StructureSchedule,
  StructureSummary,
} from '../../../contracts/structure-model.ts';
import type { MemberMap } from './frame-plan.ts';
import { DISCLAIMER } from './summary.ts';

export interface GateResult {
  gate:
    | 'combo-echo'
    | 'unchecked-listed'
    | 'analysis-confirmed'
    | 'mark-unique'
    | 'schedule-complete';
  ok: boolean;
  reasons: string[];
}

const termKey = (terms: Record<string, number>) =>
  Object.entries(terms)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([pattern, factor]) => `${pattern}×${factor}`)
    .join('+');

/** The combinations in the summary are exactly the model's, id for id and factor for factor. */
export function comboEcho(
  model: Pick<StructureModelInput, 'combinations'>,
  summary: Pick<StructureSummary, 'combos'>,
): GateResult {
  const reasons: string[] = [];
  const expected = new Map(
    model.combinations.map((c) => [
      c.id,
      `${c.limitState}:${termKey(Object.fromEntries(c.terms.map((t) => [t.pattern, t.factor])))}`,
    ]),
  );
  const got = new Map(summary.combos.map((c) => [c.id, `${c.limitState}:${termKey(c.terms)}`]));
  for (const [id, key] of expected)
    if (!got.has(id)) reasons.push(`조합 ${id}가 결과에 없음`);
    else if (got.get(id) !== key) reasons.push(`조합 ${id}의 계수가 입력과 다름`);
  for (const id of got.keys()) if (!expected.has(id)) reasons.push(`결과에만 있는 조합 ${id}`);
  if (
    expected.size !== got.size ||
    [...expected.keys()].some((id, k) => summary.combos[k]?.id !== id)
  )
    if (!reasons.length) reasons.push('조합 순서가 입력과 다름');
  return { gate: 'combo-echo', ok: !reasons.length, reasons };
}

/** Every summary names what was not reviewed and carries the disclaimer. */
export function uncheckedListed(
  summary: Pick<StructureSummary, 'unchecked' | 'disclaimer'>,
): GateResult {
  const reasons: string[] = [];
  if (!summary.unchecked.length) reasons.push('검토하지 않은 항목 목록이 비어 있음');
  if (summary.disclaimer !== DISCLAIMER) reasons.push('탐색용 예비값 안내문이 없음');
  return { gate: 'unchecked-listed', ok: !reasons.length, reasons };
}

/** Before members are baked: a confirmed, successful analysis of this very model must exist. */
export function analysisConfirmed(
  summary: Pick<StructureSummary, 'mode' | 'status' | 'modelHash'> | null | undefined,
  modelHash: string,
): GateResult {
  const reasons: string[] = [];
  if (!summary) reasons.push('확정 해석이 없음');
  else {
    if (summary.mode !== 'confirmed') reasons.push('미확정 미리보기는 확정 해석이 아님');
    if (summary.status !== 'ok') reasons.push(`해석 상태 ${summary.status}`);
    if (summary.modelHash !== modelHash) reasons.push('확정 해석의 모델이 현재 입력과 다름');
  }
  return { gate: 'analysis-confirmed', ok: !reasons.length, reasons };
}

const MARK_CHARS = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * One mark points at one group only (SPEC-06.12): every design member carries a mark, marks pass
 * the character rule, no two members of a mark differ in prefix/section/curvature, and no two marks
 * in use describe the same straight group.
 */
export function markUnique(
  result: { marks: Record<string, string>; ledger: Pick<MarkLedger, 'groups'> },
  map?: Pick<MemberMap, 'physical'>,
): GateResult {
  const reasons: string[] = [];
  const missing = Object.keys(map?.physical ?? {}).filter((id) => !result.marks[id]);
  if (missing.length)
    reasons.push(`부호 없는 부재 ${missing.length}개(${missing.slice(0, 5).join(', ')})`);
  const used = new Set(Object.values(result.marks));
  for (const mark of used) {
    if (!MARK_CHARS.test(mark)) reasons.push(`부호 '${mark}'에 허용되지 않는 문자`);
    if (!result.ledger.groups[mark]) reasons.push(`부호 '${mark}'의 묶음 설명이 없음`);
  }
  const straight = new Map<string, string>();
  for (const mark of used) {
    const g = result.ledger.groups[mark];
    if (!g || g.curved) continue;
    const key = `${g.prefix}|${g.section}`;
    const other = straight.get(key);
    if (other)
      reasons.push(`부호 ${other}와 ${mark}가 같은 묶음(${g.prefix} ${g.section})을 가리킴`);
    else straight.set(key, mark);
  }
  return { gate: 'mark-unique', ok: !reasons.length, reasons };
}

/** Every design member appears in the schedule exactly once. */
export function scheduleComplete(
  table: Pick<StructureSchedule, 'rows' | 'unlisted'>,
  map: Pick<MemberMap, 'physical'>,
): GateResult {
  const reasons: string[] = [];
  const seen = new Map<string, number>();
  for (const row of table.rows) for (const id of row.members) seen.set(id, (seen.get(id) ?? 0) + 1);
  const ids = Object.keys(map.physical);
  const missing = ids.filter((id) => !seen.has(id));
  const twice = ids.filter((id) => (seen.get(id) ?? 0) > 1);
  const foreign = [...seen.keys()].filter((id) => !map.physical[id]);
  if (missing.length)
    reasons.push(`일람표에 없는 부재 ${missing.length}개(${missing.slice(0, 5).join(', ')})`);
  if (twice.length)
    reasons.push(`두 행에 나온 부재 ${twice.length}개(${twice.slice(0, 5).join(', ')})`);
  if (foreign.length)
    reasons.push(`모델에 없는 부재 ${foreign.length}개(${foreign.slice(0, 5).join(', ')})`);
  if (table.unlisted.length) reasons.push(`부호 없는 부재 ${table.unlisted.length}개`);
  return { gate: 'schedule-complete', ok: !reasons.length, reasons };
}
