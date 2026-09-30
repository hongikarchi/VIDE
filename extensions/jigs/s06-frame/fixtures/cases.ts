// Self-test cases of the S-06 frame jig (PLAN-23 T-051, RESEARCH-10 §14.8): synthetic layouts only
// (결정 A12). `writeFixtures` turns each case into `fixtures/<case>/{input,params,expect}.json`; the
// unit tests read the same cases. Expectations are the ones a person can check by hand on the
// drawing; numbers that depend on the search are asserted as bounds in the tests, not here.

import {
  buildCase,
  grid4mBay,
  gridRot21,
  roleInputs,
  type Local,
  type SyntheticLayout,
} from './synthetic.ts';

export interface FixtureCase {
  name: string;
  layout: SyntheticLayout;
  params: Record<string, number | string | boolean>;
  expect: { steps?: Record<string, unknown>; statuses?: Record<string, string> };
}

const rect = (u0: number, v0: number, u1: number, v1: number): Local[] => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];

/**
 * grid-rot21 (M0 case + M1 site): the −21° layout of the diagnosis with a 22 × 16 m slab around it,
 * a fire route strip on the right, an existing grid whose X3 × Y2 crossing has no footing, one
 * new and one existing expansion joint.
 */
export const gridRot21M1: SyntheticLayout = {
  ...gridRot21,
  slab: rect(-3, -3.5, 17, 12.5),
  fire: [rect(15, -3.5, 17, 12.5)],
  grid: [
    { name: 'X1', from: [0, -4], to: [0, 13] },
    { name: 'X2', from: [6.559, -4], to: [6.559, 13] },
    { name: 'X3', from: [13.559, -4], to: [13.559, 13] },
    { name: 'Y1', from: [-4, -3.0], to: [18, -3.0] },
    { name: 'Y2', from: [-4, 7.059], to: [18, 7.059] },
  ],
  newEJ: [{ name: 'EJ1', from: [7.0, -3.5], to: [7.0, 12.5] }],
  existingEJ: [{ name: 'XEJ1', from: [-3, 2.0], to: [17, 2.0] }],
  requested: [{ id: 'req-1', ring: rect(1, 8, 6, 12) }],
};

/**
 * grid-4m-bay (M1 site): three existing footings in a 14 × 8 m slab; the two axis-aligned ones
 * keep 0.15 m in v from a cap on the u axis, the turned one 0.771 m — one-direction separation.
 */
export const grid4mBayM1: SyntheticLayout = {
  ...grid4mBay,
  slab: rect(-2, -4, 12, 4),
};

/**
 * priority-conflict: a 33 × 9 m strip over a dense 3 m field of existing footings (2.7 m): every cap
 * within span reach clashes, so the span must be kept and the cap violations listed.
 */
export const priorityConflict: SyntheticLayout = {
  angleDeg: 0,
  origin: [1000, 2000],
  columnZ: [0, 6],
  columns: [],
  girders: [],
  caps: [],
  existing: Array.from({ length: 11 }, (_, i) =>
    [0, 3, 6].map((v): { at: Local } => ({ at: [i * 3, v] })),
  ).flat(),
  bands: [],
  slab: rect(-1.5, -1.5, 31.5, 7.5),
};

/**
 * drawn-two-bay (M2, drawn mode): six columns on an 8 m × 7 m two-bay grid turned 15°, girders as a
 * person drew them — one ending 0.2 m short of its column (snapped), one starting 0.15 m off
 * (snapped), a duplicate piece (merged), a 2.5 m girder past the last column (dangling end), one
 * long girder over a middle column (cut there) — a planter zone over the left bay, restraint at
 * EL 3.
 */
