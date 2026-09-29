// Girder network between columns (SPEC-06.11 3, PLAN-23 T-050): a Delaunay triangulation of the
// column points with the caller's constraints kept, the diagonal of every cell whose four corners
// lie on one circle (a rectangular bay) fixed by a rule instead of by rounding noise, then every
// edge that leaves the slab, crosses its edge, a void or a barrier (new expansion joint) dropped.
// Same points and options → same edges, and a column moved within the rule's tolerances keeps the
// same edge set (`rect-grid-degenerate`).

import Delaunator from 'delaunator';
import * as constrainautorModule from '@kninnug/constrainautor';
import {
  GeometryError,
  assertPoints,
  pointInPolygon,
  requirePolygon,
  signedArea,
  type PlanPoint,
  type Polygon,
  type Vec2,
} from './plan.ts';
import {
  boundaryDistance,
  planPoints,
  requireRings,
  segmentsCross,
  type Region,
} from './polygon.ts';

interface DelaunatorLike {
  coords: ArrayLike<number>;
  triangles: Uint32Array;
  halfedges: Int32Array;
}
interface Constrained {
  del: DelaunatorLike;
  constrainOne(a: number, b: number): number;
  isConstrained(edge: number): boolean;
}
type ConstrainedCtor = new (del: DelaunatorLike) => Constrained;

// The package ships its CJS-flavoured `.ts` source as its types: a NodeNext program reads the
// default export as the module object, a bundler program reads it as the class. At runtime both
// Node (lib/Constrainautor.mjs) and Vite give the class, so the namespace is unwrapped by hand.
function defaultExport(module: unknown): unknown {
  let value = module;
  for (let i = 0; i < 3 && value && typeof value === 'object' && 'default' in value; i++)
    value = (value as { default: unknown }).default;
  return value;
}
const Constrainautor = defaultExport(constrainautorModule) as ConstrainedCtor;

/** Diagonal rule for a cell whose four corners are cocircular (RESEARCH-10 §14.4 ⑤). */
export interface DiagonalRule {
  /** Diagonals whose lengths differ by no more than this (m, default 0.05) take the u+v one. */
  tie?: number;
  /** A previous diagonal is kept unless it is longer than the other by this much (m, default 0.2). */
  keep?: number;
  /** A fourth corner this close to the circle through the other three is "on" it (m, default 0.01). */
  cocircular?: number;
}

/** Region fields (`outer`, `holes`) as in polygon.ts `Region`, plus the network rules. */
export interface TriangulateOptions {
  /** Slab outline: edges that leave it or cross it are dropped. */
  outer?: readonly PlanPoint[];
  /** Voids: edges crossing or inside one are dropped. */
  holes?: readonly (readonly PlanPoint[])[];
  /** Segments no edge may cross (new expansion joints). */
  barriers?: readonly (readonly [PlanPoint, PlanPoint])[];
  /** Index pairs that must be edges; kept even where the clipping would drop them. */
  constraints?: readonly (readonly [number, number])[];
  /** The previous run's edges (index pairs): a cocircular cell keeps its old diagonal. */
  previous?: readonly (readonly [number, number])[];
  /** Grid u axis from +x (deg, default 0). A tie-break diagonal runs along u+v (45° from u). */
  axisDeg?: number;
  diagonal?: DiagonalRule;
  /** Replace the two triangles of every decided cell by one quad cell (default false, F2.1). */
  mergeQuads?: boolean;
  /**
   * Triangles with a corner sharper than this are slivers, not bays (deg, default 1): their
   * long edge would skip a column that lies on it.
   */
  minAngleDeg?: number;
}

export type RemovedReason =
  | 'outside'
  | 'inside-hole'
  | 'crosses-boundary'
  | 'crosses-hole'
  | 'crosses-barrier'
  | 'merged'
  | 'sliver';

export interface TriEdge {
  /** Point indices, a < b. */
  a: number;
  b: number;
  length: number;
  constrained: boolean;
  /** Fixed by the diagonal rule (a cocircular cell). */
  decided: boolean;
  /** Indices into `cells` on either side (0, 1 or 2): one means the edge is on the outside. */
  cells: number[];
}

export interface TriCell {
  /** Point indices counter-clockwise, starting at the smallest. */
  vertices: number[];
  area: number;
  minAngleDeg: number;
}

