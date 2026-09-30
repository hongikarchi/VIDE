// S-06 frame jig ⑤ 거더 — drawn mode (PLAN-23 T-053, M2 머리말 2026-09-30, SPEC-06.11 3·5): the
// girder curves a person drew are read and corrected, not generated. Each end is snapped in plan to
// the nearest drawn column top within `snapTol_m` (z of the girder kept), the curve is cut at every
// column top it passes, duplicate or overlapping collinear pieces within `mergeTol_m` become one,
// ends with no column are listed as dangling, crossings of the slab edge and voids are listed, and a
// polyline bent more than `arcSagitta_m` off its chord becomes a single-curvature arc (a plan arc or
// a vertical-plane ramp/arch). Spans between columns are judged against `spanMax_m` in plan.
// Pure: (inputs, params) → JSON output, metres, no node: imports.

import {
  GeometryError,
  arcPoint,
  arcThrough,
  fitArc,
  segmentArc,
  splitAtSupports,
  verticalArc,
  type Arc,
  type Vec2,
  type Vec3,
} from '../../../../src/jigs/official/geometry-kit/index.ts';
import { nameOf, polylineOf, slabOf, type SiteInput, type SiteRow } from './roles.ts';

export interface GirdersInputs {
  site: SiteInput;
}
export interface GirdersParams {
  /** A girder end within this plan distance of a column top is moved onto it (m). */
  snapTol_m: number;
  /** Pieces this close (3D) are the same line; overlaps shorter than this are touches (m). */
  mergeTol_m: number;
  /** A polyline farther than this from its chord is a curve and gets an arc (m). */
  arcSagitta_m: number;
  /** Span limit in plan (m); the jig setting `spanMax` is read when this is not given. */
  spanMax_m: number;
  /** A column top counts for a girder only when its z is within this of the girder (m). */
  zTol_m: number;
}
export const DEFAULT_GIRDERS_PARAMS: GirdersParams = {
  snapTol_m: 0.3,
  mergeTol_m: 0.05,
  arcSagitta_m: 0.05,
  spanMax_m: 12,
  zTol_m: 2.0,
};

export interface GirderArc {
  center: Vec3;
  radius: number;
  /**
   * Angles in the arc's plane: `plan` from +X counter-clockwise; `vertical` from the plan direction
   * start → end towards +Z. `endDeg = startDeg + sweepDeg`.
   */
  startDeg: number;
  endDeg: number;
  sweepDeg: number;
  /**
   * Rise of the arc's middle over the chord (m). Vertical: in z, positive = hog. Plan: the
   * sagitta, positive when the arc bulges to the right of start → end.
   */
  rise: number;
  plane: 'vertical' | 'plan';
}
export interface GirderSupport {
  columnId: string;
  /** Fraction of the girder's plan length from its first point (see `pointAt`). */
  t: number;
}
export interface GirderRow {
  id: string;
  sourceId: string;
  /** Other drawn curves merged into this one (duplicates, overlapping collinear pieces). */
  mergedFrom?: string[];
  name?: string;
  points: Vec3[];
  kind: 'line' | 'arc';
  arc?: GirderArc;
  supports: GirderSupport[];
  snapped: { end: 'start' | 'end'; columnId: string; moved_m: number }[];
  length_m: number;
  planLength_m: number;
  /** One line for the correction table (panel): what was changed on this girder. */
  note: string;
}
export interface DanglingRow {
  girderId: string;
  end: 'start' | 'end';
  nearestColumnId?: string;
  distance_m: number | null;
}
export interface CrossingRow {
  girderId: string;
  boundary: 'slab' | 'void';
  at: Vec2;
}
export interface SpanRow {
  girderId: string;
  from: string;
  to: string;
  length_m: number;
  planLength_m: number;
  over: boolean;
}
export interface ColumnRef {
  id: string;
  sourceId: string;
  bottom: Vec3;
  top: Vec3;
}
export interface GirdersOutput {
  schema: 'vide.s06.girders/1';
  params: GirdersParams;
  girders: GirderRow[];
  columns: ColumnRef[];
  dangling: DanglingRow[];
  /** The free ends as points (panel overlay), same order as `dangling`. */
  danglingAt: { girderId: string; end: 'start' | 'end'; at: Vec3 }[];
  crossings: CrossingRow[];
  spans: SpanRow[];
  summary: { girders: number; snapped: number; dangling: number; spansOver: number };
  notes: string[];
}

