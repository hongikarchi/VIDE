// 경계 자르기 (SPEC-16.5 3·5): one convex pattern cell ∩ the face region in (s, t). The cell is first
// cut by the face rectangle (half-planes, the non-closed directions), then by the trim loops (outer
// first, holes after) with a boundary-fragment stitch. Every output vertex keeps where it came from,
// so the lattice keys come out the same in both neighbours of a shared edge:
//
//   lattice vertex           — a cell corner (I, J)
//   cut point of a cell edge — `x`: the lattice edge (its two keys, ordered) and the parameter along
//                              it, computed on the full lattice edge in key order (so both cells
//                              compute the same number); the layout turns parameters into ordinals
//   trim loop vertex         — `loop`: loop index and vertex index in the face's own loop order
//   face rectangle corner    — `corner`
//
// The trim loops are assumed in general position against the lattice lines; a vertex on a cell
// edge or an edge running along one throws `ClipDegenerate`, and the layout retries the face with
// the loops nudged by a few nanometres (SPEC-16.5 has no meaning at that scale).

import { area2, cross2, inRing, type Vec2 } from './vec.ts';

export type VertexOrigin =
  | { kind: 'lat'; I: number; J: number }
  | { kind: 'x'; ka: string; kb: string; lam: number }
  | { kind: 'loop'; loop: number; index: number }
  | { kind: 'corner'; c: number };

export interface ClipVertex {
  p: Vec2;
  o: VertexOrigin;
}

/** What an edge of the clipped polygon lies on. */
type EdgeOrigin =
  | { kind: 'lat'; ka: string; kb: string; a: Vec2; b: Vec2 }
  | { kind: 'rect'; side: number }
  | { kind: 'loop' };

export class ClipDegenerate extends Error {}

export interface Region {
  /** Rectangle half-planes [axis, bound, keep ≥ (true) or ≤ (false), side id], none when closed. */
  halfPlanes: [0 | 1, number, boolean, number][];
  /** Loops in (s, t) with their vertex indices in the face's own order; outer first when `hasOuter`. */
  loops: { pts: Vec2[]; index: number[]; loop: number }[];
  hasOuter: boolean;
  /** Corner id of two rectangle sides. */
  cornerOf(sideA: number, sideB: number): { c: number; p: Vec2 };
}

export interface ClipResult {
  /** Rings: counter-clockwise pieces and clockwise holes. */
  rings: ClipVertex[][];
  /** The cell came out unchanged (no cut). */
  whole: boolean;
}

