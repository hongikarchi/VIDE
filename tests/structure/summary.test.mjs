import test from 'node:test';
import assert from 'node:assert/strict';
import {
  structureModelSchema,
  structureSummarySchema,
} from '../../src/contracts/structure-model.ts';
import { analyzeStructure } from '../../src/jigs/structure/core.ts';
import {
  analysisConfirmed,
  buildFrameModel,
  comboEcho,
  memberMapFrom,
  referenceDeflection,
  runAnalysis,
  summarize,
  uncheckedListed,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { baseModel, fixtures, H400 } from './fixtures.mjs';
import { archPlan, bayPlan, gridPlan } from './frame-fixtures.mjs';

const kb = (value) => Buffer.byteLength(JSON.stringify(value)) / 1024;

test('reference deflection ≥ every segment deflection; a single segment equals the core value', () => {
  const { model: input, map } = buildFrameModel(
    bayPlan({
      members: bayPlan().members.map((m) =>
        m.role === 'girder' ? { ...m, ends: ['pinned', 'pinned'] } : m,
      ),
    }),
  );
  const model = structureModelSchema.parse(input);
  const result = analyzeStructure(model);
  assert.equal(result.status, 'ok', result.error);
  const rows = referenceDeflection(model, result, map);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // The girder is split at three T-joints: the chord over the whole 9 m span sees the midspan sag
  // that no 2.5 m piece sees on its own.
  const girder = byId.get('G-0');
  assert.ok(girder, 'girder row');
  assert.equal(girder.kind, 'span');
  assert.ok(girder.combo === 'D+L');
  for (const id of map.physical['G-0'])
    assert.ok(
      girder.deflection_mm >= result.members[id].deflection_mm['D+L'] - 1e-9,
      `${id}: ${girder.deflection_mm} ≥ ${result.members[id].deflection_mm['D+L']}`,
    );
  assert.ok(girder.deflection_mm > girder.segmentMax_mm * 1.5, 'chord sag dominates the pieces');
  assert.ok(Math.abs(girder.limit_mm - 25) < 1e-9, 'L/360 of 9 m');
  // A secondary beam is one segment: reference = core deflection.
  const beam = byId.get('B-5');
  assert.ok(Math.abs(beam.deflection_mm - result.members['B-5.1'].deflection_mm['D+L']) < 1e-9);
  // Columns get no deflection row.
  assert.equal(byId.has('C-0-0'), false);
});

test('a cantilever arm measures its tip from the root and uses the cantilever limit', () => {
  const plan = bayPlan();
  plan.members.push({
    key: 'A-1',
    role: 'arm',
    rail: [
      [4.5, 0, 6],
      [4.5, -2, 6],
    ],
    section: 'H400',
    ends: ['rigid', 'pinned'],
  });
  plan.lineLoads.push({ memberKey: 'A-1', case: 'D', value_kNpm: 10, source: 'area' });
  const { model: input, map } = buildFrameModel(plan);
  assert.equal(map.cantilever['A-1'], 'j');
  const model = structureModelSchema.parse(input);
  const result = analyzeStructure(model);
  assert.equal(result.status, 'ok', result.error);
  const row = referenceDeflection(model, result, map).find((r) => r.id === 'A-1');
  assert.equal(row.kind, 'cantilever');
  assert.ok(Math.abs(row.limit_mm - 2000 / 180) < 1e-9);
  assert.ok(row.deflection_mm > 0 && row.deflection_mm >= row.segmentMax_mm);
});

test('summary: per member and per segment verdicts, restraint reactions per column, echoes and lists', () => {
  const { model: input, map, assumptions } = buildFrameModel(bayPlan());
  const outcome = runAnalysis(input, map, {
    mode: 'confirmed',
    key: 'bay',
    assumptions,
    detail: 'full',
  });
  const { summary, result } = outcome;
  assert.ok(
    structureSummarySchema.safeParse(summary).success,
    JSON.stringify(structureSummarySchema.safeParse(summary).error?.issues?.slice(0, 3)),
  );
  assert.equal(summary.status, 'ok');
  assert.equal(summary.mode, 'confirmed');
  assert.equal(summary.label, '확정 결과');
  assert.equal(summary.modelHash, result.modelHash);
  assert.equal(summary.members.length, 9);
  const rows = new Map(summary.members.map((r) => [r[0], r]));
  const girder = rows.get('G-0');
  assert.equal(girder[6].length, 4, 'four segment rows');
  assert.ok(girder[4] !== null && girder[5] !== null, 'reference deflection and limit');
  assert.ok(girder[3] !== null && summary.clauses[girder[3]], 'governing clause');
  const column = rows.get('C-0-0');
  assert.equal(column[4], null);
  assert.equal(column[6].length, 2, 'two column segments');
  assert.deepEqual(rows.get('B-5')[6], [], 'a single segment repeats the member row');
  // Statuses come from the four-state core verdict plus the colour bands.
  for (const [, code, ratio] of summary.members) {
    assert.ok(code >= 0 && code <= 4);
    if (code === 0) assert.ok(ratio < 0.7);
    if (code === 1) assert.ok(ratio >= 0.7 && ratio <= 1);
  }
  assert.equal(
    Object.values(summary.counts).reduce((s, v) => s + v, 0),
    summary.members.length,
  );
  // Restraint reactions: one row per restrained column node, grouped by column key.
  assert.equal(summary.reactions.perColumn.length, 4);
  assert.deepEqual(summary.reactions.perColumn.map((r) => r[0]).sort(), [
    'C-0-0',
    'C-0-5',
    'C-9-0',
    'C-9-5',
  ]);
  for (const [, z] of summary.reactions.perColumn) assert.equal(z, 4);
  assert.ok(summary.reactions.maxLateral_kN > 0, 'notional combos push on the restraint');
  assert.ok(Math.abs(summary.reactions.sumZ_kN['D+L']) > 0);
  // Combination echo and the unchecked list gates pass; assumptions travel with the summary.
  assert.deepEqual(comboEcho(input, summary), { gate: 'combo-echo', ok: true, reasons: [] });
  assert.deepEqual(uncheckedListed(summary), { gate: 'unchecked-listed', ok: true, reasons: [] });
  assert.ok(summary.unchecked.some((u) => u.includes('참고 처짐')));
  assert.ok(summary.assumptions.includes('강재 자중을 D 패턴에 포함'));
  assert.equal(summary.margin.name, '중력 조합 부재 검정 여유');
  assert.ok(summary.steel_t > 0);
  // Gate analysis-confirmed: the confirmed summary of this hash passes, a preview does not.
  assert.equal(analysisConfirmed(summary, result.modelHash).ok, true);
  assert.equal(analysisConfirmed(summary, 'other').ok, false);
  const preview = runAnalysis(input, map, { mode: 'preview', key: 'bay' }).summary;
  assert.equal(preview.label, '미확정 미리보기');
  assert.equal(preview.mode, 'preview');
  assert.equal(analysisConfirmed(preview, result.modelHash).ok, false);
  assert.equal(preview.members.length, summary.members.length);
});

test('gates fail on tampered combinations and an empty unchecked list', () => {
  const { model: input, map } = buildFrameModel(bayPlan());
  const { summary } = runAnalysis(input, map, { mode: 'preview' });
  const tampered = {
    ...summary,
    combos: summary.combos.map((c, k) => (k ? c : { ...c, terms: { D: 1 } })),
  };
  assert.equal(comboEcho(input, tampered).ok, false);
  assert.equal(comboEcho(input, { combos: summary.combos.slice(1) }).ok, false);
  assert.equal(uncheckedListed({ ...summary, unchecked: [] }).ok, false);
  assert.equal(uncheckedListed({ ...summary, disclaimer: '' }).ok, false);
});

test('members without design lengths are 미완, check errors give invalid, mechanisms give unstable', () => {
  // A plain simply supported beam (no design values) passes the core but counts as incomplete.
  const plain = fixtures.find((f) => f.id === 'simple-beam-uniform').model;
  const { summary } = runAnalysis(plain, undefined, { mode: 'preview' });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.members[0][1], 3, 'na');
  assert.equal(summary.counts.na, 1);
  assert.ok(summary.issues.some((i) => i.code === 'DESIGN_INCOMPLETE'));
  // Check errors: no support → nothing analysed.
  const noSupport = { ...plain, nodes: plain.nodes.map((n) => ({ id: n.id, xyz_m: n.xyz_m })) };
  const invalid = runAnalysis(noSupport, undefined, { mode: 'preview' }).summary;
  assert.equal(invalid.status, 'invalid');
  assert.ok(invalid.issues.some((i) => i.code === 'NO_SUPPORT'));
  assert.equal(invalid.members.length, 0);
  // A sway mechanism is reported as unstable with its nodes (probe on for confirmed mode).
  const mechanism = fixtures.find((f) => f.id === 'mechanism').model;
  const unstable = runAnalysis(mechanism, undefined, { mode: 'confirmed', key: 'm' }).summary;
  assert.equal(unstable.status, 'unstable');
  assert.ok(unstable.issues.some((i) => i.code === 'MECHANISM' && i.nodes.length));
});

