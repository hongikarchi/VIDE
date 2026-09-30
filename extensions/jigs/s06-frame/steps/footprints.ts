// S-06 frame jig · foundation footprints (PLAN-23 T-051, SPEC-06.11 2): the pile cap under every
// new column (`capSize`, turned with the frame), the open cut around it (`capSize + 2·openCutOffset`),
// the common cap of a twin pair (capSize × (capSize + spacing)), and the existing footings and basin
// bands as plan polygons for the 3D and plan views. Each new cap is also written as a block
// definition (a box with the open-cut outline at its base) so ④ can run the M0 diagnosis on it.

import type { Vec2, Vec3 } from '../../../../src/jigs/official/geometry-kit/index.ts';
import type { AssembleOutput } from './assemble.ts';
import type { ColumnsOutput } from './columns.ts';
import { bandsOf, footprintsOf, type SiteInput } from './roles.ts';

export interface FootprintsInputs {
  site: SiteInput;
  steps: { columns: ColumnsOutput; assemble: AssembleOutput };
}
export interface FootprintsParams {
  capSize: number;
  openCutOffset: number;
  ejWidth: number;
  columnSize: number;
}
export const DEFAULT_FOOTPRINTS_PARAMS: FootprintsParams = {
  capSize: 2.0,
  openCutOffset: 0.8,
  ejWidth: 0.6,
  columnSize: 0.5,
};
/** Depth of a cap below the column bottom (m): an assumption for the block solid, not a design value. */
export const CAP_DEPTH = 1.0;

export interface Shape {
  key: string;
  polygon: Vec2[];
  z: [number, number];
  /** Same ring with a z, for a polygon overlay layer. */
  points: Vec3[];
}
export interface CapShape extends Shape {
  columns: string[];
  kind: 'single' | 'common';
  center: Vec2;
  angleDeg: number;
}
export interface FootprintsOutput {
  schema: 'vide.s06.footprints/1';
  caps: CapShape[];
  openCuts: Shape[];
  existing: Shape[];
  basin: Shape[];
  /** Block definitions of the new caps (box + open-cut outline), by cap key, in world metres. */
  definitions: Record<string, { vertices: number[]; indices: number[]; segments: number[] }>;
  notes: string[];
}

const round = (v: number, digits = 6) => Number(v.toFixed(digits));

function resolveParams(params: Partial<FootprintsParams>): FootprintsParams {
  const out = { ...DEFAULT_FOOTPRINTS_PARAMS };
  for (const key of Object.keys(DEFAULT_FOOTPRINTS_PARAMS) as (keyof FootprintsParams)[])
    if (params[key] !== undefined) Object.assign(out, { [key]: params[key] });
  for (const key of ['capSize', 'openCutOffset', 'ejWidth', 'columnSize'] as const)
    if (!Number.isFinite(out[key]) || out[key] < 0)
      throw new RangeError(`${key} ${String(out[key])}`);
  if (!(out.capSize > 0)) throw new RangeError('capSize must be positive');
  return out;
}

/** Rectangle `along` × `acrossSize` about `center`, `along` axis turned by `angleDeg`. */
export function rectangle(
  center: Vec2,
  along: number,
  acrossSize: number,
  angleDeg: number,
): Vec2[] {
  const a = (angleDeg * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  const hu = along / 2,
    hv = acrossSize / 2;
  return (
    [
      [-hu, -hv],
      [hu, -hv],
      [hu, hv],
      [-hu, hv],
    ] as const
  ).map(([x, y]): Vec2 => [round(center[0] + c * x - s * y), round(center[1] + s * x + c * y)]);
}
const withZ = (ring: readonly Vec2[], z: number): Vec3[] => ring.map(([x, y]) => [x, y, round(z)]);

/** A closed box on a plan ring (bottom z0, top z1) as a triangle mesh plus an outline at z0. */
function box(ring: readonly Vec2[], z0: number, z1: number, outline: readonly Vec2[]) {
  const vertices: number[] = [];
  for (const z of [z0, z1]) for (const [x, y] of ring) vertices.push(x, y, round(z));
  const n = ring.length;
  const indices: number[] = [];
  for (let i = 1; i + 1 < n; i++) indices.push(0, i + 1, i, n, n + i, n + i + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  const segments: number[] = [];
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i],
      q = outline[(i + 1) % outline.length];
    segments.push(p[0], p[1], round(z0), q[0], q[1], round(z0));
  }
  return { vertices, indices, segments };
}

