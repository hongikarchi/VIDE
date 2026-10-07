// T-204 spike: SPEC-12.8·12.9 restriction rules as closed solids, and the envelope pipeline.
// Every rule takes its values as parameters (SPEC-12.7 6: no formula invention). Distances are
// Euclidean distances to boundary *segments* (capsules), not to infinite lines: a strip along an
// infinite line over-cuts at reflex corners and next to exempt runs (S-04 lesson, RESEARCH-04 J-04).
// Round capsule ends are polygons circumscribing the circle, so the approximation only ever removes
// more (conservative) — the error is bounded by r·(1/cos(π/m) − 1).
import {
  intersect,
  poly,
  subtract,
  union,
  unionAll,
  type Poly,
  type Solid,
  type V3,
} from './csg.ts';
import { check, sectionArea, weld, type Mesh, type SolidCheck } from './mesh.ts';

export type P2 = [number, number];
export type Ring = P2[];

export interface Edge {
  a: P2;
  b: P2;
}
export interface Setback {
  /** Rule label (건축선 후퇴 · 민법 이격 · 대지 안의 공지 · 기타 이격). */
  rule: string;
  edge: Edge;
  distance: number;
}
export interface Chamfer {
  /** Corner of two roads, and the length cut back along each road edge (가각 전제 길이). */
  corner: P2;
  along: [P2, P2];
  length: number;
}
export interface Sunlight {
  /** Datum line segments (인접 대지 경계 or the boundary across a road), already moved outward. */
  datum: Edge[];
  /** 기준 높이 (m), 기준 높이 이하 거리 (m), 초과 부분의 높이 대비 비율 (distance = ratio × h). */
  baseHeight: number;
  nearDistance: number;
  ratio: number;
  /** Only this part of the site follows the rule (a zone the rule applies to); whole site if absent. */
  zone?: Ring;
}
export interface SiteCase {
  id: string;
  title: string;
  site: Ring;
  heightCap: number;
  setbacks: Setback[];
  chamfers: Chamfer[];
  sunlight: Sunlight[];
  /** Hand calculation where one exists (m², m³). */
  analytic?: { area?: number; extrude?: number; sun?: number; max?: number };
}

export interface Options {
  /** Sides of a full circle for round capsule ends (multiple of 4). */
  arcSides: number;
}

const signed = (r: Ring) => {
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i],
      q = r[(i + 1) % r.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
};
export const ccw = (r: Ring): Ring => (signed(r) < 0 ? [...r].reverse() : r);
export const ringArea = (r: Ring) => Math.abs(signed(r));

/** Ear clipping of a simple counter-clockwise ring into triangles. */
export function triangulate(ring: Ring): Ring[] {
  const idx = ring.map((_, i) => i);
  const out: Ring[] = [];
  const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length],
        i1 = idx[k],
        i2 = idx[(k + 1) % idx.length];
      const a = ring[i0],
        b = ring[i1],
        c = ring[i2];
      if (cr(a, b, c) <= 1e-12) continue;
      let inside = false;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = ring[j];
        if (cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) throw new Error('triangulation failed (self-crossing ring?)');
  }
  out.push(idx.map((i) => ring[i]));
  return out;
}

const convexRing = (r: Ring) => {
  for (let i = 0; i < r.length; i++) {
    const o = r[i],
      a = r[(i + 1) % r.length],
      b = r[(i + 2) % r.length];
    if ((a[0] - o[0]) * (b[1] - a[1]) - (a[1] - o[1]) * (b[0] - a[0]) < -1e-12) return false;
  }
  return true;
};

/** Closed prism of a simple ring between z0 and z1 (outward polygons). */
export function prism(ring: Ring, z0: number, z1: number): Solid {
  const r = ccw(ring);
  const caps = convexRing(r) ? [r] : triangulate(r);
  const out: Poly[] = [];
  for (const c of caps) {
    out.push(poly(c.map(([x, y]): V3 => [x, y, z1])));
    out.push(poly([...c].reverse().map(([x, y]): V3 => [x, y, z0])));
  }
  for (let i = 0; i < r.length; i++) {
    const p = r[i],
      q = r[(i + 1) % r.length];
    out.push(
      poly([
        [p[0], p[1], z0],
        [q[0], q[1], z0],
        [q[0], q[1], z1],
        [p[0], p[1], z1],
      ]),
    );
  }
  return out;
}

