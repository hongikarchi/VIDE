// 단계 `check` of `vide/compliance-check` (SPEC-15.1 3, ARCH-03 §8.6, PLAN-48 T-238): the jig's
// inputs as the runtime hands them — the classified model of the linked Rhino document
// (`host-document`), the massing work copy's '한계' and the site model's 대지 요약 (`jig-output`,
// `{source, value, reason}`) — the settings and the person's 수정 사항, into `runCheck`. Nothing is
// read from the host here: the engine reads the document when [법규 체크] is pressed. Pure.

import {
  classifiedModelSchema,
  complianceLimitsSchema,
  type ComplianceOverride,
  type ComplianceResult,
  type ComplianceSettings,
  type GroundDatum,
} from '../../../contracts/compliance.ts';
import { runCheck } from './check.ts';

/** A `jig-output` input as a step receives it (ARCH-03 §8.5). */
interface JigOutputInput {
  source: {
    instanceId?: string;
    title?: string;
    status?: string;
    at?: string | null;
    hash?: string | null;
  } | null;
  value: unknown;
  reason?: string;
}
/** A 수정 사항 as the runtime hands it to a step. */
interface StepOverride {
  id?: string;
  target?: { kind?: string };
  fields?: Record<string, unknown>;
  by?: string;
  at?: string;
}

/** 근거 of a 기준 지반 a person entered (the setting's choices; no free text in jig settings). */
export const GROUND_BASIS: Record<string, string | null> = {
  none: null,
  survey: '측량·현황 자료',
  design: '설계 기준 레벨',
  permit: '인허가 협의 값',
};

const refOf = (input: JigOutputInput | null | undefined) => {
  const s = input?.source;
  if (!s?.instanceId) return null;
  return {
    instanceId: s.instanceId.slice(0, 200),
    title: (s.title ?? '').slice(0, 200),
    hash: (s.hash ?? '').slice(0, 200),
    at: (s.at ?? '1970-01-01T00:00:00.000Z').slice(0, 40),
  };
};

/** The person's 산정 제외 면적 and 층 용도 (`by: 'user'` only — an AI value is never used). */
export function complianceOverrides(overrides: readonly StepOverride[]): ComplianceOverride[] {
  const out: ComplianceOverride[] = [];
  for (const o of overrides) {
    if (o.by !== 'user' || !o.id) continue;
    const f = o.fields ?? {};
    const at = o.at ?? '1970-01-01T00:00:00.000Z';
    if (o.target?.kind === 'floor-exclusion' && typeof f.area_m2 === 'number')
      out.push({
        kind: 'floor-exclusion',
        id: o.id,
        floor: String(f.floor ?? ''),
        area_m2: f.area_m2,
        basis: String(f.basis ?? '').trim() || '근거 없음',
        by: 'person',
        at,
      });
    else if (o.target?.kind === 'use-floor' && typeof f.use === 'string')
      out.push({
        kind: 'use-floor',
        id: o.id,
        floor: String(f.floor ?? ''),
        use: f.use,
        by: 'person',
        at,
      });
  }
  return out;
}

/** The step: the check over what the jig's inputs hold now. */
export function checkStep(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  overrides: readonly StepOverride[] = [],
): ComplianceResult {
  const read = classifiedModelSchema.safeParse(inputs.model);
  if (!read.success)
    throw new Error(
      inputs.model
        ? '읽은 모델의 형식이 맞지 않습니다 — [법규 체크]를 다시 누르세요'
        : '모델을 아직 읽지 않았습니다 — [법규 체크]를 누르면 연결 Rhino 문서를 읽습니다',
    );
  // A producer the engine registered hands the value itself; an earlier instance `{source, value}`.
  const direct = complianceLimitsSchema.safeParse(inputs.limits);
  const limitsIn = direct.success ? null : ((inputs.limits ?? null) as JigOutputInput | null);
  const parsed = direct.success ? direct : complianceLimitsSchema.safeParse(limitsIn?.value);
  const limitsStale =
    !parsed.success &&
    (limitsIn?.source?.status === 'stale' || /다시 계산/.test(limitsIn?.reason ?? ''));
  const siteIn = (inputs.siteModel ?? null) as JigOutputInput | null;
  const ground = (siteIn?.value as { ground?: unknown } | null | undefined)?.ground as
    | GroundDatum['candidate']
    | undefined;
  const set = params.groundState === 'set';
  const level = typeof params.groundLevel === 'number' ? params.groundLevel : null;
  const basis = GROUND_BASIS[String(params.groundBasis ?? 'none')] ?? null;
  const settings: ComplianceSettings = {
    groundLevel: set ? level : null,
    groundBasis: set ? basis : null,
    exclusionsComplete: params.exclusionsComplete === true,
    noneParking: params.noneParking === true,
    noneLandscape: params.noneLandscape === true,
    noneOpenSpace: params.noneOpenSpace === true,
    includeHidden: params.includeHidden === true,
  };
  return runCheck(
    read.data,
    parsed.success ? parsed.data : null,
    {
      value: settings.groundLevel,
      basis: settings.groundBasis,
      candidate:
        ground && typeof ground === 'object' && typeof ground.min === 'number' ? ground : null,
    },
    settings,
    complianceOverrides(overrides),
    { limits: refOf(limitsIn), siteModel: refOf(siteIn), limitsStale },
  );
}
