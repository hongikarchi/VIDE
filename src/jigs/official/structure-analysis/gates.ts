// Structure gates (ARCH-03 §11, SPEC-06): `combo-echo`, `unchecked-listed`, `analysis-confirmed`.
// The platform gate list calls these by name; each returns why it failed in one sentence.

import type { StructureModelInput, StructureSummary } from '../../../contracts/structure-model.ts';
import { DISCLAIMER } from './summary.ts';

export interface GateResult {
  gate: 'combo-echo' | 'unchecked-listed' | 'analysis-confirmed';
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