/**
 * Capsule ring around a segment: every point within `radius` of it, round ends as polygons
 * circumscribing the circle. The vertex order depends only on the segment, so two capsules of the
 * same segment have corresponding, parallel edges (planar frustum sides).
 */
export function capsule(e: Edge, radius: number, sides: number): Ring {
  const dx = e.b[0] - e.a[0],
    dy = e.b[1] - e.a[1];
  const base = Math.atan2(dy, dx);
  const R = radius / Math.cos(Math.PI / sides);
  const out: Ring = [];
  for (let k = 0; k < sides; k++) {
    const t = ((2 * k + 1) * Math.PI) / sides;
    const from = Math.cos(t) > 0 ? e.b : e.a;
    out.push([from[0] + R * Math.cos(base + t), from[1] + R * Math.sin(base + t)]);
  }
  return out;
}

/** Closed frustum between capsule(r0) at z0 and capsule(r1) at z1 of the same segment. */
export function capsuleFrustum(
  e: Edge,
  z0: number,
  r0: number,
  z1: number,
  r1: number,
  sides: number,
): Solid {
  const lo = capsule(e, r0, sides),
    hi = capsule(e, r1, sides);
  const out: Poly[] = [
    poly(hi.map(([x, y]): V3 => [x, y, z1])),
    poly([...lo].reverse().map(([x, y]): V3 => [x, y, z0])),
  ];
  for (let i = 0; i < lo.length; i++) {
    const j = (i + 1) % lo.length;
    out.push(
      poly([
        [lo[i][0], lo[i][1], z0],
        [lo[j][0], lo[j][1], z0],
        [hi[j][0], hi[j][1], z1],
        [hi[i][0], hi[i][1], z1],
      ]),
    );
  }
  return out;
}

const unit = (a: P2, b: P2): P2 => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};
export function chamferRing(c: Chamfer): Ring {
  const u = unit(c.corner, c.along[0]),
    v = unit(c.corner, c.along[1]);
  return [
    c.corner,
    [c.corner[0] + u[0] * c.length, c.corner[1] + u[1] * c.length],
    [c.corner[0] + v[0] * c.length, c.corner[1] + v[1] * c.length],
  ];
}

export interface Stage {
  solid: Solid;
  mesh: Mesh;
  check: SolidCheck;
  ms: number;
}
export interface Result {
  area: number;
  /** Area each rule removes on its own (SPEC-12.8 4). */
  reductions: { rule: string; area: number }[];
  extrude: Stage;
  sun: Stage;
  max: Stage;
  sections: { z: number; area: number }[];
  operands: {
    setbacks: Solid[];
    chamfers: Solid[];
    sunWall: Solid[];
    sunSlope: Solid[];
    zones: (Solid | null)[];
  };
  ms: { buildable: number; total: number };
}

const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const v = f();
  return [v, performance.now() - t];
};
const stage = (f: () => Solid): Stage => {
  const t = performance.now();
  const solid = f();
  const mesh = weld(solid);
  const ms = performance.now() - t;
  return { solid, mesh, check: check(mesh), ms };
};
const volumeOf = (s: Solid) => check(weld(s)).volume;

