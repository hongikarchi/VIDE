// 패널 타입 (SPEC-16.7 4, PLAN-49 T-256): two panels are the same shape when they have as many
// vertices and, over the cyclic re-indexings of the outline, the smallest largest distance between
// corresponding check points after a rigid alignment (rotation + translation, no mirror, least
// squares) is within the type tolerance.
//
//   check points  — vertex, edge midpoint, vertex, … (2n around the outline) and the centre; the flat
//                   plate's when the panel was planarized, else the points on the surface.
//   no mirror     — a flat outline and its mirror image differ only by turning the plate over, which a
//                   3D rotation can do. A marker at centre + normal·r (r = the RMS radius) joins the
//                   alignment, so the front face must stay the front face; it is not in the distance.
//   mirror image  — reflected across a plane through the normal, the outline reversed to stay
//                   counter-clockwise: a match only this way is another type, linked by `mirrorOf`.
//   alignment     — Horn's quaternion method (the largest eigenvector of the 4×4 matrix), so the
//                   rotation is always proper.
//   pose-free key — the sorted edge lengths and sorted centre distances. A match within d moves each
//                   by at most 2d, so half their largest difference is a lower bound of the deviation;
//                   the perimeter (|ΔP| ≤ 2n·d) buckets the candidates. Both only skip work.
//
// Grouping is deterministic: panels in their order, each joins the first existing type (by creation)
// whose representative is within the tolerance, else founds a new one. With a largest type count,
// the two closest representatives merge until it holds (ties: lower numbers; the representative of
// the larger type stays). Merging never moves a representative, so the remaining distances stay
// valid. Types whose vertex counts differ cannot merge; then the smallest reachable count is
// reported. Final numbers: larger count first, then the representative's order.

import { cross3, dot3, len3, norm3, sub3, type Vec3 } from './vec.ts';

export interface ShapeInput {
  vertices: readonly Vec3[];
  mids: readonly Vec3[];
  centre: Vec3;
  /** Front normal (unit). */
  normal: Vec3;
}

export interface Shape {
  n: number;
  /** 2n ring points (v0, m0, v1, m1, …) then centre, then the front marker; xyz flattened. */
  pts: Float64Array;
  /** Edge lengths |v_i v_{i+1}|. */
  edges: Float64Array;
  /** Centre distances |v_i c|. */
  radii: Float64Array;
  /** Sorted edges then sorted radii (pose free). */
  key: Float64Array;
  perimeter: number;
}

export function makeShape(input: ShapeInput): Shape {
  const n = input.vertices.length;
  const pts = new Float64Array((2 * n + 2) * 3);
  const put = (k: number, p: Vec3) => {
    pts[3 * k] = p[0];
    pts[3 * k + 1] = p[1];
    pts[3 * k + 2] = p[2];
  };
  let rms = 0;
  for (let i = 0; i < n; i++) {
    put(2 * i, input.vertices[i]);
    put(2 * i + 1, input.mids[i]);
    const a = sub3(input.vertices[i], input.centre),
      b = sub3(input.mids[i], input.centre);
    rms += dot3(a, a) + dot3(b, b);
  }
  rms = Math.sqrt(rms / (2 * n)) || 1;
  put(2 * n, input.centre);
  const nn = norm3(input.normal);
  put(2 * n + 1, [
    input.centre[0] + nn[0] * rms,
    input.centre[1] + nn[1] * rms,
    input.centre[2] + nn[2] * rms,
  ]);
  const edges = new Float64Array(n),
    radii = new Float64Array(n);
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    edges[i] = len3(sub3(input.vertices[(i + 1) % n], input.vertices[i]));
    radii[i] = len3(sub3(input.vertices[i], input.centre));
    perimeter += edges[i];
  }
  const key = new Float64Array(2 * n);
  key.set(Float64Array.from(edges).sort(), 0);
  key.set(Float64Array.from(radii).sort(), n);
  return { n, pts, edges, radii, key, perimeter };
}

/** The mirror image: reflected across a plane through the centre containing the normal, the outline
 *  reversed so it stays counter-clockwise from the (unchanged) front normal. */
