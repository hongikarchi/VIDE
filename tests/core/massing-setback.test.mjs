import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PARAM_ITEMS,
  REGULATION_ITEMS,
  boundarySegments,
  buildableStep,
  limitStep,
  mergeRegulations,
  planStep,
  regulationStep,
  regulationsFromLegal,
  regulationsFromParams,
  siteStep,
} from '../../src/jigs/official/massing-kit/index.ts';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { selftestJig } from '../../src/jigs/runtime/pack.ts';
import { BASE_PARAMS, SITES, ngon, paramsOf, row } from '../fixtures/massing-sites.mjs';

// PLAN-45 T-209 (SPEC-12.7·12.8): 규제 조건 items, boundary segments and the 2D buildable area on
// the synthetic sites of SPIKE-2026-10-07-envelope, against hand calculations. All sites and
// 규제 조건 values are invented test inputs.

const JIG = 'src/jigs/official/jigs/buildable-mass';
const close = (actual, expected, eps, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected} (±${eps})`);

function run2d(site, extra = {}, inputs = {}) {
  const params = { ...paramsOf(site), ...extra };
  const own = { ...site.inputs.site, ...inputs };
  const s = siteStep({ site: own }, params);
  const regulations = regulationStep({}, params);
  const limits = limitStep({ site: own, steps: { site: s, regulations } });
  const buildable = buildableStep({ steps: { site: s, regulations, limits } });
  return { site: s, regulations, limits, buildable };
}
const reduction = (b, rule) => b.reductions.find((r) => r.rule === rule)?.area;

test('five synthetic sites: buildable area and the area each rule removes (hand calculation)', () => {
  for (const site of SITES) {
    const { buildable } = run2d(site);
    const e = site.expect;
    if (e.area !== undefined) close(buildable.area, e.area, 1e-6, `${site.id} area`);
    if (e.areaTrue !== undefined) {
      // Round ends are circumscribed 64-gons: never more area than the true circles, within 0.01 ㎡.
      close(buildable.area, e.areaTrue, 0.01, `${site.id} area`);
      assert.ok(buildable.area <= e.areaTrue + 1e-9, `${site.id}: safe side`);
    }
    if (e.areaGrid !== undefined) close(buildable.area, e.areaGrid, 0.05, `${site.id} area (grid)`);
    for (const [rule, area] of Object.entries(e.reductions ?? {}))
      close(reduction(buildable, rule), area, 1e-6, `${site.id} ${rule}`);
    assert.equal(buildable.empty, false);
  }
});

test('boundary segments follow the roads and parcels across them; corners get 가각 only between roads', () => {
  const l = SITES.find((s) => s.id === 'l-shape');
  const { site, limits } = run2d(l);
  assert.deepEqual(
    site.segments.map((s) => `${s.id}:${s.kind}`),
    ['s0:road', 's1:adjacent', 's2:adjacent', 's3:adjacent', 's4:adjacent', 's5:road'],
  );
  const chamfers = limits.cutters.filter((c) => c.rule === 'chamfer');
  assert.equal(chamfers.length, 1, 'only the south-west corner joins two roads');
  assert.deepEqual(chamfers[0].ring[0], [0, 0]);
  // Datum = the north-facing parcel edges (top and step), not the east-facing inner edge.
  const table = limits.segmentRules.filter((r) => r.rules.some((x) => x.rule === 'sun-ground'));
  assert.deepEqual(
    table.map((r) => r.segment),
    ['s2', 's4'],
  );

  // A road overlapping a neighbour, and an edge touching nothing, stay '확인 필요'.
  const ring = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const { segments } = boundarySegments(
    ring,
    [
      [
        [0, 0],
        [10, 0],
      ],
      [
        [10, 2],
        [10, 6],
      ],
    ],
    [
      [
        [10, 4],
        [10, 10],
      ],
      [
        [10, 10],
        [0, 10],
      ],
    ],
    0.05,
  );
  assert.deepEqual(
    segments.map((s) => `${s.id}:${s.kind}:${s.note}`),
    [
      's0:road:',
      's1.0:unknown:맞닿은 도로·필지 없음',
      's1.1:road:',
      's1.2:unknown:도로와 인접 대지가 겹침',
      's1.3:adjacent:',
      's2:adjacent:',
      's3:unknown:맞닿은 도로·필지 없음',
    ],
  );
  assert.ok(segments.filter((s) => s.kind === 'unknown').every((s) => s.status === '확인 필요'));
  const lengths = segments.slice(1, 5).map((s) => +s.length.toFixed(9));
  assert.deepEqual(lengths, [2, 2, 2, 4]);
});

test('a road lot also on the neighbour layer (the site model 주변 필지) is the road, not 겹침', () => {
  // T-214: the site model bakes every lot around under 주변 필지, road lots included, and the road
  // lots again under 도로. The same ring on both layers is one road lot.
  const site = {
    rows: [
      row('site', [
        [0, 0],
        [20, 0],
        [20, 30],
        [0, 30],
      ]),
    ],
  };
  const roadLot = [
    [-10, -10],
    [50, -10],
    [50, 0],
    [-10, 0],
  ];
  const east = [
    [20, 0],
    [40, 0],
    [40, 30],
    [20, 30],
  ];
  const inputs = {
    boundary: site,
    roads: { rows: [row('road', roadLot)] },
    // The neighbour copy starts elsewhere and runs the other way.
    neighbors: { rows: [row('lot-road', [...roadLot].reverse()), row('lot-east', east)] },
  };
  const s = siteStep({ site: inputs }, { segmentTolerance: 0.05 });
  assert.deepEqual(
    s.segments.map((x) => `${x.id}:${x.kind}`),
    ['s0:road', 's1:adjacent', 's2:unknown', 's3:unknown'],
  );
  // A neighbour that only shares an edge with the road is still a neighbour (겹침 stays).
  const strip = [
    [0, -10],
    [20, -10],
    [20, 0],
    [0, 0],
  ];
  const other = siteStep(
    { site: { ...inputs, neighbors: { rows: [row('strip', strip)] } } },
    { segmentTolerance: 0.05 },
  );
  assert.equal(other.segments[0].note, '도로와 인접 대지가 겹침');
});

test('규제 조건: no legal number in code — an empty setting is 사람 입력 필요 and the rule is listed, not applied', () => {
  const items = regulationsFromParams({});
  assert.equal(items.length, PARAM_ITEMS.length);
  assert.ok(
    items.every((i) => i.status === '사람 입력 필요' && i.value === null && i.applies === null),
  );
  // Every item id is in the closed list.
  assert.ok(items.every((i) => i.id in REGULATION_ITEMS));

  const rect = SITES[0];
  const blank = Object.fromEntries(
    Object.entries(paramsOf(rect)).filter(([k]) => !PARAM_ITEMS.some((p) => p.state === k)),
  );
  const { buildable, limits, regulations } = run2d(rect, {}, {});
  assert.equal(buildable.area, 522.5);
  const none = (() => {
    const s = siteStep({ site: rect.inputs.site }, blank);
    const r = regulationStep({}, blank);
    const lim = limitStep({ site: rect.inputs.site, steps: { site: s, regulations: r } });
    return { r, lim, b: buildableStep({ steps: { site: s, regulations: r, limits: lim } }) };
  })();
  assert.equal(none.b.area, 600, 'nothing applied while nobody entered a value');
  assert.equal(none.lim.sun, null);
  assert.ok(none.lim.unresolved.some((u) => /정북 일조 적용 여부 사람 입력 필요/.test(u.reason)));
  assert.ok(none.lim.unresolved.some((u) => u.rule === 'road-setback'));
  assert.ok(none.lim.unresolved.some((u) => u.rule === 'civil'));
  assert.ok(none.r.needsInput.length >= PARAM_ITEMS.length - 1);
  assert.equal(regulations.legal.available, false);
  assert.equal(limits.unresolved.length, 0);

  // 적용 with a value nobody entered (0 where a value must be positive) stays 사람 입력 필요.
  const zero = run2d(rect, { sunBaseHeight: 0 });
  assert.equal(zero.limits.sun, null);
  assert.ok(zero.limits.unresolved.some((u) => /일조 값 사람 입력 필요: 기준 높이/.test(u.reason)));
  assert.equal(zero.buildable.area, 19 * 28.5);
});

test("'판단 필요' is never calculated as 미적용 silently: listed, or both variants for 일조", () => {
  const rect = SITES[0];
  const civil = run2d(rect, { civilSetbackState: 'undecided' });
  assert.equal(civil.buildable.area, 20 * 27.5, 'calculated without the undecided 민법 이격');
  const listed = civil.limits.unresolved.filter((u) => u.rule === 'civil');
  assert.equal(listed.length, 3);
  assert.ok(listed.every((u) => /판단 필요/.test(u.reason)));
  assert.ok(civil.regulations.unconfirmed.some((u) => u.id === 'civilSetback'));

  const sun = run2d(rect, { sunState: 'undecided' });
  assert.deepEqual(
    sun.buildable.variants.map((v) => [v.id, v.area]),
    [
      ['base', 522.5],
      ['without', 19 * 28.5],
    ],
  );
});

test('drawn limits only: 건축한계선 cuts the road side, 기타 이격 is a capsule around the drawn line', () => {
  const rect = SITES[0];
  const limit = run2d(
    rect,
    {},
    {
      limitLines: {
        rows: [
          row(
            'limit-1',
            [
              [-1, 3],
              [21, 3],
            ],
            false,
          ),
        ],
      },
    },
  );
  close(reduction(limit.buildable, 'limit-line'), 60, 1e-6, 'limit line');
  close(limit.buildable.area, 19 * 25.5, 1e-6, 'area');

  const other = run2d(
    rect,
    { otherSetbackState: 'apply', otherSetback: 2 },
    {
      otherLines: {
        rows: [
          row(
            'other-1',
            [
              [10, 10],
              [10, 20],
            ],
            false,
          ),
        ],
      },
    },
  );
  // 2 × 2 m wide strip over 10 m, plus the two half 64-gons of radius 2.
  close(reduction(other.buildable, 'other'), 40 + ngon(2), 1e-6, 'other');
  close(reduction(other.buildable, 'other'), 40 + Math.PI * 4, 0.02, 'other vs circle');

  // A drawn line without a 거리 is listed, not guessed.
  const missing = run2d(
    rect,
    { otherSetbackState: 'ask' },
    {
      otherLines: {
        rows: [
          row(
            'other-1',
            [
              [10, 10],
              [10, 20],
            ],
            false,
          ),
        ],
      },
    },
  );
  assert.equal(missing.buildable.area, 522.5);
  assert.ok(missing.limits.unresolved.some((u) => u.rule === 'other' && u.target === 'other-1'));
});

test('open space from the 건축선 adds to the road setback; 건폐율 compares the area with the cap', () => {
  const rect = SITES[0];
  const r = run2d(rect, { openSpaceRoadState: 'apply', openSpaceRoad: 2 });
  close(reduction(r.buildable, 'open-space-road'), 60, 1e-6, '(1 + 2) × 20');
  close(r.buildable.area, 19 * 25.5, 1e-6);
  const base = run2d(rect);
  assert.equal(base.buildable.coverage.capArea, 360);
  assert.equal(base.buildable.coverage.message, '건축면적은 상한 360 ㎡까지');
  const small = run2d(rect, { coverage: 0.9 });
  assert.match(small.buildable.coverage.message, /가능 영역이 건폐율 상한 면적/);
  const off = run2d(rect, { coverageState: 'ask' });
  assert.equal(off.buildable.coverage.capArea, null);
});

test('the north-road datum moves across the road by the road width read from the road polygon', () => {
  const north = SITES.find((s) => s.id === 'north-road');
  const { limits } = run2d(north);
  assert.equal(limits.sun.datum.length, 1);
  assert.deepEqual(
    limits.sun.datum[0].a.map((x) => +x.toFixed(9)),
    [20, 30],
  );
  assert.match(limits.sun.datum[0].source, /도로 너비 6 m/);
  const ask = run2d(north, { sunDatumRoad: 'ask' });
  assert.equal(ask.limits.sun, null);
  assert.ok(ask.limits.unresolved.some((u) => /기준선 위치 사람 입력 필요/.test(u.reason)));
});

test('failures: a boundary that crosses itself or is open stops with where; an empty area says what cut most', () => {
  const bow = {
    rows: [
      row('site-1', [
        [0, 0],
        [20, 0],
        [0, 10],
        [10, 20],
      ]),
    ],
  };
  assert.throws(
    () => siteStep({ site: { boundary: bow } }, BASE_PARAMS),
    /스스로 교차합니다: 변 \d+/,
  );
  const open = {
    rows: [
      row(
        'site-1',
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        false,
      ),
    ],
  };
  assert.throws(
    () => siteStep({ site: { boundary: open } }, BASE_PARAMS),
    /닫히지 않았습니다.*10 m/,
  );
  assert.throws(() => siteStep({ site: {} }, BASE_PARAMS), /닫힌 곡선 하나/);

  const rect = SITES[0];
  const gone = run2d(rect, { civilSetback: 12 });
  assert.equal(gone.buildable.empty, true);
  assert.equal(gone.buildable.area, 0);
  assert.match(gone.buildable.message, /^가능 영역 없음 — 가장 많이 줄인 제한선: 민법상 이격/);
});

test('SPEC-13 slot: no legal result yet; a later result fills only what the person left empty', () => {
  assert.deepEqual(regulationsFromLegal(undefined), {
    available: false,
    reason: '법규 결과 없음',
    items: [],
  });
  const person = regulationsFromParams({ civilSetbackState: 'apply', civilSetback: 0.5 });
  const legal = [
    {
      ...person.find((i) => i.id === 'civilSetback'),
      value: 1,
      origin: '원본에서 읽음',
      source: 'legal:1',
    },
    {
      ...person.find((i) => i.id === 'coverage'),
      value: 0.6,
      applies: '적용',
      status: '확정',
      origin: '원본에서 읽음',
      source: 'legal:2',
    },
  ];
  const { items, differences } = mergeRegulations(person, legal);
  assert.equal(items.find((i) => i.id === 'civilSetback').value, 0.5, 'the person keeps the value');
  assert.equal(items.find((i) => i.id === 'coverage').value, 0.6, 'an empty item is filled');
  assert.deepEqual(differences, [{ id: 'civilSetback', person: 0.5, legal: 1 }]);
});

test('계획 조건: 주용도 still 미정 is asked; plan values from the settings', () => {
  const asked = planStep({}, { ...BASE_PARAMS, mainUse: 'unset' });
  assert.equal(asked.mainUse, null);
  assert.deepEqual(asked.questions, ['주용도가 무엇인가요?']);
  const set = planStep({}, BASE_PARAMS);
  assert.equal(set.mainUse, '업무시설');
  assert.equal(set.floorHeightTypical, 3.3);
});

test('the vide/buildable-mass package validates and its self-test runs the library steps', async () => {
  const jig = await loadJig(JIG);
  assert.equal(jig.id, 'vide/buildable-mass');
  assert.ok(
    jig.manifest.steps
      .filter((s) => s.kind === 'library')
      .every((s) => s.use.startsWith('vide/massing-kit#')),
  );
  // Numbers a rule uses never sit in the package as defaults of 규제 조건 settings.
  const manifest = JSON.parse(readFileSync(`${JIG}/jig.json`, 'utf8'));
  for (const p of manifest.params.filter((p) => p.group.startsWith('규제 조건')))
    assert.ok(p.default === 0 || p.default === 'ask', `${p.key} default ${p.default}`);
  const report = await selftestJig(JIG, { runner: 'engine' });
  assert.equal(
    report.ok,
    true,
    JSON.stringify(report.cases.map((c) => [c.name, c.error, c.mismatches])),
  );
});
