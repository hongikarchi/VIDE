import test from 'node:test';
import assert from 'node:assert/strict';
import { runCheck, ComplianceInputError } from '../../src/jigs/official/compliance-kit/check.ts';
import { reportCsv, reportRows } from '../../src/jigs/official/compliance-kit/report-rows.ts';
import { prepareMesh, solidMesh } from '../../src/jigs/official/compliance-kit/geometry.ts';
import { prismSolid, solidSubtract } from '../../src/jigs/official/geometry-kit/index.ts';
import { REGULATION_ITEMS } from '../../src/jigs/official/massing-kit/rules.ts';
import { COMPLIANCE_CHECKS, complianceResultSchema } from '../../src/contracts/compliance.ts';

// PLAN-48 T-238 (SPEC-15.2·15.5~15.9): the check engine on a hand-calculated synthetic site. Every
// limit value below is test data (a 규제 조건 item the test enters), never a legal number of the
// engine. Site: 20 × 30 m (600 ㎡), road on the south edge (`도로 1`), north = +y, ground z 0.
// Base building: mass 16 × 20 m (x 2..18, y 4..24) × 10.8 m, floors 1F–3F of 320 ㎡ each (use
// 업무시설), 10 parking stalls, landscape 60 ㎡, open space 30 ㎡. Forbidden volumes: road band
// y 0..2, 일조 금지 부피 y 26..30 from z 9, 최대 외피 = (x 0..20, y 2..30, z 0..20) − 일조.

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AT = '2026-10-08T09:00:00.000Z';

function box(x0, y0, z0, x1, y1, z1) {
  return {
    v: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    f: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
      0, 4, 3, 4, 7,
    ],
  };
}
const rect = (x0, y0, x1, y1) => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

const solid = (n, mesh, extra = {}) => ({
  objectId: uuid(n),
  layer: '건물::매스',
  role: 'mass',
  roleSource: 'layer-rule',
  floor: null,
  use: null,
  hidden: false,
  geometryHash: null,
  shape: { kind: 'solid', mesh, closed: true, volume: null },
  ...extra,
});
const region = (n, role, ring, z, extra = {}) => ({
  objectId: uuid(n),
  layer: role,
  role,
  roleSource: 'layer-rule',
  floor: null,
  use: null,
  hidden: false,
  geometryHash: null,
  shape: { kind: 'region', region: { outer: ring, holes: [] }, z },
  ...extra,
});
const stall = (n, x, extra = {}) => ({
  objectId: uuid(n),
  layer: '주차',
  role: 'parking',
  roleSource: 'layer-rule',
  floor: null,
  use: null,
  hidden: false,
  geometryHash: null,
  shape: { kind: 'point', at: [x, 1, 0] },
  ...extra,
});

const MASS = solid(1, box(2, 4, 0, 18, 24, 10.8));
const FLOORS = ['1F', '2F', '3F'].map((f, i) =>
  region(10 + i, 'floor', rect(2, 4, 18, 24), i * 3.6, { floor: f }),
);
const STALLS = Array.from({ length: 10 }, (_, i) => stall(100 + i, 1 + i));
const LANDSCAPE = region(200, 'landscape', rect(0, 0, 2, 30), 0);
const OPEN = region(201, 'open-space', rect(10, 0, 16, 5), 0);

function model(objects, unclassified = [], source = {}) {
  return {
    schema: 'vide.compliance.model@1',
    source: {
      linkId: 'link-1',
      documentKey: 'doc-1',
      readId: 'read-1',
      revisionKey: 'rhino|doc-1|1',
      readAt: AT,
      toMeters: 1,
      ...source,
    },
    objects,
    unclassified,
    rolesVersion: 1,
  };
}
const baseObjects = () => [MASS, ...FLOORS, ...STALLS, LANDSCAPE, OPEN];

function reg(id, value, extra = {}) {
  const d = REGULATION_ITEMS[id];
  return {
    id,
    group: d.group,
    title: d.title,
    value,
    unit: d.unit,
    applies: '적용',
    status: '확정',
    origin: '사용자가 확정함',
    basis: { clause: `시험용 조항 ${id}` },
    source: `param.${id}`,
    ...extra,
  };
}
const na = (id) => reg(id, null, { applies: '미적용' });