export function mirrorShape(s: Shape): Shape {
  const n = s.n;
  const at = (k: number): Vec3 => [s.pts[3 * k], s.pts[3 * k + 1], s.pts[3 * k + 2]];
  const c = at(2 * n),
    marker = at(2 * n + 1);
  const normal = norm3(sub3(marker, c));
  let m = cross3(normal, sub3(at(0), c));
  if (len3(m) < 1e-12) m = cross3(normal, Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  m = norm3(m);
  const reflect = (p: Vec3): Vec3 => {
    const d = 2 * dot3(sub3(p, c), m);
    return [p[0] - d * m[0], p[1] - d * m[1], p[2] - d * m[2]];
  };
  // Ring reversed: k → −k (mod 2n) keeps vertices on even slots.
  const ring = Array.from({ length: 2 * n }, (_, k) => reflect(at((2 * n - k) % (2 * n))));
  return makeShape({
    vertices: ring.filter((_, k) => k % 2 === 0),
    mids: ring.filter((_, k) => k % 2 === 1),
    centre: c,
    normal,
  });
}

/** Lower bound of the deviation from the pose-free keys (same vertex count assumed). */
export function keyBound(a: Shape, b: Shape): number {
  let worst = 0;
  for (let i = 0; i < a.key.length; i++) worst = Math.max(worst, Math.abs(a.key[i] - b.key[i]));
  return worst / 2;
}

const N4 = new Float64Array(16);
const V4 = new Float64Array(16);

/** Largest-eigenvalue eigenvector of the symmetric 4×4 matrix in N4 (cyclic Jacobi). */
function largestEigen4(out: Float64Array) {
  const a = N4,
    v = V4;
  v.fill(0);
  v[0] = v[5] = v[10] = v[15] = 1;
  for (let sweep = 0; sweep < 40; sweep++) {
    let off = 0,
      diag = 0;
    for (let p = 0; p < 4; p++) {
      diag += Math.abs(a[p * 5]);
      for (let q = p + 1; q < 4; q++) off += Math.abs(a[p * 4 + q]);
    }
    if (off <= 1e-15 * (diag || 1)) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p * 4 + q];
        if (Math.abs(apq) <= 1e-300) continue;
        const theta = (a[q * 5] - a[p * 5]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1),
          sn = t * cs;
        for (let k = 0; k < 4; k++) {
          const akp = a[k * 4 + p],
            akq = a[k * 4 + q];
          a[k * 4 + p] = cs * akp - sn * akq;
          a[k * 4 + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p * 4 + k],
            aqk = a[q * 4 + k];
          a[p * 4 + k] = cs * apk - sn * aqk;
          a[q * 4 + k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k * 4 + p],
            vkq = v[k * 4 + q];
          v[k * 4 + p] = cs * vkp - sn * vkq;
          v[k * 4 + q] = sn * vkp + cs * vkq;
        }
      }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i * 5] > a[best * 5]) best = i;
  for (let k = 0; k < 4; k++) out[k] = v[k * 4 + best];
}

const Q = new Float64Array(4);

/**
 * Largest check-point distance after the least-squares rigid alignment of b (shifted by `shift`
 * vertices) onto a. The marker takes part in the fit, not in the distance.
 */
function alignedDistance(a: Shape, b: Shape, shift: number): number {
  const n = a.n,
    m = 2 * n + 2;
  const bi = (k: number) => (k < 2 * n ? (k + 2 * shift) % (2 * n) : k);
  let ax = 0,
    ay = 0,
    az = 0,
    bx = 0,
    by = 0,
    bz = 0;
  for (let k = 0; k < m; k++) {
    ax += a.pts[3 * k];
    ay += a.pts[3 * k + 1];
    az += a.pts[3 * k + 2];
    const j = bi(k);
    bx += b.pts[3 * j];
    by += b.pts[3 * j + 1];
    bz += b.pts[3 * j + 2];
  }
  ax /= m;
  ay /= m;
  az /= m;
  bx /= m;
  by /= m;
  bz /= m;
  let sxx = 0,
    sxy = 0,
    sxz = 0,
    syx = 0,
    syy = 0,
    syz = 0,
    szx = 0,
    szy = 0,
    szz = 0;
  for (let k = 0; k < m; k++) {
    const j = bi(k);
    const px = b.pts[3 * j] - bx,
      py = b.pts[3 * j + 1] - by,
      pz = b.pts[3 * j + 2] - bz;
    const qx = a.pts[3 * k] - ax,
      qy = a.pts[3 * k + 1] - ay,
      qz = a.pts[3 * k + 2] - az;
    sxx += px * qx;
    sxy += px * qy;
    sxz += px * qz;
    syx += py * qx;
    syy += py * qy;
    syz += py * qz;
    szx += pz * qx;
    szy += pz * qy;
    szz += pz * qz;
  }
  const N = N4;
  N[0] = sxx + syy + szz;
  N[1] = N[4] = syz - szy;
  N[2] = N[8] = szx - sxz;
  N[3] = N[12] = sxy - syx;
  N[5] = sxx - syy - szz;
  N[6] = N[9] = sxy + syx;
  N[7] = N[13] = szx + sxz;
  N[10] = -sxx + syy - szz;
  N[11] = N[14] = syz + szy;
  N[15] = -sxx - syy + szz;
  largestEigen4(Q);
  const [w, x, y, z] = Q;
  const r00 = w * w + x * x - y * y - z * z,
    r01 = 2 * (x * y - w * z),
    r02 = 2 * (x * z + w * y);
  const r10 = 2 * (x * y + w * z),
    r11 = w * w - x * x + y * y - z * z,
    r12 = 2 * (y * z - w * x);
  const r20 = 2 * (x * z - w * y),
    r21 = 2 * (y * z + w * x),
    r22 = w * w - x * x - y * y + z * z;
  let worst = 0;
  for (let k = 0; k < m - 1; k++) {
    const j = bi(k);
    const px = b.pts[3 * j] - bx,
      py = b.pts[3 * j + 1] - by,
      pz = b.pts[3 * j + 2] - bz;
    const dx = r00 * px + r01 * py + r02 * pz - (a.pts[3 * k] - ax);
    const dy = r10 * px + r11 * py + r12 * pz - (a.pts[3 * k + 1] - ay);
    const dz = r20 * px + r21 * py + r22 * pz - (a.pts[3 * k + 2] - az);
    const d = dx * dx + dy * dy + dz * dz;
    if (d > worst) worst = d;
  }
  return Math.sqrt(worst);
}

