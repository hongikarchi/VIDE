// 타입 만들기의 배치 (SPEC-16.9 1·6, PLAN-49 T-257): what [타입 만들기] places in Rhino, from the
// stage results. One block definition per panel type — the representative's flat plate (its outline
// laid as the cut outline: first vertex at the origin, pattern axis +X, front face +Z, SPEC-16.7 6)
// pushed by the thickness to the thickness side — and one placement per typed panel: the rigid
// transform (rotation, no mirror, and translation) that puts the representative's outline on that
// panel's flat plate. The placement is the 2D least-squares fit of the two outlines over the cyclic
// re-indexings (the typing matched them the same way, SPEC-16.7 4) carried into the panel's plate
// frame, so a panel within the type tolerance gets its type's block where its own plate is.
//
// Panels the typing did not type (failed in an earlier stage, plate area 0: `T-00`) and panels
// farther than the tolerance from their representative (`over-type-tol`) are not given the block —
// never silently fitted (SPEC-16.7 4, 16.9 5): they come back as failures with their outline (the
// flat plate when there is one, else the stage-1 corners) for the failure layer. Panels dropped by
// the boundary rule are the person's choice and are left out.
//
// Also the cut sheet (재단 윤곽, SPEC-16.7 6): every flat outline laid on the XY plane beside the
// surface in a grid, by type then panel number, for `curves@1` and its numbers.

import type {
  MemberSet,
  PanelLayout,
  PanelTyping,
  PreviewSettings,
  SurfaceSample,
} from '../../../contracts/paneling.ts';
import { measurePlate, planarize, type PlateGeometry } from './flatness.ts';
import { faceSampler, type FaceSampler } from './sample.ts';
import { comparePanels } from './schedule.ts';
import { patternAxis, plateFrame, unrollPlate } from './unroll.ts';
import { add3, scale3, sub3, type Vec2, type Vec3 } from './vec.ts';

/** Placeholder type of an untyped panel (contract `PanelTyping`). */
const UNTYPED = 'T-00';

export interface TypeBlock {
  type: string;
  class: PanelTyping['types'][number]['class'];
  representative: string;
  /** The representative's flat outline in the block's own frame (m, counter-clockwise from +Z). */
  outline: Vec2[];
}
export interface PanelPlacement {
  id: string;
  type: string;
  class: PanelTyping['panels'][number]['class'];
  flatness: number;
  /** Row-major 3×3 rotation of the block frame into the world (columns: X, Y, front normal). */
  rotation: number[];
  /** World position of the block frame's origin (m). */
  origin: Vec3;
  /** Largest distance of the placed block outline from the panel's own flat plate (m). */
  fit: number;
  /** Plate width × height (the type's representative, SPEC-16.2 공통 규칙 4). */
  size: [number, number];
  boundary: boolean;
  pole: boolean;
}
export interface PlacementFailure {
  id: string;
  code: string;
  message: string;
  /** Outline for the failure layer, world metres. */
  outline: Vec3[];
}
export interface TypePlacements {
  blocks: TypeBlock[];
  placements: PanelPlacement[];
  failures: PlacementFailure[];
}

export interface PlacementInput {
  sample: SurfaceSample;
  layout: PanelLayout;
  members: MemberSet;
  typing: PanelTyping;
  /** Stage-1 direction: pattern axis and start corner for the frame, `flip` for the front. */
  direction: PreviewSettings['direction']['value'];
}

interface Plate {
  geometry: PlateGeometry;
  flat: Vec3[];
  x: Vec3;
  y: Vec3;
  outline: Vec2[];
}

/** The flat plate of a member and its frame, exactly as the typing laid its cut outline. */
function plateOf(
  sampler: FaceSampler,
  uv: readonly Vec2[],
  direction: PlacementInput['direction'],
): Plate {
  const geometry = measurePlate(sampler, uv, direction.flip ? -1 : 1);
  const flat = planarize(geometry);
  const cuv = geometry.checkUV[geometry.checkUV.length - 1];
  const axis = patternAxis(sampler, cuv, direction.axis, direction.startCorner);
  const frame = plateFrame(geometry.plane.normal, axis, sub3(flat[1], flat[0]));
  return { geometry, flat, ...frame, outline: unrollPlate(flat, frame).outline };
}

/**
 * The rigid 2D map (rotation by `angle`, then `shift`) putting outline `a` on outline `b` with `a[k]`
 * on `b[(k + offset) % n]`, chosen over the offsets by the smallest largest distance.
 */
