// 2단계 부재 (SPEC-16.6, PLAN-49 T-254): `PanelLayout` + `MemberSettings` → `MemberSet`.
//
// Per panel of the layout (same order; dropped and stage-1 failures stay listed with their failure):
//   1. 줄눈: every outline edge shared with a neighbour (same two vertex keys, SPEC-16.5 5) moves in by
//      joint/2 measured ON THE SURFACE; an edge on the face boundary/trim moves 0 ('flush') or
//      joint/2 ('half'). At both ends and the middle of the edge the UV step that moves the amount
//      on the surface square across the edge comes from the sample's Jacobian; a straight line
//      fitted to the moved points is the moved edge (an end where the surface collapses — a pole, a
//      folded side — is left out, and no move passes the panel's own width). Consecutive moved
//      edges meet in the new corners; an edge whose moved piece turns round is taken out and its
//      neighbours meet instead (an offset polygon). A plate outside its panel, a moved edge running
//      far past its amount or a gap far past the joint fails as `degenerate`. A pole's collapsed
//      edge (two equal pole keys) gets no joint; edges into a pole are paired by their UV.
//   2. 면으로 옮기기: the reduced UV outline goes back on the surface (bicubic sample).
//   3. 줄눈 틈: across every shared edge, at both ends and the middle, the distance between the two
//      moved edges on the surface → `jointGap` [min, max]; off target by more than max(1 mm, 10 %)
//      → `jointUneven` (not a failure). The joint centre line runs midway between the plate edges.
//   4. 두께: the largest signed principal curvature k toward the thickness side over the panel (raw
//      samples inside it and its check points); thickness · k ≥ 0.7 → `thickness-curvature`.
//   5. A closed triangle mesh of the plate offset along the surface normal (preview and checks):
//      every edge used once each way and a positive volume, else `not-closed` (never patched).
//   6. 펼친 크기: SPEC-16.2 공통 규칙 4 on the plate's check points; exact when the flatness is within
//      the geometric tolerance, else the projection on the best-fit plane, marked approximate.
//   7. 판재 한도: plate size over the stock either way round → `overStock` (listed, not a failure).

import {
  geomTol,
  type Member,
  type MemberSet,
  type MemberSettings,
  type PanelLayout,
  type PreviewSettings,
  type SurfaceSample,
} from '../../../contracts/paneling.ts';
import { buildDomain, type Domain } from './domain.ts';
import { fingerprint } from './hash.ts';
import { openingRim } from './opening.ts';
import { faceSampler, type FaceSampler } from './sample.ts';
import { settingValues } from './settings.ts';
import {
  area2,
  bestFitPlane,
  cross2,
  cross3,
  dist3,
  dot3,
  len3,
  norm3,
  scale3,
  sub3,
  type Vec2,
  type Vec3,
} from './vec.ts';

/** Thickness × curvature at or above this fails the panel (SPEC-16.6 2). */
export const THICKNESS_CURVATURE_LIMIT = 0.7;
/** Joint gap off its target by more than max(this, 10 % of the joint) is '고르지 않음'. */
export const JOINT_UNEVEN_MIN = 0.001;
/** The rim an opening keeps inside the joint-reduced plate (SPEC-16.13 4), metres. */
export const OPENING_PLATE_RIM = 0.005;
/** A joint gap over this many joints (plus 1 mm) fails the plate as `degenerate`. */
export const JOINT_GAP_LIMIT = 4;
const MESH_VERTEX_LIMIT = 4096;
const JOINT_LINE_POINTS = 5;

export interface MembersOptions {
  /** Include the preview solids (default true); the work copy and report do not keep them. */
  solids?: boolean;
}

export interface MembersOutcome {
  members: MemberSet;
  ms: number;
}

/** The fingerprint of a stage-1 layout used as `MemberSet.layoutHash` (and `makeKey`'s middle part):
 *  a layout is a function of its face hashes and stage-1 settings, so these two decide it. */
export function layoutFingerprint(layout: PanelLayout): string {
  return fingerprint(['vide.paneling.layout@1', layout.surfaceHash, layout.settingsHash]);
}

interface FaceCtx {
  sampler: FaceSampler;
  domain: Domain | null;
  axis: 'u' | 'v';
  hu: number;
  hv: number;
  periodU: number;
  periodV: number;
}

interface EdgeRef {
  panel: number;
  edge: number;
}

interface Reduced {
  uv: Vec2[];
  /** Per edge: the moved line as two points (start, end) in UV. */
  lines: [Vec2, Vec2][];
  /** Per edge: the inward unit normal in UV. */
  normals: Vec2[];
}

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const round6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;