test('the stability probe runs only when the geometry changes for a key', () => {
  const { model: input, map } = buildFrameModel(bayPlan());
  const cache = new Map();
  const first = runAnalysis(input, map, { mode: 'confirmed', key: 'k' }, cache);
  assert.equal(cache.size, 1);
  const hash = cache.get('k');
  // Same geometry, different loads: the cache entry stays.
  const loaded = {
    ...input,
    loads: input.loads.map((l) =>
      l.type === 'memberUniform' ? { ...l, value_kNpm: l.value_kNpm * 2 } : l,
    ),
  };
  runAnalysis(loaded, map, { mode: 'confirmed', key: 'k' }, cache);
  assert.equal(cache.get('k'), hash);
  // Moved node: a new geometry hash.
  const moved = {
    ...input,
    nodes: input.nodes.map((n, k) =>
      k === 0 ? { ...n, xyz_m: [n.xyz_m[0] + 0.1, n.xyz_m[1], n.xyz_m[2]] } : n,
    ),
  };
  runAnalysis(moved, map, { mode: 'confirmed', key: 'k' }, cache);
  assert.notEqual(cache.get('k'), hash);
  assert.equal(first.summary.status, 'ok');
});

test('arch thrust appears only at the restrained column nodes', () => {
  const { model: input, map } = buildFrameModel(archPlan());
  const { summary, result } = runAnalysis(input, map, { mode: 'confirmed', detail: 'full' });
  assert.equal(summary.status, 'ok', summary.error);
  const restraint = new Set(input.analysis.lateralRestraint.nodes);
  const model = structureModelSchema.parse(input);
  const supports = new Set(model.nodes.filter((n) => n.support).map((n) => n.id));
  for (const [id, out] of Object.entries(result.nodes)) {
    if (restraint.has(id) || supports.has(id)) continue;
    assert.equal(out.reaction, undefined, `${id} carries no reaction`);
  }
  const thrust = summary.reactions.perColumn.map((r) => r[3]);
  assert.equal(thrust.length, 2);
  assert.ok(
    Math.abs(thrust[0]) > 1 && Math.sign(thrust[0]) === -Math.sign(thrust[1]),
    `thrust ${thrust}`,
  );
  const rows = referenceDeflection(model, result, map);
  assert.ok(rows[0].deflection_mm >= rows[0].segmentMax_mm);
});