export interface Triangulation {
  /** Kept edges sorted by (a, b). */
  edges: TriEdge[];
  /** Closed cells: triangles (or merged quads) whose every edge was kept. */
  cells: TriCell[];
  removed: { a: number; b: number; length: number; reason: RemovedReason }[];
  /** Diagonals fixed by the rule, as (a < b) pairs. */
  decided: [number, number][];
}

const nextEdge = (e: number) => (e % 3 === 2 ? e - 2 : e + 1);
const prevEdge = (e: number) => (e % 3 === 0 ? e + 2 : e - 1);
const key = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);

function checkPairs(
  pairs: readonly (readonly [number, number])[] | undefined,
  what: string,
  n: number,
): [number, number][] {
  if (!pairs) return [];
  if (!Array.isArray(pairs)) throw new GeometryError('polygon-valid', `${what} is not a list`);
  return pairs.map((pair, i) => {
    const a = pair?.[0],
      b = pair?.[1];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n)
      throw new GeometryError('polygon-valid', `${what}[${i}] is not a pair of point indices`);
    if (a === b) throw new GeometryError('polygon-valid', `${what}[${i}] joins a point to itself`);
    return [a, b];
  });
}

function lengthOption(value: number | undefined, fallback: number, what: string) {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < 0) throw new GeometryError('no-nan', `${what} ${String(value)}`);
  return v;
}

function circumcenter(a: Vec2, b: Vec2, c: Vec2): Vec2 | null {
  const bx = b[0] - a[0],
    by = b[1] - a[1],
    cx = c[0] - a[0],
    cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  const scale = Math.max(Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy));
  if (Math.abs(d) <= 1e-12 * scale * scale) return null;
  const b2 = bx * bx + by * by,
    c2 = cx * cx + cy * cy;
  return [a[0] + (cy * b2 - by * c2) / d, a[1] + (bx * c2 - cx * b2) / d];
}

function interiorAngle(o: Vec2, a: Vec2, b: Vec2) {
  const ux = a[0] - o[0],
    uy = a[1] - o[1],
    vx = b[0] - o[0],
    vy = b[1] - o[1];
  return Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy));
}

/**
 * Triangulate `points` (columns) in plan. Fewer than three points, or collinear points, give the
 * chain of edges along them. Two points closer than 1 µm throw `polygon-valid`.
 */