/**
 * The deviation of b against a: the smallest, over the cyclic re-indexings, largest check-point
 * distance after rigid alignment. Infinity when the vertex counts differ. Shifts whose edge/radius
 * lower bound is above `bound` (or the best found) are skipped; the result above `bound` may then
 * be Infinity.
 */
export function deviation(a: Shape, b: Shape, bound = Infinity): number {
  if (a.n !== b.n) return Infinity;
  const n = a.n;
  let best = Infinity;
  for (let r = 0; r < n; r++) {
    let lb = 0;
    for (let i = 0; i < n && lb <= bound && lb < best; i++) {
      lb = Math.max(
        lb,
        Math.abs(a.edges[i] - b.edges[(i + r) % n]) / 2,
        Math.abs(a.radii[i] - b.radii[(i + r) % n]) / 2,
      );
    }
    if (lb > bound || lb >= best) continue;
    const d = alignedDistance(a, b, r);
    if (d < best) best = d;
  }
  return best;
}

export interface TypeGroup {
  /** Index of the representative shape. */
  rep: number;
  /** Shape indices in order. */
  members: number[];
  /** Index (in the returned list) of the type this one mirrors, or null. */
  mirrorOf: number | null;
}

export interface Grouping {
  /** Final order: larger count first, then the representative's order. */
  types: TypeGroup[];
  /** Per shape: index into `types`. */
  typeOf: number[];
  /** Per shape: deviation against its type's representative (0 for representatives). */
  deviation: number[];
  /** When `maxTypes` could not be met: the smallest reachable count. */
  unmet: number | null;
}

interface Live {
  id: number;
  rep: number;
  members: number[];
  alive: boolean;
}

/** Group shapes (already in panel order) by the type tolerance, then down to `maxTypes`. */
export function groupShapes(
  shapes: readonly Shape[],
  typeTol: number,
  maxTypes: number | null,
): Grouping {
  const eps = typeTol * 1e-9 + 1e-12;
  const live: Live[] = [];
  const dev = new Array<number>(shapes.length).fill(0);
  // Buckets per vertex count by perimeter.
  const buckets = new Map<number, Map<number, number[]>>();
  const width = (n: number) => Math.max(2 * n * typeTol, 1e-9);
  for (let s = 0; s < shapes.length; s++) {
    const shape = shapes[s];
    const w = width(shape.n);
    const b = Math.floor(shape.perimeter / w);
    let byN = buckets.get(shape.n);
    if (!byN) buckets.set(shape.n, (byN = new Map()));
    const cands: number[] = [];
    for (const k of [b - 1, b, b + 1]) for (const t of byN.get(k) ?? []) cands.push(t);
    cands.sort((x, y) => x - y);
    let joined = -1;
    for (const t of cands) {
      const rep = shapes[live[t].rep];
      if (Math.abs(rep.perimeter - shape.perimeter) > 2 * shape.n * typeTol + eps) continue;
      if (keyBound(rep, shape) > typeTol + eps) continue;
      const d = deviation(rep, shape, typeTol + eps);
      if (d <= typeTol + eps) {
        joined = t;
        dev[s] = d;
        break;
      }
    }
    if (joined >= 0) live[joined].members.push(s);
    else {
      const id = live.length;
      live.push({ id, rep: s, members: [s], alive: true });
      const list = byN.get(b);
      if (list) list.push(id);
      else byN.set(b, [id]);
    }
  }

  let unmet: number | null = null;
  if (maxTypes !== null && live.length > maxTypes) {
    unmet = mergeDown(shapes, live, maxTypes);
    // Members of merged types are measured against the surviving representative.
    for (const t of live)
      if (t.alive)
        for (const s of t.members) dev[s] = s === t.rep ? 0 : deviation(shapes[t.rep], shapes[s]);
  }

  const alive = live.filter((t) => t.alive);
  alive.sort((x, y) => y.members.length - x.members.length || x.rep - y.rep);
  const typeOf = new Array<number>(shapes.length).fill(-1);
  const types: TypeGroup[] = alive.map((t, i) => {
    const members = t.members.slice().sort((x, y) => x - y);
    for (const s of members) typeOf[s] = i;
    return { rep: t.rep, members, mirrorOf: null };
  });
  linkMirrors(shapes, types, typeTol + eps);
  return { types, typeOf, deviation: dev, unmet };
}

