import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import {
  REGULATION_ITEMS,
  applyUseDraft,
  entryZone,
  legalParking,
  regulationStep,
  siteStep,
  useMixStep,
} from '../../src/jigs/official/massing-kit/index.ts';
import { SITES, override, paramsOf, row, runMass } from '../fixtures/massing-sites.mjs';

// PLAN-45 T-212 (SPEC-12.11·12.12): 용도 배분 (사람의 표, AI 초안은 사람이 받아야 들어감), 허용 용도
// 대조, 법정 주차 대수·조경 면적 (규제 조건 값과 출처만, 없으면 '사람 입력 필요'), 주차 진입 가능
// 구간, 주차 방식 대안. Rect site, max alternative: 1F 522.5, 2F–8F 2725.55 (massing-alternatives).
// Every legal-looking number below (150 ㎡/대, 0.15 …) is a test input, not a legal reading.

const JIG = 'src/jigs/official/jigs/buildable-mass';
const RECT = SITES[0];
const close = (actual, expected, eps = 1e-6, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected} (±${eps})`);
const DENSITY = { farBaseState: 'apply', farBase: 4 };
const PARKING = {
  parkingState: 'apply',
  parkingRounding: 'half-up',
  parkingRoundScope: 'sum',
  parkingAreaBasis: 'gross',
};
const rule = (use, value, applies = '적용') =>
  override(
    'regulation',
    { id: 'parkingRule', target: use },
    { value, applies, basis: { clause: '시험 값' } },
  );
const firstFloorShop = override('use-floor', { floor: '1F' }, { use: '제1종 근린생활시설' });
const parkingOf = (out, id) => out.steps.parking.alternatives.find((a) => a.id === id);

test('no legal number in the code: the item list has no default value, and an empty 규제 조건 leaves the counts empty', async () => {
  for (const [id, d] of Object.entries(REGULATION_ITEMS))
    assert.ok(!('default' in d) && !('value' in d), `${id} holds no value`);
  const out = await runMass(RECT, DENSITY);
  const max = parkingOf(out, 'max');
  assert.equal(max.legal, null);
  assert.match(max.status, /주차 산정에 쓰는 면적 사람 입력 필요/);
  assert.match(max.status, /끝수 처리 사람 입력 필요/);
  assert.match(max.status, /기준이 정해지지 않은 용도: 업무시설/);
  assert.equal(out.steps.parking.landscape.legal, null);
  assert.match(out.steps.parking.landscape.legalStatus, /조경 면적 비율 사람 입력 필요/);
  assert.ok(out.steps.parking.types.every((t) => t.verdict === '사람 입력 필요'));
  assert.ok(out.steps.parking.unresolved.some((u) => /법정 주차 대수/.test(u)));
});

test('용도 배분: default 주용도, the person’s table and splits, totals by use; 허용 용도 not listed → 초과, 판단 필요 → 미검토', async () => {
  const split = override(
    'use-floor',
    { floor: '2F' },
    {
      uses: [
        { use: '업무시설', ratio: 0.6 },
        { use: '제2종 근린생활시설', ratio: 0.4 },
      ],
    },
  );
  const allowed = override(
    'regulation',
    { id: 'allowedUses' },
    { value: ['업무시설', '제2종 근린생활시설'], applies: '적용' },
  );
  const out = await runMass(RECT, DENSITY, [firstFloorShop, split, allowed]);
  const max = out.steps.useMix.alternatives.find((a) => a.id === 'max');
  const by = Object.fromEntries(max.byUse.map((u) => [u.use, u.total]));
  close(by['제1종 근린생활시설'], 522.5);
  close(by['제2종 근린생활시설'], 522.5 * 0.4);
  close(by['업무시설'], 3248.05 - 522.5 - 522.5 * 0.4);
  const floors = Object.fromEntries(max.floors.map((f) => [f.floor, f]));
  assert.equal(floors['1F'].verdict, '초과');
  assert.match(floors['1F'].reason, /제1종 근린생활시설: 허용 용도에 없음/);
  assert.equal(floors['1F'].origin, '사용자가 확정함');
  assert.equal(floors['2F'].verdict, '적합');
  assert.equal(floors['3F'].origin, '주용도(기본)');
  // Nobody entered the 허용 용도: everything is 미검토, nothing is 적합 by default.
  const open = await runMass(RECT, DENSITY);
  assert.ok(open.steps.useMix.floorRows.every((r) => r.verdict === '미검토'));
  const undecided = await runMass(RECT, DENSITY, [
    override('regulation', { id: 'allowedUses' }, { value: ['업무시설'], applies: '판단 필요' }),
  ]);
  assert.ok(undecided.steps.useMix.floorRows.every((r) => r.verdict === '미검토'));
  // A 층별 용도 제한 for 1F only.
  const perFloor = await runMass(RECT, DENSITY, [
    allowed,
    override(
      'regulation',
      { id: 'floorUses', target: '1F' },
      { value: ['판매시설'], applies: '적용' },
    ),
  ]);
  const f1 = perFloor.steps.useMix.alternatives[0].floors[0];
  assert.equal(f1.verdict, '초과');
  assert.match(f1.reason, /층별 용도 제한에 없음/);
});

test('AI 초안: nothing enters the table before the person accepts it; accepted rows become the person’s; the AI step starts off', async () => {
  const out = await runMass(RECT, DENSITY);
  const draft = {
    floors: [{ floor: '1F', use: '판매시설' }, { floor: '99F', use: '업무시설' }, { floor: '2F' }],
  };
  // A draft marked as the AI's (not accepted) is refused by the table.
  const proposed = override('use-floor', { floor: '1F' }, { use: '판매시설' }, 'set', 'ai');
  const before = useMixStep({ steps: out.steps }, {}, [proposed]);
  assert.equal(before.alternatives[0].floors[0].uses[0].use, '업무시설');
  assert.match(before.problems.join(), /AI 초안은 사람이 받아야 표에 들어갑니다/);
  // The person accepts: the step after the human step writes the person's 수정 사항.
  const accepted = applyUseDraft({ steps: { ...out.steps, useDraft: draft } });
  assert.equal(accepted.accepted, 1);
  assert.deepEqual(accepted.refused, [
    '99F: 대안에 없는 층',
    '2F: 용도가 없거나 비율 합이 1이 아님',
  ]);
  const written = accepted.apply.overrides[0];
  assert.deepEqual(
    { id: written.id, by: written.by, note: written.note },
    { id: 'use-floor:1F', by: 'user', note: 'AI 초안을 사람이 받음' },
  );
  const after = useMixStep({ steps: out.steps }, {}, accepted.apply.overrides);
  assert.equal(after.alternatives[0].floors[0].uses[0].use, '판매시설');
  assert.equal(after.alternatives[0].floors[0].origin, 'AI 초안을 사람이 받음');

  // In the runner the AI step is off (AI_UNAVAILABLE): its human step and the apply step are
  // blocked, the use table and parking still compute from the person's values.
  const jig = await loadJig(JIG);
  const values = { ...paramsOf(RECT), ...DENSITY };
  const params = Object.fromEntries(
    Object.entries(initialParams(jig.manifest)).map(([key, value]) => [
      key,
      values[key] !== undefined ? { ...value, value: values[key], by: 'user' } : value,
    ]),
  );
  const report = await executeSteps({
    jig,
    runner: new EngineRunner(),
    cache: new MemoryCache(),
    mode: 'confirmed',
    inputs: RECT.inputs,
    params,
  });
  const status = Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  assert.equal(status.useDraft, 'failed');
  assert.equal(report.steps.find((s) => s.id === 'useDraft').error.code, 'AI_UNAVAILABLE');
  assert.equal(status.acceptUseDraft, 'blocked');
  assert.equal(status.useDraftApplied, 'blocked');
  assert.equal(status.useMix, 'done');
  assert.equal(status.parking, 'done');
  assert.deepEqual(report.applies, []);
  assert.ok(report.outputs.useMix.floorRows.every((r) => r.origin === '주용도(기본)'));
});

test('법정 주차 대수: Σ 면적 ÷ 기준 per use with the entered 끝수 처리 — sum or each, 올림·버림·0.5 이상 올림, 산정 면적', async () => {
  const rules = [firstFloorShop, rule('제1종 근린생활시설', 200), rule('업무시설', 150)];
  // max: 522.5 / 200 = 2.6125; 2725.55 / 150 = 18.170333…; Σ = 20.782833…
  const sum = await runMass(RECT, { ...DENSITY, ...PARKING }, rules);
  const max = parkingOf(sum, 'max');
  close(max.raw, 2.6125 + 2725.55 / 150, 1e-6, 'raw');
  assert.equal(max.legal, 21);
  assert.equal(max.status, '계산');
  const cases = [
    [{ parkingRounding: 'floor' }, 20],
    [{ parkingRounding: 'ceil' }, 21],
    [{ parkingRoundScope: 'each' }, 3 + 18],
    [{ parkingRoundScope: 'each', parkingRounding: 'ceil' }, 3 + 19],
    [{ parkingRoundScope: 'each', parkingRounding: 'floor' }, 2 + 18],
  ];
  for (const [extra, expected] of cases) {
    const out = await runMass(RECT, { ...DENSITY, ...PARKING, ...extra }, rules);
    assert.equal(parkingOf(out, 'max').legal, expected, JSON.stringify(extra));
  }
  // 기준 alternative (2400): 1F 522.5 + 1877.5 → 2.6125 + 12.516666… = 15.129… → 15.
  assert.equal(parkingOf(sum, 'base').legal, 15);
  // 산정 면적 'far' with 50 ㎡ excluded on 1F: 472.5 / 200 = 2.3625 → Σ 20.53 → 21; 'floor' → 20.
  const far = await runMass(
    RECT,
    { ...DENSITY, ...PARKING, parkingAreaBasis: 'far', parkingRounding: 'floor' },
    [...rules, override('floor-exclusion', { floor: '1F' }, { area: 50, basis: '시험' })],
  );
  close(parkingOf(far, 'max').raw, 472.5 / 200 + 2725.55 / 150, 1e-6, 'far raw');
  assert.equal(parkingOf(far, 'max').legal, 20);
  // A use whose rule is 판단 필요: that use 미검토 and no total; 미적용 → 0 대.
  const undecided = await runMass(RECT, { ...DENSITY, ...PARKING }, [
    firstFloorShop,
    rule('제1종 근린생활시설', 200, '판단 필요'),
    rule('업무시설', 150),
  ]);
  assert.equal(parkingOf(undecided, 'max').legal, null);
  const rows = Object.fromEntries(undecided.steps.parking.useRows.map((r) => [r.use, r.status]));
  assert.equal(rows['제1종 근린생활시설'], '미검토');
  const exempt = await runMass(RECT, { ...DENSITY, ...PARKING }, [
    firstFloorShop,
    override(
      'regulation',
      { id: 'parkingRule', target: '제1종 근린생활시설' },
      { applies: '미적용' },
    ),
    rule('업무시설', 150),
  ]);
  assert.equal(parkingOf(exempt, 'max').legal, 18);
  // The direct function: rounding not entered → raw only.
  const regs = regulationStep({}, { parkingState: 'apply', parkingAreaBasis: 'gross' }, [
    rule('업무시설', 100),
  ]);
  const lp = legalParking(
    [{ use: '업무시설', above: 250, below: 0, total: 250, farArea: 250 }],
    regs.items,
  );
  assert.equal(lp.count, null);
  close(lp.raw, 2.5, 1e-12);
});

test('조경·공지 면적: 법정 = 비율 × 대지면적, 계획 = 그린 영역; 공개공지 필요 면적과 계획', async () => {
  const drawn = {
    landscapeZones: {
      rows: [
        row('green-1', [
          [0, 24],
          [20, 24],
          [20, 30],
          [0, 30],
        ]),
      ],
    },
    openSpaceZones: {
      rows: [
        row('zone-1', [
          [0, 0],
          [10, 0],
          [10, 6],
          [0, 6],
        ]),
      ],
    },
  };
  const out = await runMass(
    RECT,
    {
      ...DENSITY,
      landscapeRatioState: 'apply',
      landscapeRatio: 0.15,
      publicOpenSpaceState: 'apply',
      publicOpenSpace: 0.1,
      parkingAlternative: 'open-space',
    },
    [],
    drawn,
  );
  const l = out.steps.parking.landscape;
  close(l.legal, 90, 1e-9);
  close(l.planned, 120, 1e-6);
  assert.equal(l.verdict, '충족');
  const p = out.steps.parking.publicOpenSpace;
  close(p.required, 60, 1e-9);
  close(p.planned, 60, 1e-6);
  const decl = JSON.parse(readFileSync(`${JIG}/jig.json`, 'utf8')).bake.find(
    (b) => b.id === 'groundZones',
  );
  const { items, problems } = extractItems(decl, out.steps.parking);
  assert.deepEqual(problems, []);
  const kinds = new Set(items.map((i) => Object.fromEntries(i.attrs)['vide-ground']));
  assert.ok(
    kinds.has('조경(그린 영역)') &&
      kinds.has('공개공지(공개공지 반영)') &&
      kinds.has('주차 진입 가능 구간'),
  );
  // Not a 대상 / ratio 미적용.
  const none = await runMass(RECT, { ...DENSITY, landscapeRatioState: 'none' });
  assert.equal(none.steps.parking.landscape.legal, 0);
  assert.equal(none.steps.parking.landscape.legalStatus, '미적용');
});

test('주차 진입 가능 구간: road segments minus drawn exclusions and the 모퉁이 제외 거리 where two roads meet', async () => {
  const L = SITES[1];
  const params = paramsOf(L);
  const site = siteStep({ site: L.inputs.site }, params);
  const without = regulationStep({}, params);
  const free = entryZone(site.segments, site.corners, [], without.items, site.tolerance);
  close(free.length, 60, 1e-9, 'two 30 m road edges');
  assert.match(free.unresolved[0], /사람 입력 필요 — 모퉁이를 빼지 않고 보임/);
  const regs = regulationStep(
    {},
    { ...params, parkingEntryState: 'apply', parkingEntryCornerDistance: 5 },
  );
  const cut = entryZone(site.segments, site.corners, [], regs.items, site.tolerance);
  close(cut.length, 50, 1e-9, '5 m off each side of the corner');
  const drawn = entryZone(
    site.segments,
    site.corners,
    [
      {
        id: 'x',
        points: [
          [10, 0],
          [14, 0],
        ],
      },
    ],
    regs.items,
    site.tolerance,
  );
  close(drawn.length, 46, 1e-9, 'and 4 m drawn');
  assert.deepEqual(
    drawn.pieces.filter((p) => p.a[1] === 0 && p.b[1] === 0).map((p) => [p.a[0], p.b[0]]),
    [
      [5, 10],
      [14, 30],
    ],
  );
  // The rect site: the road corner meets a neighbour, nothing is cut.
  const r = await runMass(RECT, {
    ...DENSITY,
    parkingEntryState: 'apply',
    parkingEntryCornerDistance: 5,
  });
  close(r.steps.parking.entry.length, 20, 1e-9);
});

test('주차 방식 대안: 대당 필요 면적 × 대수, 지상 여유, 지하 층수 추정과 그 매스', async () => {
  const drawn = {
    landscapeZones: {
      rows: [
        row('green-1', [
          [0, 24],
          [20, 24],
          [20, 30],
          [0, 30],
        ]),
      ],
    },
  };
  const out = await runMass(
    RECT,
    {
      ...DENSITY,
      ...PARKING,
      parkingAlternative: 'max',
      parkingAreaGround: 25,
      parkingAreaUnder: 30,
      parkingAreaMech: 15,
      basementFloorHeight: 3.5,
    },
    [firstFloorShop, rule('제1종 근린생활시설', 200), rule('업무시설', 150)],
    drawn,
  );
  const p = out.steps.parking;
  assert.equal(p.target.id, 'max');
  // 지상 여유 = 600 − 522.5 − (120 − 19 × 4.5) = 43.
  close(p.ground.free, 43, 1e-6, 'ground free');
  const t = Object.fromEntries(p.types.map((r) => [r.type, r]));
  close(t.ground.required, 21 * 25, 1e-9);
  assert.equal(t.ground.verdict, '부족');
  close(t.underground.required, 630, 1e-9);
  assert.equal(t.underground.floors, 2, 'ceil(630 / 600)');
  assert.equal(t.underground.verdict, '부족', 'no basement planned');
  close(t.mechanical.required, 315, 1e-9);
  // The planned count wins over the legal one.
  const planned = await runMass(
    RECT,
    {
      ...DENSITY,
      ...PARKING,
      parkingAlternative: 'max',
      parkingAreaUnder: 30,
      plannedParking: 10,
      basementFloors: 1,
      basementFloorHeight: 3.5,
    },
    [firstFloorShop, rule('제1종 근린생활시설', 200), rule('업무시설', 150)],
  );
  const u = planned.steps.parking.types.find((r) => r.type === 'underground');
  assert.equal(u.count, 10);
  assert.equal(u.floors, 1);
  assert.equal(u.verdict, '충족');
  // Two estimated basement floors as closed extrusions below 0.
  const decl = JSON.parse(readFileSync(`${JIG}/jig.json`, 'utf8')).bake.find(
    (b) => b.id === 'parkingMasses',
  );
  const { items, problems } = extractItems(decl, p);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    items.map((i) => [i.key, i.rings[0][0][2], i.height]),
    [
      ['park:under:B1:0', -3.5, 3.5],
      ['park:under:B2:0', -7, 3.5],
    ],
  );
});
