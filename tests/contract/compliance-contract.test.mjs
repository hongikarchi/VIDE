import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifiedModelSchema,
  complianceLimitsSchema,
  complianceResultSchema,
  complianceRoleRecordSchema,
  roleProposalSchema,
  COMPLIANCE_CHECKS,
} from '../../src/contracts/compliance.ts';

// PLAN-48 T-237~T-239: the reader → engine → screen contract of 법규 체크 (SPEC-15.10). A small
// synthetic chain: one box mass, one floor outline, a limits output and a result that uses them.

const ID = '6f1c2b1e-1111-4a6b-9c1d-000000000001';
const box = {
  v: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 9, 10, 0, 9, 10, 10, 9, 0, 10, 9],
  f: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ],
};
const square = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const model = {
  schema: 'vide.compliance.model@1',
  source: {
    linkId: 'link-1',
    documentKey: 'doc-1',
    readId: 'read-1',
    revisionKey: 'rhino|doc-1|7',
    readAt: '2026-10-08T09:00:00.000Z',
    toMeters: 0.001,
  },
  objects: [
    {
      objectId: ID,
      layer: '건물::매스',
      role: 'mass',
      roleSource: 'layer-rule',
      floor: null,
      use: null,
      hidden: false,
      geometryHash: 'a'.repeat(64),
      shape: { kind: 'solid', mesh: box, closed: true, volume: 900 },
    },
    {
      objectId: '6f1c2b1e-1111-4a6b-9c1d-000000000002',
      layer: '건물::층',
      role: 'floor',
      roleSource: 'attribute',
      floor: '1F',
      use: '제2종 근린생활시설',
      hidden: false,
      geometryHash: null,
      shape: { kind: 'region', region: { outer: square }, z: 0 },
    },
  ],
  unclassified: [],
  rolesVersion: 3,
};

const limits = {
  schema: 'vide.compliance.limits@1',
  frame: { linkId: 'link-1', documentKey: 'doc-1', origin: [0, 0, 0] },
  site: {
    ring: [
      [-5, -5],
      [20, -5],
      [20, 20],
      [-5, 20],
    ],
    area_m2: 625,
    areaSource: '사이트 모델링 · 공부',
    otherArea_m2: null,
    northDeg: 0,
    northSource: '설정값(진북)',
  },
  regulations: [
    {
      id: 'coverage',
      group: '밀도',
      title: '건폐율 상한',
      value: 0.6,
      unit: '비율',
      applies: '적용',
      status: '확정',
      origin: '사용자가 확정함',
      basis: { clause: '시험용 조항' },
      source: 'param.coverage',
    },
  ],
  unapplied: [],
  zones: [
    {
      rule: 'roadSetback',
      items: ['roadSetback'],
      regions: [{ outer: square }],
      segments: ['도로 1'],
    },
  ],
  variants: [
    {
      id: 'base',
      heightCap: { value: 20, items: ['heightMax'] },
      sunCut: null,
      envelope: box,
      envelopeVolume: 900,
      unconfirmed: [],
    },
  ],
  plan: { mainUse: '제2종 근린생활시설', floorHeightGround: 4.5, floorHeightTypical: 3.3 },
};

const item = {
  id: 'coverage',
  group: '규모',
  title: '건폐율',
  state: '적합',
  reason: '',
  planned: { value: 0.16, unit: '비율', text: '16.00%' },
  limit: {
    value: 0.6,
    unit: '비율',
    text: '60%',
    itemId: 'coverage',
    status: '확정',
    origin: '사용자가 확정함',
  },
  margin: 0.44,
  basis: [{ clause: '시험용 조항', link: null, answer: null }],
  numbers: [
    {
      label: '건축면적',
      value: 100,
      unit: '㎡',
      kind: '모델',
      ref: 'model:mass',
      note: '수평투영',
    },
    { label: '대지면적', value: 625, unit: '㎡', kind: '대지', ref: 'site:area' },
  ],
  cases: [],
  objectIds: [ID],
  exceedances: [],
  unconfirmed: [],
};
const result = {
  schema: 'vide.compliance.result@1',
  checkedAt: '2026-10-08T09:01:00.000Z',
  inputs: {
    model: {
      readId: 'read-1',
      revisionKey: 'rhino|doc-1|7',
      objects: 2,
      unclassified: 0,
      rolesVersion: 3,
    },
    limits: { instanceId: 'mass-1', hash: 'h1', at: '2026-10-08T08:00:00.000Z' },
    siteModel: null,
    settingsHash: 's1',
  },
  items: [item],
  notApplicable: [],
  counts: { 적합: 1, 위반: 0, '판단 필요': 0, '사람 입력 필요': 0, '검사 불가': 0 },
  unconfirmedCount: 0,
  notice: '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음',
};

test('a synthetic reader → engine → screen chain passes the contract', () => {
  const m = classifiedModelSchema.parse(model);
  assert.equal(m.objects[0].count, 1, 'parking count defaults to 1');
  assert.deepEqual(m.objects[1].shape.region.holes, []);
  complianceLimitsSchema.parse(limits);
  complianceResultSchema.parse(result);
});

test('the contract rejects what would let a check pass silently', () => {
  assert.equal(
    classifiedModelSchema.safeParse({
      ...model,
      objects: [{ ...model.objects[0], role: 'building' }],
    }).success,
    false,
  );
  const broken = { ...box, f: [...box.f.slice(0, -1), 99] };
  assert.equal(
    complianceLimitsSchema.safeParse({
      ...limits,
      variants: [{ ...limits.variants[0], envelope: broken }],
    }).success,
    false,
    'mesh index out of range',
  );
  assert.equal(
    complianceResultSchema.safeParse({ ...result, items: [{ ...item, state: '통과' }] }).success,
    false,
  );
  assert.equal(
    complianceResultSchema.safeParse({ ...result, counts: { 적합: 1 } }).success,
    false,
    'every state is counted',
  );
  assert.equal(complianceResultSchema.safeParse({ ...result, notice: '' }).success, false);
  assert.equal(new Set(COMPLIANCE_CHECKS).size, COMPLIANCE_CHECKS.length);
});

test('classification records and AI proposals', () => {
  complianceRoleRecordSchema.parse({
    documentKey: 'doc-1',
    scope: 'layer',
    key: '건물::주차',
    role: 'parking',
    by: 'person',
    at: '2026-10-08T09:00:00.000Z',
  });
  assert.equal(
    complianceRoleRecordSchema.safeParse({
      documentKey: 'doc-1',
      scope: 'object',
      key: ID,
      role: 'floor',
      floor: '0F',
      by: 'person',
      at: '2026-10-08T09:00:00.000Z',
    }).success,
    false,
    'floor labels are 1F… or B1…',
  );
  roleProposalSchema.parse({
    id: 'p1',
    scope: 'group',
    layer: 'Default',
    objectIds: [ID],
    role: 'parking',
    reason: '2.5 × 5.0 m 닫힌 사각형 48개',
    state: 'proposed',
  });
});
