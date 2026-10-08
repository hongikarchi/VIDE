// 법규 체크 계산 (SPEC-15.2·15.9·15.10, ARCH-03 §8.6, PLAN-48 T-238): `runCheck(model, limits,
// ground, settings, overrides) → ComplianceResult`. Pure: no network, AI or host; the same inputs
// give the same result but `checkedAt`. Every check of the closed list appears exactly once, as a
// row or as a 미적용 항목, and the result is validated against the contract before it leaves.

import {
  COMPLIANCE_CHECKS,
  COMPLIANCE_ROLES,
  COMPLIANCE_STATES,
  UNCLASSIFIED_REASONS,
  classifiedModelSchema,
  complianceLimitsSchema,
  complianceOverrideSchema,
  complianceResultSchema,
  complianceSettingsSchema,
  groundDatumSchema,
  type ClassifiedModel,
  type ComplianceItem,
  type ComplianceLimits,
  type ComplianceOverride,
  type ComplianceResult,
  type ComplianceSettings,
  type GroundDatum,
} from '../../../contracts/compliance.ts';
import { landscapeRow, openSpaceRow, parkingRow } from './amenity.ts';
import { buildContext } from './context.ts';
import {
  HEIGHT_ITEMS,
  coverage,
  far,
  floorsRow,
  height,
  type CheckOut,
  type NotApplicableEntry,
} from './scale.ts';
import { envelopeRow, outsideSiteRow, sunRow, zoneRows } from './shape.ts';
import { finalize } from './verdict.ts';

export const NOTICE = '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음' as const;

/** 앞 작업본 references for `inputs` (the jig step knows them; the engine only copies them). */
export interface CheckRefs {
  limits?: ComplianceResult['inputs']['limits'];
  siteModel?: ComplianceResult['inputs']['siteModel'];
  /** The massing work copy is '다시 계산 필요' (SPEC-15.5 3): its limits are not used. */
  limitsStale?: boolean;
  checkedAt?: string;
}

export class ComplianceInputError extends Error {
  readonly code = 'COMPLIANCE_INPUT_INVALID';
}

/** Stable JSON (sorted keys) for the input fingerprints. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** A 64-bit FNV-1a fingerprint (hex); pure, no node: imports. */
export function fingerprint(value: unknown): string {
  const text = canonical(value);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * The check (SPEC-15.1 3). `limits` null = no massing work copy (or one to recompute, with
 * `refs.limitsStale`): the 규제 조건 rows are '사람 입력 필요' and the shape rows '검사 불가'.
 */
export function runCheck(
  model: ClassifiedModel,
  limits: ComplianceLimits | null,
  ground: GroundDatum,
  settings: ComplianceSettings,
  overrides: readonly ComplianceOverride[],
  refs: CheckRefs = {},
): ComplianceResult {
  const parse = <T>(what: string, run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new ComplianceInputError(`${what}: ${(error as Error).message}`);
    }
  };
  const m = parse('읽은 모델', () => classifiedModelSchema.parse(model));
  const l =
    limits && !refs.limitsStale ? parse('한계', () => complianceLimitsSchema.parse(limits)) : null;
  const g = parse('기준 지반', () => groundDatumSchema.parse(ground));
  const s = parse('설정값', () => complianceSettingsSchema.parse(settings));
  const o = parse('수정 사항', () => overrides.map((x) => complianceOverrideSchema.parse(x)));
  const missing = refs.limitsStale
    ? '앞 작업본이 다시 계산 필요 — 건축 가능 영역·매스를 다시 계산하세요'
    : '규제 조건 없음 — 건축 가능 영역·매스에서 규제 조건을 넣고 계산하세요';
  const ctx = buildContext(m, l, g, s, o, missing);

  const outs: CheckOut[] = [
    coverage(ctx),
    far(ctx),
    ...HEIGHT_ITEMS.map((id) => height(ctx, id)),
    floorsRow(ctx),
    ...zoneRows(ctx),
    sunRow(ctx),
    envelopeRow(ctx),
    outsideSiteRow(ctx),
    parkingRow(ctx),
    landscapeRow(ctx),
    openSpaceRow(ctx),
  ];
  const items: ComplianceItem[] = [];
  const notApplicable: NotApplicableEntry[] = [];
  let no = 0;
  for (const out of outs) {
    if ('na' in out) {
      notApplicable.push(out.na);
      continue;
    }
    for (const e of out.row.exceedances) e.no = ++no;
    items.push(finalize(out.row, ctx.blockers));
  }
  const order = new Map(COMPLIANCE_CHECKS.map((c, i) => [c, i]));
  items.sort((a, b) => order.get(a.id)! - order.get(b.id)!);

  const counts = zero(COMPLIANCE_STATES);
  for (const i of items) counts[i.state]++;
  const byRole = zero(COMPLIANCE_ROLES);
  for (const x of m.objects) byRole[x.role]++;
  const unusedByReason = zero(UNCLASSIFIED_REASONS);
  for (const u of m.unclassified) unusedByReason[u.reason]++;

  const result: ComplianceResult = {
    schema: 'vide.compliance.result@1',
    checkedAt: refs.checkedAt ?? new Date().toISOString(),
    inputs: {
      model: {
        linkId: m.source.linkId,
        documentKey: m.source.documentKey,
        readId: m.source.readId,
        revisionKey: m.source.revisionKey,
        readAt: m.source.readAt,
        objects: m.objects.length,
        unclassified: m.unclassified.length,
        rolesVersion: m.rolesVersion,
      },
      limits: refs.limits ?? null,
      siteModel: refs.siteModel ?? null,
      settingsHash: fingerprint({ settings: s, ground: g }),
      overridesHash: fingerprint(o),
    },
    items,
    notApplicable,
    classification: {
      byRole,
      unusedByReason,
      aiAccepted: m.objects.filter((x) => x.roleSource === 'ai-accepted').length,
      hiddenWithRole: m.objects.filter((x) => x.hidden).length,
      geometryChanged: m.objects.filter((x) => x.geometryChanged).length,
    },
    counts,
    unconfirmedCount: items.filter((i) => i.unconfirmed.length > 0).length,
    notice: NOTICE,
  };
  return complianceResultSchema.parse(result);
}
