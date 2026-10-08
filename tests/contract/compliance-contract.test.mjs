import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifiedModelSchema,
  complianceLimitsSchema,
  complianceResultSchema,
  complianceRoleRecordSchema,
  complianceSettingsSchema,
  complianceOverrideSchema,
  groundDatumSchema,
  roleProposalSchema,
  checkGroup,
  COMPLIANCE_CHECKS,
  COMPLIANCE_ROLES,
  UNCLASSIFIED_REASONS,
} from '../../src/contracts/compliance.ts';

// PLAN-48 T-237~T-239: the reader → engine → screen contract of 법규 체크 (SPEC-15.10). A small
// synthetic chain: one box mass, one floor outline, a limits output and a result that uses them.
// The limit values below are test data, not legal numbers.

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
  unclassified: [
    {
      objectId: '6f1c2b1e-1111-4a6b-9c1d-000000000003',
      layer: '대안 매스',
      nativeType: 'extrusion',
      reason: '고르지 않은 대안',
      shape: 'closed-solid',
    },
  ],
  rolesVersion: 3,
};

const limits = {
  schema: 'vide.compliance.limits@1',
  frame: { linkId: 'link-1', documentKey: 'doc-1', origin: [0, 0, 0], groundZ: 0 },
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
  plan: {
    mainUse: '제2종 근린생활시설',
    floorHeightGround: 4.5,
    floorHeightTypical: 3.3,
    chosenOption: null,
  },
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

/** Every other check: '사람 입력 필요' rows, so the result covers the closed list exactly once. */
const filler = COMPLIANCE_CHECKS.filter((c) => c !== 'coverage').map((id) => ({
  id,
  group: checkGroup(id),
  title: id,
  state: '사람 입력 필요',
  reason: '규제 조건 없음',
  planned: null,
  limit: null,
  margin: null,
  basis: [],
  numbers: [],
  cases: [],
  objectIds: [],
  exceedances: [],
  unconfirmed: [],
}));

const zeroBy = (keys) => Object.fromEntries(keys.map((k) => [k, 0]));
const result = {
  schema: 'vide.compliance.result@1',
  checkedAt: '2026-10-08T09:01:00.000Z',
  inputs: {
    model: {
      linkId: 'link-1',
      documentKey: 'doc-1',
      readId: 'read-1',
      revisionKey: 'rhino|doc-1|7',
      readAt: '2026-10-08T09:00:00.000Z',
      objects: 2,
      unclassified: 1,
      rolesVersion: 3,
    },
    limits: {
      instanceId: 'mass-1',
      title: '건축 가능 영역·매스 1',
      hash: 'h1',
      at: '2026-10-08T08:00:00.000Z',
    },
    siteModel: null,
    settingsHash: 's1',
    overridesHash: 'o1',
  },
  items: [item, ...filler],
  notApplicable: [],
  classification: {
    byRole: { ...zeroBy(COMPLIANCE_ROLES), mass: 1, floor: 1 },
    unusedByReason: { ...zeroBy(UNCLASSIFIED_REASONS), '고르지 않은 대안': 1 },
    aiAccepted: 0,
    hiddenWithRole: 0,
    geometryChanged: 0,
  },
  counts: {
    적합: 1,
    위반: 0,
    '판단 필요': 0,
    '사람 입력 필요': COMPLIANCE_CHECKS.length - 1,
    '검사 불가': 0,
  },
  unconfirmedCount: 0,
  notice: '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음',
};

const settings = {
  groundLevel: null,
  groundBasis: null,
  exclusionsComplete: false,
  noneParking: false,
  noneLandscape: false,
  noneOpenSpace: false,
  includeHidden: false,
};

const AT = '2026-10-08T09:00:00.000Z';
const fails = (schema, value, why) => assert.equal(schema.safeParse(value).success, false, why);
const withItems = (first, rest = filler) => ({ ...result, items: [first, ...rest] });

test('a synthetic reader → engine → screen chain passes the contract', () => {
  const m = classifiedModelSchema.parse(model);
  assert.equal(m.objects[0].count, 1, 'parking count defaults to 1');
  assert.equal(m.objects[0].geometryChanged, false);
  assert.equal(m.unclassified[0].role, null);
  assert.deepEqual(m.objects[1].shape.region.holes, []);
  complianceLimitsSchema.parse(limits);
  const r = complianceResultSchema.parse(result);
  assert.deepEqual(r.items[0].parts, []);
  complianceSettingsSchema.parse(settings);
  groundDatumSchema.parse({
    value: null,
    basis: null,
    candidate: { min: 10.2, max: 11.8, mean: 11, source: '사이트 모델링 지형' },
  });
});

test('unknown document units are a state, not a read error', () => {
  const m = classifiedModelSchema.parse({ ...model, source: { ...model.source, toMeters: null } });
  assert.equal(m.source.toMeters, null);
});

test('the contract rejects what would let a check pass silently', () => {
  fails(classifiedModelSchema, { ...model, objects: [{ ...model.objects[0], role: 'building' }] });
  const broken = { ...box, f: [...box.f.slice(0, -1), 99] };
  fails(
    complianceLimitsSchema,
    { ...limits, variants: [{ ...limits.variants[0], envelope: broken }] },
    'mesh index out of range',
  );
  fails(complianceResultSchema, withItems({ ...item, state: '통과' }));
  fails(complianceResultSchema, { ...result, counts: { 적합: 1 } }, 'every state is counted');
  fails(
    complianceResultSchema,
    { ...result, counts: { ...result.counts, 적합: 2 } },
    'counts match the rows',
  );
  fails(complianceResultSchema, { ...result, notice: '' });
  fails(complianceResultSchema, withItems(item, filler.slice(1)), 'a check dropped');
  fails(complianceResultSchema, withItems(item, [item, ...filler]), 'a check twice');
  fails(
    complianceResultSchema,
    {
      ...result,
      notApplicable: [{ check: 'coverage', id: 'coverage', title: '건폐율', basis: '' }],
    },
    'a check both run and 미적용',
  );
  fails(complianceResultSchema, withItems({ ...item, limit: null }), '적합 without a limit value');
  fails(
    complianceResultSchema,
    withItems({ ...item, limit: { ...item.limit, status: '사람 입력 필요' } }),
    '적합 on a limit nobody entered',
  );
  fails(
    complianceResultSchema,
    withItems({ ...item, state: '판단 필요', reason: ' ' }),
    'a row that is not 적합 states why',
  );
  fails(
    complianceResultSchema,
    withItems({
      ...item,
      cases: [
        { label: '기준 지반 최저', state: '적합', planned: 1, limit: 2 },
        { label: '기준 지반 최고', state: '위반', planned: 3, limit: 2 },
      ],
    }),
    '적합 while a case is 위반',
  );
  fails(
    complianceResultSchema,
    withItems({
      ...item,
      parts: [
        {
          label: '도로 2',
          target: '도로 2',
          state: '사람 입력 필요',
          planned: null,
          limit: null,
          reason: '값 없음',
        },
      ],
    }),
    '적합 while a part is unresolved',
  );
  fails(complianceResultSchema, withItems({ ...item, group: '형상 제한' }));
  fails(
    complianceResultSchema,
    withItems({ ...item, unconfirmed: ['가정 값'] }),
    'unconfirmedCount matches the rows',
  );
  assert.equal(new Set(COMPLIANCE_CHECKS).size, COMPLIANCE_CHECKS.length);
});

test('only a person enters exclusions and floor uses', () => {
  const exclusion = {
    kind: 'floor-exclusion',
    id: 'x1',
    floor: '1F',
    area_m2: 12.5,
    basis: '시험용 근거',
    by: 'person',
    at: AT,
  };
  complianceOverrideSchema.parse(exclusion);
  fails(complianceOverrideSchema, { ...exclusion, by: 'ai' }, 'an AI value is refused');
  fails(complianceOverrideSchema, { ...exclusion, basis: '' }, 'an exclusion carries its 근거');
  complianceOverrideSchema.parse({
    kind: 'use-floor',
    id: 'u1',
    floor: 'B1',
    use: '주차장',
    by: 'person',
    at: AT,
  });
});

test('classification records and AI proposals', () => {
  complianceRoleRecordSchema.parse({
    documentKey: 'doc-1',
    scope: 'layer',
    key: '건물::주차',
    role: 'parking',
    by: 'person',
    at: AT,
  });
  fails(
    complianceRoleRecordSchema,
    {
      documentKey: 'doc-1',
      scope: 'object',
      key: ID,
      role: 'floor',
      floor: '0F',
      by: 'person',
      at: AT,
    },
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
