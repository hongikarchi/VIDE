// S-06 frame jig ⑧ model + analysis steps (PLAN-23 T-053 drawn mode). Synthetic fixture only.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { structureModelSchema } from '../../src/contracts/structure-model.ts';
import {
  closeAnalysisWorker,
  mechanismIssues,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { checkSchema } from '../../src/jigs/runtime/schema.ts';
import { model, MODEL_ASSUMPTIONS } from '../../extensions/jigs/s06-frame/steps/model.ts';
import { analysis, confirmAnalysis } from '../../extensions/jigs/s06-frame/steps/analysis.ts';

const root = new URL('../../extensions/jigs/s06-frame/', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const fixture = json('fixtures/analysis-two-bay.json');
const schemas = {
  model: json('schemas/steps/model.json'),
  analysis: json('schemas/steps/analysis.json'),
};
const inputsOf = (f = fixture) => ({
  site: f.site,
  planterZones: f.planterZones,
  dryZones: f.dryZones,
  steps: f.steps,
});
const schemaOk = (name, value) => {
  const problems = checkSchema(schemas[name], value);
  assert.deepEqual(problems, [], JSON.stringify(problems));
};

after(() => closeAnalysisWorker());

test('model: drawn columns, girders (arc segmented), beams pinned, restraint, self-weight, combos', () => {
  const out = model(inputsOf(), fixture.params);
  schemaOk('model', out);
  assert.equal(out.summary.errors, 0, JSON.stringify(out.issues));
  assert.deepEqual(
    [out.summary.columns, out.summary.girders, out.summary.beams, out.summary.cantilevers],
    [6, 5, 4, 1],
  );
  const parsed = structureModelSchema.parse(out.model);
  // Columns reach the girder top-of-steel line (drawn to 5.5 m, girders at 6 m).
  for (const c of out.columns) assert.ok(Math.abs(c.top[2] - 6) < 1e-6, `${c.key} top ${c.top}`);
  // Restraint only at the six column nodes on the restraint level.
  const nodes = new Map(parsed.nodes.map((n) => [n.id, n]));
  const held = parsed.analysis.lateralRestraint.nodes;
  assert.equal(held.length, 6);
  for (const id of held) assert.ok(Math.abs(nodes.get(id).xyz_m[2] - 3) < 1e-6);
  // Self-weight in D; named combinations with the service 1.0D+1.0L and notional X/Y.
  assert.ok(parsed.loadPatterns.some((p) => p.nature === 'D' && p.selfWeight));
  const combos = new Map(parsed.combinations.map((c) => [c.id, c]));
  assert.deepEqual(
    [...combos.keys()].sort(),
    ['1.0D+1.0L', '1.2D+1.6L', '1.2D+1.6L+NX', '1.2D+1.6L+NY'].sort(),
  );
  assert.equal(combos.get('1.0D+1.0L').limitState, 'service');
  // The arc girder is split into pieces ≤ 1 m; straight girders only at joints.
  const pieces = out.map.physical['G:G4'];
  assert.ok(pieces.length >= 6, `arc pieces ${pieces.length}`);
  const members = new Map(parsed.members.map((m) => [m.id, m]));
  const len = (m) => {
    const a = nodes.get(m.i).xyz_m,
      b = nodes.get(m.j).xyz_m;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  for (const id of pieces) assert.ok(len(members.get(id)) <= 1.0 + 1e-6);
  // G1 runs over the middle column and meets two beams → split at those joints.
  assert.ok(out.map.physical['G:G1'].length >= 2);
  // Beams pinned at both ends; the edge cantilever is a cantilever from G5.
  for (const key of Object.keys(out.map.physical).filter((k) => k.startsWith('B:'))) {
    const segs = out.map.physical[key];
    assert.ok(members.get(segs[0]).releases?.i, `${key} i pinned`);
    assert.ok(members.get(segs[segs.length - 1]).releases?.j, `${key} j pinned`);
  }
  assert.equal(out.map.cantilever['A:E1'], 'j');
  // The cantilever hangs rigid from its root with a free tip; the pre-check finds no mechanism.
  for (const id of out.map.physical['A:E1']) assert.equal(members.get(id).releases, undefined, id);
  assert.deepEqual(
    mechanismIssues(parsed).filter((i) => i.level === 'error'),
    [],
  );
  // Assumptions the report lists.
  for (const text of [
    MODEL_ASSUMPTIONS.eccentricity,
    MODEL_ASSUMPTIONS.steel,
    MODEL_ASSUMPTIONS.restraint,
  ])
    assert.ok(out.assumptions.includes(text), text);
  // Loads: deck 3 kPa in K1, planter 12 kPa in K2, deck on the 2 m × 2 m cantilever strip, ceiling.
  const expectedD = 48 * 3 + 48 * 12 + 4 * 3 + 0.3 * 100;
  assert.ok(Math.abs(out.totals.D_kN - expectedD) / expectedD < 0.01, `D ${out.totals.D_kN}`);
  assert.ok(out.loads.some((l) => l.zone === 'planter'));
});

test('model: same inputs → same hash; a setting change → another hash', () => {
  const a = model(inputsOf(), fixture.params);
  const b = model(inputsOf(), fixture.params);
  assert.equal(a.modelHash, b.modelHash);
  const c = model(inputsOf(), { ...fixture.params, girderSection: 'H-500x200x10x16' });
  assert.notEqual(a.modelHash, c.modelHash);
});

test('model: an unsupported girder is an error; no restraint level is a listed assumption', () => {
  const f = structuredClone(fixture);
  f.steps.girders.girders.push({
    id: 'G9',
    points: [
      [30, 0, 6],
      [30, 6, 6],
    ],
    kind: 'line',
    supports: [],
  });
  const out = model(inputsOf(f), { restraintLevel: null });
  assert.ok(out.issues.some((i) => i.code === 'GIRDER_UNSUPPORTED' && i.level === 'error'));
  assert.ok(out.issues.some((i) => i.code === 'NO_RESTRAINT'));
  assert.ok(out.assumptions.includes(MODEL_ASSUMPTIONS.noRestraint));
});

test('analysis: preview only, labelled 미확정 미리보기; confirmAnalysis stores the confirmed result', async () => {
  const m = model(inputsOf(), fixture.params);
  const preview = await analysis({ steps: { model: m } });
  schemaOk('analysis', preview);
  assert.equal(preview.label, '미확정 미리보기');
  assert.ok(preview.preview, JSON.stringify(preview.error));
  assert.equal(preview.preview.status, 'ok', preview.preview.error);
  assert.equal(preview.preview.mode, 'preview');
  assert.equal(preview.confirmed, undefined);
  assert.deepEqual(
    preview.preview.combos.map((c) => c.id).sort(),
    ['1.0D+1.0L', '1.2D+1.6L', '1.2D+1.6L+NX', '1.2D+1.6L+NY'].sort(),
  );
  assert.ok(preview.summary.maxRatio > 0);
  assert.ok(preview.assumptions.includes(MODEL_ASSUMPTIONS.eccentricity));

  const now = '2026-09-30T00:00:00.000Z';
  const confirmed = await confirmAnalysis({ steps: { model: m, analysis: preview } }, { now });
  schemaOk('analysis', confirmed);
  assert.equal(confirmed.confirmed.result.mode, 'confirmed');
  assert.equal(confirmed.confirmed.at, now);
  assert.equal(confirmed.confirmed.modelHash, m.modelHash);
  assert.equal(confirmed.preview.mode, 'preview');

  // Rerun of the same model keeps the confirmation; a changed model reports it stale.
  const again = await analysis({ steps: { model: m, analysis: confirmed } });
  assert.equal(again.confirmed?.at, now);
  const changed = model(inputsOf(), { ...fixture.params, girderSection: 'H-500x200x10x16' });
  const stale = await analysis({ steps: { model: changed, analysis: confirmed } });
  assert.equal(stale.confirmed, undefined);
  assert.equal(stale.staleConfirmed.at, now);
});

test('analysis: a failing analyser gives an error, never a throw; errors block confirmation', async () => {
  const m = model(inputsOf(), fixture.params);
  const failing = async () => {
    throw Object.assign(new Error('no worker here'), { code: 'ERR_ACCESS_DENIED' });
  };
  const out = await analysis({ steps: { model: m } }, {}, [], { analyze: failing });
  assert.equal(out.preview, null);
  assert.equal(out.error.code, 'ERR_ACCESS_DENIED');
  assert.equal(out.summary.status, 'unavailable');

  const f = structuredClone(fixture);
  f.steps.girders.girders.push({
    id: 'G9',
    points: [
      [30, 0, 6],
      [30, 6, 6],
    ],
    kind: 'line',
  });
  const bad = model(inputsOf(f), fixture.params);
  const refused = await confirmAnalysis({ steps: { model: bad } });
  assert.equal(refused.confirmed, undefined);
  assert.ok(refused.error);
});

// T-053 real-data leftover: a cantilever off a girder mid-span is held only by girder torsion
// unless a beam continues it through the girder. `beams` gives the continuation (`rigidAt`) or a
// back span (`backspanOf`, landing on an infill beam with `beamId`); `model` keeps those ends rigid.
test('model: cantilevers continued through the girder are held in bending, not by torsion', async () => {
  const f = structuredClone(fixture);
  const b = f.steps.beams;
  // E1 on the line of K2-B2 (y = 2) through G5; E2 off G2 at x = 12 with a back span onto K2-B4.
  b.edgeCantilevers = [
    {
      id: 'E1',
      from: { girderId: 'G5', t: 1 / 3 },
      points: [
        [16, 2, 6],
        [18, 2, 6],
      ],
      length_m: 2,
      continues: 'K2-B2',
    },
    {
      id: 'E2',
      from: { girderId: 'G2', t: 0.75 },
      points: [
        [12, 6, 6],
        [12, 8, 6],
      ],
      length_m: 2,
      continues: 'K2-R01',
    },
  ];
  const plain = model(inputsOf(f), fixture.params);
  const torsion = (out) =>
    mechanismIssues(structureModelSchema.parse(out.model)).filter((i) => i.code === 'TORSION_ROOT');
  // Without the continuation both roots twist the girder: listed.
  assert.equal(torsion(plain).length, 2, JSON.stringify(torsion(plain)));

  b.beams.find((x) => x.id === 'K2-B2').rigidAt = ['to'];
  b.beams.push({
    id: 'K2-R01',
    cellId: 'K2',
    points: [
      [12, 6, 6],
      [12, 4, 6],
    ],
    from: { girderId: 'G2', t: 0.75 },
    to: { girderId: null, t: null, beamId: 'K2-B4' },
    length_m: 2,
    rigidAt: ['from'],
    backspanOf: 'E2',
  });
  const out = model(inputsOf(f), fixture.params);
  schemaOk('model', out);
  assert.equal(out.summary.errors, 0, JSON.stringify(out.issues));
  const parsed = structureModelSchema.parse(out.model);
  assert.deepEqual(torsion(out), []);
  const members = new Map(parsed.members.map((m) => [m.id, m]));
  const nodes = new Map(parsed.nodes.map((n) => [n.id, n.xyz_m]));
  const segs = (key) => out.map.physical[key].map((id) => members.get(id));
  // K2-B2: pinned on G4, rigid on G5 where E1 carries on.
  const b2 = segs('B:K2-B2');
  assert.ok(b2[0].releases?.i);
  assert.equal(b2[b2.length - 1].releases?.j, undefined);
  // The back span: rigid at the root on G2, pinned on K2-B4, which is split at that point.
  const r = segs('B:K2-R01');
  assert.equal(r[0].releases?.i, undefined);
  assert.ok(r[r.length - 1].releases?.j);
  const landing = r[r.length - 1].j;
  // On K2-B4's rail (which rises to the arched G4), at x = 12, y = 4 in plan.
  const at = nodes.get(landing);
  assert.deepEqual(at.slice(0, 2), [12, 4]);
  assert.ok(at[2] > 6 && at[2] < 6.3, `z ${at[2]}`);
  const b4 = segs('B:K2-B4');
  assert.equal(b4.length, 2);
  assert.ok(b4.some((m) => m.i === landing || m.j === landing));
  // The back span carries no cell strip (the infill beams already do).
  assert.ok(!out.loads.some((l) => l.memberKey === 'B:K2-R01' && l.source === 'area'));
  const a = await analysis({ steps: { model: out } });
  assert.equal(a.preview?.status, 'ok', JSON.stringify(a.error ?? a.preview?.issues));
});

// Review (wave 5): an edge cantilever carries the strip width `beams` gives it, not a fixed spacing.
test('model: an edge cantilever is loaded over its own strip width', () => {
  const base = model(inputsOf(), fixture.params);
  const f = structuredClone(fixture);
  for (const e of f.steps.beams.edgeCantilevers) e.width_m = 3;
  const wide = model(inputsOf(f), fixture.params);
  const lineD = (out) =>
    out.loads.filter((l) => l.memberKey.startsWith('A:') && l.case === 'D' && l.source === 'area');
  assert.ok(lineD(base).length > 0);
  for (const l of lineD(wide)) {
    const before = lineD(base).find((x) => x.memberKey === l.memberKey);
    close3(l.value_kNpm / before.value_kNpm, 3 / (fixture.steps.beams.summary?.spacingUsed_m ?? 2));
  }
});
function close3(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-3, `${actual} ≠ ${expected}`);
}

// Review (wave 5): a cantilever at a girder junction continues that girder through the edge
// girder; the girder end there is rigid (its back span), not pinned onto the edge girder's torsion.
test('model: a girder continued by an edge cantilever is rigid at that end', () => {
  const f = structuredClone(fixture);
  f.steps.girders.girders.push({
    id: 'G6',
    points: [
      [8, 3, 6.3],
      [16, 3, 6],
    ],
  });
  const endJ = (out) => {
    const parsed = structureModelSchema.parse(out.model);
    const members = new Map(parsed.members.map((m) => [m.id, m]));
    const segs = out.map.physical['G:G6'];
    return members.get(segs[segs.length - 1]).releases?.j;
  };
  const withArm = model(inputsOf(f), fixture.params);
  assert.equal(withArm.summary.errors, 0, JSON.stringify(withArm.issues));
  assert.equal(endJ(withArm), undefined, 'rigid where E1 carries G6 on');
  const torsion = mechanismIssues(structureModelSchema.parse(withArm.model)).filter(
    (i) => i.code === 'TORSION_ROOT',
  );
  assert.deepEqual(torsion, []);
  f.steps.beams.edgeCantilevers = [];
  assert.ok(endJ(model(inputsOf(f), fixture.params)), 'pinned without a cantilever');
});
