import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  surfaceSampleSchema,
  previewSettingsSchema,
  panelLayoutSchema,
  memberSetSchema,
  panelTypingSchema,
  stageConfirmed,
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
    path: 'attached-template',
  },
  faces: [
    {
      faceIndex: 0,
      domainU: [0, 2400],
      domainV: [10, 1210],
      nu: 2,
      nv: 2,
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
});

test('settings: assumed values block confirmation', () => {
  const settings = {
    pattern: { value: 'grid', source: 'assumed' },
    size: { value: [1.2, 0.6], source: 'person' },
    measure: { value: 'arc-length', source: 'assumed' },
    direction: { value: { axis: 'u', startCorner: 'min-min', flip: false }, source: 'assumed' },
    boundary: { value: { rule: 'trim', mergeBelow: 0.3 }, source: 'assumed' },
  };
  assert.equal(previewSettingsSchema.safeParse(settings).success, true);
  assert.equal(stageConfirmed(settings), false);
  for (const k of Object.keys(settings)) settings[k].source = 'person';
  assert.equal(stageConfirmed(settings), true);
});

test('layout → members → typing chain', () => {
  const layout = {
    schema: 'vide.paneling.layout@1',
    surfaceHash: H,
    settingsHash: H,
    panels: [
      {
        id: 'P-0-0',
        faceIndex: 0,
        row: 0,
        col: 0,
        uv,
        corners,
        boundary: false,
        width: 1.2,
        height: 0.6,
        area: 0.72,
        failure: null,
      },
    ],
    counts: { total: 1, boundary: 0, failed: 0, dropped: 0, offTarget: 0 },
    sizeRange: { minW: 1.2, maxW: 1.2, minH: 0.6, maxH: 0.6, area: 0.72 },
  };
  assert.equal(panelLayoutSchema.safeParse(layout).success, true);
  assert.equal(
    panelLayoutSchema.safeParse({ ...layout, panels: [{ ...layout.panels[0], id: 'X1' }] }).success,
    false,
  );

  const members = {
    schema: 'vide.paneling.members@1',
    layoutHash: H,
    settingsHash: H,
    members: [
      {
        panelId: 'P-0-0',
        uv,
        solid: null,
        flatSize: [1.19, 0.59],
        flatSizeApprox: false,
        thickness: 0.05,
        area: 0.7021,
        volume: 0.0351,
        failure: null,
      },
    ],
    joints: [
      [
        [1.2, 0, 0],
        [1.2, 0.6, 0],
      ],
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
        panelId: 'P-0-0',
        type: 'T-01',
        class: 'flat',
        flatness: 0,
        planarGap: null,
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
        representative: 'P-0-0',
        size: [1.19, 0.59],
        maxDeviation: 0,
        mirrored: false,
      },
    ],
    nodes: [{ type: 'N-01', valence: 1, angles: [90], count: 4 }],
    joints: [{ type: 'J-01', dihedral: [179, 181], count: 1, length: 0.6 }],
    overTypeTol: [],
  };
  assert.equal(panelTypingSchema.safeParse(typing).success, true);
});
