// Synthetic `SurfaceSample`s for the 패널링 tests (PLAN-49): analytic faces sampled like the read
// template (`vide.read.surface-grid@1`: equal parameter steps, k = j·nu + i, a closed direction's last
// sample equals its first, normals after the face orientation, signed curvatures k1 ≥ k2 with + =
// centre on the normal side, trim loops in UV with the outer loop first). No project data.

const HASH = (n) => n.toString(16).padStart(2, '0').repeat(32);

/**
 * Sample `fn(u, v) → { p: [x,y,z], n: [x,y,z], k: [k1,k2] }` on an nu × nv grid.
 * @param {object} o
 */
export function sampleFace(fn, o) {
  const { nu = 128, nv = 128, domainU, domainV } = o;
  const points = [],
    normals = [],
    curvatures = [],
    inside = [];
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const u = domainU[0] + ((domainU[1] - domainU[0]) * i) / (nu - 1);
      const v = domainV[0] + ((domainV[1] - domainV[0]) * j) / (nv - 1);
      const { p, n, k } = fn(u, v);
      points.push(...p);
      normals.push(...n);
      curvatures.push(...k);
      inside.push(o.inside ? (o.inside(u, v) ? 1 : 0) : 1);
    }
  return {
    faceIndex: o.faceIndex ?? 0,
    domainU,
    domainV,
    nu,
    nv,
    closedU: !!o.closedU,
    closedV: !!o.closedV,
    singular: { uMin: false, uMax: false, vMin: false, vMax: false, ...(o.singular ?? {}) },
    points,
    normals,
    curvatures,
    inside,
    trimLoops: o.trimLoops ?? [],
    geometryHash: o.hash ?? HASH(o.faceIndex ?? 0),
  };
}

export function sampleOf(faces, source = {}) {
  return {
    schema: 'vide.paneling.surface@1',
    source: {
      linkId: 'link-1',
      documentKey: 'doc-1',
      objectId: '6f1c2b1e-1111-4a6b-9c1d-000000000002',
      revisionKey: 'rhino|doc-1|1',
      readAt: '2026-10-08T09:00:00.000Z',
      toMeters: 1,
      absTol: 0.00001,
      path: 'attached-template',
      ...source,
    },
    faces: Array.isArray(faces) ? faces : [faces],
  };
}

/** Plane W × H (m) on z = 0, parameters scaled by `paramScale` (e.g. 1000 = a mm domain). */
export function plane(W, H, o = {}) {
  const ps = o.paramScale ?? 1;
  const off = o.paramOffset ?? [0, 0];
  return sampleFace(
    (u, v) => ({ p: [(u - off[0]) / ps, (v - off[1]) / ps, 0], n: [0, 0, 1], k: [0, 0] }),
    {
      nu: 16,
      nv: 16,
      ...o,
      domainU: [off[0], off[0] + W * ps],
      domainV: [off[1], off[1] + H * ps],
    },
  );
}

/**
 * Cylinder band, radius R, `angle` (rad) around Z, height H. The angle is not proportional to u
 * (θ = angle·(u + 0.5u²)/1.5), as a rational NURBS arc is not: arc length ≠ parameter.
 * The normal points outward (curvature centre on the other side: k2 = −1/R).
 */
export function cylinderBand(R = 8, angle = (2 * Math.PI) / 3, H = 6, o = {}) {
  return sampleFace(
    (u, v) => {
      const th = (angle * (u + 0.5 * u * u)) / 1.5;
      return {
        p: [R * Math.cos(th), R * Math.sin(th), v * H],
        n: [Math.cos(th), Math.sin(th), 0],
        k: [0, -1 / R],
      };
    },
    { ...o, domainU: [0, 1], domainV: [0, 1] },
  );
}

/** Closed cylinder (seam along U), radius R, height H. */
export function closedCylinder(R = 4, H = 6, o = {}) {
  return sampleFace(
    (u, v) => ({
      p: [R * Math.cos(u), R * Math.sin(u), v],
      n: [Math.cos(u), Math.sin(u), 0],
      k: [0, -1 / R],
    }),
    { ...o, domainU: [0, 2 * Math.PI], domainV: [0, H], closedU: true },
  );
}