// --- small helpers ---------------------------------------------------------------------------------

const round = (value: number, step = 1e-4) => Math.round(value / step) * step;
const r4 = (value: number) => Number(round(value).toFixed(4));
const p3 = (p: readonly number[]): Vec3 => [r4(p[0]), r4(p[1]), r4(p[2])];
const key2 = (prefix: string, n: number) => prefix + String(n).padStart(2, '0');
const mm = (value: number) => Math.round(value * 1000);
const planOrder = (a: readonly number[], b: readonly number[]) =>
  mm(a[0]) - mm(b[0]) || mm(a[1]) - mm(b[1]);
const planDistance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const deg = (radians: number) => (radians * 180) / Math.PI;

/** 3D distance of `p` from the segment a–b. */
function segmentDistance3(p: readonly number[], a: readonly number[], b: readonly number[]) {
  const d = sub(b, a);
  const length2 = dot(d, d);
  let t = length2 > 0 ? dot(sub(p, a), d) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return norm(sub(p, [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]));
}
/** Largest 3D distance of the polyline's points from its chord. */
function chordDeviation(points: readonly Vec3[]) {
  const a = points[0],
    b = points[points.length - 1];
  let out = 0;
  for (const p of points) out = Math.max(out, segmentDistance3(p, a, b));
  return out;
}
function planLengthOf(points: readonly Vec3[]) {
  let out = 0;
  for (let i = 1; i < points.length; i++) out += planDistance(points[i], points[i - 1]);
  return out;
}
function lengthOf(points: readonly Vec3[]) {
  let out = 0;
  for (let i = 1; i < points.length; i++) out += norm(sub(points[i], points[i - 1]));
  return out;
}

/** The point at plan-length fraction `t` of a girder (the `t` of supports and beam ends). */
export function pointAt(points: readonly Vec3[], t: number): Vec3 {
  const total = planLengthOf(points);
  if (!(total > 0)) return [...points[0]] as Vec3;
  let left = Math.min(Math.max(t, 0), 1) * total;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const d = planDistance(a, b);
    if (left <= d || i === points.length - 1) {
      const u = d > 0 ? Math.min(left / d, 1) : 0;
      return [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), a[2] + u * (b[2] - a[2])];
    }
    left -= d;
  }
  return [...points[points.length - 1]] as Vec3;
}

function resolveParams(params: Record<string, unknown>): GirdersParams {
  const out = { ...DEFAULT_GIRDERS_PARAMS };
  for (const key of Object.keys(DEFAULT_GIRDERS_PARAMS) as (keyof GirdersParams)[])
    if (params[key] !== undefined) out[key] = params[key] as number;
  if (params.spanMax_m === undefined && params.spanMax !== undefined)
    out.spanMax_m = params.spanMax as number;
  for (const key of Object.keys(out) as (keyof GirdersParams)[])
    if (!Number.isFinite(out[key]) || out[key] < 0)
      throw new RangeError(`${key} ${String(out[key])}`);
  if (!(out.spanMax_m > 0)) throw new RangeError(`spanMax_m ${out.spanMax_m}`);
  return out;
}

// --- reading ---------------------------------------------------------------------------------------

interface Drawn {
  sourceId: string;
  mergedFrom: string[];
  name?: string;
  points: Vec3[];
  straight: boolean;
}

const idOf = (row: SiteRow, index: number) =>
  row.id === undefined || row.id === null ? `#${index}` : String(row.id);