export function footprints(
  inputs: FootprintsInputs,
  params: Partial<FootprintsParams> = {},
): FootprintsOutput {
  const p = resolveParams(params);
  const cols = inputs.steps?.columns;
  const assembled = inputs.steps?.assemble;
  if (!cols || !assembled) throw new Error('COLUMNS_MISSING: 기둥 결과가 없습니다');
  const notes: string[] = [];
  const angle = assembled.frame.angleDeg;
  const cutSize = p.capSize + 2 * p.openCutOffset;
  const caps: CapShape[] = [];
  const openCuts: Shape[] = [];
  const definitions: FootprintsOutput['definitions'] = {};
  const paired = new Set<string>();
  const add = (
    key: string,
    columns: string[],
    kind: CapShape['kind'],
    center: Vec2,
    along: number,
    across: number,
    rectAngle: number,
    zTop: number,
  ) => {
    const ring = rectangle(center, along, across, rectAngle);
    const cut = rectangle(
      center,
      along + 2 * p.openCutOffset,
      across + 2 * p.openCutOffset,
      rectAngle,
    );
    const z: [number, number] = [round(zTop - CAP_DEPTH), round(zTop)];
    caps.push({
      key,
      columns,
      kind,
      center: [round(center[0]), round(center[1])],
      angleDeg: round(rectAngle, 3),
      polygon: ring,
      z,
      points: withZ(ring, z[1]),
    });
    openCuts.push({ key: `${key}:cut`, polygon: cut, z, points: withZ(cut, z[0]) });
    definitions[key] = box(ring, z[0], z[1], cut);
  };
  // Twin pairs first: one common cap for both columns, long side across the joint.
  for (const pair of cols.pairs ?? []) {
    if (pair.columns.length < 2) continue;
    const a = cols.columns.find((c) => c.key === pair.columns[0]);
    if (!a) continue;
    for (const key of pair.columns) paired.add(key);
    const acrossDeg = (Math.atan2(pair.across[1], pair.across[0]) * 180) / Math.PI;
    add(
      `cap:${pair.key.replace(/^pair:/, '')}`,
      pair.columns,
      'common',
      pair.at,
      p.capSize + pair.spacing,
      p.capSize,
      acrossDeg,
      a.bottom[2],
    );
  }
  for (const col of cols.columns) {
    if (paired.has(col.key)) continue;
    add(`cap:${col.mark}`, [col.key], 'single', col.at, p.capSize, p.capSize, angle, col.bottom[2]);
  }
  const existing = footprintsOf('existingFootings', inputs.site?.existingFootings, 'base');
  const basin = bandsOf('basinGirders', inputs.site?.basinGirders);
  if (existing.unreadable.length)
    notes.push(`기존 기초 ${existing.unreadable.length}개는 발자국을 읽지 못했습니다.`);
  if (basin.unreadable.length)
    notes.push(`유수지 보 ${basin.unreadable.length}개는 띠를 읽지 못했습니다.`);
  notes.push(
    `파일캡 ${p.capSize} m 각(쌍기둥은 ${p.capSize} × ${round(p.capSize + p.columnSize + p.ejWidth, 2)} m), 오픈컷 여유 ${p.openCutOffset} m, 캡 깊이 ${CAP_DEPTH} m는 가정입니다.`,
  );
  return {
    schema: 'vide.s06.footprints/1',
    caps,
    openCuts,
    existing: existing.shapes.map((s, i) => ({
      key: `E${i + 1}`,
      polygon: s.hull,
      z: s.z,
      points: withZ(s.hull, s.z[1]),
    })),
    basin: basin.shapes.map((s, i) => ({
      key: `B${i + 1}`,
      polygon: s.hull,
      z: s.z,
      points: withZ(s.hull, s.z[1]),
    })),
    definitions,
    notes,
  };
}
