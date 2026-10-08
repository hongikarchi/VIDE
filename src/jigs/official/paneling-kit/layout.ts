// 1단계 배치 (SPEC-16.5, PLAN-49 T-252): `SurfaceSample` + `PreviewSettings` → `PanelLayout`.
//
// Per face: the 2D domain (domain.ts) → the pattern cells (patterns.ts) → each cell cut by the face
// rectangle and trim loops (clip.ts; the loops, not the sample's `inside` flags, decide —
// SPIKE-2026-10-08-paneling §7) → the boundary rule (trim keeps cut panels, merge joins a small cut
// panel to the uncut neighbour sharing its longest edge, drop keeps it listed as `dropped`) → rows
// and columns renumbered from 1 → the outline on the surface (bicubic sample), its winding
// counter-clockwise from the reference normal starting at the vertex nearest the start corner, poles
// merged into triangles, and the measures of SPEC-16.2 공통 규칙 4 (width × height in the best-fit
// plane along the pattern axis), area, '목표와 다름'.
//
// Counts: `total` is every listed panel except dropped ones; `failed` the listed panels with a
// failure other than `dropped`; `dropped` the cut panels the 'drop' rule took out (they stay in
// `panels` with their position and the failure `dropped`, never silently missing — SPEC-16.10).

import {
  OUTLINE_LIMIT,
  PANEL_LIMIT,
  geomTol,
  type Panel,
  type PanelLayout,
  type PreviewSettings,
  type SurfaceSample,
} from '../../../contracts/paneling.ts';
import { ClipDegenerate, clipCell, piecesOf, type ClipVertex, type Region } from './clip.ts';
import { buildDomain, type Domain } from './domain.ts';
import { fingerprint } from './hash.ts';
import { estimateCells, patternCells, type Cell } from './patterns.ts';
import { settingValues } from './settings.ts';
import {
  area2,
  bestFitPlane,
  cross3,
  dist3,
  dot3,
  norm3,
  scale3,
  sub3,
  type Vec2,
  type Vec3,
} from './vec.ts';

export type LayoutOutcome =
  | { ok: true; layout: PanelLayout; notes: string[]; ms: number }
  | { ok: false; code: 'TOO_MANY_PANELS' | 'NO_PANELS'; message: string };

/** '목표와 다름': width or height more than this share away from the module (SPEC-16.5 4). */
export const OFF_TARGET = 0.15;

interface Draft {
  face: number;
  cell: Cell;
  /** Outline in (s, t), counter-clockwise, with the vertex keys. */
  st: Vec2[];
  keys: string[];
  /** The clipped outline with where each vertex came from (keys resolve once all cells are in). */
  raw: ClipVertex[];
  cut: boolean;
  failure: Panel['failure'];
  merged: Cell[];
  removed: boolean;
}

interface Point {
  uv: Vec2;
  xyz: Vec3;
  folded: boolean;
  missing: boolean;
}