function readColumns(site: SiteInput, notes: string[]): ColumnRef[] {
  const out: ColumnRef[] = [];
  let skipped = 0;
  (site.columns?.rows ?? []).forEach((row, index) => {
    const points = row && typeof row === 'object' ? polylineOf(row) : null;
    if (!points) {
      skipped++;
      return;
    }
    // Drawn either way: bottom = lowest point, top = highest.
    let bottom = points[0],
      top = points[0];
    for (const q of points) {
      if (q[2] < bottom[2]) bottom = q;
      if (q[2] > top[2]) top = q;
    }
    out.push({ id: '', sourceId: idOf(row, index), bottom: p3(bottom), top: p3(top) });
  });
  if (skipped) notes.push(`기둥 레이어에서 곡선이 아닌 객체 ${skipped}개는 뺐습니다.`);
  out.sort((a, b) => planOrder(a.top, b.top) || a.sourceId.localeCompare(b.sourceId));
  out.forEach((c, k) => (c.id = key2('C', k + 1)));
  return out;
}

function readGirders(site: SiteInput, p: GirdersParams, notes: string[]): Drawn[] {
  const out: Drawn[] = [];
  let skipped = 0,
    vertical = 0;
  (site.girders?.rows ?? []).forEach((row, index) => {
    const raw = row && typeof row === 'object' ? polylineOf(row) : null;
    if (!raw) {
      skipped++;
      return;
    }
    // Drop repeated points; a curve with no plan length is not a girder.
    const points: Vec3[] = [raw[0]];
    for (const q of raw.slice(1))
      if (norm(sub(q, points[points.length - 1])) > 1e-9) points.push(q);
    if (points.length < 2 || planLengthOf(points) <= p.mergeTol_m) {
      vertical++;
      return;
    }
    const straight = points.length === 2 || chordDeviation(points) <= p.arcSagitta_m;
    const name = nameOf(row);
    out.push({
      sourceId: idOf(row, index),
      mergedFrom: [],
      ...(name ? { name } : {}),
      points: straight ? [points[0], points[points.length - 1]] : points,
      straight,
    });
  });
  if (skipped) notes.push(`거더 레이어에서 곡선이 아닌 객체 ${skipped}개는 뺐습니다.`);
  if (vertical) notes.push(`평면 길이가 없는 거더 곡선 ${vertical}개는 뺐습니다.`);
  return out;
}

// --- merging ---------------------------------------------------------------------------------------

/** Two straight pieces on one line (3D, within tol) that overlap by more than tol → their union. */
function mergeStraight(a: Drawn, b: Drawn, tol: number): Vec3[] | null {
  const [a0, a1] = a.points;
  const d = sub(a1, a0);
  const length = norm(d);
  const u: Vec3 = [d[0] / length, d[1] / length, d[2] / length];
  const along = (p: Vec3) => dot(sub(p, a0), u);
  const offLine = (p: Vec3) => {
    const s = along(p);
    return norm(sub(p, [a0[0] + s * u[0], a0[1] + s * u[1], a0[2] + s * u[2]]));
  };
  const [b0, b1] = b.points;
  if (offLine(b0) > tol || offLine(b1) > tol) return null;
  const sb0 = along(b0),
    sb1 = along(b1);
  const lo = Math.max(0, Math.min(sb0, sb1)),
    hi = Math.min(length, Math.max(sb0, sb1));
  if (hi - lo <= tol) return null;
  const s0 = Math.min(0, sb0, sb1),
    s1 = Math.max(length, sb0, sb1);
  const at = (s: number): Vec3 =>
    s === 0 ? a0 : s === length ? a1 : [a0[0] + s * u[0], a0[1] + s * u[1], a0[2] + s * u[2]];
  return [at(s0), at(s1)];
}
/** A curve that lies along another (every point within tol, ends matching either way). */
function duplicateCurve(a: Drawn, b: Drawn, tol: number) {
  const ea = [a.points[0], a.points[a.points.length - 1]];
  const eb = [b.points[0], b.points[b.points.length - 1]];
  const ends =
    (norm(sub(ea[0], eb[0])) <= tol && norm(sub(ea[1], eb[1])) <= tol) ||
    (norm(sub(ea[0], eb[1])) <= tol && norm(sub(ea[1], eb[0])) <= tol);
  if (!ends) return false;
  const near = (p: Vec3, q: Drawn) => {
    for (let i = 1; i < q.points.length; i++)
      if (segmentDistance3(p, q.points[i - 1], q.points[i]) <= tol) return true;
    return false;
  };
  return a.points.every((p) => near(p, b)) && b.points.every((p) => near(p, a));
}