export const drawnTwoBay: SyntheticLayout = {
  angleDeg: 15,
  origin: [500, 800],
  columnZ: [0, 6],
  columns: [
    { at: [0, 0] },
    { at: [8, 0] },
    { at: [16, 0] },
    { at: [0, 7] },
    { at: [8, 7] },
    { at: [16, 7] },
  ],
  girders: [
    [
      [0, 0],
      [16, 0],
    ],
    [
      [0, 7],
      [15.8, 7],
    ],
    [
      [0, 0],
      [0, 7],
    ],
    [
      [8, 0.15],
      [8, 7],
    ],
    [
      [16, 0],
      [16, 7],
    ],
    [
      [0, 0],
      [8, 0],
    ],
    [
      [16, 0],
      [18.5, 0],
    ],
  ],
  existing: [{ at: [4, 3.5] }, { at: [12, 3.5] }],
  bands: [],
  slab: rect(-1, -1, 18.5, 8),
  planter: [rect(-1, -1, 8, 8)],
};

export const CASES: FixtureCase[] = [
  {
    name: 'grid-rot21',
    layout: gridRot21M1,
    params: {
      capClearance: 0,
      columnSize: 0.5,
      spanMax: 12,
      splitTol: 0.3,
      layoutSource: 'proposed',
    },
    expect: {
      steps: {
        assemble: {
          existing: { readable: 6, angleDeg: -21 },
          frame: { angleDeg: -21, source: 'footings' },
          basin: { readable: 2 },
        },
        diagnose: {
          summary: {
            columns: 10,
            cap: { count: 4 },
            openCut: { count: 7 },
            basin: { count: 2 },
            spans: { total: 12, over: 2 },
            curves: { total: 6, over: 4 },
          },
        },
        axes: { objective: { spanOver: 0, cap: 0 } },
        interference: { summary: { cap: { count: 0 } } },
      },
      statuses: { confirmInputs: 'confirmed' },
    },
  },
  {
    name: 'grid-4m-bay',
    layout: grid4mBayM1,
    params: { capClearance: 0, spanMax: 12, cantileverMax: 4, layoutSource: 'proposed' },
    expect: {
      steps: {
        diagnose: { summary: { cap: { count: 0 }, openCut: { count: 3 }, basin: { count: 0 } } },
        axes: { objective: { spanOver: 0, cap: 0 } },
        interference: { summary: { cap: { count: 0 } } },
      },
      statuses: { confirmInputs: 'confirmed' },
    },
  },
  {
    name: 'priority-conflict',
    layout: priorityConflict,
    params: { spanMax: 12, capClearance: 0.2, layoutSource: 'proposed' },
    expect: {
      steps: {
        axes: { objective: { spanOver: 0 }, relaxed: ['openCut', 'cap'] },
      },
      statuses: { confirmInputs: 'confirmed' },
    },
  },
  {
    name: 'drawn-two-bay',
    layout: drawnTwoBay,
    params: { spanMax: 12, restraintOn: true, restraintLevel: 3 },
    expect: {
      steps: {
        // Every end within reach counts as snapped (9), two of them actually moved (0.2, 0.15 m).
        girders: { summary: { girders: 6, snapped: 9, dangling: 1, spansOver: 0 } },
        cells: { summary: { cells: 2 } },
        beams: { summary: { beams: 4, edgeCantilevers: 0 } },
        axes: { skipped: true },
        // M3 (T-056): five sizing groups (column, three girder span bands, beam), sixteen marked
        // members, six columns floored to 5 m under a 0.6 m girder, sixteen top lines and members
        // planned. Sections and tonnes depend on the analysis: tests/core/s06-m3.test.mjs.
        sizing: { summary: { groups: 5 } },
        schedule: { totals: { count: 16 } },
        heights: { summary: { columns: 6, floored: 6, short: 0 } },
        bakePlan: { previewOnly: true, summary: { lines: 16, members: 16 } },
        bakeMembers: { previewOnly: true, summary: { lines: 0, members: 16 } },
      },
      // model·analysis need the engine (structure sections and core): tests/core/s06-m2.test.mjs.
      statuses: { confirmInputs: 'confirmed' },
    },
  },
];

export function fixtureFiles(entry: FixtureCase) {
  const built = buildCase(entry.layout);
  return {
    input: roleInputs(built, entry.layout),
    params: entry.params,
    expect: entry.expect,
  };
}