/** Stage 1: lay the pattern on every face of the sample. */
export function layoutPanels(sample: SurfaceSample, settings: PreviewSettings): LayoutOutcome {
  const started = performance.now();
  const tol = geomTol(sample);
  const pattern = settings.pattern.value;
  const domains = sample.faces.map((face) => buildDomain(face, settings));
  const estimate = domains.reduce(
    (n, d) => n + estimateCells(pattern, d.cell, d.sRange, d.tRange),
    0,
  );
  if (estimate > PANEL_LIMIT)
    return {
      ok: false,
      code: 'TOO_MANY_PANELS',
      message: `패널이 너무 많습니다(약 ${estimate.toLocaleString('en-US')}개, 상한 ${PANEL_LIMIT.toLocaleString('en-US')}개) · 크기를 키우거나 면을 나누세요`,
    };
  const multi = sample.faces.length > 1;
  const panels: Panel[] = [];
  const notes: string[] = [];
  for (const domain of domains) {
    const prefix = multi ? `F${domain.faceIndex}-` : '';
    panels.push(...layoutFace(domain, settings, tol, prefix));
    for (const note of domain.notes) notes.push(multi ? `면 ${domain.faceIndex}: ${note}` : note);
  }
  if (panels.length > PANEL_LIMIT)
    return {
      ok: false,
      code: 'TOO_MANY_PANELS',
      message: `패널이 너무 많습니다(${panels.length.toLocaleString('en-US')}개, 상한 ${PANEL_LIMIT.toLocaleString('en-US')}개) · 크기를 키우거나 면을 나누세요`,
    };
  const listed = panels.filter((p) => p.failure?.code !== 'dropped');
  if (!listed.length)
    return {
      ok: false,
      code: 'NO_PANELS',
      message: panels.length
        ? `패널이 0개입니다(경계 처리 '빼기'로 ${panels.length}개를 뺌) · 크기를 줄이거나 경계 처리를 바꾸세요`
        : '패널이 0개입니다 · 기준 면이 패널 하나보다 작거나 트림 안이 비었습니다',
    };
  const good = listed.filter((p) => !p.failure);
  const [mw, mh] = domains[0].module;
  const layout: PanelLayout = {
    schema: 'vide.paneling.layout@1',
    surfaceHash: fingerprint(sample.faces.map((f) => [f.faceIndex, f.geometryHash])),
    settingsHash: fingerprint(settingValues(settings)),
    panels,
    counts: {
      total: listed.length,
      boundary: listed.filter((p) => p.boundary).length,
      pole: listed.filter((p) => p.pole).length,
      failed: listed.filter((p) => p.failure).length,
      dropped: panels.length - listed.length,
      offTarget: listed.filter((p) => offTarget(p, mw, mh)).length,
    },
    sizeRange: good.length
      ? {
          minW: Math.min(...good.map((p) => p.width)),
          maxW: Math.max(...good.map((p) => p.width)),
          minH: Math.min(...good.map((p) => p.height)),
          maxH: Math.max(...good.map((p) => p.height)),
          area: good.reduce((a, p) => a + p.area, 0),
        }
      : { minW: 0, maxW: 0, minH: 0, maxH: 0, area: 0 },
    module: [mw, mh],
    coarseSample: domains.some((d) => d.coarse),
  };
  if (layout.coarseSample) notes.push('표본이 거칩니다 · 촘촘하게 다시 읽기');
  return { ok: true, layout, notes, ms: Math.round(performance.now() - started) };
}

/** '목표와 다름' for a panel against the module (boundary and failed panels are not counted). */
export function offTarget(panel: Panel, mw: number, mh: number): boolean {
  if (panel.boundary || panel.failure) return false;
  return (
    Math.abs(panel.width - mw) > OFF_TARGET * mw || Math.abs(panel.height - mh) > OFF_TARGET * mh
  );
}

function layoutFace(domain: Domain, settings: PreviewSettings, tol: number, prefix: string) {
  // Loops in general position against the lattice lines; nudged and retried when not.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return layoutFaceOnce(domain, settings, tol, prefix, attempt);
    } catch (error) {
      if (!(error instanceof ClipDegenerate) || attempt === 3) throw error;
    }
  }
  return [];
}