/** Clip one cell (counter-clockwise, convex) by the region. */
export function clipCell(
  st: readonly Vec2[],
  lat: readonly [number, number][],
  keyOf: (I: number, J: number) => string,
  region: Region,
  scale: number,
): ClipResult {
  let poly: ClipVertex[] = st.map((p, k) => ({
    p: [p[0], p[1]],
    o: { kind: 'lat', I: lat[k][0], J: lat[k][1] },
  }));
  let origins: EdgeOrigin[] = st.map((_, k) => {
    const k2 = (k + 1) % st.length;
    const ka = keyOf(lat[k][0], lat[k][1]),
      kb = keyOf(lat[k2][0], lat[k2][1]);
    return ka < kb
      ? { kind: 'lat', ka, kb, a: st[k] as Vec2, b: st[k2] as Vec2 }
      : { kind: 'lat', ka: kb, kb: ka, a: st[k2] as Vec2, b: st[k] as Vec2 };
  });
  const eps = scale * 1e-12;
  let whole = true;

  // 1. Face rectangle.
  for (const [axis, bound, keepGE, side] of region.halfPlanes) {
    const inside = (v: ClipVertex) =>
      keepGE ? v.p[axis] >= bound - eps : v.p[axis] <= bound + eps;
    if (poly.every(inside)) continue;
    whole = false;
    const out: ClipVertex[] = [];
    const outOrigins: EdgeOrigin[] = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const cur = poly[i],
        prevIndex = (i - 1 + n) % n,
        prev = poly[prevIndex],
        edge = origins[prevIndex];
      const cut = (): ClipVertex => {
        if (edge.kind === 'lat') {
          const va = edge.a[axis],
            vb = edge.b[axis];
          const lam = (bound - va) / (vb - va);
          const p: Vec2 = [
            edge.a[0] + lam * (edge.b[0] - edge.a[0]),
            edge.a[1] + lam * (edge.b[1] - edge.a[1]),
          ];
          p[axis] = bound;
          return { p, o: { kind: 'x', ka: edge.ka, kb: edge.kb, lam } };
        }
        if (edge.kind === 'rect') {
          const corner = region.cornerOf(edge.side, side);
          return { p: corner.p, o: { kind: 'corner', c: corner.c } };
        }
        const va = prev.p[axis],
          vb = cur.p[axis];
        const lam = (bound - va) / (vb - va);
        const p: Vec2 = [
          prev.p[0] + lam * (cur.p[0] - prev.p[0]),
          prev.p[1] + lam * (cur.p[1] - prev.p[1]),
        ];
        p[axis] = bound;
        return { p, o: { kind: 'corner', c: -1 } };
      };
      if (inside(cur)) {
        if (!inside(prev)) {
          out.push(cut());
          outOrigins.push(edge);
        }
        out.push(cur);
        outOrigins.push(origins[i]);
      } else if (inside(prev)) {
        out.push(cut());
        outOrigins.push({ kind: 'rect', side });
      }
    }
    // Drop repeated points (a vertex on the line also yields a cut point there).
    const keep: ClipVertex[] = [];
    const keepOrigins: EdgeOrigin[] = [];
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      const last = keep[keep.length - 1];
      if (last && Math.abs(last.p[0] - v.p[0]) <= eps && Math.abs(last.p[1] - v.p[1]) <= eps) {
        if (rank(v.o) > rank(last.o)) keep[keep.length - 1] = v;
        keepOrigins[keepOrigins.length - 1] = outOrigins[i];
        continue;
      }
      keep.push(v);
      keepOrigins.push(outOrigins[i]);
    }
    while (
      keep.length > 1 &&
      Math.abs(keep[0].p[0] - keep[keep.length - 1].p[0]) <= eps &&
      Math.abs(keep[0].p[1] - keep[keep.length - 1].p[1]) <= eps
    ) {
      const last = keep.pop()!;
      const lastOrigin = keepOrigins.pop()!;
      if (rank(last.o) > rank(keep[0].o)) keep[0] = last;
      void lastOrigin;
    }
    poly = keep;
    origins = keepOrigins;
    if (poly.length < 3 || Math.abs(area2(poly.map((v) => v.p))) <= eps * scale)
      return { rings: [], whole: false };
  }
  if (!region.loops.length) return { rings: [poly], whole };

  // 2. Trim loops.
  const rings = clipByLoops(poly, origins, region, scale);
  const unchanged =
    rings.length === 1 &&
    rings[0].length === poly.length &&
    rings[0].every((v) => v.o.kind === 'lat');
  return { rings, whole: whole && unchanged };
}

const rank = (o: VertexOrigin) =>
  o.kind === 'lat' ? 3 : o.kind === 'loop' ? 2 : o.kind === 'corner' ? 1 : 0;

interface Hit {
  id: number;
  p: Vec2;
  o: VertexOrigin;
  /** Position along the polygon edge and along the loop edge. */
  edge: number;
  alpha: number;
  loop: number;
  loopEdge: number;
  beta: number;
}

type Node = { hit: Hit } | { v: ClipVertex };

