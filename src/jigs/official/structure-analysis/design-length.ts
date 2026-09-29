// Design lengths per analysis segment from the physical (design) member (SPEC-06.6, RESEARCH-10
// §10.1). The core multiplies K by the segment length and reads Lb as given, so every segment of a
// physical member gets K = K_eff × L_reference / L_segment and Lb measured on the physical member.
// Nothing here changes the Rust core; the values travel in `members[].design`.

import type { EndCondition } from './frame-plan.ts';

export interface DesignValues {
  Lb_m: number;
  K2: number;
  K3: number;
  Cb: number;
}

export interface MemberDesign {
  /** One entry per segment, in the segment order given. */
  segments: DesignValues[];
  /** Reference values of the whole member: the longest segment Lb and the effective-length factor. */
  Lb_m: number;
  K: number;
  notes: string[];
}

export interface BeamDesignInput {
  /** Segment lengths in order from the first end (m). */
  segments: { length_m: number }[];
  ends: [EndCondition, EndCondition];
  /** Top-flange lateral braces (secondary beam joints) as fractions of the member length. */
  bracedAt?: number[];
  /** Negative-moment zones at rigid ends as fractions; unknown = the whole length (conservative). */
  negativeZones?: [number, number][];
  cantilever?: boolean;
  /** User overrides: unbraced length for every segment, effective-length factors, Cb. */
  Lb_m?: number;
  K?: { K2?: number; K3?: number };
  Cb?: number;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.min(a1, b1) - Math.max(a0, b0) > 1e-9;
/** Design values are rounded so the same plan hashes to the same model. */
const r9 = (v: number) => Number(v.toFixed(9));

/** Beams, girders, edge beams and arms. */
export function designForBeam(input: BeamDesignInput): MemberDesign {
  const notes: string[] = [];
  const lengths = input.segments.map((s) => s.length_m);
  const L = lengths.reduce((s, v) => s + v, 0);
  if (!(L > 0)) throw Object.assign(new Error('member length is zero'), { code: 'INVALID_INPUT' });
  const bounds: [number, number][] = [];
  let at = 0;
  for (const l of lengths) {
    bounds.push([at / L, (at + l) / L]);
    at += l;
  }
  const cantilever = !!input.cantilever;
  const rigid = input.ends.includes('rigid');
  // Intervals whose length bounds the positive-moment unbraced length (deck braces the top flange).
  const braced = cantilever
    ? [0, 1]
    : [
        0,
        ...(input.bracedAt ?? []).filter((f) => f > 1e-6 && f < 1 - 1e-6).sort((u, v) => u - v),
        1,
      ];
  const intervals: [number, number][] = [];
  for (let k = 1; k < braced.length; k++)
    if (braced[k] - braced[k - 1] > 1e-9) intervals.push([braced[k - 1], braced[k]]);
  let zones: [number, number][] = [];
  if (cantilever) {
    zones = [[0, 1]];
    notes.push('캔틸레버: 비지지 길이 = 전 길이, K = 2.0 가정');
  } else if (rigid && !input.negativeZones) {
    zones = [[0, 1]];
    notes.push('강접 단부의 부모멘트 구간 미지정 → 비지지 길이 = 지지점 사이 전 길이(보수적)');
  } else if (rigid) {
    zones = input.negativeZones!.map(([a, b]) => [Math.max(0, a), Math.min(1, b)]);
    notes.push('부모멘트 구간은 지정한 변곡점까지를 비지지 길이로 봄');
  }
  if (!cantilever && intervals.length > 1)
    notes.push('정모멘트 구간의 비지지 길이 = 횡지지(작은보) 간격');
  const K3eff = input.K?.K3 ?? (cantilever ? 2.0 : 1.0);
  const K2eff = input.K?.K2 ?? K3eff;
  const Cb = input.Cb ?? 1.0;
  const segments = bounds.map(([s0, s1], k) => {
    let Lb = 0;
    for (const [a, b] of intervals) if (overlap(a, b, s0, s1)) Lb = Math.max(Lb, (b - a) * L);
    for (const [a, b] of zones) if (overlap(a, b, s0, s1)) Lb = Math.max(Lb, (b - a) * L);
    if (input.Lb_m) Lb = input.Lb_m;
    if (!(Lb > 0)) Lb = L;
    const Lseg = lengths[k];
    return { Lb_m: r9(Lb), K2: r9((K2eff * Lb) / Lseg), K3: r9((K3eff * L) / Lseg), Cb };
  });
  return { segments, Lb_m: Math.max(...segments.map((s) => s.Lb_m)), K: K3eff, notes };
}

export interface ColumnDesignInput {
  /** Segment bounds from the base upward (m, global Z). */
  segments: { z0_m: number; z1_m: number }[];
  /** Heights of the lateral restraint nodes on this column (m). */
  restraintZ_m: number[];
  /** Effective-length factor of the sway zone above the highest restraint. */
  swayK: number;
  K?: { K2?: number; K3?: number };
  Lb_m?: number;
}

/** Columns: braced zones between restraints (K 1.0), the zone above the last restraint sways. */
export function designForColumn(input: ColumnDesignInput): MemberDesign {
  const notes: string[] = [];
  if (!input.segments.length)
    throw Object.assign(new Error('column has no segments'), { code: 'INVALID_INPUT' });
  const base = input.segments[0].z0_m;
  const top = input.segments[input.segments.length - 1].z1_m;
  const eps = 1e-6;
  const levels = [
    ...new Set(input.restraintZ_m.filter((z) => z > base + eps && z < top - eps)),
  ].sort((u, v) => u - v);
  const restrainedTop = input.restraintZ_m.some((z) => Math.abs(z - top) <= eps);
  const boundaries = [base, ...levels, top];
  const highest = restrainedTop ? top : levels.length ? levels[levels.length - 1] : base;
  const sways = !restrainedTop;
  if (sways)
    notes.push(
      levels.length || restrainedTop
        ? `구속 레벨 위 구간은 흔들림 골조(K = ${input.swayK}) 가정`
        : `수평 구속 없음: 기둥 전 길이를 흔들림 골조(K = ${input.swayK})로 봄(가정)`,
    );
  const segments = input.segments.map((seg) => {
    const mid = (seg.z0_m + seg.z1_m) / 2;
    let z0 = base,
      z1 = top;
    for (let k = 1; k < boundaries.length; k++)
      if (mid >= boundaries[k - 1] - eps && mid <= boundaries[k] + eps) {
        z0 = boundaries[k - 1];
        z1 = boundaries[k];
        break;
      }
    const Lzone = Math.max(z1 - z0, eps);
    const Lseg = Math.max(seg.z1_m - seg.z0_m, eps);
    const sway = sways && z0 >= highest - eps;
    const K3eff = input.K?.K3 ?? (sway ? input.swayK : 1.0);
    const K2eff = input.K?.K2 ?? K3eff;
    const Lb = input.Lb_m ?? Lzone;
    return {
      Lb_m: r9(Lb),
      K2: r9((K2eff * Lzone) / Lseg),
      K3: r9((K3eff * Lzone) / Lseg),
      Cb: 1.0,
    };
  });
  const K = input.K?.K3 ?? (sways ? input.swayK : 1.0);
  return { segments, Lb_m: Math.max(...segments.map((s) => s.Lb_m)), K, notes };
}