function layoutFaceOnce(
  domain: Domain,
  settings: PreviewSettings,
  tol: number,
  prefix: string,
  attempt: number,
): Panel[] {
  const f = domain.faceIndex;
  const { pattern, boundary } = {
    pattern: settings.pattern.value,
    boundary: settings.boundary.value,
  };
  const set = patternCells(
    pattern,
    domain.cell,
    domain.sRange,
    domain.tRange,
    domain.closedS,
    domain.closedT,
  );
  const scale = Math.max(
    domain.sRange[1] - domain.sRange[0],
    domain.tRange[1] - domain.tRange[0],
    domain.cell[0],
    domain.cell[1],
  );
  const singular = Object.values(domain.sampler.face.singular).some(Boolean);

  // Lattice keys: wrapped in closed directions, one key per collapsed side (pole).
  const keyCache = new Map<string, string>();
  const keyOf = (I: number, J: number): string => {
    const raw = `${I}:${J}`;
    const known = keyCache.get(raw);
    if (known) return known;
    let key: string | null = null;
    if (singular) {
      const hit = domain.toUV(I * set.unit[0], J * set.unit[1]);
      const side = hit ? domain.poleOf(hit.uv) : null;
      if (side) key = `${f}:p:${side}`;
    }
    if (!key) {
      const [wi, wj] = set.wrap;
      const i = wi ? ((I % wi) + wi) % wi : I;
      const j = wj ? ((J % wj) + wj) % wj : J;
      key = `${f}:${i}:${j}`;
    }
    keyCache.set(raw, key);
    return key;
  };

  // A projected outline that folds over itself has no inside to cut by: the cells stay whole and
  // a vertex without a surface point under it fails the panel (SPEC-16.5 1 '트림 밖으로').
  const folded = domain.kind === 'projected' && selfIntersects(domain.loops[0] ?? []);
  const region = folded ? noRegion() : regionOf(domain, scale, attempt, set.unit);
  const drafts: Draft[] = [];
  const crossings = new Map<string, Set<number>>();
  for (const cell of set.cells) {
    if (folded && cell.st.every((p) => !domain.toUV(p[0], p[1]))) continue;
    const { rings, whole } = clipCell(cell.st, cell.lat, keyOf, region, scale);
    const pieces = piecesOf(rings);
    if (!pieces.length) continue;
    const cellArea = Math.abs(area2(cell.st));
    const main = pieces[0];
    if (Math.abs(area2(main.outline.map((v) => v.p))) < cellArea * 1e-9) continue; // sliver
    let failure: Panel['failure'] = null;
    const extra = pieces
      .slice(1)
      .filter((x) => Math.abs(area2(x.outline.map((v) => v.p))) >= cellArea * 1e-9);
    if (extra.length)
      failure = {
        code: 'degenerate',
        message: `경계에서 ${extra.length + 1}조각으로 나뉨 · 가장 큰 조각만 패널로 둠`,
      };
    else if (main.holes)
      failure = { code: 'degenerate', message: '패널 안에 트림 구멍이 있음 · 크기를 줄이세요' };
    for (const v of main.outline)
      if (v.o.kind === 'x') {
        const edge = `${v.o.ka}|${v.o.kb}`;
        if (!crossings.has(edge)) crossings.set(edge, new Set());
        crossings.get(edge)!.add(v.o.lam);
      }
    drafts.push({
      face: f,
      cell,
      st: main.outline.map((v) => v.p),
      keys: [],
      raw: main.outline,
      cut: !whole,
      failure,
      merged: [],
      removed: false,
    });
  }
  // Ordinals of the crossings along each lattice edge, in key order.
  const ordinals = new Map<string, Map<number, number>>();
  for (const [edge, lams] of crossings)
    ordinals.set(edge, new Map([...lams].sort((a, b) => a - b).map((lam, k) => [lam, k + 1])));
  for (const draft of drafts)
    draft.keys = draft.raw.map((v) =>
      v.o.kind === 'x'
        ? `${f}:x:${v.o.ka}|${v.o.kb}:${ordinals.get(`${v.o.ka}|${v.o.kb}`)!.get(v.o.lam)}`
        : vertexKey(f, v, keyOf),
    );

  // Rows and columns from 1, over every panel the cells produced (before merging or dropping), so
  // the numbers do not depend on the boundary rule.
  const rmin = Math.min(...drafts.map((d) => d.cell.r));
  const cmin = Math.min(...drafts.map((d) => d.cell.c));
  const rowOf = (c: Cell) => c.r - rmin + 1;
  const colOf = (c: Cell) => c.c - cmin + 1;
  const order = (a: Cell, b: Cell) =>
    a.r - b.r || a.c - b.c || (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0);
  drafts.sort((a, b) => order(a.cell, b.cell));

  // Points on the surface, shared between cells by their (s, t).
  const pointCache = new Map<string, Point>();
  const sampler = domain.sampler;
  const pointAt = (p: Vec2): Point => {
    const k = `${p[0]},${p[1]}`;
    const known = pointCache.get(k);
    if (known) return known;
    const hit = domain.toUV(p[0], p[1]);
    const point: Point = hit
      ? { uv: hit.uv, xyz: sampler.point(hit.uv[0], hit.uv[1]), folded: hit.folded, missing: false }
      : { uv: [NaN, NaN], xyz: [NaN, NaN, NaN], folded: false, missing: true };
    pointCache.set(k, point);
    return point;
  };

  if (boundary.rule === 'merge') mergeSmall(drafts, boundary.mergeBelow, pointAt);
  if (boundary.rule === 'drop')
    for (const d of drafts)
      if (d.cut && !d.failure)
        d.failure = { code: 'dropped', message: "경계 처리 '빼기'로 뺀 잘린 패널" };

  // Orientation of (s, t) against the reference normal, once per face.
  const flip = settings.direction.value.flip ? -1 : 1;
  const sign = orientation(domain, flip);
  const panels: Panel[] = [];
  for (const d of drafts) {
    if (d.removed) continue;
    const id = (c: Cell) => `${prefix}P-${rowOf(c)}-${colOf(c)}${c.sub}`;
    const mergedIds = d.merged.map(id);
    const panelId = id(d.cell) + d.merged.map((c) => `+${rowOf(c)}-${colOf(c)}${c.sub}`).join('');
    panels.push(
      buildPanel(
        domain,
        d,
        panelId,
        mergedIds,
        rowOf(d.cell),
        colOf(d.cell),
        pointAt,
        sign,
        flip,
        tol,
      ),
    );
  }
  return panels;
}