function mergeDrawn(drawn: Drawn[], tol: number): { kept: Drawn[]; merged: number } {
  const list = [...drawn].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  let merged = 0;
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i],
          b = list[j];
        let union: Vec3[] | null = null;
        if (a.straight && b.straight) union = mergeStraight(a, b, tol);
        else if (!a.straight && !b.straight && duplicateCurve(a, b, tol)) union = a.points;
        if (!union) continue;
        list[i] = {
          ...a,
          points: union,
          mergedFrom: [...a.mergedFrom, b.sourceId, ...b.mergedFrom],
        };
        list.splice(j, 1);
        merged++;
        changed = true;
        break outer;
      }
  }
  return { kept: list, merged };
}

// --- arcs ------------------------------------------------------------------------------------------

function arcOf(fit: Arc, start: Vec3, end: Vec3): { arc: Arc; plane: 'vertical' | 'plan' } | null {
  const nz = Math.abs(fit.normal[2]);
  if (nz <= 0.01) {
    // Vertical-plane ramp or arch: keep its rise in z over the (snapped) chord's middle.
    const mid = arcPoint(fit, 0.5);
    const rise = mid[2] - (fit.start[2] + fit.end[2]) / 2;
    return { arc: verticalArc(start, end, rise), plane: 'vertical' };
  }
  if (nz >= 0.999) return { arc: arcThrough(start, arcPoint(fit, 0.5), end), plane: 'plan' };
  return null;
}
function describeArc(arc: Arc, plane: 'vertical' | 'plan'): GirderArc {
  const c = arc.center;
  let axis: Vec3, frameNormal: Vec3;
  if (plane === 'plan') {
    axis = [1, 0, 0];
    frameNormal = [0, 0, 1];
  } else {
    const h = planDistance(arc.end, arc.start);
    axis = [(arc.end[0] - arc.start[0]) / h, (arc.end[1] - arc.start[1]) / h, 0];
    frameNormal = [axis[1], -axis[0], 0];
  }
  const up: Vec3 = plane === 'plan' ? [0, 1, 0] : [0, 0, 1];
  const angle = (p: Vec3) => {
    const d = sub(p, c);
    return deg(Math.atan2(dot(d, up), dot(d, axis)));
  };
  const sign = dot(arc.normal, frameNormal) >= 0 ? 1 : -1;
  const startDeg = angle(arc.start);
  const sweepDeg = sign * deg(arc.sweep);
  const mid = arcPoint(arc, 0.5);
  const rise =
    plane === 'vertical'
      ? mid[2] - (arc.start[2] + arc.end[2]) / 2
      : arc.rise * (sign > 0 ? 1 : -1);
  return {
    center: p3(c),
    radius: r4(arc.radius),
    startDeg: Number(startDeg.toFixed(4)),
    endDeg: Number((startDeg + sweepDeg).toFixed(4)),
    sweepDeg: Number(sweepDeg.toFixed(4)),
    rise: r4(rise),
    plane,
  };
}

// --- crossings -------------------------------------------------------------------------------------

function segmentCross(a: Vec3, b: Vec3, c: Vec2, d: Vec2): { s: number; at: Vec2 } | null {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    vx = d[0] - c[0],
    vy = d[1] - c[1];
  const den = ux * vy - uy * vx;
  if (Math.abs(den) < 1e-12) return null;
  const wx = c[0] - a[0],
    wy = c[1] - a[1];
  const s = (wx * vy - wy * vx) / den;
  const t = (wx * uy - wy * ux) / den;
  if (s < 0 || s > 1 || t < 0 || t > 1) return null;
  return { s, at: [a[0] + s * ux, a[1] + s * uy] };
}

