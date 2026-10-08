// 넘겨줄 결과 '한계' (SPEC-15.5 1, ARCH-03 §8.6, PLAN-48 T-238): what the 법규 체크 jig reads from
// a 건축 가능 영역·매스 work copy — the site, every 규제 조건 item, the 미반영 조건, the forbidden plan
// band of each 2D rule (with the 구간 each region is measured from), and per envelope variant its
// height cap, 일조 금지 부피 and 최대 외피 — as `ComplianceLimits`. The values are the steps' own
// (site · regulations · plan · limits · envelope); only shapes are converted: cutters to plan
// rings, the 일조 pieces to their union, and the welded envelope mesh to triangles. No legal value
// is written here. It needs no chosen alternative (SPEC-15.5 2).

import type { Vec2 } from '../geometry-kit/plan.ts';
import { solidUnionAll, weldSolid, type SolidMesh } from '../geometry-kit/solid.ts';
import {
  complianceLimitsSchema,
  type ComplianceLimits,
  type Mesh,
  type RegulationItemData,
  type ZoneRule,
} from '../../../contracts/compliance.ts';
import { itemOf, numberOf, ruleOf, type RegulationItem, type RuleId } from './rules.ts';
import { cutterRing, sunCutPieces } from './setback.ts';
import {
  SQUARE_DATUM,
  type LimitsOutput,
  type PlanOutput,
  type RegulationsOutput,
  type SiteOutput,
} from './steps.ts';

/** The 2D rules of massing-kit and the check list's zone rule of each. */
const ZONE_OF: Partial<Record<RuleId, ZoneRule>> = {
  'road-setback': 'roadSetback',
  chamfer: 'chamfer',
  'limit-line': 'limitLine',
  'open-space-road': 'openSpaceRoad',
  'open-space-adjacent': 'openSpaceAdjacent',
  civil: 'civilSetback',
  other: 'otherSetback',
};

interface EnvelopeVariant {
  id: 'base' | 'without';
  height: number;
  sunApplied: boolean;
  envelopes: { kind: string; volume: number; check: { ok: boolean } }[];
  maxMesh: SolidMesh;
}
interface EnvelopeOutput {
  variants: EnvelopeVariant[];
  unresolved: { rule: RuleId; title: string; reason: string; target?: string }[];
}
interface AlternativesLike {
  alternatives: { id: string; title: string }[];
}

const cut = (text: string | undefined, n: number) => (text ?? '').slice(0, n);

/**
 * A welded mesh as contract triangles. Each loop is fanned from its centre point: a loop keeps the
 * T-junction corners the weld inserted (collinear on an edge), and a fan from a corner would make
 * zero-area triangles there that a reader drops, opening the mesh.
 */
export function meshTriangles(m: SolidMesh): Mesh {
  const v: number[] = [];
  const f: number[] = [];
  for (const p of m.v) v.push(p[0], p[1], p[2]);
  for (const loop of m.f) {
    if (loop.length < 3) continue;
    if (loop.length === 3) {
      f.push(loop[0], loop[1], loop[2]);
      continue;
    }
    const c = [0, 0, 0];
    for (const i of loop) for (let k = 0; k < 3; k++) c[k] += m.v[i][k] / loop.length;
    const centre = v.length / 3;
    v.push(c[0], c[1], c[2]);
    for (let k = 0; k < loop.length; k++) f.push(centre, loop[k], loop[(k + 1) % loop.length]);
  }
  return { v, f };
}

/** A 규제 조건 item in the contract's form (text cut to its limits; the value as it is). */
function itemData(i: RegulationItem): RegulationItemData {
  const value = Array.isArray(i.value)
    ? i.value.slice(0, 100).map((x) => cut(x, 100))
    : typeof i.value === 'string'
      ? cut(i.value, 200)
      : i.value;
  return {
    id: i.id,
    group: cut(i.group, 20),
    title: cut(i.title, 120),
    value,
    unit: cut(i.unit, 20),
    applies: i.applies,
    status: i.status,
    origin: i.origin,
    basis: i.basis
      ? {
          ...(i.basis.clause ? { clause: cut(i.basis.clause, 400) } : {}),
          ...(i.basis.link ? { link: cut(i.basis.link, 800) } : {}),
          ...(i.basis.note ? { note: cut(i.basis.note, 400) } : {}),
        }
      : null,
    source: cut(i.source, 200),
    ...(i.target ? { target: cut(i.target, 80) } : {}),
  };
}

/** The items the height cap of a variant came from (massing-kit `heightCap`), or null (검토 높이). */
function capItems(items: readonly RegulationItem[], height: number, withUndecided: boolean) {
  const usable = (i: RegulationItem) =>
    i.applies === '적용' || (withUndecided && i.applies === '판단 필요');
  const heights = (['heightMax', 'streetHeight', 'altitudeHeight'] as const)
    .map((id) => itemOf(items, id))
    .filter(usable)
    .map((i) => ({ id: i.id, value: numberOf(i) }))
    .filter((x): x is { id: typeof x.id; value: number } => x.value !== null);
  if (heights.length) {
    const low = heights.reduce((a, b) => (b.value < a.value ? b : a));
    return Math.abs(low.value - height) <= 1e-6 ? [low.id] : null;
  }
  const floors = itemOf(items, 'floorsMax');
  return usable(floors) && numberOf(floors) !== null ? ['floorsMax'] : null;
}

