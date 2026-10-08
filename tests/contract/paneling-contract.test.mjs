import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  surfaceSampleSchema,
  previewSettingsSchema,
  panelLayoutSchema,
  memberSetSchema,
  panelTypingSchema,
  stageConfirmed,
  makeAllowed,
  makeKey,
  geomTol,
  SCHEDULE_COLUMNS,
  memberSettingsSchema,
} from '../../src/contracts/paneling.ts';

// PLAN-49: the shared shapes of 패널링 (SPEC-16). A 2×2 sampled plane, one panel through the stages.

const H = 'b'.repeat(64);
const sample = {
  schema: 'vide.paneling.surface@1',
  source: {
    linkId: 'link-1',
    documentKey: 'doc-1',
    objectId: '6f1c2b1e-1111-4a6b-9c1d-000000000002',
    revisionKey: 'rhino|doc-1|3',
    readAt: '2026-10-08T09:00:00.000Z',
    toMeters: 0.001,
    absTol: 0.00001,
    path: 'attached-template',
  },
  faces: [
    {
      faceIndex: 0,
      domainU: [0, 2400],
      domainV: [10, 1210],
      nu: 2,
      nv: 2,
      closedU: false,
      closedV: false,
      singular: { uMin: false, uMax: false, vMin: false, vMax: false },
      points: [0, 0, 0, 2.4, 0, 0, 0, 1.2, 0, 2.4, 1.2, 0],
      normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      curvatures: [0, 0, 0, 0, 0, 0, 0, 0],
      inside: [1, 1, 1, 1],
      trimLoops: [],
      geometryHash: H,
    },
  ],
};

const corners = [
  [0, 0, 0],
  [1.2, 0, 0],
  [1.2, 0.6, 0],
  [0, 0.6, 0],
];
const uv = [
  [0, 10],
  [1200, 10],
  [1200, 610],
  [0, 610],
];

test('surface sample: valid grid passes, wrong array lengths fail', () => {
  assert.equal(surfaceSampleSchema.safeParse(sample).success, true);
  const bad = structuredClone(sample);
  bad.faces[0].normals.pop();
  assert.equal(surfaceSampleSchema.safeParse(bad).success, false);
  const reversed = structuredClone(sample);
  reversed.faces[0].domainU = [5, 5];
  assert.equal(surfaceSampleSchema.safeParse(reversed).success, false);
  // all faces together stay under the read cap
  const big = structuredClone(sample);
  const f = big.faces[0];
  f.nu = 512;
  f.nv = 129;
  const n = f.nu * f.nv;
  f.points = new Array(3 * n).fill(0);
  f.normals = new Array(3 * n).fill(0);
  f.curvatures = new Array(2 * n).fill(0);
  f.inside = new Array(n).fill(1);
  assert.equal(surfaceSampleSchema.safeParse(big).success, false);
  // geometric tolerance never drops under 0.1 mm
  assert.equal(geomTol(sample), 0.0001);
});

test('settings: assumed values block confirmation', () => {
  const settings = {
    pattern: { value: 'grid', source: 'assumed' },
    size: { value: [1.2, 0.6], source: 'person' },
    measure: { value: 'arc-length', source: 'assumed' },
    projection: { value: 'plan-xy', source: 'assumed' },
    direction: { value: { axis: 'u', startCorner: 'min-min', flip: false }, source: 'assumed' },
    boundary: { value: { rule: 'trim', mergeBelow: 0.3 }, source: 'assumed' },
  };
  assert.equal(previewSettingsSchema.safeParse(settings).success, true);
  assert.equal(stageConfirmed(settings), false);
  assert.equal(makeAllowed('preview', { preview: settings }), true);
  const members = {
    thickness: { value: 0.05, source: 'person' },
    thicknessSide: { value: 'outside', source: 'person' },
    joint: { value: 0.01, source: 'question' },
    boundaryJoint: { value: 'flush', source: 'person' },
    stock: { value: null, source: 'person' },
  };
  assert.equal(memberSettingsSchema.safeParse(members).success, true);
  // members are confirmed but stage 1 still has assumed values → no member make
  assert.equal(makeAllowed('members', { preview: settings, members }), false);
  for (const k of Object.keys(settings)) settings[k].source = 'person';
  assert.equal(stageConfirmed(settings), true);
  assert.equal(makeAllowed('members', { preview: settings, members }), true);
  assert.equal(makeAllowed('optimize', { preview: settings, members }), false);
  // the old joint placement is gone: boundaryJoint only
  assert.equal(
    memberSettingsSchema.safeParse({
      ...members,
      jointPlacement: { value: 'inset', source: 'person' },
    }).success,
    false,
  );
});