function clipByLoops(
  poly: ClipVertex[],
  origins: EdgeOrigin[],
  region: Region,
  scale: number,
): ClipVertex[][] {
  const n = poly.length;
  const e = 1e-9;
  const hits: Hit[] = [];
  const outer = region.hasOuter ? region.loops[0].pts : null;
  const holes = region.loops.slice(region.hasOuter ? 1 : 0).map((l) => l.pts);
  const inRegion = (p: Vec2) => (!outer || inRing(p, outer)) && !holes.some((h) => inRing(p, h));
  const inPoly = (p: Vec2) => {
    for (let i = 0; i < n; i++) {
      const a = poly[i].p,
        b = poly[(i + 1) % n].p;
      if (cross2([b[0] - a[0], b[1] - a[1]], [p[0] - a[0], p[1] - a[1]]) <= 0) return false;
    }
    return true;
  };
  let pminS = Infinity,
    pmaxS = -Infinity,
    pminT = Infinity,
    pmaxT = -Infinity;
  for (const v of poly) {
    pminS = Math.min(pminS, v.p[0]);
    pmaxS = Math.max(pmaxS, v.p[0]);
    pminT = Math.min(pminT, v.p[1]);
    pmaxT = Math.max(pmaxT, v.p[1]);
  }
  const near = scale * 1e-9;

  for (let li = 0; li < region.loops.length; li++) {
    const L = region.loops[li].pts;
    const m = L.length;
    for (let j = 0; j < m; j++) {
      const C = L[j],
        D = L[(j + 1) % m];
      if (
        Math.max(C[0], D[0]) < pminS - near ||
        Math.min(C[0], D[0]) > pmaxS + near ||
        Math.max(C[1], D[1]) < pminT - near ||
        Math.min(C[1], D[1]) > pmaxT + near
      )
        continue;
      const CD: Vec2 = [D[0] - C[0], D[1] - C[1]];
      for (let k = 0; k < n; k++) {
        const A = poly[k].p,
          B = poly[(k + 1) % n].p;
        const AB: Vec2 = [B[0] - A[0], B[1] - A[1]];
        const denom = cross2(AB, CD);
        const AC: Vec2 = [C[0] - A[0], C[1] - A[1]];
        const lenAB = Math.hypot(AB[0], AB[1]),
          lenCD = Math.hypot(CD[0], CD[1]);
        if (Math.abs(denom) <= 1e-14 * lenAB * lenCD) {
          // Parallel: degenerate only when on the same line and overlapping.
          if (Math.abs(cross2(AB, AC)) <= near * lenAB) {
            const t0 = (AC[0] * AB[0] + AC[1] * AB[1]) / (lenAB * lenAB);
            const t1 = t0 + (CD[0] * AB[0] + CD[1] * AB[1]) / (lenAB * lenAB);
            if (Math.max(t0, t1) >= -e && Math.min(t0, t1) <= 1 + e) throw new ClipDegenerate();
          }
          continue;
        }
        const alpha = cross2(AC, CD) / denom;
        const beta = cross2(AC, AB) / denom;
        if (alpha < -e || alpha > 1 + e || beta < -e || beta > 1 + e) continue;
        if (alpha < e || alpha > 1 - e || beta < e || beta > 1 - e) throw new ClipDegenerate();
        const edge = origins[k];
        let p: Vec2, o: VertexOrigin;
        if (edge.kind === 'lat') {
          const ab: Vec2 = [edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]];
          const lam = cross2([C[0] - edge.a[0], C[1] - edge.a[1]], CD) / cross2(ab, CD);
          p = [edge.a[0] + lam * ab[0], edge.a[1] + lam * ab[1]];
          o = { kind: 'x', ka: edge.ka, kb: edge.kb, lam };
        } else {
          p = [A[0] + alpha * AB[0], A[1] + alpha * AB[1]];
          o = { kind: 'loop', loop: region.loops[li].loop, index: -1 - region.loops[li].index[j] };
        }
        hits.push({ id: hits.length, p, o, edge: k, alpha, loop: li, loopEdge: j, beta });
      }
    }
  }

  const rings: ClipVertex[][] = [];
  const loopRing = (li: number): ClipVertex[] =>
    region.loops[li].pts.map((p, j) => ({
      p,
      o: { kind: 'loop', loop: region.loops[li].loop, index: region.loops[li].index[j] },
    }));
  if (!hits.length) {
    const a = poly[0].p,
      b = poly[1].p;
    if (inRegion([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) rings.push(poly);
    for (let li = 0; li < region.loops.length; li++)
      if (inPoly(region.loops[li].pts[0])) rings.push(loopRing(li));
    return rings;
  }

  // Walk lists: polygon vertices with its hits, each loop with its hits.
  const polyNodes: Node[] = [];
  for (let k = 0; k < n; k++) {
    polyNodes.push({ v: poly[k] });
    for (const h of hits.filter((x) => x.edge === k).sort((x, y) => x.alpha - y.alpha))
      polyNodes.push({ hit: h });
  }
  const loopNodes: Node[][] = region.loops.map((loop, li) => {
    const nodes: Node[] = [];
    const ring = loopRing(li);
    const mine = hits.filter((x) => x.loop === li);
    for (let j = 0; j < loop.pts.length; j++) {
      nodes.push({ v: ring[j] });
      for (const h of mine.filter((x) => x.loopEdge === j).sort((x, y) => x.beta - y.beta))
        nodes.push({ hit: h });
    }
    return nodes;
  });

  interface Fragment {
    start: number;
    end: number;
    points: ClipVertex[];
  }
  const kept = new Map<number, Fragment>();
  const fragments = (nodes: Node[], keep: (p: Vec2) => boolean) => {
    const first = nodes.findIndex((x) => 'hit' in x);
    if (first < 0) return;
    const count = nodes.length;
    let k = first;
    do {
      const startHit = (nodes[k] as { hit: Hit }).hit;
      const points: ClipVertex[] = [{ p: startHit.p, o: startHit.o }];
      let j = (k + 1) % count;
      while (!('hit' in nodes[j])) {
        points.push((nodes[j] as { v: ClipVertex }).v);
        j = (j + 1) % count;
      }
      const endHit = (nodes[j] as { hit: Hit }).hit;
      const next = points.length > 1 ? points[1].p : endHit.p;
      const mid: Vec2 = [(points[0].p[0] + next[0]) / 2, (points[0].p[1] + next[1]) / 2];
      if (keep(mid)) {
        if (kept.has(startHit.id)) throw new ClipDegenerate();
        kept.set(startHit.id, { start: startHit.id, end: endHit.id, points });
      }
      k = j;
    } while (k !== first);
  };
  fragments(polyNodes, inRegion);
  for (let li = 0; li < region.loops.length; li++) {
    if (loopNodes[li].some((x) => 'hit' in x)) fragments(loopNodes[li], inPoly);
    else if (inPoly(region.loops[li].pts[0])) rings.push(loopRing(li));
  }

  const used = new Set<number>();
  for (const fragment of kept.values()) {
    if (used.has(fragment.start)) continue;
    const ring: ClipVertex[] = [];
    let f: Fragment | undefined = fragment;
    let guard = 0;
    while (f && !used.has(f.start)) {
      used.add(f.start);
      ring.push(...f.points);
      f = kept.get(f.end);
      if (++guard > kept.size + 1) throw new ClipDegenerate();
    }
    if (!f || f.start !== fragment.start) throw new ClipDegenerate();
    rings.push(ring);
  }
  return rings;
}

/** Group rings into pieces (counter-clockwise) with the holes (clockwise) inside each. */
export function piecesOf(rings: ClipVertex[][]): { outline: ClipVertex[]; holes: number }[] {
  const pieces: { outline: ClipVertex[]; holes: number; area: number }[] = [];
  const holes: ClipVertex[][] = [];
  for (const ring of rings) {
    const a = area2(ring.map((v) => v.p));
    if (a > 0) pieces.push({ outline: ring, holes: 0, area: a });
    else if (a < 0) holes.push(ring);
  }
  for (const hole of holes) {
    const piece = pieces.find((x) =>
      inRing(
        hole[0].p,
        x.outline.map((v) => v.p),
      ),
    );
    if (piece) piece.holes++;
  }
  return pieces.sort((x, y) => y.area - x.area);
}
