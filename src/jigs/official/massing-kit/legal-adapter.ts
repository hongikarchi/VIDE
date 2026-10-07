// The SPEC-13 adapter slot (PLAN-45 T-209 「규제 조건 항목 스키마」): legal results → 규제 조건 items
// of `rules.ts`. The SPEC-13 result format is decided by PLAN-46, and T-220 fills this function.
// Until then every call answers "법규 결과 없음" and the items stay what the person entered
// (SPEC-12.16 법규 결과 없음). Whatever T-220 maps must keep the SPEC-13 출처 구분 and 근거 as they
// are (SPEC-12.14) and never turn a '판단 필요' into 적용 or 미적용.

import type { RegulationItem } from './rules.ts';

export interface LegalAdapterResult {
  /** False until a SPEC-13 result is wired in (T-220). */
  available: boolean;
  /** Why there are no items, shown as-is. */
  reason: string;
  items: RegulationItem[];
}

/** Map a SPEC-13 legal result onto 규제 조건 items (slot; T-220). */
export function regulationsFromLegal(result: unknown): LegalAdapterResult {
  if (result === undefined || result === null)
    return { available: false, reason: '법규 결과 없음', items: [] };
  return {
    available: false,
    reason: '법규 결과 연결 전(T-220): 규제 조건은 사람 입력으로 받습니다',
    items: [],
  };
}
