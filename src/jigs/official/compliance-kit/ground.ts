// 기준 지반과 층 (SPEC-15.6 3, SPEC-15.3 4, SPEC-15.5 5, PLAN-48 T-238): the 기준 지반 cases (the
// person's value, else the site model's lowest and highest candidate), the shift that moves the
// massing work copy's forbidden volumes from `frame.groundZ` to each case, and the floor table of a
// case — named floors as named, unnamed outlines by height from that case's ground.

import type {
  ClassifiedObject,
  ComplianceLimits,
  ComplianceOverride,
  ComplianceSettings,
  GroundDatum,
  NumberSource,
} from '../../../contracts/compliance.ts';
import { unionArea } from '../massing-kit/floors.ts';
import { LEVEL_TOL, midSectionArea, prepareMesh, type PreparedSolid } from './geometry.ts';

export interface GroundCase {
  key: 'ground:value' | 'ground:min' | 'ground:max';
  label: string;
  /** Document z (m). */
  doc: number;
  /** Local z of the massing frame (doc − origin z). */
  local: number;
  /** How far the forbidden volumes move (local − frame.groundZ). */
  shift: number;
}

export function groundCases(
  ground: GroundDatum,
  settings: ComplianceSettings,
  limits: ComplianceLimits | null,
): { cases: GroundCase[]; numbers: NumberSource[] } {
  const oz = limits?.frame.origin[2] ?? 0;
  const gz = limits?.frame.groundZ ?? 0;
  const make = (key: GroundCase['key'], label: string, doc: number): GroundCase => ({
    key,
    label,
    doc,
    local: doc - oz,
    shift: doc - oz - gz,
  });
  const value = ground.value ?? settings.groundLevel;
  if (value !== null) {
    const basis = ground.basis ?? settings.groundBasis;
    return {
      cases: [make('ground:value', '기준 지반(사람 입력)', value)],
      numbers: [
        {
          label: '기준 지반 높이',
          value,
          unit: 'm',
          kind: '사람 입력',
          ref: 'setting:groundLevel',
          note: (basis?.trim() || '근거 없음').slice(0, 300),
        },
      ],
    };
  }
  const c = ground.candidate;
  if (!c) return { cases: [], numbers: [] };
  const note = `${c.source} · 도구로 계산함`.slice(0, 300);
  const numbers: NumberSource[] = [
    {
      label: '기준 지반 후보 최저',
      value: c.min,
      unit: 'm',
      kind: '계산',
      ref: 'ground:min',
      note,
    },
    {
      label: '기준 지반 후보 최고',
      value: c.max,
      unit: 'm',
      kind: '계산',
      ref: 'ground:max',
      note,
    },
    {
      label: '기준 지반 후보 평균(보이기만 함)',
      value: c.mean,
      unit: 'm',
      kind: '계산',
      ref: 'ground:mean',
      note,
    },
  ];
  if (c.max - c.min <= LEVEL_TOL / 10)
    return { cases: [make('ground:min', '기준 지반 후보', c.min)], numbers };
  return {
    cases: [
      make('ground:min', '기준 지반 최저 후보', c.min),
      make('ground:max', '기준 지반 최고 후보', c.max),
    ],
    numbers,
  };
}

// ── 층 ──────────────────────────────────────────────────────────────────────────────────────────

export interface FloorEntry {
  label: string;
  /** 1, 2, … above ground; −1, −2, … below. */
  index: number;
  above: boolean;
  area: number;
  /** Distinct floor heights inside the floor (more than one = 중층·복층). */
  levels: number[];
  objectIds: string[];
  use: string | null;
  useSource: string;
  /** Labelled by height (도구로 계산함). */
  byHeight: boolean;
}

export interface FloorTable {
  /** The ground case the unnamed outlines were labelled from (null = every outline is named). */
  ground: GroundCase | null;
  floors: FloorEntry[];
  /**
   * Unnamed outlines whose height order gives a floor name that a named floor at another height
   * already has: left out of every floor and reported (the rows reading floors are 판단 필요).
   */
  unlabelled: string[];
}

const labelIndex = (label: string) =>
  label.startsWith('B') ? -Number(label.slice(1)) : Number(label.slice(0, -1));

/** Base height of a floor object (region height, or the solid's lowest point). */
export function baseOf(o: ClassifiedObject, solid?: PreparedSolid): number | null {
  if (o.shape.kind === 'region') return o.shape.z;
  if (o.shape.kind === 'solid') return (solid ?? prepareMesh(o.shape.mesh)).box.min[2];
  return null;
}

/** Group heights within LEVEL_TOL. */
export function levelsOf(zs: readonly number[]): number[] {
  const out: number[] = [];
  for (const z of [...zs].sort((a, b) => a - b))
    if (!out.length || z - out[out.length - 1] > LEVEL_TOL) out.push(z);
  return out;
}

