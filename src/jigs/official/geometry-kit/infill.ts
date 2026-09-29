// Cell infill and edge framing (SPEC-06.11 4·6, PLAN-23 T-050): secondary beams inside a closed
// cell parallel to its longest edge at a pitch no wider than the spacing, cut at the cell boundary
// and dropped when shorter than the minimum; cantilever arms from an outer girder out to the edge
// girder line, with the cantilever measured from the girder (the last support) to the slab edge.

import {
  GeometryError,
  assertPoints,
  counterClockwise,
  type PlanPoint,
  type Vec2,
} from './plan.ts';
import { lineCrossings, longestEdge, rayHits, requireRings } from './polygon.ts';

export interface InfillOptions {
  /** Maximum beam pitch (m). */
  spacing: number;
  /** Beams shorter than this are left out (m, default 1.0). */
  minLength?: number;
  /** 'longest' (default), an angle from +x in degrees, or a direction vector. */
  direction?: 'longest' | number | PlanPoint;
}

export interface InfillBeam {
  from: Vec2;
  to: Vec2;
  length: number;
  /** Which pitch line the beam lies on (1 … count − 1 from the low side). */
  line: number;
}

export interface Infill {
  beams: InfillBeam[];
  /** Unit beam direction. */
  direction: Vec2;
  /** Cell width across the beams and the pitch actually used (≤ spacing). */
  width: number;
  pitch: number;
  /** Beams that were shorter than the minimum. */
  dropped: number;
}

function lengthOption(value: number | undefined, fallback: number, what: string) {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0) throw new GeometryError('no-nan', `${what} ${String(value)}`);
  return v;
}

/** Beams inside a closed cell (any simple polygon; concave cells give several pieces per line). */
export function cellInfill(cell: readonly PlanPoint[], options: InfillOptions): Infill {
  const ring = counterClockwise(cell);
  const spacing = options.spacing;
  if (!Number.isFinite(spacing) || spacing <= 0)
    throw new GeometryError('no-nan', `spacing ${String(spacing)}`);
  const minLength = lengthOption(options.minLength, 1.0, 'minLength');
  let direction: Vec2;
  const wanted = options.direction ?? 'longest';
  if (wanted === 'longest') {
    const i = longestEdge(ring);
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    direction = [q[0] - p[0], q[1] - p[1]];
  } else if (typeof wanted === 'number') {
    if (!Number.isFinite(wanted)) throw new GeometryError('no-nan', 'direction angle');
    direction = [Math.cos((wanted * Math.PI) / 180), Math.sin((wanted * Math.PI) / 180)];
  } else {
    assertPoints([wanted], 'direction');
    direction = [wanted[0], wanted[1]];
  }
  const length = Math.hypot(direction[0], direction[1]);
  if (!(length > 0)) throw new GeometryError('no-nan', 'direction is zero');
  direction = [direction[0] / length, direction[1] / length];
  const normal: Vec2 = [-direction[1], direction[0]];

  // Local frame about the first vertex.
  const ox = ring[0][0],
    oy = ring[0][1];
  const local = ring.map((p): Vec2 => [p[0] - ox, p[1] - oy]);
  let low = Infinity,
    high = -Infinity;
  for (const p of local) {
    const d = p[0] * normal[0] + p[1] * normal[1];
    if (d < low) low = d;
    if (d > high) high = d;
  }
  const width = high - low;
  const count = Math.max(1, Math.ceil(width / spacing - 1e-9));
  const pitch = width / count;
  const beams: InfillBeam[] = [];
  let dropped = 0;
  for (let line = 1; line < count; line++) {
    const offset = low + line * pitch;
    const origin: Vec2 = [normal[0] * offset, normal[1] * offset];
    const ts = lineCrossings(origin, direction, local);
    for (let k = 0; k + 1 < ts.length; k += 2) {
      const beamLength = ts[k + 1] - ts[k];
      if (beamLength < minLength) {
        dropped++;
        continue;
      }
      beams.push({
        from: [ox + origin[0] + ts[k] * direction[0], oy + origin[1] + ts[k] * direction[1]],
        to: [ox + origin[0] + ts[k + 1] * direction[0], oy + origin[1] + ts[k + 1] * direction[1]],
        length: beamLength,
        line,
      });
    }
  }
  return { beams, direction, width, pitch, dropped };
}

