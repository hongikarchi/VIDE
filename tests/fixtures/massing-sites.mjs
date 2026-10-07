// Synthetic sites for `vide/massing-kit` (PLAN-45 T-209·T-210): the five sites of
// SPIKE-2026-10-07-envelope, a slanted-north site with a hand calculation for the due-north
// distance, and the spike's star-shaped stress sites. Invented coordinates in local metres
// (x = east, y = north); no real parcel. The 규제 조건 values below are test inputs a person would
// type, not a legal reading (SPEC-12.7 5·6) — the library itself holds no such number.

/** A read row (flat xyz `line`) as the assembly gives it; closed rings repeat the first point. */
export const row = (id, points, closed = true) => ({
  id,
  line: [...points, ...(closed ? [points[0]] : [])].flatMap(([x, y]) => [x, y, 0]),
});
const rows = (prefix, rings, closed = true) => ({
  rows: rings.map((r, i) => row(`${prefix}-${i + 1}`, r, closed)),
});

/** 규제 조건 settings shared by the spike sites (test values). */
export const BASE_PARAMS = {
  roadSetbackState: 'apply',
  roadSetback: 1,
  civilSetbackState: 'apply',
  civilSetback: 0.5,
  chamferLengthState: 'none',
  openSpaceRoadState: 'none',
  openSpaceAdjacentState: 'none',
  otherSetbackState: 'none',
  sunState: 'apply',
  sunBaseHeight: 10,
  sunNearDistance: 1.5,
  sunRatio: 0.5,
  sunDatumRoad: 'across-road',
  sunDistance: 'euclidean',
  heightMaxState: 'apply',
  heightMax: 30,
  streetHeightState: 'none',
  altitudeHeightState: 'none',
  floorsMaxState: 'none',
  coverageState: 'apply',
  coverage: 0.6,
  mainUse: '업무시설',
  floorHeightGround: 4.5,
  floorHeightTypical: 3.3,
  studyHeight: 60,
  northBasis: 'true',
  gridNorthDeg: 0,
  convergenceDeg: 0,
  segmentTolerance: 0.05,
};

/** Area of a circle's circumscribed n-gon (the library's round ends, n = 64). */
export const ngon = (r, n = 64) => n * r * r * Math.tan(Math.PI / n);

const lArea = (() => {
  const r = 1.5,
    c = 0.5;
  const segment = r * r * Math.acos(c / r) - c * Math.sqrt(r * r - c * c);
  return 28.5 * 12.5 + (14 * 1.5 + 13.5 * 13.5) - (Math.PI * r * r) / 4 - segment / 2 - 0.5;
})();