/** Merge the two closest representatives until `maxTypes` holds or no two share a vertex count. */
function mergeDown(shapes: readonly Shape[], live: Live[], maxTypes: number): number | null {
  // Alive types per vertex count, sorted by the representative's perimeter.
  const byN = new Map<number, Live[]>();
  for (const t of live) {
    const n = shapes[t.rep].n;
    const list = byN.get(n);
    if (list) list.push(t);
    else byN.set(n, [t]);
  }
  for (const list of byN.values())
    list.sort((a, b) => shapes[a.rep].perimeter - shapes[b.rep].perimeter || a.id - b.id);
  const nearest = new Map<number, { other: number; d: number }>();
  const cache = new Map<string, number>();
  const pairDev = (a: Live, b: Live) => {
    const k = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let d = cache.get(k);
    if (d === undefined) {
      d = deviation(shapes[a.rep], shapes[b.rep]);
      cache.set(k, d);
    }
    return d;
  };
  const better = (d: number, o: number, bd: number, bo: number) => d < bd || (d === bd && o < bo);
  const findNearest = (t: Live) => {
    const list = byN.get(shapes[t.rep].n)!;
    const n = shapes[t.rep].n;
    const p = shapes[t.rep].perimeter;
    const at = list.indexOf(t);
    let best = { other: -1, d: Infinity };
    // Walk outward by perimeter; |ΔP| / 2n is a lower bound of the deviation.
    for (const dir of [-1, 1]) {
      for (let i = at + dir; i >= 0 && i < list.length; i += dir) {
        const o = list[i];
        const lb = Math.abs(shapes[o.rep].perimeter - p) / (2 * n);
        if (lb > best.d) break;
        if (keyBound(shapes[t.rep], shapes[o.rep]) > best.d) continue;
        const d = pairDev(t, o);
        if (better(d, o.id, best.d, best.other)) best = { other: o.id, d };
      }
    }
    if (best.other >= 0) nearest.set(t.id, best);
    else nearest.delete(t.id);
  };
  for (const t of live) findNearest(t);
  let count = live.length;
  while (count > maxTypes) {
    let pick: { a: number; b: number; d: number } | null = null;
    for (const [id, nb] of nearest) {
      const a = Math.min(id, nb.other),
        b = Math.max(id, nb.other);
      if (
        !pick ||
        nb.d < pick.d ||
        (nb.d === pick.d && (a < pick.a || (a === pick.a && b < pick.b)))
      )
        pick = { a, b, d: nb.d };
    }
    if (!pick) break;
    const ta = live[pick.a],
      tb = live[pick.b];
    const [keep, gone] = tb.members.length > ta.members.length ? [tb, ta] : [ta, tb]; // tie: lower number stays
    keep.members.push(...gone.members);
    gone.alive = false;
    count--;
    const list = byN.get(shapes[gone.rep].n)!;
    list.splice(list.indexOf(gone), 1);
    nearest.delete(gone.id);
    for (const t of live)
      if (t.alive) {
        const nb = nearest.get(t.id);
        if (!nb || nb.other === gone.id) findNearest(t);
      }
  }
  return count > maxTypes ? count : null;
}

/** Mark mirror pairs: a type whose representative matches another's only as a mirror image. */
function linkMirrors(shapes: readonly Shape[], types: TypeGroup[], tol: number) {
  const mirrored = new Map<number, Shape>();
  const mirrorOf = (i: number) => {
    let m = mirrored.get(i);
    if (!m) mirrored.set(i, (m = mirrorShape(shapes[types[i].rep])));
    return m;
  };
  const order = types
    .map((t, i) => i)
    .sort((x, y) => shapes[types[x].rep].perimeter - shapes[types[y].rep].perimeter || x - y);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    const a = shapes[types[i].rep];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      const b = shapes[types[j].rep];
      if (b.perimeter - a.perimeter > 2 * a.n * tol) break;
      if (a.n !== b.n || keyBound(a, b) > tol) continue;
      if (deviation(a, mirrorOf(j), tol) <= tol) {
        const [lo, hi] = i < j ? [i, j] : [j, i];
        if (types[hi].mirrorOf === null) types[hi].mirrorOf = lo;
        if (types[lo].mirrorOf === null) types[lo].mirrorOf = hi;
      }
    }
  }
}