/** Where the site boundary was read from: the Link of the assembled `site.boundary` role. */
function frameLink(inputs: Record<string, unknown>): string | null {
  const boundary = ((inputs.site ?? {}) as Record<string, unknown>).boundary as
    | { sources?: { linkId?: unknown }[] }
    | undefined;
  const link = boundary?.sources?.[0]?.linkId;
  return typeof link === 'string' && link && !link.startsWith('sync:') ? link : null;
}

/** The site model's 공부 면적 when it differs from the drawn boundary's (SPEC-15.6 1). */
function otherArea(inputs: Record<string, unknown>, area: number): number | null {
  const summary = (inputs.siteModel as { value?: { officialArea_m2?: unknown } } | null | undefined)
    ?.value;
  const official = summary?.officialArea_m2;
  return typeof official === 'number' && official > 0 && Math.abs(official - area) > 1e-6
    ? official
    : null;
}

/** 넘겨줄 결과 '한계' of `vide/buildable-mass` (step `limitsHandoff`, output `limits`). */
export function limitsHandoffStep(
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
): ComplianceLimits {
  const steps = (inputs.steps ?? {}) as Record<string, unknown>;
  const site = steps.site as SiteOutput | undefined;
  const regs = steps.regulations as RegulationsOutput | undefined;
  const plan = steps.plan as PlanOutput | undefined;
  const limits = steps.limits as LimitsOutput | undefined;
  const envelope = steps.envelope as EnvelopeOutput | undefined;
  const alternatives = steps.alternatives as AlternativesLike | undefined;
  if (!site || !regs || !plan || !limits || !envelope)
    throw new Error('앞 단계(대지·규제 조건·계획·제한선·외피)의 결과가 없습니다');
  if (!(plan.floorHeightGround > 0) || !(plan.floorHeightTypical > 0))
    throw new Error('층고(1층·기준층)가 없습니다 — 계획 조건에서 넣으세요');
  const linkId = frameLink(inputs);
  const chosenId =
    typeof params.chosenAlternative === 'string' ? params.chosenAlternative : 'unset';
  const chosen =
    chosenId === 'unset'
      ? null
      : (alternatives?.alternatives.find((a) => a.id === chosenId)?.title ?? null);

  // 미반영 조건: rules the envelope ran without. Readings computed with an assumption (일조 거리의
  // 정의, near-square datum segments) were applied: they are the variants' 미확정 조건.
  const assumed = (u: { rule: RuleId; reason: string }) =>
    (u.rule === 'sun-slope' && /거리의 정의/.test(u.reason)) || SQUARE_DATUM.test(u.reason);
  const unapplied = envelope.unresolved
    .filter((u) => !assumed(u))
    .map((u) => ({
      id: cut(u.rule, 60),
      title: cut(u.title, 200),
      reason: cut(u.reason, 300),
      ...(u.target ? { segments: [cut(u.target, 60)] } : {}),
    }));
  const unconfirmed = [
    ...regs.unconfirmed.map((u) => cut(`${u.title} ${u.status}`, 200)),
    ...envelope.unresolved.filter(assumed).map((u) => cut(`${u.title}: ${u.reason}`, 200)),
  ];

  // The plan band of each 2D rule, each region with the 구간 it is measured from.
  const zones: ComplianceLimits['zones'] = [];
  for (const c of limits.cutters) {
    const rule = ZONE_OF[c.rule];
    if (!rule) continue;
    let zone = zones.find((z) => z.rule === rule);
    if (!zone) {
      zone = {
        rule,
        items: [...new Set(ruleOf(c.rule).reads)],
        regions: [],
        segments: [],
        regionSegments: [],
      };
      zones.push(zone);
    }
    const ring = cutterRing(c, limits.sides).map((p): Vec2 => [p[0], p[1]]);
    zone.regions.push({ outer: ring, holes: [] });
    zone.regionSegments!.push(cut(c.target, 60) || null);
    if (c.target && !zone.segments.includes(c.target)) zone.segments.push(cut(c.target, 60));
  }

  const variants = envelope.variants.map((v) => {
    const items = capItems(regs.items, v.height, v.id === 'base');
    const max = v.envelopes.find((e) => e.kind === 'max');
    let sunCut: Mesh | null = null;
    if (v.sunApplied && limits.sun) {
      const pieces = sunCutPieces(limits.sun, v.height + 1, limits.sides);
      if (pieces.length) sunCut = meshTriangles(weldSolid(solidUnionAll(pieces)));
    }
    return {
      id: v.id,
      heightCap: items ? { value: v.height, items } : null,
      sunCut,
      envelope: meshTriangles(v.maxMesh),
      envelopeVolume: Math.max(0, max?.volume ?? 0),
      unconfirmed: unconfirmed.slice(0, 400),
    };
  });

  const result: ComplianceLimits = {
    schema: 'vide.compliance.limits@1',
    frame: { linkId, documentKey: linkId, origin: [0, 0, 0], groundZ: 0 },
    site: {
      ring: site.ring.map((p): Vec2 => [p[0], p[1]]),
      area_m2: site.area_m2,
      areaSource: '그린 대지 경계(도구로 계산함)',
      otherArea_m2: otherArea(inputs, site.area_m2),
      northDeg: site.northDeg,
      northSource: cut(site.northSource, 120),
    },
    regulations: regs.items.map(itemData),
    unapplied,
    zones,
    variants,
    plan: {
      mainUse: plan.mainUse ? cut(plan.mainUse, 60) : null,
      floorHeightGround: plan.floorHeightGround,
      floorHeightTypical: plan.floorHeightTypical,
      chosenOption: chosen ? cut(chosen, 120) : null,
    },
  };
  return complianceLimitsSchema.parse(result);
}