function regulations(over = {}) {
  const items = {
    coverage: reg('coverage', 0.6),
    farBase: reg('farBase', 2),
    farMax: reg('farMax', 2.5),
    heightMax: reg('heightMax', 20),
    streetHeight: na('streetHeight'),
    altitudeHeight: na('altitudeHeight'),
    floorsMax: reg('floorsMax', 5),
    roadSetback: reg('roadSetback', 2, { target: '도로 1' }),
    chamferLength: na('chamferLength'),
    limitLine: na('limitLine'),
    openSpaceRoad: na('openSpaceRoad'),
    openSpaceAdjacent: na('openSpaceAdjacent'),
    civilSetback: na('civilSetback'),
    otherSetback: na('otherSetback'),
    sun: reg('sun', '적용'),
    sunBaseHeight: reg('sunBaseHeight', 9),
    parkingRule: reg('parkingRule', 100, { target: '업무시설' }),
    parkingRounding: reg('parkingRounding', 'ceil'),
    parkingRoundScope: reg('parkingRoundScope', 'sum'),
    parkingAreaBasis: reg('parkingAreaBasis', 'gross'),
    landscapeRatio: reg('landscapeRatio', 0.1),
    publicOpenSpace: reg('publicOpenSpace', 0.05),
    ...over,
  };
  return Object.values(items).flat().filter(Boolean);
}

const SITE = rect(0, 0, 20, 30);
const SUN_CUT = box(0, 26, 9, 20, 30, 100);
const envelopeMesh = () =>
  solidMesh(
    solidSubtract(prismSolid(rect(0, 2, 20, 30), 0, 20), prismSolid(rect(0, 26, 20, 30), 9, 21)),
  );
const ENVELOPE = envelopeMesh();

function limits(over = {}, regOver = {}) {
  return {
    schema: 'vide.compliance.limits@1',
    frame: { linkId: 'link-1', documentKey: 'doc-1', origin: [0, 0, 0], groundZ: 0 },
    site: {
      ring: SITE,
      area_m2: 600,
      areaSource: '시험 대지',
      otherArea_m2: null,
      northDeg: 0,
      northSource: '시험',
    },
    regulations: regulations(regOver),
    unapplied: [],
    zones: [
      {
        rule: 'roadSetback',
        items: ['roadSetback'],
        regions: [{ outer: rect(0, 0, 20, 2), holes: [] }],
        segments: ['도로 1'],
      },
    ],
    variants: [
      {
        id: 'base',
        heightCap: { value: 20, items: ['heightMax'] },
        sunCut: SUN_CUT,
        envelope: ENVELOPE,
        envelopeVolume: 20 * 28 * 20 - 20 * 4 * 11,
        unconfirmed: [],
      },
    ],
    plan: {
      mainUse: '업무시설',
      floorHeightGround: 3.6,
      floorHeightTypical: 3.6,
      chosenOption: null,
    },
    ...over,
  };
}

const SETTINGS = {
  groundLevel: 0,
  groundBasis: '시험 지반',
  exclusionsComplete: true,
  noneParking: false,
  noneLandscape: false,
  noneOpenSpace: false,
  includeHidden: false,
};
const GROUND = { value: null, basis: null, candidate: null };

