// Plan section outline of a triangle mesh (T-283, SPEC-05.8 솔리드 단면): the Sync jig compares a
// solid-only Rhino model with a drawing through the outline of each solid cut by a horizontal
// plane. Sync sends Breps and Extrusions as render meshes (flat xyz `vertices`, triangle
// `indices`, one mesh per Brep face, so seams repeat vertices); the cut uses the same edge
// crossing as `sectionArea` (a vertex on the plane counts as above it) on the welded mesh, chains
// the crossing points into loops by shared mesh edges, and merges collinear runs into straight
// edges. General geometry only.

import type { Vec3 } from './plan.ts';
import { planeCrossing } from './solid.ts';

export interface SectionOptions {
  /** Vertices closer than this are one vertex (m, default 1e-6). */
  weld?: number;
  /** Points within this distance of a run's chord stay in one straight edge (m, default 1e-4). */
  straight?: number;
  /** Straight edges shorter than this are dropped (m, default 1e-4). */
  minEdge?: number;
}

export interface SectionOutline {
  /** Chained section points, in mesh order; `closed[i]` when loop i returns to its start. */
  loops: Vec3[][];
  closed: boolean[];
  /** Straight edges of the loops (collinear runs merged), at height z. */
  edges: [Vec3, Vec3][];
}

/** Section of a triangle mesh by the plane at height `z`: its loops and straight edges. */
export function sectionOutline(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  z: number,
  options: SectionOptions = {},
): SectionOutline {
  const weld = options.weld ?? 1e-6;
  const tol = options.straight ?? 1e-4;
  const minEdge = options.minEdge ?? 1e-4;
  const empty: SectionOutline = { loops: [], closed: [], edges: [] };
  const count = Math.floor(vertices.length / 3);
  if (!count || indices.length < 3 || !Number.isFinite(z)) return empty;

  // Weld by position so the faces of neighbouring Brep faces share their seam vertices.
  const welded = new Int32Array(count);
  const positions: Vec3[] = [];
  const byKey = new Map<string, number>();
  const quantum = weld > 0 ? weld : 1e-9;
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]];
    const k = `${Math.round(p[0] / quantum)},${Math.round(p[1] / quantum)},${Math.round(p[2] / quantum)}`;
    let id = byKey.get(k);
    if (id === undefined) {
      id = positions.length;
      positions.push(p);
      byKey.set(k, id);
    }
    welded[i] = id;
  }

  // One crossing point per mesh edge (or per vertex lying on the plane), keyed by topology so
  // both triangles of an edge name the same point.
  const points = new Map<string, Vec3>();
  const crossing = (i: number, j: number): string | undefined => {
    const lo = Math.min(i, j),
      hi = Math.max(i, j);
    const hit = planeCrossing(positions[lo], positions[hi], z);
    if (!hit) return undefined;
    const on = positions[lo][2] === z ? lo : positions[hi][2] === z ? hi : -1;
    const key = on >= 0 ? 'v' + on : 'e' + lo + ':' + hi;
    if (!points.has(key)) points.set(key, on >= 0 ? [positions[on][0], positions[on][1], z] : hit);
    return key;
  };
  const links = new Map<string, string[]>();
  const seen = new Set<string>();
  const link = (a: string, b: string) => {
    const pair = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(pair)) return;
    seen.add(pair);
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = welded[indices[t]],
      b = welded[indices[t + 1]],
      c = welded[indices[t + 2]];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (a === b || b === c || a === c) continue;
    const hits = new Set<string>();
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = crossing(p, q);
      if (key) hits.add(key);
    }
    if (hits.size === 2) {
      const [p, q] = [...hits];
      link(p, q);
    }
  }
  if (!links.size) return empty;

  // Chain: open chains from their ends first, then the closed loops.
  const used = new Set<string>();
  const edgeKey = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);
  const walk = (start: string) => {
    const chain = [start];
    let at = start;
    for (;;) {
      const next = (links.get(at) ?? []).find((n) => !used.has(edgeKey(at, n)));
      if (next === undefined) break;
      used.add(edgeKey(at, next));
      chain.push(next);
      at = next;
      if (next === start) break;
    }
    return chain;
  };
  const loops: Vec3[][] = [];
  const closed: boolean[] = [];
  const starts = [...[...links.keys()].filter((k) => links.get(k)!.length !== 2), ...links.keys()];
  for (const start of starts)
    while ((links.get(start) ?? []).some((n) => !used.has(edgeKey(start, n)))) {
      const chain = walk(start);
      if (chain.length < 2) break;
      const isClosed = chain.length > 2 && chain[0] === chain[chain.length - 1];
      if (isClosed) chain.pop();
      loops.push(chain.map((k) => points.get(k)!));
      closed.push(isClosed);
    }

  const edges: [Vec3, Vec3][] = [];
  loops.forEach((loop, i) => {
    for (const edge of straightRuns(loop, closed[i], tol))
      if (Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]) >= minEdge) edges.push(edge);
  });
  return { loops, closed, edges };
}

/** Distance of p from the line through a and b (XY). */
function offChord(p: Vec3, a: Vec3, b: Vec3) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Collinear runs of a chain merged into straight edges (a closed loop starts at a corner). */
function straightRuns(points: Vec3[], isClosed: boolean, tol: number): [Vec3, Vec3][] {
  let list = points;
  if (isClosed) {
    const n = points.length;
    if (n < 3) return [];
    const corner = points.findIndex(
      (p, i) => offChord(p, points[(i + n - 1) % n], points[(i + 1) % n]) > tol,
    );
    if (corner < 0) return [];
    list = [...points.slice(corner), ...points.slice(0, corner), points[corner]];
  }
  const out: [Vec3, Vec3][] = [];
  let i = 0;
  while (i < list.length - 1) {
    let j = i + 1;
    while (j + 1 < list.length) {
      let fits = true;
      for (let k = i + 1; k <= j; k++)
        if (offChord(list[k], list[i], list[j + 1]) > tol) {
          fits = false;
          break;
        }
      if (!fits) break;
      j++;
    }
    out.push([list[i], list[j]]);
    i = j;
  }
  return out;
}