test('summary of a 1,500-segment frame stays under 50 KB and reports timing', () => {
  const plan = gridPlan();
  const { model: input, map, issues } = buildFrameModel(plan);
  assert.equal(
    issues.filter((i) => i.level === 'error').length,
    0,
    JSON.stringify(issues.slice(0, 3)),
  );
  assert.ok(input.members.length >= 1500, `${input.members.length} segments`);
  const started = performance.now();
  const { summary } = runAnalysis(input, map, { mode: 'preview', key: 'grid' });
  const total = performance.now() - started;
  assert.equal(summary.status, 'ok', summary.error);
  assert.ok(structureSummarySchema.safeParse(summary).success);
  const size = kb(summary);
  assert.ok(
    size <= 50,
    `summary ${size.toFixed(1)} KB for ${input.members.length} segments, ${summary.members.length} members`,
  );
  assert.ok(summary.ms > 0 && summary.ms <= total + 1);
  console.log(
    `summary ${size.toFixed(1)} KB · ${input.members.length} segments · ${summary.members.length} members · core+summary ${summary.ms} ms · pipeline ${total.toFixed(0)} ms`,
  );
});

test('a model without designMembers maps every member to itself', () => {
  const model = structureModelSchema.parse(
    baseModel({
      nodes: [
        { id: 'N1', xyz_m: [0, 0, 0], support: { dx: true, dy: true, dz: true, rx: true } },
        { id: 'N2', xyz_m: [6, 0, 0], support: { dy: true, dz: true } },
      ],
      members: [
        {
          id: 'B1',
          i: 'N1',
          j: 'N2',
          section: H400.id,
          material: 'SM355',
          role: 'beam',
          kind: 'frame',
        },
      ],
    }),
  );
  const map = memberMapFrom(model);
  assert.deepEqual(map.physical, { B1: ['B1'] });
  const result = analyzeStructure(model);
  const summary = summarize(model, map, result, { mode: 'preview' });
  assert.equal(summary.members.length, 1);
});