export const SITES = [
  {
    id: 'rect',
    title: '직사각형 20×30, 남측 도로, 북측 인접 대지',
    inputs: {
      site: {
        boundary: rows('site', [
          [
            [0, 0],
            [20, 0],
            [20, 30],
            [0, 30],
          ],
        ]),
        roads: rows('road', [
          [
            [-10, -8],
            [30, -8],
            [30, 0],
            [-10, 0],
          ],
        ]),
        neighbors: rows('lot', [
          [
            [20, 0],
            [40, 0],
            [40, 30],
            [20, 30],
          ],
          [
            [0, 30],
            [20, 30],
            [20, 50],
            [0, 50],
          ],
          [
            [-20, 0],
            [0, 0],
            [0, 30],
            [-20, 30],
          ],
        ]),
      },
    },
    params: { heightMax: 30 },
    // Hand calculation: x ∈ [0.5, 19.5], y ∈ [1, 28.5]; 일조 per metre of x: 3.5×10 + ∫5..15 2d + 15×30.
    expect: {
      area: 19 * 27.5,
      reductions: { 'road-setback': 20, civil: 600 - 19 * 29.5, 'sun-ground': 30 },
      extrude: 19 * 27.5 * 30,
      sun: 20 * 685,
      max: 19 * 655,
    },
  },
  {
    id: 'l-shape',
    title: '오목 L형 30×30(북동 15×15 제외), 남·서 도로와 가각, 꺾인 북측 두 구간',
    inputs: {
      site: {
        boundary: rows('site', [
          [
            [0, 0],
            [30, 0],
            [30, 15],
            [15, 15],
            [15, 30],
            [0, 30],
          ],
        ]),
        roads: rows('road', [
          [
            [-6, -6],
            [40, -6],
            [40, 0],
            [-6, 0],
          ],
          [
            [-6, 0],
            [0, 0],
            [0, 40],
            [-6, 40],
          ],
        ]),
        neighbors: rows('lot', [
          [
            [30, 0],
            [40, 0],
            [40, 15],
            [30, 15],
          ],
          [
            [15, 15],
            [30, 15],
            [30, 30],
            [15, 30],
          ],
          [
            [0, 30],
            [15, 30],
            [15, 40],
            [0, 40],
          ],
        ]),
      },
    },
    params: { heightMax: 25, chamferLengthState: 'apply', chamferLength: 3 },
    expect: {
      // lower bar + column − quarter disk(1.5) − half circular segment − chamfer overlap (true circles)
      areaTrue: lArea,
      reductions: {
        'road-setback': 59,
        chamfer: 4.5,
        // four 0.5 strips, two convex corner squares, the reflex corner's fourth quarter of 0.5
        civil: 30 - 0.5 + ngon(0.5) / 4,
        // two 1.5 strips of 15 m and the half round end at the reflex corner
        'sun-ground': 45 + ngon(1.5) / 2,
      },
      // fine-grid integration of the true-circle heights (SPIKE 결과 2, ±0.09)
      maxGrid: 9384.08,
    },
  },
  {
    id: 'north-road',
    title: '직사각형 20×24, 정북에 너비 6 m 도로(기준선 = 도로 건너편 경계)',
    inputs: {
      site: {
        boundary: rows('site', [
          [
            [0, 0],
            [20, 0],
            [20, 24],
            [0, 24],
          ],
        ]),
        roads: rows('road', [
          [
            [-10, 24],
            [30, 24],
            [30, 30],
            [-10, 30],
          ],
        ]),
        neighbors: rows('lot', [
          [
            [0, -20],
            [20, -20],
            [20, 0],
            [0, 0],
          ],
          [
            [20, 0],
            [40, 0],
            [40, 24],
            [20, 24],
          ],
          [
            [-20, 0],
            [0, 0],
            [0, 24],
            [-20, 24],
          ],
        ]),
      },
    },
    params: { heightMax: 40, roadSetbackState: 'none' },
    expect: {
      area: 19 * 23.5,
      reductions: { civil: 480 - 19 * 23.5, 'sun-ground': 0 },
      extrude: 19 * 23.5 * 40,
      sun: 20 * 764,
      max: 19 * 744,
    },
  },
  {
    id: 'kinked-north',
    title: '북측 경계가 오목하게 꺾인 대지(두 구간의 원뿔 이음)',
    inputs: {
      site: {
        boundary: rows('site', [
          [
            [0, 0],
            [24, 0],
            [24, 28],
            [12, 24],
            [0, 28],
          ],
        ]),
        roads: rows('road', [
          [
            [-10, -6],
            [34, -6],
            [34, 0],
            [-10, 0],
          ],
        ]),
        neighbors: rows('lot', [
          [
            [24, 0],
            [34, 0],
            [34, 28],
            [24, 28],
          ],
          [
            [24, 28],
            [12, 24],
            [0, 28],
            [0, 40],
            [24, 40],
          ],
          [
            [-10, 0],
            [0, 0],
            [0, 28],
            [-10, 28],
          ],
        ]),
      },
    },
    params: { heightMax: 30 },
    // fine-grid integration of the true-circle heights (SPIKE 결과 1·2): area ±0.04, volume ±0.38
    expect: { areaGrid: 536.7316, maxGrid: 12005.25 },
  },
  {
    id: 'two-zones',
    title: '두 용도지역 걸침 30×20: 서측 12 m만 일조 적용',
    inputs: {
      site: {
        boundary: rows('site', [
          [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
          ],
        ]),
        roads: rows('road', [
          [
            [-10, -6],
            [40, -6],
            [40, 0],
            [-10, 0],
          ],
        ]),
        neighbors: rows('lot', [
          [
            [30, 0],
            [40, 0],
            [40, 20],
            [30, 20],
          ],
          [
            [0, 20],
            [30, 20],
            [30, 40],
            [0, 40],
          ],
          [
            [-10, 0],
            [0, 0],
            [0, 20],
            [-10, 20],
          ],
        ]),
        sunZone: rows('zone', [
          [
            [-5, -5],
            [12, -5],
            [12, 25],
            [-5, 25],
          ],
        ]),
      },
    },
    params: { heightMax: 35 },
    expect: {
      area: 11.5 * 17.5 + 17.5 * 18.5,
      reductions: { 'sun-ground': 1.5 * 12 },
      extrude: (11.5 * 17.5 + 17.5 * 18.5) * 35,
      sun: 12 * 403.75 + 18 * 20 * 35,
      max: 11.5 * 368.75 + 17.5 * 18.5 * 35,
    },
  },
];

