import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import {
  chosenStep,
  floorFits,
  meshSolid,
  regionsArea,
} from '../../src/jigs/official/massing-kit/index.ts';
import { SITES, override, paramsOf, row, runMass } from '../fixtures/massing-sites.mjs';

// PLAN-45 T-211 (SPEC-12.10): 층 나누기, 대안(최대 · 기준 용적률 · 인센티브 · 공개공지 · 사람 수정,
// 8개까지), 공개공지 후보 표, 제외 면적, '초과' 판정, 고른 대안(사람 단계). The rect site
// (20 × 30, 남측 도로, 건축선 1 m, 민법 0.5 m, 일조 1.5 m / 10 m / 0.5, 높이 30 m) is hand-calculated:
// floors 4.5 + 3.3 k; a floor's outline is x ∈ [0.5, 19.5], y ∈ [1, min(28.5, 30 − top / 2)] above
// 10 m. The 규제 조건 values are test inputs a person would type, not a legal reading.

const JIG = 'src/jigs/official/jigs/buildable-mass';
const RECT = SITES[0];
const close = (actual, expected, eps = 1e-6, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected} (±${eps})`);
const FLOORS = [522.5, 522.5, 445.55, 414.2, 382.85, 351.5, 320.15, 288.8];
const MAX = FLOORS.reduce((a, b) => a + b, 0); // 3248.05
const DENSITY = { farBaseState: 'apply', farBase: 4, incentiveState: 'apply', incentiveFar: 0.5 };
const alt = (out, id) => out.steps.alternatives.alternatives.find((a) => a.id === id);
const rowOf = (out, id) => out.steps.alternatives.rows.find((r) => r.id === id);

test('floors: the maximum envelope cut at 4.5 + 3.3 k — areas by hand, every floor prism inside the envelope, basements', async () => {
  const out = await runMass(RECT, {
    basementFloors: 2,
    basementFloorHeight: 3.5,
    basementSetback: 1,
  });
  const { floors, envelope } = out.steps;
  assert.deepEqual(
    floors.floors.map((f) => f.floor),
    ['1F', '2F', '3F', '4F', '5F', '6F', '7F', '8F'],
  );
  floors.floors.forEach((f, i) => close(f.area, FLOORS[i], 1e-6, f.floor));
  close(floors.floors[7].z1, 4.5 + 7 * 3.3, 1e-9, '8F top');
  const solid = meshSolid(envelope.variants[0].maxMesh);
  for (const f of floors.floors)
    assert.ok(floorFits(solid, f.regions, f.z0, f.z1), `${f.floor} fits`);
  // A floor 1 m wider to the north does not fit.
  const f3 = floors.floors[2];
  const wide = [
    {
      outer: [
        [0.5, 1],
        [19.5, 1],
        [19.5, 25.45],
        [0.5, 25.45],
      ],
      holes: [],
    },
  ];
  assert.equal(floorFits(solid, wide, f3.z0, f3.z1), false);
  // Basements: the site minus 1 m along every edge = 18 × 28.
  assert.deepEqual(
    floors.basement.map((b) => [b.floor, b.z0, b.z1]),
    [
      ['B1', -3.5, 0],
      ['B2', -7, -3.5],
    ],
  );
  close(floors.basementArea, 18 * 28, 1e-6, 'basement');
});

test('alternatives: 최대 · 기준 용적률 (위층 축소) · 인센티브 against hand sums; 층수 줄이기; 상한 용적률 caps the incentive', async () => {
  const out = await runMass(RECT, DENSITY);
  const { rows } = out.steps.alternatives;
  assert.deepEqual(
    rows.map((r) => r.id),
    ['max', 'base', 'incentive'],
  );
  close(rowOf(out, 'max').gfaAbove, MAX, 1e-6, 'max gfa');
  assert.equal(rowOf(out, 'max').floorsAbove, 8);
  // 기준 4.0 × 600 = 2400: 8F (288.8) and 7F (320.15) go, 6F is cut back to 351.5 − 239.1 = 112.4.
  const base = alt(out, 'base');
  close(rowOf(out, 'base').farArea, 2400, 1e-6, 'base');
  close(rowOf(out, 'base').far, 4, 1e-9);
  assert.equal(base.floors.length, 6);
  close(base.floors[5].area, 112.4, 1e-6, '6F');
  assert.equal(base.floors[5].change, '축소');
  // Cut from the north side: the kept 6F is y ∈ [1, 1 + 112.4 / 19].
  const ys = base.floors[5].regions.flatMap((r) => r.outer.map((p) => p[1]));
  close(Math.max(...ys), 1 + 112.4 / 19, 1e-6, '6F north edge');
  close(Math.min(...ys), 1, 1e-9);
  // 인센티브 4.5 → 2700: 8F goes, 7F cut to 320.15 − 259.25 = 60.9.
  close(rowOf(out, 'incentive').farArea, 2700, 1e-6, 'incentive');
  assert.equal(rowOf(out, 'incentive').floorsAbove, 7);
  close(alt(out, 'incentive').floors[6].area, 60.9, 1e-6, '7F');
  close(rowOf(out, 'max').height, 4.5 + 7 * 3.3, 1e-9, 'height');

  const drop = await runMass(RECT, { ...DENSITY, trimMethod: 'drop-floors' });
  // 층수 줄이기: 8F, 7F, 6F go (3248.05 → 2287.6 ≤ 2400).
  assert.equal(rowOf(drop, 'base').floorsAbove, 5);
  close(rowOf(drop, 'base').farArea, 2287.6, 1e-6, 'drop');

  const capped = await runMass(RECT, { ...DENSITY, farMaxState: 'apply', farMax: 4.2 });
  close(rowOf(capped, 'incentive').farTarget, 4.2, 1e-12);
  close(rowOf(capped, 'incentive').farArea, 2520, 1e-6, 'capped');
  assert.match(rowOf(capped, 'incentive').farTargetSource, /상한 용적률까지/);
});

test("verdicts: over the 건폐율·용적률 limits is '초과' and the flow goes on; a 판단 필요 incentive is '조건 미확정'", async () => {
  const out = await runMass(RECT, { ...DENSITY, incentiveState: 'undecided' });
  const max = rowOf(out, 'max');
  // 건폐율 0.6 → 360 ㎡; the max footprint is 1F = 522.5.
  close(max.buildingArea, 522.5, 1e-6);
  assert.equal(max.coverageVerdict, '초과');
  close(max.coverageMargin, 360 - 522.5, 1e-6);
  // Only 기준 is entered: the max (5.41) is over it, the base is within.
  assert.equal(max.farVerdict, '초과');
  assert.equal(max.farCeilingSource, '기준 용적률');
  assert.equal(rowOf(out, 'base').farVerdict, '적합');
  const incentive = rowOf(out, 'incentive');
  assert.equal(incentive.title, '인센티브 반영 (조건 미확정)');
  assert.match(incentive.flags, /조건 미확정/);
  assert.equal(incentive.farVerdict, '초과', 'over 기준 — the only ceiling entered');
  assert.equal(incentive.unconfirmed, rowOf(out, 'base').unconfirmed + 1);
  // Nothing entered for 용적률: only the max, the others listed with the reason.
  const bare = await runMass(RECT);
  assert.deepEqual(
    bare.steps.alternatives.rows.map((r) => r.id),
    ['max'],
  );
  assert.equal(rowOf(bare, 'max').farVerdict, '상한 없음');
  assert.deepEqual(
    bare.steps.alternatives.skipped.map((s) => [s.id, s.reason]),
    [
      ['base', '기준 용적률 사람 입력 필요'],
      ['incentive', '적용할 인센티브 없음(사람 입력 필요)'],
      ['open-space', '공개공지 대상 여부·비율 사람 입력 필요'],
    ],
  );
});

test('제외 면적: the person’s per-floor value with its 근거 lowers the 용적률 산정 면적; an AI-marked one is refused', async () => {
  const ex = override('floor-exclusion', { floor: '1F' }, { area: 50, basis: '필로티(사람 확인)' });
  const ai = override('floor-exclusion', { floor: '2F' }, { area: 80 }, 'set', 'ai');
  const out = await runMass(RECT, DENSITY, [ex, ai]);
  const max = rowOf(out, 'max');
  close(max.exclusion, 50, 1e-9);
  close(max.farArea, MAX - 50, 1e-6, 'max far area');
  close(max.gfaAbove, MAX, 1e-6);
  assert.match(out.steps.alternatives.problems.join(), /2F: AI가 제안한 값은 사람이 받아야/);
  // 기준: excess 798.05 → 8F, 7F out, 6F cut by 189.1 to 162.4; 산정 2400, 연면적 2450.
  const base = rowOf(out, 'base');
  close(base.farArea, 2400, 1e-6, 'base far');
  close(base.gfaAbove, 2450, 1e-6, 'base gfa');
  assert.equal(alt(out, 'base').floors[0].exclusionBasis, '필로티(사람 확인)');
});

test('공개공지: 필요 면적 = 비율 × 대지면적, drawn and corner candidates, the open-space alternative keeps the picked one open', async () => {
  const zone = {
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
  const params = {
    ...DENSITY,
    publicOpenSpaceState: 'apply',
    publicOpenSpace: 0.1,
    openSpaceIncentiveState: 'apply',
    openSpaceIncentiveFar: 0.2,
  };
  const out = await runMass(RECT, params, [], zone);
  const os = out.steps.openSpace;
  close(os.requirement.required, 60, 1e-9);
  assert.deepEqual(
    os.rows.map((r) => [r.no, r.source, r.verdict, r.picked]),
    [
      [1, '그린 영역', '충족', '대안에 씀'],
      [2, '대지 모서리 후보', '충족', ''],
      [3, '대지 모서리 후보', '충족', ''],
    ],
  );
  close(os.rows[1].area, 60, 1e-6, 'corner square √60²');
  assert.equal(os.rows[0].incentive, '0.2');
  // Each floor loses the zone's part inside it: 9.5 × 5 = 47.5.
  const open = alt(out, 'open-space');
  assert.equal(open.floors[0].change, '공개공지 뺌');
  close(open.floors[0].area, 522.5 - 47.5, 1e-6, '1F');
  // 기준 4 + 공개공지 0.2 → 2520: 8F (241.3) out, 7F cut to 272.65 − 106.75 = 165.9.
  const r = rowOf(out, 'open-space');
  close(r.farTarget, 4.2, 1e-12);
  close(r.farArea, 2520, 1e-6, 'open-space far');
  assert.equal(r.floorsAbove, 7);
  close(open.floors[6].area, 165.9, 1e-6, '7F');
  // Row 2 instead of the drawn zone; no incentive value → 기준 only, the source says so.
  const corner = await runMass(
    RECT,
    { ...params, openSpaceCandidate: 2, openSpaceIncentiveState: 'ask' },
    [],
    zone,
  );
  assert.equal(corner.steps.openSpace.picked.no, 2);
  const cr = rowOf(corner, 'open-space');
  close(cr.farTarget, 4, 1e-12);
  assert.match(cr.farTargetSource, /공개공지 완화량 사람 입력 필요/);
  assert.equal(corner.steps.openSpace.rows[0].incentive, '사람 입력 필요');
  // Not a 대상: skipped with the reason.
  const none = await runMass(RECT, { ...DENSITY, publicOpenSpaceState: 'none' });
  assert.deepEqual(
    none.steps.alternatives.skipped.find((s) => s.id === 'open-space').reason,
    '공개공지 대상 아님(미적용)',
  );
});

test('사람 수정: outlines and removed floors from the 수정 사항; outside the envelope is flagged; at most 8 alternatives', async () => {
  const square = [
    [1, 2],
    [19, 2],
    [19, 20],
    [1, 20],
  ];
  const edits = [
    override('mass-floor', { alternative: 'human-1', floor: '3F' }, { outline: square }),
    override('mass-floor', { alternative: 'human-1', floor: '8F' }, {}, 'remove'),
    override(
      'mass-floor',
      { alternative: 'human-2', floor: '5F' },
      {
        outline: [
          [1, 2],
          [19, 2],
          [19, 25],
          [1, 25],
        ],
      },
    ),
    override(
      'mass-floor',
      { alternative: 'human-3', floor: '1F' },
      { outline: square },
      'set',
      'ai',
    ),
  ];
  const out = await runMass(RECT, DENSITY, edits);
  const h1 = rowOf(out, 'human-1');
  assert.equal(h1.title, '사람 수정 1');
  assert.equal(h1.floorsAbove, 7);
  close(h1.gfaAbove, MAX - 288.8 - 445.55 + 18 * 18, 1e-6, 'human-1');
  assert.equal(h1.flags, '');
  assert.equal(alt(out, 'human-1').floors[2].change, '사람 수정');
  // 5F top 17.7 m allows y ≤ 21.15: an outline to y = 25 is outside.
  assert.equal(rowOf(out, 'human-2').flags, '외피 밖');
  assert.equal(alt(out, 'human-2').floors[4].outside, true);
  assert.ok(!rowOf(out, 'human-3'), 'an AI-marked edit makes no alternative');
  assert.match(
    out.steps.alternatives.problems.join(),
    /human-3 1F: AI가 제안한 수정은 사람이 받아야/,
  );

  const many = [1, 2, 3, 4, 5, 6].map((k) =>
    override('mass-floor', { alternative: `human-${k}`, floor: '8F' }, {}, 'remove'),
  );
  const capped = await runMass(RECT, DENSITY, many);
  // max, base, incentive + human-1…5 = 8; human-6 is listed as over the limit.
  assert.equal(capped.steps.alternatives.rows.length, 8);
  assert.deepEqual(capped.steps.alternatives.skipped.at(-1), {
    id: 'human-6',
    title: '사람 수정 6',
    reason: '대안은 8개까지',
  });
});

test('고른 대안: the human step holds it; confirmed, the 건축개요 input is the alternative; a change asks again', async () => {
  const out = await runMass(RECT, DENSITY);
  assert.throws(
    () => chosenStep({ steps: out.steps }, { chosenAlternative: 'unset' }),
    /고른 대안이 없습니다/,
  );
  assert.throws(
    () => chosenStep({ steps: out.steps }, { chosenAlternative: 'human-1' }),
    /대안 표에 없습니다/,
  );
  const chosen = chosenStep({ steps: out.steps }, { chosenAlternative: 'base' });
  assert.equal(chosen.row.farArea, 2400);
  assert.equal(chosen.origin, '사용자가 확정함');

  const jig = await loadJig(JIG);
  const run = async (values, confirmations) => {
    const all = Object.fromEntries(
      Object.entries(initialParams(jig.manifest)).map(([key, value]) => [
        key,
        values[key] !== undefined ? { ...value, value: values[key], by: 'user' } : value,
      ]),
    );
    return executeSteps({
      jig,
      runner: new EngineRunner(),
      cache: new MemoryCache(),
      mode: 'confirmed',
      inputs: RECT.inputs,
      params: all,
      confirmations,
    });
  };
  const status = (report) => Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  const values = { ...paramsOf(RECT), ...DENSITY, chosenAlternative: 'base' };
  const first = await run(values);
  assert.equal(status(first).confirmChoice, 'waiting');
  assert.equal(status(first).chosen, 'blocked');
  const hash = first.steps.find((s) => s.id === 'confirmChoice').inputHash;
  const confirmed = await run(values, { confirmChoice: hash });
  assert.equal(status(confirmed).chosen, 'done');
  assert.equal(confirmed.outputs.chosen.id, 'base');
  // Another way of taking area away changes the alternatives: confirm again.
  const changed = await run({ ...values, trimMethod: 'drop-floors' }, { confirmChoice: hash });
  assert.equal(status(changed).confirmChoice, 'reconfirm');
  assert.equal(status(changed).chosen, 'blocked');

  // The floor masses: one closed extrusion per floor region with option, floor, area and use.
  const manifest = JSON.parse(readFileSync(`${JIG}/jig.json`, 'utf8'));
  const decl = manifest.bake.find((b) => b.id === 'alternativeMasses');
  const { items, problems } = extractItems(decl, confirmed.outputs.useMix);
  assert.deepEqual(problems, []);
  assert.equal(items.length, 8 + 6 + 7);
  const six = items.find((i) => i.key === 'alt:base:6F:0');
  close(six.height, 3.3, 1e-9);
  assert.equal(six.rings[0][0][2], 4.5 + 4 * 3.3);
  const attrs = Object.fromEntries(six.attrs);
  assert.equal(attrs['vide-option'], '기준 용적률');
  assert.equal(attrs['vide-area-m2'], '112.40');
  assert.equal(attrs['vide-use'], '업무시설');
  close(regionsArea(alt({ steps: confirmed.outputs }, 'base').floors[5].regions), 112.4, 1e-6);
});