/**
 * The floor table of one ground case (SPEC-15.3 4, 15.6 5): each floor's area is the union of its
 * outlines at one height (a solid: its mid-height section), outlines of one name at different
 * heights are added; the use is `vide-use`/record → the person's 층 용도 수정 사항 → 주용도.
 */
export function floorTable(
  floors: readonly ClassifiedObject[],
  solids: ReadonlyMap<string, PreparedSolid>,
  ground: GroundCase | null,
  overrides: readonly ComplianceOverride[],
  mainUse: string | null,
): FloorTable {
  const byLabel = new Map<string, { objs: ClassifiedObject[]; byHeight: boolean }>();
  const add = (label: string, o: ClassifiedObject, byHeight: boolean) => {
    const e = byLabel.get(label) ?? byLabel.set(label, { objs: [], byHeight }).get(label)!;
    e.objs.push(o);
    e.byHeight ||= byHeight;
  };
  const unlabelled: string[] = [];
  const unnamed = floors.filter((o) => !o.floor);
  const named = floors.filter((o) => o.floor);
  for (const o of named) add(o.floor!, o, false);
  if (ground && unnamed.length) {
    // Heights of the named floors (each name at its lowest level) and of the unnamed outlines,
    // ordered together: an unnamed outline at a named floor's height takes that name; any other
    // gets its place in the order (1F, 2F … up from the ground, B1, B2 … down), unless a named
    // floor at another height already has that name (SPEC-15.3 4).
    const zOf = (o: ClassifiedObject) => baseOf(o, solids.get(o.objectId)) ?? 0;
    const namedAt = new Map<string, number>();
    for (const o of named) {
      const z = zOf(o);
      const label = o.floor!;
      if (!namedAt.has(label) || z < namedAt.get(label)!) namedAt.set(label, z);
    }
    const sameLevel = (a: number, b: number) => Math.abs(a - b) <= LEVEL_TOL;
    const isAbove = (z: number) => z >= ground.local - LEVEL_TOL;
    const levels = (above: boolean) => {
      const zs = [
        ...unnamed.map(zOf).filter((z) => isAbove(z) === above),
        ...[...namedAt].filter(([label]) => !label.startsWith('B') === above).map(([, z]) => z),
      ];
      return above ? levelsOf(zs) : levelsOf(zs).reverse();
    };
    const above = levels(true);
    const below = levels(false);
    for (const o of unnamed) {
      const z = zOf(o);
      const match = [...namedAt].find(([, at]) => sameLevel(at, z));
      if (match) {
        add(match[0], o, true);
        continue;
      }
      const list = isAbove(z) ? above : below;
      const i = list.findIndex((l) => sameLevel(l, z));
      const label = isAbove(z) ? `${i + 1}F` : `B${i + 1}`;
      if (i < 0 || namedAt.has(label)) unlabelled.push(o.objectId);
      else add(label, o, true);
    }
  }
  const useOverride = new Map<string, string>();
  for (const o of [...overrides].sort((a, b) => a.id.localeCompare(b.id)))
    if (o.kind === 'use-floor' && !useOverride.has(o.floor)) useOverride.set(o.floor, o.use.trim());
  const out: FloorEntry[] = [];
  for (const [label, { objs, byHeight }] of byLabel) {
    const sorted = [...objs].sort((a, b) => a.objectId.localeCompare(b.objectId));
    const zs = sorted.map((o) => baseOf(o, solids.get(o.objectId)) ?? 0);
    const levels = levelsOf(zs);
    let area = 0;
    for (const level of levels) {
      const at = sorted.filter((_, i) => Math.abs(zs[i] - level) <= LEVEL_TOL);
      const regions = at.flatMap((o) => (o.shape.kind === 'region' ? [o.shape.region] : []));
      area += regions.length ? unionArea([regions]) : 0;
      for (const o of at)
        if (o.shape.kind === 'solid') {
          const s = solids.get(o.objectId);
          if (s?.ok) area += midSectionArea(s);
        }
    }
    const uses = sorted.map((o) => o.use?.trim()).filter((u): u is string => !!u);
    const counts = new Map<string, number>();
    for (const u of uses) counts.set(u, (counts.get(u) ?? 0) + 1);
    const modelUse = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    const use = modelUse ?? useOverride.get(label) ?? mainUse?.trim() ?? null;
    out.push({
      label,
      index: labelIndex(label),
      above: !label.startsWith('B'),
      area,
      levels,
      objectIds: sorted.map((o) => o.objectId),
      use: use || null,
      useSource: modelUse
        ? '모델(용도 속성·분류 기록)'
        : useOverride.has(label)
          ? '사람 입력(층 용도)'
          : use
            ? '매스 작업본의 주용도'
            : '없음',
      byHeight,
    });
  }
  out.sort((a, b) => b.index - a.index);
  return {
    ground: ground && unnamed.length ? ground : null,
    floors: out,
    unlabelled: unlabelled.sort(),
  };
}