export interface CantileverOptions {
  /** Maximum arm pitch along the girder (m). */
  spacing: number;
  /** Which side of a→b the slab edge lies on, or a point (e.g. the cell centroid) to face away from. */
  side: 'left' | 'right' | { awayFrom: PlanPoint };
  /** Slab outline: the cantilever is measured from the girder to it. */
  boundary: readonly PlanPoint[];
  /** Edge girder line (e.g. the inset ring); arms end on it. Without it arms end on the boundary. */
  edge?: readonly PlanPoint[];
  /** Arms at the girder ends (the columns) as well (default true). */
  includeEnds?: boolean;
  /** Arms shorter than this are left out (m, default 0). */
  minLength?: number;
}

export interface CantileverArm {
  from: Vec2;
  to: Vec2;
  length: number;
  /** Distance from the girder to the slab edge along the arm (m). */
  cantilever: number;
  /** Position along the girder from a (m). */
  at: number;
}

export interface Cantilevers {
  arms: CantileverArm[];
  /** Unit outward direction. */
  outward: Vec2;
  pitch: number;
  /** Longest cantilever over the stations, including those without an arm. */
  cantileverMax: number;
  /** Stations (m along the girder) where no slab edge lies outward. */
  skipped: number[];
}

/** Arms from girder a→b outward to the edge line, and the cantilever to the slab edge. */
export function cantileverBeams(
  girder: readonly [PlanPoint, PlanPoint],
  options: CantileverOptions,
): Cantilevers {
  assertPoints(girder, 'girder');
  const [boundary, edge] = requireRings(
    options.edge ? [options.boundary, options.edge] : [options.boundary],
    'rings',
  );
  const spacing = options.spacing;
  if (!Number.isFinite(spacing) || spacing <= 0)
    throw new GeometryError('no-nan', `spacing ${String(spacing)}`);
  const minLength = lengthOption(options.minLength, 0, 'minLength');
  const [a, b] = girder;
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) throw new GeometryError('polygon-valid', 'girder has no length');
  const along: Vec2 = [dx / length, dy / length];
  let outward: Vec2 = [-along[1], along[0]];
  if (options.side === 'right') outward = [-outward[0], -outward[1]];
  else if (options.side !== 'left') {
    const away = options.side?.awayFrom;
    assertPoints([away], 'side.awayFrom');
    const mx = (a[0] + b[0]) / 2 - away[0],
      my = (a[1] + b[1]) / 2 - away[1];
    if (mx * outward[0] + my * outward[1] < 0) outward = [-outward[0], -outward[1]];
  }
  const count = Math.max(1, Math.ceil(length / spacing - 1e-9));
  const pitch = length / count;
  const includeEnds = options.includeEnds ?? true;
  const arms: CantileverArm[] = [];
  const skipped: number[] = [];
  let cantileverMax = 0;
  for (let i = includeEnds ? 0 : 1; i <= (includeEnds ? count : count - 1); i++) {
    const at = i * pitch;
    const from: Vec2 = [a[0] + along[0] * at, a[1] + along[1] * at];
    const toBoundary = rayHits(from, outward, boundary)[0];
    if (toBoundary === undefined) {
      skipped.push(at);
      continue;
    }
    if (toBoundary > cantileverMax) cantileverMax = toBoundary;
    const toEdge = edge ? rayHits(from, outward, edge)[0] : toBoundary;
    if (toEdge === undefined || toEdge < minLength) continue;
    arms.push({
      from,
      to: [from[0] + outward[0] * toEdge, from[1] + outward[1] * toEdge],
      length: toEdge,
      cantilever: toBoundary,
      at,
    });
  }
  return { arms, outward, pitch, cantileverMax, skipped };
}