export function fitOutline(
  a: readonly Vec2[],
  b: readonly Vec2[],
): { angle: number; shift: Vec2; offset: number; worst: number } {
  const n = a.length;
  let best = { angle: 0, shift: [0, 0] as Vec2, offset: 0, worst: Infinity };
  if (b.length !== n) return best;
  const ca = centroid(a);
  for (let offset = 0; offset < n; offset++) {
    const cb = centroid(b, offset);
    let dot = 0,
      cross = 0;
    for (let k = 0; k < n; k++) {
      const ax = a[k][0] - ca[0],
        ay = a[k][1] - ca[1];
      const q = b[(k + offset) % n];
      const bx = q[0] - cb[0],
        by = q[1] - cb[1];
      dot += ax * bx + ay * by;
      cross += ax * by - ay * bx;
    }
    const angle = Math.atan2(cross, dot);
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const shift: Vec2 = [cb[0] - (c * ca[0] - s * ca[1]), cb[1] - (s * ca[0] + c * ca[1])];
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const q = b[(k + offset) % n];
      const x = c * a[k][0] - s * a[k][1] + shift[0],
        y = s * a[k][0] + c * a[k][1] + shift[1];
      worst = Math.max(worst, Math.hypot(x - q[0], y - q[1]));
    }
    if (worst < best.worst - 1e-12) best = { angle, shift, offset, worst };
  }
  return best;
}
function centroid(points: readonly Vec2[], offset = 0): Vec2 {
  let x = 0,
    y = 0;
  for (let k = 0; k < points.length; k++) {
    const p = points[(k + offset) % points.length];
    x += p[0];
    y += p[1];
  }
  return [x / points.length, y / points.length];
}

/** Block definitions, placements and failures of a [타입 만들기]. */
export function typePlacements(input: PlacementInput): TypePlacements {
  const { sample, layout, members, typing, direction } = input;
  const samplers = new Map(sample.faces.map((f) => [f.faceIndex, faceSampler(f)]));
  const panelOf = new Map(layout.panels.map((p) => [p.id, p]));
  const memberOf = new Map(members.members.map((m) => [m.panelId, m]));
  const typeOf = new Map(typing.types.map((t) => [t.type, t]));
  const plates = new Map<string, Plate | null>();
  const plate = (id: string): Plate | null => {
    if (plates.has(id)) return plates.get(id)!;
    const panel = panelOf.get(id);
    const member = memberOf.get(id);
    const sampler = panel ? samplers.get(panel.faceIndex) : undefined;
    const value =
      panel && member && sampler && !member.failure && member.uv.length >= 3
        ? plateOf(sampler, member.uv as Vec2[], direction)
        : null;
    plates.set(id, value);
    return value;
  };
  const blocks: TypeBlock[] = [];
  const blockOf = new Map<string, TypeBlock | null>();
  for (const type of typing.types) {
    const rep = plate(type.representative);
    const block = rep
      ? {
          type: type.type,
          class: type.class,
          representative: type.representative,
          outline: rep.outline,
        }
      : null;
    blockOf.set(type.type, block);
    if (block) blocks.push(block);
  }
  const placements: PanelPlacement[] = [];
  const failures: PlacementFailure[] = [];
  const ordered = typing.panels
    .map((t) => ({ t, p: panelOf.get(t.panelId) }))
    .filter((row): row is { t: (typeof typing.panels)[number]; p: PanelLayout['panels'][number] } =>
      Boolean(row.p),
    )
    .sort((a, b) => comparePanels(a.p, b.p));
  for (const { t, p } of ordered) {
    if (p.failure?.code === 'dropped') continue;
    const own = plate(t.panelId);
    const fallback = own ? own.flat : (p.corners as Vec3[]);
    const block = t.type === UNTYPED ? null : blockOf.get(t.type);
    const failure =
      t.failure ??
      (t.type === UNTYPED
        ? { code: 'degenerate', message: '타입이 없는 패널입니다' }
        : !block || !own
          ? { code: 'make-failed', message: '대표 패널의 판을 만들 수 없습니다' }
          : null);
    if (failure || !block || !own) {
      failures.push({
        id: t.panelId,
        code: failure?.code ?? 'make-failed',
        message: failure?.message ?? '',
        outline: fallback,
      });
      continue;
    }
    const fit = fitOutline(block.outline, own.outline);
    if (!Number.isFinite(fit.worst)) {
      failures.push({
        id: t.panelId,
        code: 'make-failed',
        message: '꼭짓점 수가 타입 대표와 다릅니다',
        outline: own.flat,
      });
      continue;
    }
    // Block frame → panel plate frame (2D fit) → world (plate origin, X, Y, front normal).
    const c = Math.cos(fit.angle),
      s = Math.sin(fit.angle);
    const n = own.geometry.plane.normal;
    const X = add3(scale3(own.x, c), scale3(own.y, s));
    const Y = add3(scale3(own.x, -s), scale3(own.y, c));
    const origin = add3(
      own.flat[0],
      add3(scale3(own.x, fit.shift[0]), scale3(own.y, fit.shift[1])),
    );
    const type = typeOf.get(t.type)!;
    placements.push({
      id: t.panelId,
      type: t.type,
      class: t.class,
      flatness: t.flatness,
      rotation: [X[0], Y[0], n[0], X[1], Y[1], n[1], X[2], Y[2], n[2]],
      origin,
      fit: fit.worst,
      size: [type.size[0], type.size[1]],
      boundary: p.boundary,
      pole: p.pole,
    });
  }
  return { blocks, placements, failures };
}