/** Stage 2: members of every panel of the layout. */
export function buildMembers(
  sample: SurfaceSample,
  layout: PanelLayout,
  preview: PreviewSettings,
  settings: MemberSettings,
  options: MembersOptions = {},
): MembersOutcome {
  const started = performance.now();
  const tol = geomTol(sample);
  const withSolids = options.solids !== false;
  const flip = preview.direction.value.flip ? -1 : 1;
  const thickness = settings.thickness.value;
  const side = settings.thicknessSide.value === 'outside' ? 1 : -1;
  const joint = settings.joint.value;
  const boundaryJoint = settings.boundaryJoint.value;
  const stock = settings.stock.value;

  const faces = new Map<number, FaceCtx>();
  const ctxOf = (faceIndex: number): FaceCtx => {
    const known = faces.get(faceIndex);
    if (known) return known;
    const face = sample.faces.find((f) => f.faceIndex === faceIndex);
    if (!face) throw new Error(`기준 면 표본에 면 ${faceIndex}이 없습니다 · 다시 읽기`);
    const ctx: FaceCtx = {
      sampler: faceSampler(face),
      domain: preview.measure.value === 'projected' ? buildDomain(face, preview) : null,
      axis: preview.direction.value.axis,
      hu: (face.domainU[1] - face.domainU[0]) * 1e-5,
      hv: (face.domainV[1] - face.domainV[0]) * 1e-5,
      periodU: face.closedU ? face.domainU[1] - face.domainU[0] : 0,
      periodV: face.closedV ? face.domainV[1] - face.domainV[0] : 0,
    };
    faces.set(faceIndex, ctx);
    return ctx;
  };

  // Edge owners by their two vertex keys; dropped panels are not there (their edges are boundary).
  const panels = layout.panels;
  const listed = panels.map((p) => p.failure?.code !== 'dropped');
  const owners = new Map<string, EdgeRef[]>();
  panels.forEach((p, pi) => {
    if (!listed[pi]) return;
    const n = p.vertexKeys.length;
    for (let i = 0; i < n; i++) {
      if (p.vertexKeys[i] === p.vertexKeys[(i + 1) % n]) continue; // a pole's collapsed edge
      const k = `${p.faceIndex}#${edgeKey(p.vertexKeys[i], p.vertexKeys[(i + 1) % n])}`;
      const list = owners.get(k) ?? [];
      list.push({ panel: pi, edge: i });
      owners.set(k, list);
    }
  });
  const partnerOf = (pi: number, i: number): EdgeRef | null => {
    const p = panels[pi];
    const n = p.vertexKeys.length;
    if (p.vertexKeys[i] === p.vertexKeys[(i + 1) % n]) return null;
    const list = owners.get(
      `${p.faceIndex}#${edgeKey(p.vertexKeys[i], p.vertexKeys[(i + 1) % n])}`,
    );
    const others = list?.filter((r) => r.panel !== pi) ?? [];
    if (others.length <= 1) return others[0] ?? null;
    // Several edges with the same two keys: the edges into a pole (every pole vertex has the one
    // key), e.g. a diamond's fan. The partner is the one running along the same UV curve.
    const ctx = ctxOf(p.faceIndex);
    const a = p.uv[i],
      b = p.uv[(i + 1) % n];
    let best: EdgeRef | null = null,
      bestD = Infinity;
    for (const r of others) {
      const q = panels[r.panel];
      const c = q.uv[r.edge],
        d = q.uv[(r.edge + 1) % q.uv.length];
      const dd = uvDist(ctx, a, d) + uvDist(ctx, b, c);
      if (dd < bestD) {
        best = r;
        bestD = dd;
      }
    }
    return best;
  };
  /** A pole's collapsed edge (both keys the pole's): it has no length on the surface, so no joint. */
  const collapsedEdge = (p: PanelLayout['panels'][number], i: number) =>
    p.vertexKeys[i] === p.vertexKeys[(i + 1) % p.vertexKeys.length];

  // 1. Joint reduction in UV.
  const reduced: (Reduced | null)[] = [];
  const failures: Member['failure'][] = [];
  panels.forEach((p, pi) => {
    if (p.failure) {
      reduced.push(null);
      failures.push(p.failure);
      return;
    }
    const ctx = ctxOf(p.faceIndex);
    const amounts = p.uv.map((_, i) =>
      collapsedEdge(p, i)
        ? 0
        : partnerOf(pi, i)
          ? joint / 2
          : boundaryJoint === 'half'
            ? joint / 2
            : 0,
    );
    const r = reduceOutline(ctx, p.uv as Vec2[], amounts);
    const bad = r ? (plateOutOfPanel(r.uv, p.uv as Vec2[]) ?? ranAway(ctx, p, r, amounts)) : null;
    if (!r || bad) {
      reduced.push(null);
      failures.push({
        code: 'degenerate',
        message: r
          ? `줄눈 축소가 맞지 않음(${bad}) · 극점이나 접힌 변 가까이`
          : `줄눈(${round1(joint * 1000)} mm)이 패널보다 커서 판이 남지 않음`,
      });
      return;
    }
    // The stage-1 opening must stay inside the plate the joint left (SPEC-16.13 4).
    const rim = p.opening ? openingRim(ctx.sampler, p.opening.uv as Vec2[], r.uv) : Infinity;
    if (rim < OPENING_PLATE_RIM) {
      reduced.push(r);
      failures.push({
        code: 'degenerate',
        message:
          rim < 0
            ? '개구가 줄눈으로 줄어든 판 밖으로 나감 · 개구율이나 줄눈을 줄이세요'
            : `개구와 판 가장자리 사이가 ${round1(rim * 1000)} mm뿐 · 개구율이나 줄눈을 줄이세요`,
      });
      return;
    }
    reduced.push(r);
    failures.push(null);
  });

  // 3. Gaps and joint centre lines across shared edges.
  const gaps: [number, number][] = panels.map(() => [Infinity, -Infinity]);
  const joints: MemberSet['joints'] = [];
  const seen = new Set<string>();
  panels.forEach((p, pi) => {
    if (!listed[pi]) return;
    const n = p.vertexKeys.length;
    for (let i = 0; i < n; i++) {
      const other = partnerOf(pi, i);
      if (!other) continue;
      const ka = p.vertexKeys[i],
        kb = p.vertexKeys[(i + 1) % n];
      const key = `${p.faceIndex}#${edgeKey(ka, kb)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ctx = ctxOf(p.faceIndex);
      const ra = reduced[pi],
        rb = reduced[other.panel];
      const q = panels[other.panel];
      const line: Vec3[] = [];
      for (let k = 0; k < JOINT_LINE_POINTS; k++) {
        const lam = k / (JOINT_LINE_POINTS - 1);
        if (ra && rb) {
          const pa = acrossPoint(p.uv as Vec2[], ra, i, lam);
          const pb = acrossPoint(q.uv as Vec2[], rb, other.edge, 1 - lam);
          const xa = ctx.sampler.point(pa[0], pa[1]),
            xb = ctx.sampler.point(pb[0], pb[1]);
          line.push(roundVec([(xa[0] + xb[0]) / 2, (xa[1] + xb[1]) / 2, (xa[2] + xb[2]) / 2]));
        } else {
          const a = p.uv[i],
            b = p.uv[(i + 1) % n];
          line.push(
            roundVec(ctx.sampler.point(a[0] + (b[0] - a[0]) * lam, a[1] + (b[1] - a[1]) * lam)),
          );
        }
      }
      if (ra && rb)
        for (const lam of stationsOf(ka, kb)) {
          const pa = acrossPoint(p.uv as Vec2[], ra, i, lam);
          const pb = acrossPoint(q.uv as Vec2[], rb, other.edge, 1 - lam);
          const gap = dist3(ctx.sampler.point(pa[0], pa[1]), ctx.sampler.point(pb[0], pb[1]));
          for (const owner of [pi, other.panel]) {
            gaps[owner][0] = Math.min(gaps[owner][0], gap);
            gaps[owner][1] = Math.max(gaps[owner][1], gap);
          }
        }
      joints.push({ keys: ka < kb ? [ka, kb] : [kb, ka], line });
    }
  });

  // 2, 4–7 per panel.
  const unevenBy = Math.max(JOINT_UNEVEN_MIN, joint * 0.1);
  const overStock: string[] = [];
  const members: Member[] = panels.map((p, pi) => {
    const ctx = ctxOf(p.faceIndex);
    const r = reduced[pi];
    let failure = failures[pi];
    const gap = gaps[pi];
    const jointGap: [number, number] | null = Number.isFinite(gap[0])
      ? [round9(gap[0]), round9(gap[1])]
      : null;
    const jointUneven =
      !!jointGap &&
      Math.max(Math.abs(jointGap[0] - joint), Math.abs(jointGap[1] - joint)) > unevenBy;
    // A gap far past the joint means a moved edge went wrong (a pole, a folded side), not an
    // uneven joint: the plate is not trusted.
    if (!failure && jointGap && jointGap[1] > JOINT_GAP_LIMIT * joint + JOINT_UNEVEN_MIN)
      failure = {
        code: 'degenerate',
        message: `줄눈 틈 ${round1(jointGap[1] * 1000)} mm가 줄눈(${round1(joint * 1000)} mm)의 ${JOINT_GAP_LIMIT}배를 넘음 · 극점이나 접힌 변 가까이`,
      };
    const uv = (r ? r.uv : (p.uv as Vec2[])).map((x) => [x[0], x[1]] as Vec2);
    if (!r) {
      return {
        panelId: p.id,
        uv,
        solid: null,
        flatSize: [p.width, p.height],
        flatSizeApprox: true,
        thickness,
        area: p.area,
        volume: 0,
        jointGap,
        jointUneven,
        failure,
      };
    }
    // 6. Plate measures.
    const size = plateSize(ctx, r.uv, flip);
    // 4. Curvature toward the thickness side (+ = centre on the face normal side).
    const sign = side * flip;
    const k = maxCurvatureToward(ctx, r.uv, sign);
    if (!failure && thickness * k >= THICKNESS_CURVATURE_LIMIT)
      failure = {
        code: 'thickness-curvature',
        message: `두께 불가 · 곡률 반지름 ${Math.round(1000 / k)} mm (두께 ${round1(thickness * 1000)} mm)`,
      };
    // 5. Closed mesh.
    const mesh = plateSolid(ctx, r.uv, sign * thickness, size.flatness <= tol);
    if (!failure && !mesh.closed)
      failure = { code: 'not-closed', message: '부재가 닫히지 않거나 바깥을 향하지 않음' };
    if (!failure && stock && overStockOf(size.w, size.h, stock, tol)) overStock.push(p.id);
    return {
      panelId: p.id,
      uv,
      solid: withSolids && mesh.closed && !failure ? mesh.mesh : null,
      flatSize: [round9(size.w), round9(size.h)],
      flatSizeApprox: size.flatness > tol,
      thickness,
      area: round9(mesh.area),
      volume: round9(mesh.closed ? mesh.volume : mesh.area * thickness),
      jointGap,
      jointUneven,
      failure,
    };
  });

  return {
    members: {
      schema: 'vide.paneling.members@1',
      layoutHash: layoutFingerprint(layout),
      settingsHash: fingerprint(settingValues(settings)),
      members,
      joints,
      overStock,
    },
    ms: Math.round(performance.now() - started),
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round9 = (x: number) => Math.round(x * 1e9) / 1e9 + 0;
const roundVec = (p: Vec3): Vec3 => [round6(p[0]), round6(p[1]), round6(p[2])];

/** Stock check either way round (SPEC-16.2: 90° turned fits → not over); a side of 0 has no limit
 *  (SPEC-16.6 4). */
export function overStockOf(w: number, h: number, stock: readonly [number, number], tol = 0) {
  const fits = (a: number, b: number) => (a <= 0 || w <= a + tol) && (b <= 0 || h <= b + tol);
  return !fits(stock[0], stock[1]) && !fits(stock[1], stock[0]);
}

// ── geometry on the sample ────────────────────────────────────────────────────────────────────

/** UV distance with the closed directions wrapped by their period. */
function uvDist(ctx: FaceCtx, a: readonly number[], b: readonly number[]): number {
  const wrap = (x: number, period: number) =>
    period > 0 ? Math.abs(x - period * Math.round(x / period)) : Math.abs(x);
  return Math.hypot(wrap(a[0] - b[0], ctx.periodU), wrap(a[1] - b[1], ctx.periodV));
}

function partials(ctx: FaceCtx, u: number, v: number): [Vec3, Vec3] {
  const s = ctx.sampler;
  const su = scale3(sub3(s.point(u + ctx.hu, v), s.point(u - ctx.hu, v)), 1 / (2 * ctx.hu));
  const sv = scale3(sub3(s.point(u, v + ctx.hv), s.point(u, v - ctx.hv)), 1 / (2 * ctx.hv));
  return [su, sv];
}

/** The UV step that moves one metre on the surface square across the edge direction `e` (unit,
 *  UV) at `at`, toward the side of `nu`: the pseudo-inverse of the Jacobian applied to the surface
 *  direction normal × edge tangent. With it, `scale` = the surface length per UV unit across the
 *  edge (near a pole or a folded side it goes to 0). */
function acrossStep(ctx: FaceCtx, at: Vec2, e: Vec2, nu: Vec2): { step: Vec2; scale: number } {
  const [su, sv] = partials(ctx, at[0], at[1]);
  const te: Vec3 = [
    su[0] * e[0] + sv[0] * e[1],
    su[1] * e[0] + sv[1] * e[1],
    su[2] * e[0] + sv[2] * e[1],
  ];
  const tn: Vec3 = [
    su[0] * nu[0] + sv[0] * nu[1],
    su[1] * nu[0] + sv[1] * nu[1],
    su[2] * nu[0] + sv[2] * nu[1],
  ];
  const tt = dot3(te, te);
  const across = tt > 0 ? sub3(tn, scale3(te, dot3(tn, te) / tt)) : tn;
  const m = len3(across);
  if (!(m > 0) || !Number.isFinite(m)) return { step: [0, 0], scale: 0 };
  // Solve [Su Sv]·δ = across / m in the least-squares sense (2 × 2 normal equations).
  const a3 = scale3(across, 1 / m);
  const g11 = dot3(su, su),
    g12 = dot3(su, sv),
    g22 = dot3(sv, sv);
  const r1 = dot3(su, a3),
    r2 = dot3(sv, a3);
  const det = g11 * g22 - g12 * g12;
  const step: Vec2 =
    det > 1e-18 * (g11 * g22 || 1)
      ? [(g22 * r1 - g12 * r2) / det, (g11 * r2 - g12 * r1) / det]
      : [nu[0] / m, nu[1] / m];
  return { step, scale: m };
}

/** A station (an end or the middle of an edge) whose across scale is under this share of the
 *  edge's largest is degenerate — a pole or a folded side — and is not used, so the UV move cannot
 *  run away there (SPEC-16.6 1). */
const DEGENERATE_SCALE = 0.05;

/** The moved line of edge a→b for a surface `amount`: each station (ends, middle) moves `amount`
 *  on the surface square across the edge; the line is the least-squares fit through the moved
 *  stations, or with a degenerate end the line through the other end and the middle. No station
 *  moves past the panel's own UV width across the edge. Null when nothing is usable. */
function edgeMove(
  ctx: FaceCtx,
  a: Vec2,
  b: Vec2,
  e: Vec2,
  nu: Vec2,
  amount: number,
  width: number,
): [Vec2, Vec2] | null {
  if (amount === 0) return [a, b];
  const ex = b[0] - a[0],
    ey = b[1] - a[1];
  const xs = [0, 0.5, 1];
  const steps = xs.map((lam) => acrossStep(ctx, [a[0] + ex * lam, a[1] + ey * lam], e, nu));
  const top = Math.max(...steps.map((s) => s.scale));
  if (!(top > 1e-12)) return null;
  const use = [0, 1, 2].filter((k) => steps[k].scale >= top * DEGENERATE_SCALE);
  if (!use.length) return null;
  const moved = xs.map((lam, k): Vec2 => {
    const { step } = steps[k];
    // The part across the edge decides the cap; the step is shortened as a whole.
    const across = (step[0] * nu[0] + step[1] * nu[1]) * amount;
    const f = across > width && across > 0 ? width / across : 1;
    return [a[0] + ex * lam + step[0] * amount * f, a[1] + ey * lam + step[1] * amount * f];
  });
  let p0: Vec2, p1: Vec2;
  if (use.length === 3) {
    // Least-squares line through the three moved stations at λ = 0, ½, 1.
    const fit = (c: 0 | 1) => {
      const slope = moved[2][c] - moved[0][c];
      const mean = (moved[0][c] + moved[1][c] + moved[2][c]) / 3;
      return [mean - slope / 2, mean + slope / 2];
    };
    const [u0, u1] = fit(0),
      [v0, v1] = fit(1);
    p0 = [u0, v0];
    p1 = [u1, v1];
  } else if (use.length === 2) {
    const [i, j] = use;
    const at = (lam: number): Vec2 => {
      const t = (lam - xs[i]) / (xs[j] - xs[i]);
      return [
        moved[i][0] + (moved[j][0] - moved[i][0]) * t,
        moved[i][1] + (moved[j][1] - moved[i][1]) * t,
      ];
    };
    p0 = at(0);
    p1 = at(1);
  } else {
    const k = use[0];
    const d: Vec2 = [moved[k][0] - (a[0] + ex * xs[k]), moved[k][1] - (a[1] + ey * xs[k])];
    p0 = [a[0] + d[0], a[1] + d[1]];
    p1 = [b[0] + d[0], b[1] + d[1]];
  }
  // Never outward and never past the width (the ends of an extrapolated line).
  const clamp = (p: Vec2, o: Vec2): Vec2 => {
    const across = (p[0] - o[0]) * nu[0] + (p[1] - o[1]) * nu[1];
    const c = Math.min(Math.max(across, 0), width);
    return [p[0] + nu[0] * (c - across), p[1] + nu[1] * (c - across)];
  };
  return [clamp(p0, a), clamp(p1, b)];
}

/**
 * Move every edge of a UV outline inward by its surface amount (an offset polygon): the moved
 * lines meet in the new corners; an edge whose moved piece turns round (a short trim piece, a
 * 0–6 mm Voronoi edge, the collapsed edge at a pole) is taken out and its neighbours meet instead,
 * again until none turns round. Null only when fewer than three edges or no area are left. The
 * plate may so have fewer vertices than the panel (its keys then no longer match one to one).
 */
function reduceOutline(ctx: FaceCtx, uv: Vec2[], amounts: number[]): Reduced | null {
  const n = uv.length;
  const w = Math.sign(area2(uv)) || 1;
  const lines: [Vec2, Vec2][] = [];
  const normals: Vec2[] = [];
  const dirs: Vec2[] = [];
  const active: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = uv[i],
      b = uv[(i + 1) % n];
    const ex = b[0] - a[0],
      ey = b[1] - a[1];
    const L = Math.hypot(ex, ey);
    const e: Vec2 = L > 0 ? [ex / L, ey / L] : [1, 0];
    const nu: Vec2 = w > 0 ? [-e[1], e[0]] : [e[1], -e[0]];
    normals.push(nu);
    dirs.push(e);
    if (L === 0) {
      lines.push([a, b]);
      continue;
    }
    // The panel's own UV width across this edge: no move may pass it.
    let width = 0;
    for (const p of uv) width = Math.max(width, (p[0] - a[0]) * nu[0] + (p[1] - a[1]) * nu[1]);
    const line = edgeMove(ctx, a, b, e, nu, amounts[i], width);
    if (!line) return null;
    lines.push(line);
    active.push(i);
  }
  const cornersOf = (edges: number[]): Vec2[] =>
    edges.map((cur, j) => {
      const prev = lines[edges[(j - 1 + edges.length) % edges.length]];
      const hit = intersect(prev, lines[cur]);
      if (hit) return hit;
      // Collinear neighbours (a T point): the two moved ends, averaged.
      const a = prev[1],
        b = lines[cur][0];
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    });
  let out: Vec2[] = [];
  for (;;) {
    if (active.length < 3) return null;
    out = cornersOf(active);
    // The edge that turned round the most (its new length over its old, most negative) goes.
    let worst = -1,
      worstBy = 0;
    active.forEach((i, j) => {
      const a = out[j],
        b = out[(j + 1) % out.length];
      const along = (b[0] - a[0]) * dirs[i][0] + (b[1] - a[1]) * dirs[i][1];
      const L = Math.hypot(uv[(i + 1) % n][0] - uv[i][0], uv[(i + 1) % n][1] - uv[i][1]);
      const by = along / L;
      if (along <= 0 && (worst < 0 || by < worstBy)) {
        worst = j;
        worstBy = by;
      }
    });
    if (worst < 0) break;
    active.splice(worst, 1);
  }
  // A plate is left when the winding holds and nothing crosses.
  const area = area2(out);
  if (Math.sign(area) !== w || Math.abs(area) <= Math.abs(area2(uv)) * 1e-9) return null;
  if (selfCrosses(out)) return null;
  return { uv: out, lines, normals };
}

/** The checks after the reduction (a moved edge that ran away): the plate's UV inside the panel's
 *  UV bounding box and its UV area not over the panel's. The reason, or null when it holds. */
function plateOutOfPanel(plate: Vec2[], panel: Vec2[]): string | null {
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity;
  for (const [u, v] of panel) {
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const slack = Math.max(u1 - u0, v1 - v0) * 1e-6;
  if (
    plate.some(
      ([u, v]) =>
        !Number.isFinite(u) ||
        !Number.isFinite(v) ||
        u < u0 - slack ||
        u > u1 + slack ||
        v < v0 - slack ||
        v > v1 + slack,
    )
  )
    return '판 꼭짓점이 패널 밖';
  if (Math.abs(area2(plate)) > Math.abs(area2(panel)) * (1 + 1e-6)) return '판이 패널보다 큼';
  return null;
}

/** Gap stations along an edge a→b: both ends and the middle, moved off an end at a pole (every
 *  plate meets that one point, so the distance there says nothing of the joint). */
const stationsOf = (ka: string, kb: string) => [
  ka.includes(':p:') ? 0.1 : 0,
  0.5,
  kb.includes(':p:') ? 0.9 : 1,
];

/** A moved edge that went much further on the surface than its amount (a pole, a folded side):
 *  the reason, or null. Measured at the gap stations from the edge to its moved line. */
function ranAway(
  ctx: FaceCtx,
  panel: PanelLayout['panels'][number],
  r: Reduced,
  amounts: number[],
): string | null {
  const uv = panel.uv as Vec2[];
  const n = uv.length;
  for (let i = 0; i < n; i++) {
    if (!amounts[i]) continue;
    const a = uv[i],
      b = uv[(i + 1) % n];
    for (const lam of stationsOf(panel.vertexKeys[i], panel.vertexKeys[(i + 1) % n])) {
      const m = ctx.sampler.point(a[0] + (b[0] - a[0]) * lam, a[1] + (b[1] - a[1]) * lam);
      const q = acrossPoint(uv, r, i, lam);
      const moved = dist3(m, ctx.sampler.point(q[0], q[1]));
      if (!Number.isFinite(moved) || moved > JOINT_GAP_LIMIT * amounts[i] + JOINT_UNEVEN_MIN)
        return `변이 ${Math.round(moved * 1000)} mm 움직임`;
    }
  }
  return null;
}

function intersect(p: [Vec2, Vec2], q: [Vec2, Vec2]): Vec2 | null {
  const r: Vec2 = [p[1][0] - p[0][0], p[1][1] - p[0][1]];
  const s: Vec2 = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  const den = cross2(r, s);
  if (Math.abs(den) <= 1e-9 * Math.hypot(...r) * Math.hypot(...s)) return null;
  const t = cross2([q[0][0] - p[0][0], q[0][1] - p[0][1]], s) / den;
  return [p[0][0] + r[0] * t, p[0][1] + r[1] * t];
}

function selfCrosses(ring: Vec2[]): boolean {
  const n = ring.length;
  if (n < 4) return false;
  const orient = (a: Vec2, b: Vec2, c: Vec2) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = ring[i],
        b = ring[(i + 1) % n],
        c = ring[j],
        d = ring[(j + 1) % n];
      const d1 = orient(a, b, c),
        d2 = orient(a, b, d),
        d3 = orient(c, d, a),
        d4 = orient(c, d, b);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  return false;
}

/** The point on the moved edge `i` that the original edge's point at `lam` moved to (the moved
 *  line is parametrised like the edge, so this is the point across on the surface). */
function acrossPoint(_uv: Vec2[], r: Reduced, i: number, lam: number): Vec2 {
  const [p, q] = r.lines[i];
  return [p[0] + (q[0] - p[0]) * lam, p[1] + (q[1] - p[1]) * lam];
}
/** SPEC-16.2 공통 규칙 4 and SPEC-16.7 1 on the plate: width × height along the pattern axis in the
 *  best-fit plane of the check points (corners, edge middles, centre), and the flatness. */
function plateSize(ctx: FaceCtx, uv: Vec2[], flip: number) {
  const s = ctx.sampler;
  const n = uv.length;
  const corners = uv.map((p) => s.point(p[0], p[1]));
  const mids: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = uv[i],
      b = uv[(i + 1) % n];
    mids.push(s.point((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
  }
  const cu = uv.reduce((x, p) => x + p[0], 0) / n;
  const cv = uv.reduce((x, p) => x + p[1], 0) / n;
  const centre = s.point(cu, cv);
  const checks = [...corners, ...mids, centre];
  const plane = bestFitPlane(checks);
  const ref = scale3(s.normal(cu, cv), flip);
  const normal = dot3(plane.normal, ref) < 0 ? scale3(plane.normal, -1) : plane.normal;
  let flatness = 0;
  for (const c of checks)
    flatness = Math.max(flatness, Math.abs(dot3(sub3(c, plane.origin), normal)));
  let axis: Vec3;
  if (ctx.domain) axis = ctx.domain.axisDir(0, 0);
  else {
    const [su, sv] = partials(ctx, cu, cv);
    axis = norm3(ctx.axis === 'u' ? su : sv);
  }
  let ax = sub3(axis, scale3(normal, dot3(axis, normal)));
  if (len3(ax) < 1e-12) ax = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
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
  return { w: x1 - x0, h: y1 - y0, flatness };
}

/** Largest principal curvature with its centre on the `sign` side of the face normal (≥ 0), over the
 *  raw samples inside the outline and its check points. */
function maxCurvatureToward(ctx: FaceCtx, uv: Vec2[], sign: number): number {
  const s = ctx.sampler;
  const face = s.face;
  let k = 0;
  const take = (k1: number, k2: number) => {
    k = Math.max(k, k1 * sign, k2 * sign);
  };
  const n = uv.length;
  for (let i = 0; i < n; i++) {
    const a = uv[i],
      b = uv[(i + 1) % n];
    take(...s.curvature(a[0], a[1]));
    take(...s.curvature((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
  }
  const cu = uv.reduce((x, p) => x + p[0], 0) / n;
  const cv = uv.reduce((x, p) => x + p[1], 0) / n;
  take(...s.curvature(cu, cv));
  // Raw samples inside the outline (shifted by a period on a closed direction).
  let u0 = Infinity,
    u1 = -Infinity,
    v0 = Infinity,
    v1 = -Infinity;
  for (const p of uv) {
    u0 = Math.min(u0, p[0]);
    u1 = Math.max(u1, p[0]);
    v0 = Math.min(v0, p[1]);
    v1 = Math.max(v1, p[1]);
  }
  const du = (face.domainU[1] - face.domainU[0]) / (face.nu - 1);
  const dv = (face.domainV[1] - face.domainV[0]) / (face.nv - 1);
  const i0 = Math.ceil((u0 - face.domainU[0]) / du),
    i1 = Math.floor((u1 - face.domainU[0]) / du);
  const j0 = Math.ceil((v0 - face.domainV[0]) / dv),
    j1 = Math.floor((v1 - face.domainV[0]) / dv);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) return k;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const pu = face.domainU[0] + i * du,
        pv = face.domainV[0] + j * dv;
      if (!inPolygon([pu, pv], uv)) continue;
      const ii = wrapIndex(i, face.nu, face.closedU),
        jj = wrapIndex(j, face.nv, face.closedV);
      if (ii < 0 || jj < 0) continue;
      const c = (jj * face.nu + ii) * 2;
      take(face.curvatures[c], face.curvatures[c + 1]);
    }
  return k;
}

function wrapIndex(i: number, n: number, closed: boolean): number {
  if (closed) return ((i % (n - 1)) + (n - 1)) % (n - 1);
  return i >= 0 && i < n ? i : -1;
}

function inPolygon(p: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1]) {
      const x = ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0];
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * The plate as a closed triangle mesh: the outline (edges split when curved) on the surface, rings
 * toward its centre when the outline is star-shaped about it (else ear clipping), the same sheet
 * moved `offset` along the face normal, and the side walls. Oriented outward (positive volume);
 * `closed` checks that every edge is used once each way.
 */
function plateSolid(ctx: FaceCtx, uv: Vec2[], offset: number, flat: boolean) {
  const s = ctx.sampler;
  const n0 = uv.length;
  // Curved plates: each edge split in two and one inner ring (a preview, not the made solid).
  const split = flat ? 1 : Math.max(1, Math.min(2, Math.floor(128 / n0)));
  const ring: Vec2[] = [];
  for (let i = 0; i < n0; i++) {
    const a = uv[i],
      b = uv[(i + 1) % n0];
    for (let k = 0; k < split; k++)
      ring.push([a[0] + ((b[0] - a[0]) * k) / split, a[1] + ((b[1] - a[1]) * k) / split]);
  }
  const N = ring.length;
  const w = Math.sign(area2(ring)) || 1;
  const cu = ring.reduce((x, p) => x + p[0], 0) / N;
  const cv = ring.reduce((x, p) => x + p[1], 0) / N;
  const star = ring.every((p, i) => {
    const q = ring[(i + 1) % N];
    return w * cross2([p[0] - cu, p[1] - cv], [q[0] - cu, q[1] - cv]) > 0;
  });
  // Front sheet in UV: boundary first (indices 0..N−1), then inner rings and the centre.
  const front: Vec2[] = ring.slice();
  const tris: [number, number, number][] = [];
  if (star) {
    const R = flat ? 1 : 2;
    let prevRing = Array.from({ length: N }, (_, i) => i);
    for (let r = R - 1; r >= 1; r--) {
      const f = r / R;
      const cur: number[] = [];
      for (const p of ring) {
        cur.push(front.length);
        front.push([cu + (p[0] - cu) * f, cv + (p[1] - cv) * f]);
      }
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        tris.push([prevRing[i], prevRing[j], cur[j]], [prevRing[i], cur[j], cur[i]]);
      }
      prevRing = cur;
    }
    const c = front.length;
    front.push([cu, cv]);
    for (let i = 0; i < N; i++) tris.push([prevRing[i], prevRing[(i + 1) % N], c]);
  } else tris.push(...earClip(ring, w));
  const F = front.length;
  if (2 * F > MESH_VERTEX_LIMIT) return { mesh: null, closed: false, area: 0, volume: 0 };
  const pts: Vec3[] = [];
  for (const p of front) pts.push(s.point(p[0], p[1]));
  for (let i = 0; i < F; i++) {
    const p = front[i];
    const nrm = s.normal(p[0], p[1]);
    pts.push([
      pts[i][0] + nrm[0] * offset,
      pts[i][1] + nrm[1] * offset,
      pts[i][2] + nrm[2] * offset,
    ]);
  }
  const faces: [number, number, number][] = [];
  let area = 0;
  for (const [a, b, c] of tris) {
    faces.push([a, b, c]);
    faces.push([F + a, F + c, F + b]);
    area += len3(cross3(sub3(pts[b], pts[a]), sub3(pts[c], pts[a]))) / 2;
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    faces.push([j, i, F + i], [j, F + i, F + j]);
  }
  // Volume about the first vertex; reverse everything when it comes out inward.
  const o = pts[0];
  let six = 0;
  for (const [a, b, c] of faces)
    six += dot3(sub3(pts[a], o), cross3(sub3(pts[b], o), sub3(pts[c], o)));
  if (six < 0) {
    for (const f of faces) [f[1], f[2]] = [f[2], f[1]];
    six = -six;
  }
  // Closed: every directed edge has exactly one opposite.
  const directed = new Map<string, number>();
  for (const [a, b, c] of faces)
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = `${x}>${y}`;
      directed.set(k, (directed.get(k) ?? 0) + 1);
    }
  let closed = six > 0;
  for (const [k, count] of directed) {
    if (!closed) break;
    const [x, y] = k.split('>');
    if (count !== 1 || directed.get(`${y}>${x}`) !== 1) closed = false;
  }
  const mesh = {
    v: pts.flatMap((p) => [round6(p[0]), round6(p[1]), round6(p[2])]),
    f: faces.flat(),
  };
  return { mesh, closed, area, volume: six / 6 };
}

/** Ear clipping of a simple polygon with winding `w` (+1 ccw); triangles keep that winding. */
function earClip(ring: Vec2[], w: number): [number, number, number][] {
  const idx = ring.map((_, i) => i);
  const out: [number, number, number][] = [];
  const cr = (a: Vec2, b: Vec2, c: Vec2) =>
    w * ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k - 1 + idx.length) % idx.length],
        ib = idx[k],
        ic = idx[(k + 1) % idx.length];
      const a = ring[ia],
        b = ring[ib],
        c = ring[ic];
      if (cr(a, b, c) <= 0) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = ring[j];
        if (cr(a, b, p) >= 0 && cr(b, c, p) >= 0 && cr(c, a, p) >= 0) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      out.push([ia, ib, ic]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  return out;
}
