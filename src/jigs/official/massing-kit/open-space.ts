// 공개공지 (SPEC-12.10 5, PLAN-45 T-211): the required area from the 규제 조건 item (비율 × 대지면적,
// the item's own meaning), the candidate regions — drawn by a person, or a parallelogram at a site
// corner on a road sized to the required area — and their table. Whether the site must provide
// one, the ratio, and the incentive are 규제 조건 values; nothing here decides them. Where a
// candidate may stand (setback strips, the share of the road front …) is a legal reading the
// table does not make: it shows area against the required area only.

import { signedArea, type Polygon, type Vec2 } from '../geometry-kit/plan.ts';
import type { Corner, BoundarySegment } from './boundary-segments.ts';
import { intersectRegions, regionsArea } from './floors.ts';
import { itemOf, numberOf, type RegulationItem } from './rules.ts';
import type { PlanRegion } from './setback.ts';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export interface OpenSpaceRequirement {
  /** 'required': the item applies with a ratio; 'none': 미적용; 'needs-input': nobody entered it. */
  state: 'required' | 'none' | 'needs-input';
  ratio: number | null;
  required: number | null;
  /** True when the item is '판단 필요' (the area is shown, the result is 미확정). */
  undecided: boolean;
  message: string;
}

/** 필요 면적 = 공개공지 비율 × 대지면적 (SPEC-12.12 2 and 12.10 5). */
export function openSpaceRequirement(
  items: readonly RegulationItem[],
  siteArea: number,
): OpenSpaceRequirement {
  const item = itemOf(items, 'publicOpenSpace');
  if (item.applies === '미적용')
    return {
      state: 'none',
      ratio: null,
      required: null,
      undecided: false,
      message: '공개공지 대상 아님(미적용)',
    };
  const ratio = numberOf(item);
  if (ratio === null)
    return {
      state: 'needs-input',
      ratio: null,
      required: null,
      undecided: item.applies === '판단 필요',
      message: `${item.title} 사람 입력 필요`,
    };
  return {
    state: 'required',
    ratio,
    required: r6(ratio * siteArea),
    undecided: item.applies === '판단 필요',
    message:
      item.applies === '판단 필요'
        ? `필요 면적 ${r6(ratio * siteArea)} ㎡ (대상 여부 판단 필요)`
        : `필요 면적 ${r6(ratio * siteArea)} ㎡`,
  };
}

export interface OpenSpaceCandidate {
  no: number;
  id: string;
  source: '그린 영역' | '대지 모서리 후보';
  regions: PlanRegion[];
  area: number;
  required: number | null;
  verdict: '충족' | '부족' | '필요 면적 없음';
  /** 공개공지 관련 완화량 (규제 조건 값, 그대로). */
  incentive: number | null;
  incentiveText: string;
  note: string;
}

const unit = (a: Vec2, b: Vec2): Vec2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};

/**
 * A corner candidate: the parallelogram spanned from a convex site corner along its two edges,
 * with equal sides s so that s² · sin θ = the required area, clipped to the site. When an edge is
 * shorter than s the side stops at the edge's end and the note says so.
 */
function cornerCandidate(
  corner: Corner,
  before: BoundarySegment,
  after: BoundarySegment,
  required: number,
  site: Polygon,
): { regions: PlanRegion[]; note: string } | null {
  const u = unit(corner.at, before.a),
    v = unit(corner.at, after.b);
  const sin = Math.abs(u[0] * v[1] - u[1] * v[0]);
  if (!(sin > 1e-6)) return null;
  const s = Math.sqrt(required / sin);
  const su = Math.min(s, before.length),
    sv = Math.min(s, after.length);
  const at = corner.at;
  const ring: Polygon = [
    at,
    [at[0] + v[0] * sv, at[1] + v[1] * sv],
    [at[0] + v[0] * sv + u[0] * su, at[1] + v[1] * sv + u[1] * su],
    [at[0] + u[0] * su, at[1] + u[1] * su],
  ];
  const outer = signedArea(ring) < 0 ? [...ring].reverse() : ring;
  const regions = intersectRegions([{ outer, holes: [] }], [{ outer: site, holes: [] }]);
  const notes: string[] = [];
  if (su < s - 1e-9 || sv < s - 1e-9) notes.push('변이 짧아 변 끝까지만');
  return { regions, note: notes.join(', ') };
}

export interface SiteShape {
  ring: Polygon;
  segments: BoundarySegment[];
  corners: Corner[];
}

/**
 * Candidates (SPEC-12.10 5): every drawn region first, then a corner candidate at each convex corner
 * that touches a road segment (only when a required area is known).
 */
export function openSpaceCandidates(
  site: SiteShape,
  drawn: { id: string; ring: Polygon }[],
  requirement: OpenSpaceRequirement,
  items: readonly RegulationItem[],
): OpenSpaceCandidate[] {
  const incentiveItem = itemOf(items, 'openSpaceIncentiveFar');
  const incentive = incentiveItem.applies === '미적용' ? null : numberOf(incentiveItem);
  const incentiveText =
    incentiveItem.applies === '미적용'
      ? '미적용'
      : incentive === null
        ? '사람 입력 필요'
        : `${r6(incentive)}${incentiveItem.applies === '판단 필요' ? ' (조건 미확정)' : ''}`;
  const required = requirement.required;
  const out: OpenSpaceCandidate[] = [];
  const push = (
    id: string,
    source: OpenSpaceCandidate['source'],
    regions: PlanRegion[],
    note: string,
  ) => {
    const area = r6(regionsArea(regions));
    out.push({
      no: out.length + 1,
      id,
      source,
      regions,
      area,
      required,
      verdict: required === null ? '필요 면적 없음' : area >= required - 1e-6 ? '충족' : '부족',
      incentive,
      incentiveText,
      note,
    });
  };
  for (const d of drawn) {
    const clipped = intersectRegions(
      [{ outer: signedArea(d.ring) < 0 ? [...d.ring].reverse() : d.ring, holes: [] }],
      [{ outer: site.ring, holes: [] }],
    );
    const outside = Math.abs(signedArea(d.ring)) - regionsArea(clipped);
    push(d.id, '그린 영역', clipped, outside > 1e-6 ? `대지 밖 ${r6(outside)} ㎡는 뺌` : '');
  }
  if (required !== null && required > 0) {
    const order = new Map(site.segments.map((s, i) => [s.id, i]));
    for (const corner of site.corners) {
      if (!(corner.angleDeg < 180 - 1e-6)) continue;
      const before = site.segments[order.get(corner.before)!],
        after = site.segments[order.get(corner.after)!];
      if (before.kind !== 'road' && after.kind !== 'road') continue;
      const made = cornerCandidate(corner, before, after, required, site.ring);
      if (made && made.regions.length)
        push(`corner:${corner.id}`, '대지 모서리 후보', made.regions, made.note);
    }
  }
  return out;
}

/** The candidate an alternative uses: row `pick` (1-based), or 0 = the first drawn, else the first corner that meets the area. */
export function pickCandidate(candidates: readonly OpenSpaceCandidate[], pick: number) {
  if (pick > 0) return candidates.find((c) => c.no === Math.floor(pick)) ?? null;
  return (
    candidates.find((c) => c.source === '그린 영역') ??
    candidates.find((c) => c.verdict === '충족') ??
    null
  );
}