/** Sphere band, radius R, latitude from `lat0` to the north pole (collapsed side vMax). */
export function sphereBand(R = 5, lat0 = -Math.PI / 6, o = {}) {
  return sampleFace(
    (u, v) => {
      const c = Math.cos(v),
        s = Math.sin(v);
      const n = [c * Math.cos(u), c * Math.sin(u), s];
      return { p: n.map((x) => R * x), n, k: [-1 / R, -1 / R] };
    },
    {
      ...o,
      domainU: [0, 2 * Math.PI],
      domainV: [lat0, Math.PI / 2],
      closedU: true,
      singular: { vMax: true },
    },
  );
}

/** Ring of `count` UV points around (cx, cy), radius r (counter-clockwise). */
export function circleLoop(cx, cy, r, count = 64) {
  return Array.from({ length: count }, (_, k) => {
    const a = (2 * Math.PI * k) / count + 0.0123;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** The domain rectangle as a loop of 64 points (16 per side), as the read template writes it. */
export function rectLoop(u0, u1, v0, v1, per = 16) {
  const out = [];
  for (let k = 0; k < per; k++) out.push([u0 + ((u1 - u0) * k) / per, v0]);
  for (let k = 0; k < per; k++) out.push([u1, v0 + ((v1 - v0) * k) / per]);
  for (let k = 0; k < per; k++) out.push([u1 - ((u1 - u0) * k) / per, v1]);
  for (let k = 0; k < per; k++) out.push([u0, v1 - ((v1 - v0) * k) / per]);
  return out;
}

/** Hyperbolic paraboloid 30 × 20 m, z = (x−15)²/60 − (y−10)²/40 + 5, with a 2.5 m trim hole. */
export function hypar(o = {}) {
  const hole = o.hole ?? true;
  return sampleFace(
    (x, y) => {
      const fx = (x - 15) / 30,
        fy = -(y - 10) / 20,
        fxx = 1 / 30,
        fyy = -1 / 20;
      const W = Math.sqrt(1 + fx * fx + fy * fy);
      const E = 1 + fx * fx,
        F = fx * fy,
        G = 1 + fy * fy;
      const L = fxx / W,
        N = fyy / W;
      const K = (L * N) / (E * G - F * F);
      const Hm = (E * N + G * L) / (2 * (E * G - F * F));
      const d = Math.sqrt(Math.max(0, Hm * Hm - K));
      return {
        p: [x, y, (x - 15) ** 2 / 60 - (y - 10) ** 2 / 40 + 5],
        n: [-fx / W, -fy / W, 1 / W],
        k: [Hm + d, Hm - d],
      };
    },
    {
      ...o,
      domainU: [0, 30],
      domainV: [0, 20],
      trimLoops: hole ? [rectLoop(0, 30, 0, 20), circleLoop(15.3, 9.7, 2.5)] : [],
    },
  );
}

/** More than half a cylinder lying along Y: seen from above (plan XY) it folds over itself. */
export function foldedArc(R = 3, L = 6, o = {}) {
  return sampleFace(
    (u, v) => ({
      p: [R * Math.cos(u), v, R * Math.sin(u)],
      n: [Math.cos(u), 0, Math.sin(u)],
      k: [0, -1 / R],
    }),
    { nu: 64, nv: 32, ...o, domainU: [-0.2 * Math.PI, 0.6 * Math.PI], domainV: [0, L] },
  );
}

/** Stage-1 settings with every value given by a person, overridable per key. */
export function previewSettings(over = {}) {
  const base = {
    pattern: 'grid',
    size: [1.2, 0.6],
    measure: 'arc-length',
    projection: 'plan-xy',
    direction: { axis: 'u', startCorner: 'min-min', flip: false },
    boundary: { rule: 'trim', mergeBelow: 0.3 },
    ...over,
  };
  return Object.fromEntries(
    Object.entries(base).map(([k, value]) => [k, { value, source: 'person' }]),
  );
}
