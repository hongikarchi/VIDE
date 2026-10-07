// ⑥ 지형 (SPEC-12.5, setting '지형 포함' default off): off → flat ground at height 0 and '지형 없음'.
// On → the contours (resampled every 5 m) and spot heights of the 수치지형도 SHP put in, triangulated
// (Delaunay) into a mesh; triangles with an edge over 150 m (the hull's long slivers) are dropped.
// The mesh is cut into pieces of at most 1,500 faces so each fits one Rhino bake body.

import Delaunator from 'delaunator';
import { round } from './common.ts';
import type { FrameOutput } from './frame.ts';

type P3 = [number, number, number];
export interface TerrainOutput {
  included: boolean;
  note: string;
  points: number;
  mesh: { key: string; vertices: P3[]; faces: number[][]; source: string }[];
  contours: { key: string; curve: P3[]; elevation: string }[];
  /** Triangles for sampling heights (document coordinates). */
  triangles: [P3, P3, P3][];
  range: { min: number; max: number } | null;
  /** 대지 고저차: highest less lowest ground on the site outline, when there is terrain. */
  relief_m: number | null;
  checks: string[];
}

const RESAMPLE = 5;
const MAX_EDGE = 150;
const PIECE_FACES = 1500;

/** Height of the terrain at a plan point (barycentric in the triangle holding it), or null. */
export function heightAt(triangles: readonly [P3, P3, P3][], x: number, y: number): number | null {
  for (const [a, b, c] of triangles) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return l1 * a[2] + l2 * b[2] + l3 * c[2];
  }
  return null;
}

export function terrain(
  inputs: { steps: { frame: FrameOutput } },
  params: { terrain?: boolean },
): TerrainOutput {
  const { frame } = inputs.steps;
  const empty = (note: string, checks: string[] = []): TerrainOutput => ({
    included: false,
    note,
    points: 0,
    mesh: [],
    contours: [],
    triangles: [],
    range: null,
    relief_m: null,
    checks,
  });
  if (!params.terrain) return empty('지형 없음 — 평지(높이 0)로 둡니다');
  const points: P3[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number, z: number) => {
    const key = `${x.toFixed(2)},${y.toFixed(2)}`;
    if (seen.has(key)) return;
    seen.add(key);
    points.push([round(x, 3), round(y, 3), round(z, 3)]);
  };
  for (const contour of frame.contours) {
    const line = contour.line;
    for (let i = 0; i < line.length; i++) {
      add(line[i][0], line[i][1], contour.z);
      if (i + 1 < line.length) {
        const [a, b] = [line[i], line[i + 1]];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.floor(length / RESAMPLE);
        for (let k = 1; k < n; k++)
          add(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, contour.z);
      }
    }
  }
  for (const spot of frame.spots) add(spot.at[0], spot.at[1], spot.z);
  if (points.length < 3)
    return empty('지형 자료 없음 — 평지(높이 0)로 둡니다', [
      '지형 포함이 켜져 있지만 등고선·표고점이 없습니다. 수치지형도 SHP(등고선 F0010000·표고점 F0020000)를 넣으세요',
    ]);
  const delaunay = Delaunator.from(points.map((p) => [p[0], p[1]]));
  const faces: number[][] = [];
  const tri = delaunay.triangles;
  for (let t = 0; t < tri.length; t += 3) {
    const [a, b, c] = [tri[t], tri[t + 1], tri[t + 2]];
    const edge = (i: number, j: number) =>
      Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
    if (Math.max(edge(a, b), edge(b, c), edge(c, a)) > MAX_EDGE) continue;
    faces.push([a, b, c]);
  }
  const triangles = faces.map(([a, b, c]) => [points[a], points[b], points[c]] as [P3, P3, P3]);
  // Pieces of at most PIECE_FACES faces, each with only its own vertices.
  const mesh: TerrainOutput['mesh'] = [];
  for (let start = 0; start < faces.length; start += PIECE_FACES) {
    const index = new Map<number, number>();
    const vertices: P3[] = [];
    const piece = faces.slice(start, start + PIECE_FACES).map((face) =>
      face.map((i) => {
        let j = index.get(i);
        if (j === undefined) {
          j = vertices.length;
          index.set(i, j);
          vertices.push(points[i]);
        }
        return j;
      }),
    );
    mesh.push({
      key: `terrain:${mesh.length + 1}`,
      vertices,
      faces: piece,
      source: '넣은 수치지형도 SHP(등고선·표고점)',
    });
  }
  const zs = points.map((p) => p[2]);
  const ground = frame.site.rings
    .flat()
    .map(([x, y]) => heightAt(triangles, x, y))
    .filter((z): z is number => z !== null);
  const checks: string[] = [];
  if (frame.site.rings.length && ground.length < frame.site.rings.flat().length)
    checks.push('대지 경계 일부가 지형 범위 밖입니다');
  return {
    included: true,
    note: `지형 메쉬 ${faces.length}면 (점 ${points.length})`,
    points: points.length,
    mesh,
    contours: frame.contours.map((c) => ({ key: c.key, curve: c.line, elevation: String(c.z) })),
    triangles,
    range: { min: Math.min(...zs), max: Math.max(...zs) },
    relief_m: ground.length ? round(Math.max(...ground) - Math.min(...ground), 2) : null,
    checks,
  };
}