/**
 * A site whose north boundary slants (y = 20 + x/2 from x = 0 to 20): measured due north, the
 * distance from (x, y) to the datum is 20 + x/2 − y, so per metre of x the 일조 외피 holds
 * 35 + 200 + 30·(L − 15) with L = 20 + x/2 (H = 30), i.e. 4700 + 30·∫(5 + x/2)dx = 10700 m³.
 */
export const SLANTED = {
  id: 'slanted-north',
  inputs: {
    site: {
      boundary: rows('site', [
        [
          [0, 0],
          [20, 0],
          [20, 30],
          [0, 20],
        ],
      ]),
      neighbors: rows('lot', [
        [
          [20, 30],
          [0, 20],
          [0, 40],
          [20, 40],
        ],
      ]),
    },
  },
  params: {
    roadSetbackState: 'none',
    civilSetbackState: 'none',
    sunDistance: 'north',
    heightMax: 30,
  },
  // The 1.5 m 지면 벽 is a 20 × 1.5 parallelogram in plan, so the extrusion stands on 470 ㎡.
  expect: { extrude: 470 * 30, sun: 10700 },
};

/** The spike's stress site: n edges, all neighbours (민법 0.5), north-facing edges as datum. */
export function star(n) {
  const site = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const r = 25 + (i % 2 ? 3 : 0) + 2 * Math.sin(3 * t);
    site.push([30 + r * Math.cos(t), 30 + r * Math.sin(t)]);
  }
  // Each neighbour is a thin quad outside its edge, so every edge is an 인접 대지 segment.
  const neighbors = site.map((a, i) => {
    const b = site[(i + 1) % n];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      l = Math.hypot(dx, dy);
    const nx = dy / l,
      ny = -dx / l;
    return [a, [a[0] + nx * 5, a[1] + ny * 5], [b[0] + nx * 5, b[1] + ny * 5], b];
  });
  return {
    id: `star-${n}`,
    inputs: { site: { boundary: rows('site', [site]), neighbors: rows('lot', neighbors) } },
    params: { roadSetbackState: 'none', heightMax: 40 },
  };
}

export const paramsOf = (site) => ({ ...BASE_PARAMS, ...(site.params ?? {}) });

/**
 * The whole `vide/buildable-mass` pipeline as library calls (PLAN-45 T-211·T-212): site → … →
 * envelope → floors → 공개공지 → 대안 → 용도 → 주차. `overrides` are 수정 사항 as the engine hands
 * them; `drawn` adds input roles (공개공지·조경 영역, 주차 출입 제외 선).
 */
export async function runMass(site, extra = {}, overrides = [], drawn = {}) {
  const kit = await import('../../src/jigs/official/massing-kit/index.ts');
  const params = { ...paramsOf(site), ...extra };
  const own = { ...site.inputs.site, ...drawn };
  const s = kit.siteStep({ site: own }, params);
  const regulations = kit.regulationStep({}, params, overrides);
  const plan = kit.planStep({}, params);
  const limits = kit.limitStep({ site: own, steps: { site: s, regulations } });
  const envelope = kit.envelopeStep({ steps: { site: s, regulations, plan, limits } });
  const floors = kit.floorsStep({ steps: { site: s, plan, envelope } });
  const openSpace = kit.openSpaceStep({ site: own, steps: { site: s, regulations } }, params);
  const steps = { site: s, regulations, plan, limits, envelope, floors, openSpace };
  steps.alternatives = kit.alternativesStep({ steps }, params, overrides);
  steps.useMix = kit.useMixStep({ steps }, params, overrides);
  steps.parking = kit.parkingStep({ site: own, steps }, params);
  return { params, steps, kit };
}

/** A 수정 사항 as the instance keeps it (SPEC-07.8). */
export const override = (kind, identity, fields, op = 'set', by = 'user') => ({
  id: `${kind}:${Object.values(identity).join(':')}`,
  target: { kind, identity },
  op,
  fields,
  origin: 'table',
  by,
  at: '2026-10-08T00:00:00Z',
});