/** The SPEC-12.8·12.9 pipeline on one site, in local metres. */
export function envelope(c: SiteCase, o: Options): Result {
  const t0 = performance.now();
  const lo = -1,
    top = c.heightCap + 1;
  const setbacks = c.setbacks.map((s) => prism(capsule(s.edge, s.distance, o.arcSides), lo, top));
  const chamfers = c.chamfers.map((ch) => prism(chamferRing(ch), lo, top));
  const zones = c.sunlight.map((s) => (s.zone ? prism(s.zone, lo - 1, top + 1) : null));
  const sunWall: Solid[] = [],
    sunSlope: Solid[] = [];
  c.sunlight.forEach((s, i) => {
    const wall: Solid[] = [],
      slope: Solid[] = [];
    for (const e of s.datum) {
      wall.push(prism(capsule(e, s.nearDistance, o.arcSides), lo, top));
      // Above the base height the allowed height is distance / ratio: the forbidden part is the
      // frustum whose capsule radius grows as ratio × z.
      if (s.baseHeight < top)
        slope.push(
          capsuleFrustum(e, s.baseHeight, s.ratio * s.baseHeight, top, s.ratio * top, o.arcSides),
        );
    }
    let w = unionAll(wall),
      sl = slope.length ? unionAll(slope) : [];
    if (zones[i]) {
      w = intersect(w, zones[i]!);
      if (sl.length) sl = intersect(sl, zones[i]!);
    }
    sunWall.push(w);
    if (sl.length) sunSlope.push(sl);
  });

  // 2D buildable area (SPEC-12.8): a 1 m slab, so area = volume.
  const cutters2d = [...setbacks, ...chamfers, ...sunWall];
  const [cut2d, msCut] = timed(() => unionAll(cutters2d));
  const slab = prism(c.site, 0, 1);
  const [buildable, msB] = timed(() => (cut2d.length ? subtract(slab, cut2d) : slab));
  const area = volumeOf(buildable);
  const siteArea = ringArea(c.site);
  const labels = [
    ...c.setbacks.map((s) => s.rule),
    ...c.chamfers.map(() => '가각'),
    ...c.sunlight.map(() => '정북 일조(지면)'),
  ];
  const reductions = cutters2d.map((cut, i) => ({
    rule: labels[i],
    area: siteArea - volumeOf(subtract(slab, cut)),
  }));

  const box = prism(c.site, 0, c.heightCap);
  const extrude = stage(() => (cut2d.length ? subtract(box, cut2d) : box));
  const sunAll = sunSlope.length ? unionAll([...sunWall, ...sunSlope]) : unionAll(sunWall);
  const sun = stage(() => (sunAll.length ? subtract(box, sunAll) : box));
  const max = stage(() => (sunAll.length ? subtract(extrude.solid, sunAll) : extrude.solid));
  const sections = [0.5, 5, 9.99, 10.01, 15, 20, 25, 30, c.heightCap - 0.01]
    .filter((z) => z < c.heightCap)
    .map((z) => ({ z, area: sectionArea(max.mesh, z) }));
  return {
    area,
    reductions,
    extrude,
    sun,
    max,
    sections,
    operands: { setbacks, chamfers, sunWall, sunSlope, zones },
    ms: { buildable: msCut + msB, total: performance.now() - t0 },
  };
}

// ── Exact reference (true circles, no polygons): allowed height H(x, y) ─────────────────────────

const segDist = (p: P2, e: Edge) => {
  const dx = e.b[0] - e.a[0],
    dy = e.b[1] - e.a[1];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(p[0] - (e.a[0] + t * dx), p[1] - (e.a[1] + t * dy));
};
export const inRing = (p: P2, r: Ring) => {
  let h = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i],
      [xj, yj] = r[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) h = !h;
  }
  return h;
};

/** Allowed heights at a plan point: [extrusion, sky-exposure only, maximum]. 0 = not buildable. */
export function heights(c: SiteCase, p: P2): [number, number, number] {
  if (!inRing(p, c.site)) return [0, 0, 0];
  let ground = true;
  for (const s of c.setbacks) if (segDist(p, s.edge) < s.distance) ground = false;
  for (const ch of c.chamfers) if (inRing(p, chamferRing(ch))) ground = false;
  let sun = c.heightCap;
  for (const s of c.sunlight) {
    if (s.zone && !inRing(p, s.zone)) continue;
    const d = Math.min(...s.datum.map((e) => segDist(p, e)));
    const h = d < s.nearDistance ? 0 : d < s.ratio * s.baseHeight ? s.baseHeight : d / s.ratio;
    if (h === 0) ground = false;
    sun = Math.min(sun, h);
  }
  const ext = ground ? c.heightCap : 0;
  return [ext, sun, Math.min(ext, sun)];
}

/** Midpoint-rule integration of the exact heights on a `step` grid (m², m³ and sections). */
export function reference(c: SiteCase, step: number, zs: number[]) {
  const xs = c.site.map((p) => p[0]),
    ys = c.site.map((p) => p[1]);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  let area = 0,
    ext = 0,
    sun = 0,
    max = 0;
  const sec = zs.map(() => 0);
  const cell = step * step;
  for (let x = x0 + step / 2; x < x1; x += step)
    for (let y = y0 + step / 2; y < y1; y += step) {
      const [e, s, m] = heights(c, [x, y]);
      if (e > 0) area += cell;
      ext += e * cell;
      sun += s * cell;
      max += m * cell;
      zs.forEach((z, i) => {
        if (m > z) sec[i] += cell;
      });
    }
  return { area, extrude: ext, sun, max, sections: zs.map((z, i) => ({ z, area: sec[i] })) };
}

export { union };