test('panel ids, make keys and schedule columns', () => {
  assert.equal(makeKey('member', 'abcdef0123456789', 'P-3-4'), 'member:abcdef01:P-3-4');
  assert.deepEqual(SCHEDULE_COLUMNS.panels.map(([k]) => k).slice(0, 4), [
    'id',
    'face',
    'row',
    'col',
  ]);
  const keys = new Set(SCHEDULE_COLUMNS.panels.map(([k]) => k));
  assert.equal(keys.size, SCHEDULE_COLUMNS.panels.length);
});

test('layout → members → typing chain', () => {
  const layout = {
    schema: 'vide.paneling.layout@1',
    surfaceHash: H,
    settingsHash: H,
    panels: [
      {
        id: 'P-1-1',
        faceIndex: 0,
        row: 1,
        col: 1,
        uv,
        corners,
        vertexKeys: ['0:0:0', '0:1:0', '0:1:1', '0:0:1'],
        boundary: false,
        pole: false,
        mergedFrom: [],
        width: 1.2,
        height: 0.6,
        area: 0.72,
        failure: null,
      },
    ],
    counts: { total: 1, boundary: 0, pole: 0, failed: 0, dropped: 0, offTarget: 0 },
    sizeRange: { minW: 1.2, maxW: 1.2, minH: 0.6, maxH: 0.6, area: 0.72 },
    module: [1.2, 0.6],
    coarseSample: false,
  };
  assert.equal(panelLayoutSchema.safeParse(layout).success, true);
  assert.equal(
    panelLayoutSchema.safeParse({ ...layout, panels: [{ ...layout.panels[0], id: 'X1' }] }).success,
    false,
  );
  // ids count from 1; triangle halves and merged cut panels have their own forms
  for (const [id, ok] of [
    ['P-0-1', false],
    ['P-3-4a', true],
    ['P-3-4+3-5', true],
    ['F2-P-10-1b', true],
  ]) {
    const r = panelLayoutSchema.safeParse({ ...layout, panels: [{ ...layout.panels[0], id }] });
    assert.equal(r.success, ok, id);
  }
  // one vertex key per outline vertex
  assert.equal(
    panelLayoutSchema.safeParse({
      ...layout,
      panels: [{ ...layout.panels[0], vertexKeys: ['0:0:0', '0:1:0', '0:1:1'] }],
    }).success,
    false,
  );

  const members = {
    schema: 'vide.paneling.members@1',
    layoutHash: H,
    settingsHash: H,
    members: [
      {
        panelId: 'P-1-1',
        uv,
        solid: null,
        flatSize: [1.19, 0.59],
        flatSizeApprox: false,
        thickness: 0.05,
        area: 0.7021,
        volume: 0.0351,
        jointGap: [0.01, 0.01],
        jointUneven: false,
        failure: null,
      },
    ],
    joints: [
      {
        keys: ['0:1:0', '0:1:1'],
        line: [
          [1.2, 0, 0],
          [1.2, 0.6, 0],
        ],
      },
    ],
    overStock: [],
  };
  assert.equal(memberSetSchema.safeParse(members).success, true);

  const typing = {
    schema: 'vide.paneling.typing@1',
    membersHash: H,
    settingsHash: H,
    panels: [
      {
        panelId: 'P-1-1',
        type: 'T-01',
        class: 'flat',
        flatness: 0,
        planarGap: null,
        offSurface: null,
        deviation: 0,
        flat: [
          [0, 0],
          [1.19, 0],
          [1.19, 0.59],
          [0, 0.59],
        ],
        failure: null,
      },
    ],
    types: [
      {
        type: 'T-01',
        class: 'flat',
        count: 1,
        vertexCount: 4,
        representative: 'P-1-1',
        size: [1.19, 0.59],
        maxDeviation: 0,
        mirrorOf: null,
      },
    ],
    nodes: [{ type: 'N-01', valence: 1, angles: [90], count: 4 }],
    joints: [{ type: 'J-01', dihedral: [-0.5, 0.5], count: 1, length: 0.6, totalLength: 0.6 }],
    nodeAt: [{ key: '0:0:0', type: 'N-01', at: [0, 0, 0] }],
    jointAt: [],
    overTypeTol: [],
    maxTypesUnmet: null,
  };
  assert.equal(panelTypingSchema.safeParse(typing).success, true);
});