export function triangulate(
  points: readonly PlanPoint[],
  options: TriangulateOptions = {},
): Triangulation {
  const pts = planPoints(points, 'points');
  const n = pts.length;
  const outer = options.outer ? requirePolygon(options.outer, 'outer') : undefined;
  const holes = options.holes ? requireRings(options.holes, 'holes') : [];
  const barriers = (options.barriers ?? []).map(([a, b], i): [Vec2, Vec2] => {
    assertPoints([a, b], `barriers[${i}]`);
    return [
      [a[0], a[1]],
      [b[0], b[1]],
    ];
  });
  const constraints = checkPairs(options.constraints, 'constraints', n);
  const previous = new Set(checkPairs(options.previous, 'previous', n).map(([a, b]) => key(a, b)));
  const tie = lengthOption(options.diagonal?.tie, 0.05, 'diagonal.tie');
  const keep = lengthOption(options.diagonal?.keep, 0.2, 'diagonal.keep');
  const cocircular = lengthOption(options.diagonal?.cocircular, 0.01, 'diagonal.cocircular');
  const minAngle = (lengthOption(options.minAngleDeg, 1, 'minAngleDeg') * Math.PI) / 180;
  const slivers: [number, number][] = [];
  const axisDeg = options.axisDeg ?? 0;
  if (!Number.isFinite(axisDeg)) throw new GeometryError('no-nan', `axisDeg ${String(axisDeg)}`);
  const preferred = ((axisDeg + 45) * Math.PI) / 180;
  const prefer: Vec2 = [Math.cos(preferred), Math.sin(preferred)];

  // Coincident points would be silently dropped by the triangulation; that is an input error.
  const cellOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pts[i][0] * 1e6)},${Math.round(pts[i][1] * 1e6)}`;
    const other = cellOf.get(k);
    if (other !== undefined)
      throw new GeometryError('polygon-valid', `points ${other} and ${i} coincide`);
    cellOf.set(k, i);
  }

  const constrainedKeys = new Set(constraints.map(([a, b]) => key(a, b)));
  const decidedKeys = new Set<string>();
  const decided: [number, number][] = [];
  let pairs: [number, number][] = [];
  let rings: number[][] = [];

  if (n === 2) pairs = [[0, 1]];
  else if (n > 2) {
    // Local frame: site coordinates are far from the origin, sizes are metres.
    const ox = pts[0][0],
      oy = pts[0][1];
    const coords = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      coords[2 * i] = pts[i][0] - ox;
      coords[2 * i + 1] = pts[i][1] - oy;
    }
    const del = new Delaunator(coords);
    const tri = del.triangles,
      half = del.halfedges;
    const local = (i: number): Vec2 => [coords[2 * i], coords[2 * i + 1]];
    if (tri.length === 0) {
      // Collinear: the chain along the line.
      const order = pts
        .map((_, i) => i)
        .sort((i, j) => pts[i][0] - pts[j][0] || pts[i][1] - pts[j][1]);
      for (let k = 1; k < order.length; k++) pairs.push([order[k - 1], order[k]]);
    } else {
      const con = new Constrainautor(del);
      for (const [a, b] of constraints) {
        try {
          con.constrainOne(a, b);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new GeometryError('polygon-valid', `constraint ${a}–${b}: ${message}`);
        }
      }

      const thin = (p: Vec2, q: Vec2, r: Vec2) =>
        Math.min(interiorAngle(p, q, r), interiorAngle(q, r, p), interiorAngle(r, p, q)) < minAngle;
      // Is the quad around halfedge e (a→b, third corners c and d) convex with d on the circle
      // through a, b, c? Then Delaunay does not decide its diagonal and the rule does.
      const cocircularQuad = (a: number, b: number, c: number, d: number) => {
        const pa = local(a),
          pb = local(b),
          pc = local(c),
          pd = local(d);
        if (!segmentsCross(pa, pb, pc, pd, 1e-9)) return false;
        // Slivers along a jittered straight hull are flat quads on a huge circle: not bays.
        if (thin(pa, pb, pc) || thin(pb, pa, pd)) return false;
        const center = circumcenter(pa, pb, pc);
        if (!center) return false;
        const r = Math.hypot(pa[0] - center[0], pa[1] - center[1]);
        return Math.abs(Math.hypot(pd[0] - center[0], pd[1] - center[1]) - r) <= cocircular;
      };
      const length = (i: number, j: number) => {
        const p = local(i),
          q = local(j);
        return Math.hypot(q[0] - p[0], q[1] - p[1]);
      };
      const alignment = (i: number, j: number) => {
        const p = local(i),
          q = local(j);
        const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        return Math.abs(((q[0] - p[0]) * prefer[0] + (q[1] - p[1]) * prefer[1]) / l);
      };
      const choose = (current: [number, number], other: [number, number]) => {
        const lc = length(current[0], current[1]),
          lo = length(other[0], other[1]);
        if (previous.has(key(current[0], current[1])) && lc - lo < keep) return current;
        if (previous.has(key(other[0], other[1])) && lo - lc < keep) return other;
        if (Math.abs(lc - lo) <= tie) {
          const ac = alignment(current[0], current[1]),
            ao = alignment(other[0], other[1]);
          if (ac > ao + 1e-9) return current;
          if (ao > ac + 1e-9) return other;
          return key(current[0], current[1]) < key(other[0], other[1]) ? current : other;
        }
        return lc <= lo ? current : other;
      };

      // A flip keeps the halfedge slots of its two triangles, so each slot pair is one cell
      // position; passes repeat while decisions change neighbouring quads.
      for (let pass = 0; pass < 6; pass++) {
        const candidates: { e: number; a: number; b: number }[] = [];
        for (let e = 0; e < half.length; e++) {
          const t = half[e];
          if (t === -1 || t < e || con.isConstrained(e)) continue;
          const a = tri[e],
            b = tri[nextEdge(e)],
            c = tri[prevEdge(e)],
            d = tri[prevEdge(t)];
          if (cocircularQuad(a, b, c, d))
            candidates.push({ e, a: Math.min(a, b), b: Math.max(a, b) });
        }
        candidates.sort((p, q) => p.a - q.a || p.b - q.b);
        let made = 0;
        for (const candidate of candidates) {
          const e = candidate.e,
            t = half[e];
          if (t === -1 || con.isConstrained(e)) continue;
          const a = tri[e],
            b = tri[nextEdge(e)];
          if (Math.min(a, b) !== candidate.a || Math.max(a, b) !== candidate.b) continue;
          const c = tri[prevEdge(e)],
            d = tri[prevEdge(t)];
          if (!cocircularQuad(a, b, c, d)) continue;
          const [x, y] = choose([a, b], [c, d]);
          try {
            con.constrainOne(x, y);
          } catch {
            continue;
          }
          decidedKeys.add(key(x, y));
          decided.push([Math.min(x, y), Math.max(x, y)]);
          made++;
        }
        if (!made) break;
      }

      // Collinear hull points (every grid edge) give zero-area hull triangles, and points moved by
      // a millimetre turn them into slivers; either way their long edge skips a column. Only edges
      // of real triangles count; a sliver's own edge is reported as removed.
      const sliver = new Uint8Array(tri.length / 3);
      for (let i = 0; i < tri.length; i += 3) {
        const ring = [tri[i], tri[i + 1], tri[i + 2]];
        const corners = ring.map(local);
        const area = signedArea(corners);
        const size = Math.max(
          Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]),
          Math.hypot(corners[2][0] - corners[0][0], corners[2][1] - corners[0][1]),
        );
        const angle = Math.min(
          interiorAngle(corners[0], corners[1], corners[2]),
          interiorAngle(corners[1], corners[2], corners[0]),
          interiorAngle(corners[2], corners[0], corners[1]),
        );
        if (Math.abs(area) <= 1e-9 * size * size || angle < minAngle) {
          sliver[i / 3] = 1;
          continue;
        }
        if (area < 0) ring.reverse();
        rings.push(ring);
      }
      const seen = new Set<string>();
      for (let e = 0; e < half.length; e++) {
        if (sliver[Math.floor(e / 3)]) continue;
        const a = tri[e],
          b = tri[nextEdge(e)];
        const k = key(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        pairs.push([a, b]);
      }
      for (let e = 0; e < half.length; e++) {
        if (!sliver[Math.floor(e / 3)]) continue;
        const a = tri[e],
          b = tri[nextEdge(e)];
        const k = key(a, b);
        if (seen.has(k)) continue;
        seen.add(k);
        slivers.push([Math.min(a, b), Math.max(a, b)]);
      }
    }
  }

  // Clipping: what the slab, its voids and the barriers leave.
  const reasonFor = (a: number, b: number): RemovedReason | null => {
    if (constrainedKeys.has(key(a, b))) return null;
    const p = pts[a],
      q = pts[b];
    if (outer)
      for (let i = 0, j = outer.length - 1; i < outer.length; j = i++)
        if (segmentsCross(p, q, outer[j], outer[i])) return 'crosses-boundary';
    for (const hole of holes)
      for (let i = 0, j = hole.length - 1; i < hole.length; j = i++)
        if (segmentsCross(p, q, hole[j], hole[i])) return 'crosses-hole';
    for (const [c, d] of barriers) if (segmentsCross(p, q, c, d)) return 'crosses-barrier';
    const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (outer && !pointInPolygon(mid, outer, 1e-9)) return 'outside';
    for (const hole of holes)
      if (pointInPolygon(mid, hole, 0) && boundaryDistance(mid, hole) > 1e-9) return 'inside-hole';
    return null;
  };
  const edgeLength = (a: number, b: number) =>
    Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]);
  const removed: Triangulation['removed'] = slivers.map(([a, b]) => ({
    a,
    b,
    length: edgeLength(a, b),
    reason: 'sliver',
  }));
  const kept = new Map<string, TriEdge>();
  for (const [x, y] of pairs) {
    const a = Math.min(x, y),
      b = Math.max(x, y);
    const k = key(a, b);
    if (kept.has(k)) continue;
    const reason = reasonFor(a, b);
    if (reason) {
      removed.push({ a, b, length: edgeLength(a, b), reason });
      continue;
    }
    kept.set(k, {
      a,
      b,
      length: edgeLength(a, b),
      constrained: constrainedKeys.has(k),
      decided: decidedKeys.has(k),
      cells: [],
    });
  }

  // Cells: triangles whose three edges survived and whose centre is on the slab (three
  // constrained edges round a triangular void would otherwise close a "bay" inside it); merged
  // into quads across decided diagonals.
  const closed = (ring: number[]) => {
    if (!ring.every((v, i) => kept.has(key(v, ring[(i + 1) % ring.length])))) return false;
    if (!outer && !holes.length) return true;
    const centre: Vec2 = [0, 0];
    for (const v of ring) {
      centre[0] += pts[v][0] / ring.length;
      centre[1] += pts[v][1] / ring.length;
    }
    if (outer && !pointInPolygon(centre, outer, 0)) return false;
    return !holes.some(
      (hole) => pointInPolygon(centre, hole, 0) && boundaryDistance(centre, hole) > 1e-9,
    );
  };
  let cellRings = rings.filter(closed);
  if (options.mergeQuads) {
    const byDiagonal = new Map<string, number[]>();
    cellRings.forEach((ring, index) => {
      for (let i = 0; i < 3; i++) {
        const k = key(ring[i], ring[(i + 1) % 3]);
        if (decidedKeys.has(k)) byDiagonal.set(k, [...(byDiagonal.get(k) ?? []), index]);
      }
    });
    const consumed = new Set<number>();
    const quads: number[][] = [];
    for (const [k, owners] of [...byDiagonal].sort(([p], [q]) => (p < q ? -1 : 1))) {
      if (owners.length !== 2 || owners.some((o) => consumed.has(o))) continue;
      const [first, second] = owners.map((o) => cellRings[o]);
      const [da, db] = k.split('-').map(Number);
      const far = (ring: number[]) => ring.find((v) => v !== da && v !== db)!;
      // Around the quad: da, then the far corner of the triangle that turns right of da→db.
      const rightOf = signedArea([pts[da], pts[db], pts[far(first)]]) < 0 ? first : second;
      const leftOf = rightOf === first ? second : first;
      quads.push([da, far(rightOf), db, far(leftOf)]);
      owners.forEach((o) => consumed.add(o));
      const edge = kept.get(k)!;
      kept.delete(k);
      removed.push({ a: edge.a, b: edge.b, length: edge.length, reason: 'merged' });
    }
    cellRings = cellRings.filter((_, i) => !consumed.has(i)).concat(quads);
  }
  const cells: TriCell[] = cellRings
    .map((ring) => {
      const start = ring.indexOf(Math.min(...ring));
      const vertices = ring.slice(start).concat(ring.slice(0, start));
      let minAngle = Infinity;
      for (let i = 0; i < vertices.length; i++) {
        const angle = interiorAngle(
          pts[vertices[i]],
          pts[vertices[(i + vertices.length - 1) % vertices.length]],
          pts[vertices[(i + 1) % vertices.length]],
        );
        if (angle < minAngle) minAngle = angle;
      }
      return {
        vertices,
        area: Math.abs(signedArea(vertices.map((v) => pts[v]))),
        minAngleDeg: (minAngle * 180) / Math.PI,
      };
    })
    .sort((p, q) => {
      for (let i = 0; i < Math.max(p.vertices.length, q.vertices.length); i++) {
        const d = (p.vertices[i] ?? -1) - (q.vertices[i] ?? -1);
        if (d) return d;
      }
      return 0;
    });
  cells.forEach((cell, index) => {
    for (let i = 0; i < cell.vertices.length; i++)
      kept
        .get(key(cell.vertices[i], cell.vertices[(i + 1) % cell.vertices.length]))
        ?.cells.push(index);
  });
  const edges = [...kept.values()].sort((p, q) => p.a - q.a || p.b - q.b);
  removed.sort((p, q) => p.a - q.a || p.b - q.b);
  decided.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return { edges, cells, removed, decided };
}

/**
 * Constrained Delaunay triangulation of a region's own vertices: the ring edges are constraints,
 * so the cells cover the outer ring less the holes exactly (a concave outline as convex pieces,
 * e.g. as window-search obstacles). Returns the point list the cell indices refer to.
 */
export function triangulateRegion(
  region: Region,
  options: Omit<TriangulateOptions, 'outer' | 'holes' | 'constraints'> = {},
): { points: Vec2[]; result: Triangulation } {
  const outer = requirePolygon(region.outer, 'outer');
  const holes = requireRings(region.holes ?? [], 'holes');
  const points: Vec2[] = [];
  const constraints: [number, number][] = [];
  for (const ring of [outer, ...holes]) {
    const base = points.length;
    for (const p of ring) points.push([p[0], p[1]]);
    for (let i = 0; i < ring.length; i++)
      constraints.push([base + i, base + ((i + 1) % ring.length)]);
  }
  return { points, result: triangulate(points, { ...options, outer, holes, constraints }) };
}

/** Plan polygon of a cell (its vertices in order), for infill and checks. */
export function cellPolygon(points: readonly PlanPoint[], cell: TriCell): Polygon {
  return cell.vertices.map((v): Vec2 => [points[v][0], points[v][1]]);
}