/** The correction table's text for one girder (Korean UI words). */
function correctionNote(
  g: {
    snapped: GirderRow['snapped'];
    danglingEnds: unknown[];
    kind: 'line' | 'arc';
    arc?: GirderArc;
    mergedFrom: string[];
  },
  supports: number,
): string {
  const parts: string[] = [];
  const moved = g.snapped.filter((s) => s.moved_m >= 0.005);
  if (moved.length)
    parts.push(
      `끝 붙임 ${moved.length}곳(최대 ${Math.max(...moved.map((s) => s.moved_m)).toFixed(2)} m)`,
    );
  if (g.mergedFrom.length) parts.push(`중복 ${g.mergedFrom.length}개 합침`);
  if (g.kind === 'arc' && g.arc)
    parts.push(g.arc.plane === 'vertical' ? '연직 원호로 맞춤' : '평면 원호로 맞춤');
  if (g.danglingEnds.length) parts.push(`기둥 없는 끝 ${g.danglingEnds.length}곳`);
  if (supports > 2) parts.push(`기둥 ${supports}곳에서 끊음`);
  return parts.length ? parts.join(' · ') : '그대로';
}

// --- the step --------------------------------------------------------------------------------------

export function girders(
  inputs: GirdersInputs,
  params: Partial<GirdersParams> & Record<string, unknown> = {},
): GirdersOutput {
  const p = resolveParams(params);
  const site = inputs?.site ?? {};
  const notes: string[] = [];
  const columns = readColumns(site, notes);
  if (!site.girders?.rows?.length) notes.push('거더 레이어에 곡선이 없습니다.');
  if (!columns.length)
    notes.push('기둥 레이어에 곡선이 없어 거더를 붙이거나 끊을 기둥이 없습니다.');
  const { kept, merged } = mergeDrawn(readGirders(site, p, notes), p.mergeTol_m);
  if (merged) notes.push(`겹치거나 중복된 거더 곡선 ${merged}개를 합쳤습니다.`);

  // A column top usable for a girder point: within zTol of the girder's z.
  const nearestColumn = (at: Vec3) => {
    let best: ColumnRef | undefined,
      distance = Infinity;
    for (const c of columns) {
      if (Math.abs(c.top[2] - at[2]) > p.zTol_m) continue;
      const d = planDistance(c.top, at);
      if (d < distance || (d === distance && best && c.id < best.id)) {
        best = c;
        distance = d;
      }
    }
    return best ? { column: best, distance } : null;
  };

  interface Work extends Drawn {
    snapped: GirderRow['snapped'];
    danglingEnds: { end: 'start' | 'end'; near: { column: ColumnRef; distance: number } | null }[];
    kind: 'line' | 'arc';
    arc?: GirderArc;
  }
  const work: Work[] = [];
  let notArc = 0;
  for (const g of kept) {
    const points = g.points.map((q) => [...q] as Vec3);
    const snapped: Work['snapped'] = [];
    const danglingEnds: Work['danglingEnds'] = [];
    for (const end of ['start', 'end'] as const) {
      const index = end === 'start' ? 0 : points.length - 1;
      const at = points[index];
      const near = nearestColumn(at);
      if (!near || near.distance > p.snapTol_m) {
        danglingEnds.push({ end, near });
        continue;
      }
      // Move the end onto the column top in plan; the girder keeps its own z.
      if (near.distance > 1e-6) {
        points[index] = [near.column.top[0], near.column.top[1], at[2]];
        snapped.push({ end, columnId: near.column.id, moved_m: r4(near.distance) });
      }
    }
    let kind: Work['kind'] = 'line';
    let arc: GirderArc | undefined;
    let final = points;
    if (!g.straight) {
      try {
        const fit = fitArc(g.points);
        const made =
          fit.deviation <= p.arcSagitta_m
            ? arcOf(fit.arc, points[0], points[points.length - 1])
            : null;
        if (made) {
          kind = 'arc';
          arc = describeArc(made.arc, made.plane);
          final = segmentArc(made.arc, { maxLength: 1.0, maxSagitta: 0.005 });
        } else notArc++;
      } catch (error) {
        if (!(error instanceof GeometryError)) throw error;
        notArc++;
      }
    }
    work.push({ ...g, points: final, snapped, danglingEnds, kind, ...(arc ? { arc } : {}) });
  }
  if (notArc)
    notes.push(`단일 곡률 원호로 맞지 않는 거더 곡선 ${notArc}개는 그린 꺾은선 그대로 둡니다.`);

  const mid = (points: readonly Vec3[]) => {
    const a = points[0],
      b = points[points.length - 1];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  work.sort(
    (a, b) => planOrder(mid(a.points), mid(b.points)) || a.sourceId.localeCompare(b.sourceId),
  );

  const tops: Vec3[] = columns.map((c) => c.top);
  const slab = slabOf(site.slab, site.voids);
  notes.push(...slab.notes);
  const rings: { boundary: 'slab' | 'void'; ring: Vec2[] }[] = slab.region
    ? [
        { boundary: 'slab', ring: slab.region.outer as Vec2[] },
        ...slab.region.holes.map((ring) => ({ boundary: 'void' as const, ring: ring as Vec2[] })),
      ]
    : [];

  const out: GirderRow[] = [];
  const dangling: DanglingRow[] = [];
  const danglingAt: GirdersOutput['danglingAt'] = [];
  const crossings: CrossingRow[] = [];
  const spans: SpanRow[] = [];
  work.forEach((g, k) => {
    const id = key2('G', k + 1);
    const points = g.points.map(p3);
    const planLength = planLengthOf(g.points);
    const split = splitAtSupports(g.points, tops, p.snapTol_m, {
      merge: p.mergeTol_m,
      zTolerance: p.zTol_m,
    });
    const supports: GirderSupport[] = [];
    for (const station of split.stations)
      for (const s of station.supports)
        supports.push({
          columnId: columns[s].id,
          t: Number((planLength > 0 ? station.planAt / planLength : 0).toFixed(6)),
        });
    for (const piece of split.spans) {
      const from = columns[split.stations[piece.from!].supports[0]].id;
      const to = columns[split.stations[piece.to!].supports[0]].id;
      spans.push({
        girderId: id,
        from,
        to,
        length_m: r4(piece.length),
        planLength_m: r4(piece.planLength),
        over: piece.planLength > p.spanMax_m,
      });
    }
    for (const d of g.danglingEnds)
      dangling.push({
        girderId: id,
        end: d.end,
        ...(d.near ? { nearestColumnId: d.near.column.id } : {}),
        distance_m: d.near ? r4(d.near.distance) : null,
      });
    for (const d of g.danglingEnds)
      danglingAt.push({
        girderId: id,
        end: d.end,
        at: p3(d.end === 'start' ? g.points[0] : g.points[g.points.length - 1]),
      });
    const start = g.points[0],
      end = g.points[g.points.length - 1];
    const seen: (CrossingRow & { along: number })[] = [];
    for (let i = 1; i < g.points.length; i++)
      for (const { boundary, ring } of rings)
        for (let j = 0; j < ring.length; j++) {
          const hit = segmentCross(
            g.points[i - 1],
            g.points[i],
            ring[j],
            ring[(j + 1) % ring.length],
          );
          if (!hit) continue;
          if (
            planDistance(hit.at, start) <= p.mergeTol_m ||
            planDistance(hit.at, end) <= p.mergeTol_m
          )
            continue;
          if (seen.some((c) => planDistance(c.at, hit.at) <= p.mergeTol_m)) continue;
          seen.push({
            girderId: id,
            boundary,
            at: [r4(hit.at[0]), r4(hit.at[1])],
            along: i - 1 + hit.s,
          });
        }
    seen.sort((a, b) => a.along - b.along);
    crossings.push(...seen.map(({ along: _, ...row }) => row));
    out.push({
      id,
      sourceId: g.sourceId,
      ...(g.mergedFrom.length ? { mergedFrom: g.mergedFrom } : {}),
      ...(g.name ? { name: g.name } : {}),
      points,
      kind: g.kind,
      ...(g.arc ? { arc: g.arc } : {}),
      supports,
      snapped: g.snapped,
      length_m: r4(lengthOf(g.points)),
      planLength_m: r4(planLength),
      note: correctionNote(g, supports.length),
    });
  });

  return {
    schema: 'vide.s06.girders/1',
    params: p,
    girders: out,
    columns,
    dangling,
    danglingAt,
    crossings,
    spans,
    summary: {
      girders: out.length,
      snapped: out.reduce((n, g) => n + g.snapped.length, 0),
      dangling: dangling.length,
      spansOver: spans.filter((s) => s.over).length,
    },
    notes,
  };
}
