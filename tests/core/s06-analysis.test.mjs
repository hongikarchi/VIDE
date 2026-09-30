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