function check({
  objects = baseObjects(),
  unclassified = [],
  source,
  lim,
  regOver,
  settings,
  ground,
  overrides = [],
  refs,
} = {}) {
  const l = lim === null ? null : limits(lim ?? {}, regOver ?? {});
  return runCheck(
    model(objects, unclassified, source),
    l,
    { ...GROUND, ...ground },
    { ...SETTINGS, ...settings },
    overrides,
    { checkedAt: AT, ...refs },
  );
}
const row = (r, id) => r.items.find((i) => i.id === id);
const close = (a, b, eps = 1e-6, what = '') =>
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} ≈ ${b}`);

test('the synthetic envelope is a closed solid', () => {
  assert.equal(prepareMesh(ENVELOPE).ok, true, prepareMesh(ENVELOPE).reasons.join());
  close(prepareMesh(ENVELOPE).volume, 20 * 28 * 20 - 20 * 4 * 11, 1e-6, 'envelope volume');
});

test('a building inside every limit: every row 적합, 미적용 items listed, deterministic', () => {
  const r = check();
  for (const i of r.items) assert.equal(i.state, '적합', `${i.id}: ${i.reason}`);
  assert.deepEqual(r.notApplicable.map((n) => n.check).sort(), [
    'height:altitudeHeight',
    'height:streetHeight',
    'zone:chamfer',
    'zone:civilSetback',
    'zone:limitLine',
    'zone:openSpaceAdjacent',
    'zone:openSpaceRoad',
    'zone:otherSetback',
  ]);
  assert.equal(r.items.length + r.notApplicable.length, COMPLIANCE_CHECKS.length);
  close(row(r, 'coverage').planned.value, 320 / 600, 1e-9, 'coverage');
  assert.equal(row(r, 'coverage').limit.value, 0.6);
  assert.equal(row(r, 'coverage').basis[0].clause, '시험용 조항 coverage');
  close(row(r, 'far').planned.value, 960 / 600, 1e-9, 'far');
  close(row(r, 'height:heightMax').planned.value, 10.8, 1e-9, 'height');
  assert.equal(row(r, 'floors').planned.value, 3);
  assert.equal(row(r, 'parking').planned.value, 10);
  assert.equal(row(r, 'parking').limit.value, 10, '960 ㎡ ÷ 100 = 9.6 → 올림 10');
  assert.equal(row(r, 'landscape').limit.value, 60, 'planned 60 = required 60 is 적합');
  assert.equal(row(r, 'open-space').limit.value, 30);
  assert.equal(r.counts['적합'], r.items.length);
  assert.equal(r.notice, '탐색용 법규 체크 — 인허가 검토·법규 검토를 대체하지 않음');
  const again = check();
  assert.deepEqual(again, r, 'same inputs → same result');
  assert.equal(
    check({ refs: { checkedAt: '2026-10-09T00:00:00.000Z' } }).inputs.settingsHash,
    r.inputs.settingsHash,
  );
  assert.notEqual(
    check({ settings: { includeHidden: true } }).inputs.settingsHash,
    r.inputs.settingsHash,
  );
});

test('the top floor pushed 4 m north: 일조 and 최대 외피 위반 with volume, heights and object', () => {
  const ext = solid(2, box(2, 24, 7.2, 18, 28, 10.8));
  const r = check({ objects: [...baseObjects(), ext] });
  const sun = row(r, 'sun');
  assert.equal(sun.state, '위반');
  close(sun.planned.value, 16 * 2 * 1.8, 1e-6, 'sun volume');
  assert.equal(sun.exceedances.length, 1);
  const e = sun.exceedances[0];
  assert.deepEqual(e.objectIds, [uuid(2)]);
  close(e.min[2], 9, 1e-9);
  close(e.max[2], 10.8, 1e-9);
  close(e.min[1], 26, 1e-9);
  close(e.max[1], 28, 1e-9);
  assert.equal(e.groundCase, 'ground:value');
  const env = row(r, 'envelope');
  assert.equal(env.state, '위반');
  close(env.planned.value, 57.6, 1e-6, 'envelope excess');
  assert.equal(env.limit, null);
  assert.equal(env.margin, null);
  assert.equal(row(r, 'outside-site').state, '적합');
  // The footprint grew to 16 × 24 = 384 ㎡ (64%) — but a 수평투영 never decides 위반.
  assert.equal(row(r, 'coverage').state, '판단 필요');
  assert.match(row(r, 'coverage').reason, /수평투영/);
  const nos = r.items.flatMap((i) => i.exceedances.map((x) => x.no));
  assert.deepEqual(
    nos,
    nos.map((_, i) => i + 1),
    'markers numbered 1… over the result',
  );
});

test('a box over the road band: 건축선 후퇴 위반 on 도로 1', () => {
  const r = check({ objects: [...baseObjects(), solid(3, box(5, 1, 0, 10, 4, 3.6))] });
  const z = row(r, 'zone:roadSetback');
  assert.equal(z.state, '위반');
  close(z.planned.value, 5 * 1 * 3.6, 1e-6, 'band overlap');
  assert.deepEqual(z.exceedances[0].segments, ['도로 1']);
  assert.ok(z.basis.some((b) => b.clause === '시험용 조항 roadSetback'));
});

test('건폐율 at the limit is 적합, just above is 위반 (drawn outline, no rounding)', () => {
  const at = check({
    objects: [...baseObjects(), region(20, 'building-area', rect(0, 0, 18, 20), 0)],
  });
  assert.equal(row(at, 'coverage').state, '적합');
  assert.equal(row(at, 'coverage').planned.value, 0.6);
  const over = check({
    objects: [...baseObjects(), region(20, 'building-area', rect(0, 0, 18.003, 20), 0)],
  });
  const c = row(over, 'coverage');
  assert.equal(c.state, '위반');
  assert.notEqual(c.planned.text, c.limit.text, 'texts never look equal for a 위반');
  assert.ok(c.margin < 0);
});

// 용적률 사다리 (SPEC-15.6 5): 기준 2.0, 상한 2.5, 완화 0.3.
const farFloors = (area) => [region(30, 'floor', rect(0, 0, 20, area / 20), 0, { floor: '1F' })];
const farRow = (area, regOver, settings) =>
  row(
    check({ objects: [MASS, ...farFloors(area), ...STALLS, LANDSCAPE, OPEN], regOver, settings }),
    'far',
  );

test('용적률 ladder: five bands and no 기준', () => {
  assert.equal(farRow(960).state, '적합');
  const confirmed = farRow(1320, { incentiveFar: reg('incentiveFar', 0.3) });
  assert.equal(confirmed.state, '적합');
  close(confirmed.limit.value, 2.3, 1e-9);
  const undecided = farRow(1320, {
    incentiveFar: reg('incentiveFar', 0.3, { applies: '판단 필요', status: '판단 필요' }),
  });
  assert.equal(undecided.state, '판단 필요');
  assert.match(undecided.reason, /완화 조건 미확정/);
  const noRelief = farRow(1320);
  assert.equal(noRelief.state, '판단 필요');
  assert.match(noRelief.reason, /넘는 근거가 되는 완화 항목 없음/);
  const over = farRow(1560);
  assert.equal(over.state, '위반');
  assert.equal(over.limit.value, 2.5);
  assert.ok(over.numbers.some((n) => n.ref === 'regulation:farBase'));
  assert.ok(over.numbers.some((n) => n.ref === 'regulation:farMax'));
  const notDone = farRow(1560, {}, { exclusionsComplete: false });
  assert.equal(notDone.state, '판단 필요');
  assert.match(notDone.reason, /산정 제외 면적 입력 전/);
  const noBaseOver = farRow(1560, { farBase: undefined });
  assert.equal(noBaseOver.state, '위반');
  const noBaseUnder = farRow(1320, { farBase: undefined });
  assert.equal(noBaseUnder.state, '사람 입력 필요');
});

test('용적률 uses a person’s 산정 제외 면적 and refuses one larger than the floor', () => {
  const ex = (area) => ({
    kind: 'floor-exclusion',
    id: 'x1',
    floor: '1F',
    area_m2: area,
    basis: '시험 근거',
    by: 'person',
    at: AT,
  });
  const r = check({
    objects: [MASS, ...farFloors(1320), ...STALLS, LANDSCAPE, OPEN],
    overrides: [ex(120)],
  });
  close(row(r, 'far').planned.value, 1200 / 600, 1e-9);
  assert.equal(row(r, 'far').state, '적합');
  const big = check({
    objects: [MASS, ...farFloors(1320), ...STALLS, LANDSCAPE, OPEN],
    overrides: [ex(2000)],
  });
  assert.equal(row(big, 'far').state, '사람 입력 필요');
  assert.match(row(big, 'far').reason, /제외 면적이 바닥면적보다 큼/);
  assert.throws(
    () => check({ overrides: [{ ...ex(10), by: 'ai' }] }),
    (e) => e instanceof ComplianceInputError,
    'an AI 수정 사항 is refused at the contract',
  );
});

test('기준 지반 후보 split the height: two cases, 판단 필요', () => {
  const r = check({
    settings: { groundLevel: null },
    ground: { candidate: { min: -1, max: 1, mean: 0, source: '시험 지형' } },
    regOver: { heightMax: reg('heightMax', 11) },
  });
  const h = row(r, 'height:heightMax');
  assert.equal(h.state, '판단 필요');
  assert.equal(h.cases.length, 2);
  assert.deepEqual(
    h.cases.map((c) => c.state),
    ['위반', '적합'],
  );
  close(h.cases[0].planned, 11.8, 1e-9);
  close(h.cases[1].planned, 9.8, 1e-9);
  assert.match(h.reason, /기준 지반/);
});

test('기준 지반 2 m above the envelope ground moves the 일조 excess up by 2 m', () => {
  const ext = solid(2, box(2, 24, 7.2, 18, 28, 12.6));
  const at0 = row(check({ objects: [...baseObjects(), ext] }), 'sun');
  close(at0.planned.value, 16 * 2 * 3.6, 1e-6);
  const at2 = row(check({ objects: [...baseObjects(), ext], settings: { groundLevel: 2 } }), 'sun');
  assert.equal(at2.state, '위반');
  close(at2.planned.value, 16 * 2 * 1.6, 1e-6);
  close(at2.exceedances[0].min[2], 11, 1e-9);
});

test('주차: 10 planned vs 법정 10 적합, 9 위반; a use name one character off needs a person', () => {
  const nine = check({ objects: [MASS, ...FLOORS, ...STALLS.slice(1), LANDSCAPE, OPEN] });
  assert.equal(row(nine, 'parking').state, '위반');
  assert.equal(row(nine, 'parking').margin, -1);
  const counted = check({
    objects: [MASS, ...FLOORS, ...STALLS.slice(2), stall(150, 15, { count: 2 }), LANDSCAPE, OPEN],
  });
  assert.equal(row(counted, 'parking').planned.value, 10, 'vide-count 2 counts two stalls');
  const r = check({
    lim: {
      plan: {
        mainUse: '업무 시설',
        floorHeightGround: 3.6,
        floorHeightTypical: 3.6,
        chosenOption: null,
      },
    },
  });
  assert.equal(row(r, 'parking').state, '사람 입력 필요');
  assert.match(row(r, 'parking').reason, /용도 업무 시설의 주차 산정 기준/);
});

test('조경 made up only by a roof garden is 판단 필요', () => {
  const ground40 = region(200, 'landscape', rect(0, 0, 2, 20), 0);
  const roof30 = region(202, 'landscape-roof', rect(2, 4, 8, 9), 10.8);
  const r = check({ objects: [MASS, ...FLOORS, ...STALLS, ground40, roof30, OPEN] });
  const l = row(r, 'landscape');
  assert.equal(l.state, '판단 필요');
  assert.match(l.reason, /옥상 등 조경의 산입/);
  assert.deepEqual(
    l.cases.map((c) => [c.planned, c.state]),
    [
      [40, '위반'],
      [70, '적합'],
    ],
  );
});

test('대안 A·B: only the chosen alternative counts; unchosen ones never block', () => {
  const r = check({
    unclassified: [
      {
        objectId: uuid(300),
        layer: '대안 매스',
        nativeType: 'extrusion',
        reason: '고르지 않은 대안',
        shape: 'closed-solid',
      },
      {
        objectId: uuid(301),
        layer: '대안 매스',
        nativeType: 'extrusion',
        reason: '다른 jig의 결과',
        shape: 'closed-solid',
      },
    ],
  });
  for (const i of r.items) assert.equal(i.state, '적합', i.id);
  close(row(r, 'far').planned.value, 1.6, 1e-9);
  assert.equal(r.classification.unusedByReason['고르지 않은 대안'], 1);
});

test('a closed solid without a role turns 적합 rows into 판단 필요; a hidden mass into 검사 불가', () => {
  const roleless = check({
    unclassified: [
      {
        objectId: uuid(400),
        layer: 'Default',
        nativeType: 'brep',
        reason: '역할 없음',
        shape: 'closed-solid',
      },
    ],
  });
  for (const i of roleless.items) {
    assert.equal(i.state, '판단 필요', i.id);
    assert.match(i.reason, /역할 없는 객체 1개/);
  }
  const hidden = check({
    objects: [...baseObjects(), solid(5, box(3, 5, 0, 4, 6, 3), { hidden: true })],
  });
  for (const id of [
    'coverage',
    'height:heightMax',
    'sun',
    'envelope',
    'zone:roadSetback',
    'outside-site',
  ]) {
    assert.equal(row(hidden, id).state, '검사 불가', id);
    assert.match(row(hidden, id).reason, /숨긴 건물 매스 객체 1개/);
  }
  assert.equal(row(hidden, 'far').state, '적합', 'the floor rows do not use the hidden mass');
  assert.equal(hidden.classification.hiddenWithRole, 1);
  const shown = check({
    objects: [...baseObjects(), solid(5, box(3, 5, 0, 4, 6, 3), { hidden: true })],
    settings: { includeHidden: true },
  });
  assert.equal(row(shown, 'height:heightMax').state, '적합');
});

test('높이 between the cap and cap + 높이 완화 is 판단 필요, above is 위반', () => {
  const r = check({
    regOver: { heightMax: reg('heightMax', 10), incentiveHeight: reg('incentiveHeight', 2) },
  });
  assert.equal(row(r, 'height:heightMax').state, '판단 필요');
  assert.match(row(r, 'height:heightMax').reason, /높이 완화 적용 미확정/);
  const over = check({
    regOver: { heightMax: reg('heightMax', 8), incentiveHeight: reg('incentiveHeight', 2) },
  });
  assert.equal(row(over, 'height:heightMax').state, '위반');
});

test('구간: one segment needs a person, another is 위반 → 위반', () => {
  const r = check({
    objects: [...baseObjects(), solid(3, box(5, 1, 0, 10, 4, 3.6))],
    regOver: {
      roadSetback: [
        reg('roadSetback', 2, { target: '도로 1' }),
        reg('roadSetback', null, {
          target: '도로 2',
          applies: null,
          status: '사람 입력 필요',
          origin: '없음',
        }),
      ],
    },
  });
  const z = row(r, 'zone:roadSetback');
  assert.equal(z.state, '위반');
  assert.deepEqual(
    z.parts.map((p) => [p.target, p.state]),
    [
      ['도로 1', '위반'],
      ['도로 2', '사람 입력 필요'],
    ],
  );
});

test('an AI-estimated limit, a wrong unit and an empty item each need a person', () => {
  const ai = check({ regOver: { coverage: reg('coverage', 0.6, { origin: 'AI가 추정함' }) } });
  assert.equal(row(ai, 'coverage').state, '사람 입력 필요');
  assert.match(row(ai, 'coverage').reason, /AI 추정 값은 사람이 확정해야 함/);
  const unit = check({ regOver: { heightMax: reg('heightMax', 20, { unit: 'mm' }) } });
  assert.equal(row(unit, 'height:heightMax').state, '사람 입력 필요');
  assert.match(row(unit, 'height:heightMax').reason, /단위가 다름/);
  const empty = check({
    regOver: {
      coverage: reg('coverage', null, { applies: null, status: '사람 입력 필요', origin: '없음' }),
    },
  });
  assert.equal(row(empty, 'coverage').state, '사람 입력 필요');
  assert.ok(row(empty, 'coverage').planned, 'the plan value is still shown');
  const assumed = check({
    regOver: { coverage: reg('coverage', 0.6, { status: '가정', origin: '서비스 해석' }) },
  });
  assert.equal(row(assumed, 'coverage').state, '적합');
  assert.match(row(assumed, 'coverage').unconfirmed.join(), /가정 값 기준/);
  assert.equal(assumed.unconfirmedCount, 1);
  const undecided = check({
    regOver: { heightMax: reg('heightMax', 20, { status: '판단 필요' }) },
  });
  assert.equal(row(undecided, 'height:heightMax').state, '판단 필요');
});

test('unknown units: length and area rows 검사 불가, floors and parking count still computed', () => {
  const r = check({ source: { toMeters: null } });
  for (const id of [
    'coverage',
    'far',
    'height:heightMax',
    'zone:roadSetback',
    'sun',
    'envelope',
    'outside-site',
    'landscape',
    'open-space',
  ]) {
    assert.equal(row(r, id).state, '검사 불가', id);
    assert.match(row(r, id).reason, /문서 단위 모름/);
  }
  assert.equal(row(r, 'floors').state, '적합');
  assert.equal(row(r, 'parking').state, '검사 불가');
  assert.equal(row(r, 'parking').planned.value, 10);
});

test('no limits: 규제 조건 rows need a person, shape rows cannot be checked', () => {
  const r = check({ lim: null });
  assert.equal(r.notApplicable.length, 0);
  for (const i of r.items) {
    const shape = i.group === '형상 제한';
    assert.equal(i.state, shape ? '검사 불가' : '사람 입력 필요', i.id);
    assert.match(i.reason, /규제 조건 없음/);
  }
  const stale = check({ refs: { limitsStale: true } });
  assert.match(row(stale, 'coverage').reason, /다시 계산 필요/);
});

test('failures: envelope check, other document, open mass, prism from floor outlines', () => {
  const open = { ...ENVELOPE, f: ENVELOPE.f.slice(3) };
  const env = check({ lim: { variants: [{ ...limits().variants[0], envelope: open }] } });
  for (const id of ['zone:roadSetback', 'sun', 'envelope']) {
    assert.equal(row(env, id).state, '검사 불가', id);
    assert.match(row(env, id).reason, /외피 점검 실패/);
  }
  assert.equal(row(env, 'coverage').state, '적합', 'scale rows are still computed');

  const other = check({ source: { documentKey: 'doc-2' } });
  for (const id of ['zone:roadSetback', 'sun', 'envelope', 'outside-site'])
    assert.match(row(other, id).reason, /대지와 모델이 다른 문서/);
  assert.equal(row(other, 'coverage').state, '적합');

  const broken = box(2, 4, 0, 18, 24, 10.8);
  const leaky = solid(1, { v: broken.v, f: broken.f.slice(3) });
  const r = check({ objects: [leaky, ...FLOORS, ...STALLS, LANDSCAPE, OPEN] });
  assert.equal(row(r, 'sun').state, '검사 불가');
  assert.match(row(r, 'sun').reason, /형상 연산 실패/);
  assert.deepEqual(row(r, 'sun').objectIds, [uuid(1)]);
  assert.equal(row(r, 'far').state, '적합', 'other rows go on');

  const unusable = check({
    objects: [...FLOORS, ...STALLS, LANDSCAPE, OPEN],
    unclassified: [
      {
        objectId: uuid(1),
        layer: '건물',
        nativeType: 'brep',
        reason: '닫히지 않음',
        role: 'mass',
        shape: 'open-solid',
      },
    ],
  });
  assert.equal(row(unusable, 'sun').state, '검사 불가', 'an open mass is a mass: no floor prisms');
  assert.match(row(unusable, 'height:heightMax').reason, /쓰지 못한 건물 매스 객체 1개/);

  const floorsInBand = [0, 3.6].map((z, i) =>
    region(40 + i, 'floor', rect(2, 1, 18, 24), z, { floor: `${i + 1}F` }),
  );
  const prism = check({ objects: [...floorsInBand, ...STALLS, LANDSCAPE, OPEN] });
  const z = row(prism, 'zone:roadSetback');
  assert.equal(z.state, '위반');
  close(z.planned.value, 16 * 1 * 7.2, 1e-6, 'two floor prisms, top one by 기준층 층고');
  assert.ok(z.unconfirmed.includes('층 윤곽으로 만든 형상'));
});

test('unnamed floor outlines are named by height from the ground; result passes the contract', () => {
  const unnamed = FLOORS.map((f) => ({ ...f, floor: null }));
  const basement = region(50, 'floor', rect(2, 4, 18, 24), -3.6);
  const r = check({ objects: [MASS, ...unnamed, basement, ...STALLS, LANDSCAPE, OPEN] });
  assert.equal(row(r, 'floors').planned.value, 3);
  close(row(r, 'far').planned.value, 1.6, 1e-9, 'the basement is not in 용적률');
  assert.equal(row(r, 'parking').limit.value, 13, '(960 + 320) ÷ 100 = 12.8 → 13 (gross)');
  assert.equal(row(r, 'parking').state, '위반');
  complianceResultSchema.parse(r);
});

test('report rows: one CSV row per check and per 미적용 항목', () => {
  const r = check({ objects: [...baseObjects(), solid(3, box(5, 1, 0, 10, 4, 3.6))] });
  const rows = reportRows(r);
  assert.equal(rows.length, COMPLIANCE_CHECKS.length);
  const z = rows.find((x) => x.검사 === '건축선 후퇴');
  assert.equal(z.상태, '위반');
  assert.match(z['근거 조항'], /시험용 조항 roadSetback/);
  const csv = reportCsv(r);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.slice(1).startsWith('검사,묶음,상태,계획 값'));
  assert.equal(csv.trim().split('\r\n').length, COMPLIANCE_CHECKS.length + 1);
});

test('a 판단 필요 일조 rule: the two envelope variants disagree → 판단 필요', () => {
  const ext = solid(2, box(2, 24, 7.2, 18, 28, 10.8));
  const without = {
    id: 'without',
    heightCap: { value: 20, items: ['heightMax'] },
    sunCut: null,
    envelope: solidMesh(prismSolid(rect(0, 2, 20, 30), 0, 20)),
    envelopeVolume: 20 * 28 * 20,
    unconfirmed: ['정북 일조 적용 여부 판단 필요'],
  };
  const r = check({
    objects: [...baseObjects(), ext],
    regOver: { sun: reg('sun', '판단 필요', { applies: '판단 필요', status: '판단 필요' }) },
    lim: { variants: [limits().variants[0], without] },
  });
  for (const id of ['sun', 'envelope']) {
    const i = row(r, id);
    assert.equal(i.state, '판단 필요', id);
    assert.deepEqual(
      i.cases.map((c) => c.state),
      ['위반', '적합'],
      id,
    );
  }
  assert.match(row(r, 'envelope').reason, /판단 필요 항목을 넣은 외피와 뺀 외피/);
  assert.ok(row(r, 'envelope').unconfirmed.includes('정북 일조 적용 여부 판단 필요'));
  const os = check({
    regOver: {
      publicOpenSpace: reg('publicOpenSpace', 0.05, { applies: '판단 필요', status: '판단 필요' }),
    },
  });
  assert.equal(row(os, 'open-space').state, '판단 필요');
});

test('no 기준 지반 at all: rows that need it ask a person', () => {
  const r = check({ settings: { groundLevel: null } });
  for (const id of ['height:heightMax', 'zone:roadSetback', 'sun', 'envelope', 'coverage']) {
    assert.equal(row(r, id).state, '사람 입력 필요', id);
    assert.match(row(r, id).reason, /기준 지반 높이/);
  }
  assert.equal(row(r, 'outside-site').state, '적합', 'the site boundary needs no ground');
  assert.equal(row(r, 'far').state, '적합', 'named floors need no ground');
});

test('미반영 조건 of the envelope: the rule needs a person; the 최대 외피 row says so', () => {
  const r = check({
    lim: {
      unapplied: [{ id: 'road-setback', title: '건축선 후퇴', reason: '시험: 구간 값 없음' }],
    },
  });
  assert.equal(row(r, 'zone:roadSetback').state, '사람 입력 필요');
  assert.match(row(r, 'zone:roadSetback').reason, /미반영 조건/);
  assert.equal(row(r, 'envelope').state, '적합');
  assert.ok(row(r, 'envelope').unconfirmed.includes('미반영 조건 1개'));
});