function vertexKey(f: number, v: ClipVertex, keyOf: (I: number, J: number) => string): string {
  switch (v.o.kind) {
    case 'lat':
      return keyOf(v.o.I, v.o.J);
    case 'loop':
      return v.o.index >= 0
        ? `${f}:t:${v.o.loop}:${v.o.index}`
        : `${f}:t:${v.o.loop}:e${-1 - v.o.index}`;
    case 'corner':
      return `${f}:t:d:${v.o.c}`;
    default:
      return `${f}:x:${v.o.ka}|${v.o.kb}:?`;
  }
}

function noRegion(): Region {
  return { halfPlanes: [], loops: [], hasOuter: false, cornerOf: () => ({ c: -1, p: [0, 0] }) };
}

/** True when two non-adjacent edges of the ring cross or touch. */
function selfIntersects(ring: readonly Vec2[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  const box = ring.map((a, i) => {
    const b = ring[(i + 1) % n];
    return [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  });
  const orient = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const A = box[i],
        B = box[j];
      if (A[1] < B[0] || B[1] < A[0] || A[3] < B[2] || B[3] < A[2]) continue;
      const a = ring[i],
        b = ring[(i + 1) % n],
        c = ring[j],
        d = ring[(j + 1) % n];
      const d1 = orient(a, b, c),
        d2 = orient(a, b, d),
        d3 = orient(c, d, a),
        d4 = orient(c, d, b);
      if (d1 * d2 <= 0 && d3 * d4 <= 0) return true;
    }
  return false;
}

/** The face rectangle and the trim loops as a clipping region in (s, t). */
function regionOf(domain: Domain, scale: number, attempt: number, unit: Vec2): Region {
  const [s0, s1] = domain.sRange;
  const [t0, t1] = domain.tRange;
  const halfPlanes: Region['halfPlanes'] = [];
  if (domain.rect) {
    if (!domain.closedS) halfPlanes.push([0, s0, true, 0], [0, s1, false, 1]);
    if (!domain.closedT) halfPlanes.push([1, t0, true, 2], [1, t1, false, 3]);
  }
  const bound = (side: number) => (side === 0 ? s0 : side === 1 ? s1 : side === 2 ? t0 : t1);
  const eps = scale * 1e-7;
  const push = scale * 1e-6;
  const nudge = attempt ? scale * 1e-9 * Math.pow(10, attempt) : 0;
  const loops = domain.loops.map((pts, li) => {
    let ring = pts.map((p, k): Vec2 => {
      let [s, t] = p;
      if (nudge) {
        s += nudge * Math.cos(k * 2.399963 + li);
        t += nudge * Math.sin(k * 2.399963 + li);
      }
      // The outer loop's stretches along the face rectangle move just outside it: the rectangle
      // already cuts there (no edge runs along a cell edge).
      if (domain.rect && li === 0 && domain.hasOuter) {
        if (!domain.closedS) {
          if (s <= s0 + eps) s = s0 - push;
          else if (s >= s1 - eps) s = s1 + push;
        }
        if (!domain.closedT) {
          if (t <= t0 + eps) t = t0 - push;
          else if (t >= t1 - eps) t = t1 + push;
        }
      }
      return [s, t];
    });
    let index = pts.map((_, k) => k);
    // Drop repeated points (a closed polyline may repeat its first point at the end).
    const keep: number[] = [];
    for (let k = 0; k < ring.length; k++) {
      const prev = ring[keep.length ? keep[keep.length - 1] : -1];
      if (prev && Math.hypot(prev[0] - ring[k][0], prev[1] - ring[k][1]) <= scale * 1e-12) continue;
      keep.push(k);
    }
    while (
      keep.length > 2 &&
      Math.hypot(
        ring[keep[0]][0] - ring[keep[keep.length - 1]][0],
        ring[keep[0]][1] - ring[keep[keep.length - 1]][1],
      ) <=
        scale * 1e-12
    )
      keep.pop();
    ring = keep.map((k) => ring[k]);
    index = keep.map((k) => index[k]);
    const outer = domain.hasOuter && li === 0;
    const ccw = area2(ring) > 0;
    if (outer !== ccw) {
      ring.reverse();
      index.reverse();
    }
    offLattice(ring, unit, scale);
    return { pts: ring, index, loop: li };
  });
  return {
    halfPlanes,
    loops: loops.filter((l) => l.pts.length >= 3),
    hasOuter: domain.hasOuter && loops.length > 0 && loops[0].pts.length >= 3,
    cornerOf(a, b) {
      const sSide = a <= 1 ? a : b,
        tSide = a <= 1 ? b : a;
      return { c: (sSide === 1 ? 1 : 0) + (tSide === 3 ? 2 : 0), p: [bound(sSide), bound(tSide)] };
    },
  };
}

/**
 * Move loop points lying on a lattice line (cell edges: s = k·a, t = k·b and both diagonals) a
 * micrometre-scale step away from the region, so no loop vertex sits on a cell edge and no loop
 * edge runs along one (a face edge along a grid line, a plane seen straight on). The loop is
 * oriented with the region on its left, so 'away' is the right-hand normal.
 */
function offLattice(ring: Vec2[], unit: Vec2, scale: number) {
  const [a, b] = unit;
  const eps = scale * 1e-9;
  const push = scale * 1e-6;
  const diag = Math.sqrt(1 / (a * a) + 1 / (b * b));
  const onLine = (p: Vec2) => {
    const fs = p[0] / a,
      ft = p[1] / b,
      f1 = fs - ft,
      f2 = fs + ft;
    return (
      Math.abs(fs - Math.round(fs)) * a <= eps ||
      Math.abs(ft - Math.round(ft)) * b <= eps ||
      Math.abs(f1 - Math.round(f1)) / diag <= eps ||
      Math.abs(f2 - Math.round(f2)) / diag <= eps
    );
  };
  const n = ring.length;
  const moved = ring.map((p, k) => {
    if (!onLine(p)) return p;
    const prev = ring[(k - 1 + n) % n],
      next = ring[(k + 1) % n];
    let dx = next[0] - prev[0],
      dy = next[1] - prev[1];
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    let q: Vec2 = [p[0] + dy * push, p[1] - dx * push];
    if (onLine(q)) q = [q[0] + dx * push * 0.37, q[1] + dy * push * 0.37];
    return q;
  });
  for (let k = 0; k < n; k++) ring[k] = moved[k];
}

/** 'merge': a cut panel under `below` of its full cell area joins the uncut neighbour that shares
 *  its longest edge (ties: the smaller number); without one it stays cut (SPEC-16.5 3). */
function mergeSmall(drafts: Draft[], below: number, pointAt: (p: Vec2) => Point) {
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const owners = new Map<string, Set<Draft>>();
  const addEdges = (d: Draft) => {
    for (let i = 0; i < d.keys.length; i++) {
      const k = edgeKey(d.keys[i], d.keys[(i + 1) % d.keys.length]);
      if (!owners.has(k)) owners.set(k, new Set());
      owners.get(k)!.add(d);
    }
  };
  const dropEdges = (d: Draft) => {
    for (let i = 0; i < d.keys.length; i++)
      owners.get(edgeKey(d.keys[i], d.keys[(i + 1) % d.keys.length]))?.delete(d);
  };
  drafts.forEach(addEdges);
  for (const small of drafts) {
    if (!small.cut || small.failure || small.removed) continue;
    if (Math.abs(area2(small.st)) >= below * Math.abs(area2(small.cell.st))) continue;
    // Shared length with each uncut neighbour.
    const shared = new Map<Draft, number>();
    for (let i = 0; i < small.keys.length; i++) {
      const a = small.keys[i],
        b = small.keys[(i + 1) % small.keys.length];
      for (const other of owners.get(edgeKey(a, b)) ?? []) {
        if (other === small || other.cut || other.failure || other.removed) continue;
        if (other.merged.length >= 7) continue;
        const len = dist3(
          pointAt(small.st[i]).xyz,
          pointAt(small.st[(i + 1) % small.st.length]).xyz,
        );
        shared.set(other, (shared.get(other) ?? 0) + len);
      }
    }
    let best: Draft | null = null,
      bestLen = -1;
    for (const [other, len] of shared) {
      if (
        len > bestLen + 1e-12 ||
        (Math.abs(len - bestLen) <= 1e-12 &&
          best &&
          (other.cell.r - best.cell.r ||
            other.cell.c - best.cell.c ||
            (other.cell.sub < best.cell.sub ? -1 : 1)) < 0)
      ) {
        best = other;
        bestLen = len;
      }
    }
    if (!best) continue;
    const union = unionOutlines(best, small);
    if (!union || union.keys.length > OUTLINE_LIMIT) continue;
    dropEdges(best);
    dropEdges(small);
    best.keys = union.keys;
    best.st = union.st;
    best.merged.push(small.cell);
    small.removed = true;
    addEdges(best);
  }
  for (const d of drafts) if (d.merged.length) d.cut = true;
}

/** Union of two counter-clockwise outlines sharing edges (by key); null when not one ring. */
function unionOutlines(a: Draft, b: Draft): { keys: string[]; st: Vec2[] } | null {
  const directed = new Map<string, { to: string; at: Vec2 }>();
  const pos = new Map<string, Vec2>();
  const edges: [string, string, Vec2][] = [];
  for (const d of [a, b])
    for (let i = 0; i < d.keys.length; i++) {
      edges.push([d.keys[i], d.keys[(i + 1) % d.keys.length], d.st[i]]);
      if (!pos.has(d.keys[i])) pos.set(d.keys[i], d.st[i]);
    }
  const set = new Set(edges.map(([x, y]) => `${x}>${y}`));
  for (const [x, y, at] of edges) {
    if (set.has(`${y}>${x}`)) continue; // shared edge: inside the union
    if (directed.has(x)) return null; // a vertex touched twice: not a simple ring
    directed.set(x, { to: y, at });
  }
  const start = a.keys.find((k) => directed.has(k));
  if (!start) return null;
  const keys: string[] = [];
  const st: Vec2[] = [];
  let k: string | undefined = start;
  while (k !== undefined && keys.length <= directed.size) {
    const e = directed.get(k);
    if (!e) return null;
    keys.push(k);
    st.push(e.at);
    k = e.to;
    if (k === start) break;
  }
  if (k !== start || keys.length !== directed.size) return null;
  return { keys, st };
}

/** +1 when counter-clockwise in (s, t) is counter-clockwise seen from the reference normal. */
function orientation(domain: Domain, flip: number): number {
  const sm = (domain.sRange[0] + domain.sRange[1]) / 2;
  const tm = (domain.tRange[0] + domain.tRange[1]) / 2;
  const d = Math.max(domain.cell[0], domain.cell[1]) * 1e-2;
  const at = (s: number, t: number) => {
    const hit = domain.toUV(s, t);
    return hit ? domain.sampler.point(hit.uv[0], hit.uv[1]) : null;
  };
  const centre = domain.toUV(sm, tm);
  const ps = at(sm + d, tm),
    ms = at(sm - d, tm),
    pt = at(sm, tm + d),
    mt = at(sm, tm - d);
  if (!centre || !ps || !ms || !pt || !mt) return 1;
  const n = scale3(domain.sampler.normal(centre.uv[0], centre.uv[1]), flip);
  return dot3(cross3(sub3(ps, ms), sub3(pt, mt)), n) >= 0 ? 1 : -1;
}

function buildPanel(
  domain: Domain,
  d: Draft,
  id: string,
  mergedFrom: string[],
  row: number,
  col: number,
  pointAt: (p: Vec2) => Point,
  sign: number,
  flip: number,
  tol: number,
): Panel {
  let st = d.st.slice(),
    keys = d.keys.slice();
  if (sign < 0) {
    st.reverse();
    keys.reverse();
  }
  let points = st.map(pointAt);
  let failure = d.failure;
  if (!failure && points.some((p) => p.missing))
    failure = { code: 'outside-trim', message: '꼭짓점이 기준 면 위에 맞지 않음(트림 밖)' };
  if (!failure && points.some((p) => p.folded))
    failure = {
      code: 'folded-projection',
      message: '투영 방향으로 면이 접혀 있어 한 점에 면이 여럿 맞음',
    };
  // Missing points borrow the mean of the others so the outline stays finite and visible.
  const okPoints = points.filter((p) => !p.missing);
  if (okPoints.length !== points.length) {
    const sampler = domain.sampler;
    const uv: Vec2 = okPoints.length
      ? [
          okPoints.reduce((a, p) => a + p.uv[0], 0) / okPoints.length,
          okPoints.reduce((a, p) => a + p.uv[1], 0) / okPoints.length,
        ]
      : [sampler.u0, sampler.v0];
    points = points.map((p) =>
      p.missing ? { uv, xyz: sampler.point(uv[0], uv[1]), folded: false, missing: true } : p,
    );
  }
  // Poles: every vertex on a collapsed side takes that side's one key, and neighbouring vertices
  // at the pole merge into one (a triangle panel, SPEC-16.5 1).
  keys = keys.map((k, i) => {
    const side = domain.poleOf(points[i].uv);
    return side ? `${d.face}:p:${side}` : k;
  });
  let pole = false;
  const atPole = (a: number, b: number) =>
    keys[a] === keys[b] && keys[a].includes(':p:') && dist3(points[a].xyz, points[b].xyz) <= tol;
  const keepIdx: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keepIdx.length && atPole(keepIdx[keepIdx.length - 1], i)) {
      pole = true;
      continue;
    }
    keepIdx.push(i);
  }
  while (keepIdx.length > 1 && atPole(keepIdx[0], keepIdx[keepIdx.length - 1])) {
    keepIdx.pop();
    pole = true;
  }
  if (keepIdx.length >= 3) {
    st = keepIdx.map((i) => st[i]);
    keys = keepIdx.map((i) => keys[i]);
    points = keepIdx.map((i) => points[i]);
  } else if (!failure)
    failure = { code: 'degenerate', message: '꼭짓점이 한 점으로 모여 넓이가 0' };
  // Start at the vertex nearest the start corner (ties: smaller t, then smaller s).
  let first = 0;
  for (let i = 1; i < st.length; i++) {
    const a = st[i],
      b = st[first];
    const da = a[0] * a[0] + a[1] * a[1],
      db = b[0] * b[0] + b[1] * b[1];
    if (
      da < db - 1e-12 ||
      (Math.abs(da - db) <= 1e-12 && (a[1] < b[1] || (a[1] === b[1] && a[0] < b[0])))
    )
      first = i;
  }
  const rot = <T>(xs: T[]) => xs.slice(first).concat(xs.slice(0, first));
  st = rot(st);
  keys = rot(keys);
  points = rot(points);
  if (points.length > OUTLINE_LIMIT) {
    const step = points.length / OUTLINE_LIMIT;
    const pickIdx = Array.from({ length: OUTLINE_LIMIT }, (_, k) => Math.floor(k * step));
    st = pickIdx.map((i) => st[i]);
    keys = pickIdx.map((i) => keys[i]);
    points = pickIdx.map((i) => points[i]);
    if (!failure)
      failure = { code: 'degenerate', message: `윤곽 꼭짓점이 ${OUTLINE_LIMIT}개를 넘음` };
  }

  // Measures: best-fit plane of the check points, pattern axis, extents, area (SPEC-16.2 규칙 4).
  const sampler = domain.sampler;
  const n = points.length;
  const corners = points.map((p) => p.xyz);
  const mids: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i].uv,
      b = points[(i + 1) % n].uv;
    mids.push(sampler.point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
  }
  const cu = points.reduce((a, p) => a + p.uv[0], 0) / n;
  const cv = points.reduce((a, p) => a + p.uv[1], 0) / n;
  const centre = sampler.point(cu, cv);
  const plane = bestFitPlane([...corners, ...mids, centre]);
  const ref = scale3(sampler.normal(cu, cv), flip);
  const normal = dot3(plane.normal, ref) < 0 ? scale3(plane.normal, -1) : plane.normal;
  const sc = st.reduce((a, p) => a + p[0], 0) / n,
    tc = st.reduce((a, p) => a + p[1], 0) / n;
  const axis = domain.axisDir(sc, tc);
  let ax = sub3(axis, scale3(normal, dot3(axis, normal)));
  if (Math.hypot(...ax) < 1e-12) ax = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  ax = norm3(sub3(ax, scale3(normal, dot3(ax, normal))));
  const ay = cross3(normal, ax);
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const c of corners) {
    const q = sub3(c, plane.origin);
    const x = dot3(q, ax),
      y = dot3(q, ay);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const ring = [corners[i], mids[i], corners[(i + 1) % n]];
    for (let k = 0; k < 2; k++) {
      const c = cross3(sub3(ring[k], centre), sub3(ring[k + 1], centre));
      area += Math.hypot(c[0], c[1], c[2]) / 2;
    }
  }
  if (!failure && area <= tol * tol) failure = { code: 'degenerate', message: '패널 넓이가 0' };
  const finite = (x: number) => (Number.isFinite(x) ? x : 0);
  return {
    id,
    faceIndex: d.face,
    row,
    col,
    uv: points.map((p) => [p.uv[0], p.uv[1]] as Vec2),
    corners: corners.map((c) => [c[0], c[1], c[2]] as Vec3),
    vertexKeys: keys,
    boundary: d.cut,
    pole,
    mergedFrom,
    width: finite(x1 - x0),
    height: finite(y1 - y0),
    area: finite(area),
    failure,
  };
}