/** World point of a block-frame point under a placement. */
export function placePoint(placement: Pick<PanelPlacement, 'rotation' | 'origin'>, p: Vec3): Vec3 {
  const r = placement.rotation;
  return [
    placement.origin[0] + r[0] * p[0] + r[1] * p[1] + r[2] * p[2],
    placement.origin[1] + r[3] * p[0] + r[4] * p[1] + r[5] * p[2],
    placement.origin[2] + r[6] * p[0] + r[7] * p[1] + r[8] * p[2],
  ];
}

export interface CutOutline {
  id: string;
  type: string;
  /** Closed outline on the XY plane (the first point repeated at the end), world metres. */
  outline: Vec3[];
  /** Where the number goes (the outline's middle). */
  label: Vec3;
}
/** Gap between cut outlines and from the surface (m). */
export const CUT_GAP = 0.1;

/**
 * The cut outlines of the flat plates laid in a grid on the XY plane to the right of the panels
 * (SPEC-16.7 6): ordered by type then panel number, each outline moved so its box starts at its
 * cell; z is the panels' lowest point. Panels without a flat outline (curved, not planarized) are not
 * in the sheet (일람표 '펼침 없음 · 곡면').
 */
export function cutSheet(layout: PanelLayout, typing: PanelTyping): CutOutline[] {
  const panelOf = new Map(layout.panels.map((p) => [p.id, p]));
  const rows = typing.panels
    .filter((t) => t.flat && t.type !== UNTYPED && panelOf.has(t.panelId))
    .sort(
      (a, b) =>
        (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
        comparePanels(panelOf.get(a.panelId)!, panelOf.get(b.panelId)!),
    );
  if (!rows.length) return [];
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    z0 = Infinity;
  for (const p of layout.panels)
    for (const [x, y, z] of p.corners) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      z0 = Math.min(z0, z);
    }
  const boxes = rows.map((t) => {
    const outline = t.flat as Vec2[];
    let bx0 = Infinity,
      bx1 = -Infinity,
      by0 = Infinity,
      by1 = -Infinity;
    for (const [x, y] of outline) {
      bx0 = Math.min(bx0, x);
      bx1 = Math.max(bx1, x);
      by0 = Math.min(by0, y);
      by1 = Math.max(by1, y);
    }
    return { t, outline, bx0, by0, w: bx1 - bx0, h: by1 - by0 };
  });
  const cellW = Math.max(...boxes.map((b) => b.w)) + CUT_GAP;
  const cellH = Math.max(...boxes.map((b) => b.h)) + CUT_GAP;
  const columns = Math.max(1, Math.ceil(Math.sqrt(boxes.length)));
  const left = x1 + Math.max(1, (x1 - x0) * 0.1);
  return boxes.map((box, i) => {
    const cx = left + (i % columns) * cellW;
    const cy = y0 + Math.floor(i / columns) * cellH;
    const outline = box.outline.map(([x, y]) => [cx + x - box.bx0, cy + y - box.by0, z0] as Vec3);
    const label: Vec3 = [
      outline.reduce((s, p) => s + p[0], 0) / outline.length,
      outline.reduce((s, p) => s + p[1], 0) / outline.length,
      z0,
    ];
    return { id: box.t.panelId, type: box.t.type, outline: [...outline, outline[0]], label };
  });
}
