import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { validateJig } from '../../src/jigs/runtime/pack.ts';
import { scopeOf, validatePanel } from '../../src/ui/jig-panel/spec.ts';
import { extractItems } from '../../src/jigs/bake/plan.ts';
import { bakeDeclsOf } from '../../src/jigs/bake/builtin.ts';
import { closeAnalysisWorker } from '../../src/jigs/official/structure-analysis/index.ts';
import { CASES, fixtureFiles } from '../../extensions/jigs/s06-frame/fixtures/cases.ts';
import { bakeMembers } from '../../extensions/jigs/s06-frame/steps/bakeplan.ts';

// S-06 frame jig 0.3, M3 (PLAN-23 T-056): ⑨ sizing → ⑪ schedule → ⑩ heights → ⑫ bake plan wired
// into the package and run end to end on the synthetic `drawn-two-bay` case in the engine runner.
// Sizing runs on the preview (previewOnly), the lines bake reads step 'bakePlan', and the members
// bakes read step 'bakeMembers', which the runner reaches only after [해석 확정] and which offers
// members only when the confirmed model carries the planned sections (SPEC-06.12).
const JIG = join(import.meta.dirname, '..', '..', 'extensions', 'jigs', 's06-frame');
const read = (file) => JSON.parse(readFileSync(join(JIG, file), 'utf8'));
const files = (name) => fixtureFiles(CASES.find((c) => c.name === name));

after(() => closeAnalysisWorker());

async function run(name, overrides = {}, mode = 'selftest', confirmations) {
  const jig = await loadJig(JIG);
  const { input, params } = files(name);
  const values = { ...params, ...overrides };
  const all = Object.fromEntries(
    Object.entries(initialParams(jig.manifest)).map(([key, value]) => [
      key,
      values[key] !== undefined ? { ...value, value: values[key] } : value,
    ]),
  );
  return executeSteps({
    jig,
    runner: new EngineRunner(),
    cache: new MemoryCache(),
    mode,
    inputs: input,
    params: all,
    confirmations,
  });
}

test('the package declares the M3 chain, its settings, bakes and panel tabs', async () => {
  const validation = await validateJig(JIG);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  const manifest = read('jig.json');
  const ids = manifest.steps.map((s) => s.id);
  for (const id of ['sizing', 'schedule', 'heights', 'bakePlan', 'bakeMembers'])
    assert.ok(ids.indexOf(id) > ids.indexOf('analysis'), id);
  const step = (id) => manifest.steps.find((s) => s.id === id);
  // Sizing runs on the preview; only the members plan waits for the confirmed analysis.
  assert.ok(step('sizing').reads.includes('step.analysis'));
  assert.ok(!step('sizing').reads.some((r) => r.includes('analysisConfirmed')));
  assert.ok(!step('bakePlan').reads.some((r) => r.includes('analysisConfirmed')));
  assert.ok(step('bakeMembers').needs.includes('analysisConfirmed'));
  for (const key of ['depthMax', 'targetRatio', 'steelGrade'])
    assert.ok(step('sizing').reads.includes(`param.${key}`), key);
  assert.ok(step('heights').reads.includes('param.heightStep'));
  assert.equal(manifest.params.find((p) => p.key === 'targetRatio').default, 0.9);
  assert.ok(manifest.capabilities.some((c) => c.name === 'host.bake'));

  const bakes = Object.fromEntries(manifest.bake.map((b) => [b.id, b]));
  assert.equal(bakes.lines.items, 'step.bakePlan.lines');
  assert.equal(bakes.lines.requires, undefined);
  for (const id of ['members', 'member-columns']) {
    assert.equal(bakes[id].items, 'step.bakeMembers.members');
    assert.deepEqual(bakes[id].requires, ['analysis-confirmed']);
  }
  // The jig's own declarations shadow VIDE's built-in bakes of the same ids.
  const offered = bakeDeclsOf({ source: 'dev-source', manifest });
  assert.deepEqual(
    offered.map((b) => [b.id, b.items]),
    manifest.bake.map((b) => [b.id, b.items]),
  );

  const panel = validatePanel(read('panel.json'), scopeOf(manifest));
  assert.deepEqual(panel.issues, []);
  const tabs = panel.spec.drawer.tabs;
  assert.deepEqual(
    tabs.slice(4).map((t) => t.title),
    ['단면', '일람표', '높이', '만들기'],
  );
  const schedule = tabs.find((t) => t.title === '일람표');
  assert.equal(schedule.part, 'schedule');
  assert.equal(schedule.from, 'step.schedule.rows');
  assert.equal(schedule.csv, '부재일람표');
  const steel = panel.spec.center.kpis.items.find((k) => k.label === '강재');
  assert.equal(steel.from, 'step.schedule.totals.t');
  assert.equal(steel.unit, 't');
  const card = panel.spec.left.find((p) => p.part === 'bake-card');
  assert.deepEqual(card.bake, ['lines', 'members', 'member-columns']);
});

test('drawn-two-bay: sizing on the preview, schedule, floored heights and the bake plan', async () => {
  const report = await run('drawn-two-bay');
  const status = Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  for (const id of ['sizing', 'schedule', 'heights', 'bakePlan', 'bakeMembers'])
    assert.equal(status[id], 'done', id);
  const { model, sizing, schedule, heights, bakePlan, bakeMembers: members } = report.outputs;

  // ⑨ Sizing: the step 'analysis' preview is the first iteration, so the result stays a preview.
  assert.equal(sizing.schema, 'vide.s06.sizing/1');
  assert.equal(sizing.basis, 'preview');
  assert.equal(sizing.previewOnly, true);
  assert.equal(sizing.status, 'converged');
  assert.equal(sizing.summary.groups, 5);
  assert.ok(sizing.groups.every((g) => g.status === 'ok' && g.maxRatio <= 0.9 + 1e-9));
  assert.ok(sizing.groups.every((g) => /^(기둥|거더|테두리보|작은보)$/.test(g.roleLabel)));
  for (const g of sizing.groups) {
    const s = sizing.sectionsById[g.sectionId];
    assert.ok(s && s.kgpm > 0, g.id);
    if (g.role !== 'column') assert.ok(s.h_mm <= 900, g.id);
  }

  // ⑪ Schedule: every design member once, marks with the prefix, totals = rows, a preview label.
  const designed = Object.keys(model.map.physical).filter((id) =>
    ['column', 'girder', 'beam'].includes(model.map.roles[id]),
  );
  assert.equal(schedule.marks.length, designed.length);
  assert.equal(schedule.totals.count, 16);
  assert.ok(schedule.marks.every((m) => /^S06-S[A-Z]+\d+$/.test(m.mark)));
  const sum = schedule.rows.reduce((s, r) => s + r.t, 0);
  assert.ok(Math.abs(sum - schedule.totals.t) < 0.01);
  assert.equal(schedule.label, '미확정 미리보기');
  assert.match(schedule.csv, /S06-SC1/);

  // ⑩ Heights (height-floor): whole metres under the deepest girder, the steel never in the slab.
  assert.equal(heights.summary.columns, 6);
  for (const row of heights.rows) {
    assert.ok(Math.abs(row.length_m - Math.round(row.length_m)) < 1e-9, row.columnId);
    assert.ok(row.topZ <= row.girderBottomZ + 1e-9, row.columnId);
    assert.ok(row.gap_m >= 0 && row.gap_m < 1, row.columnId);
    assert.equal(row.depthFrom, 'sizing');
  }

  // ⑫ Bake plan: top lines for every column, girder and beam; members with marks and sections.
  assert.equal(bakePlan.summary.lines, 16);
  assert.equal(bakePlan.summary.members, 16);
  assert.equal(bakePlan.previewOnly, true);
  assert.ok(bakePlan.lines.every((l) => l.layer === 'jig 상단선'));
  assert.ok(bakePlan.members.every((m) => m.mark && m.webVertical === true));
  // Column members stand on the floored heights.
  const col = bakePlan.members.find((m) => m.role === 'column');
  const h = heights.rows.find((r) => `column:${r.sourceId}` === col.key);
  assert.equal(col.points[1][2], h.topZ);

  // The lines bake takes the plan; members from the preview plan are refused.
  const manifest = read('jig.json');
  const decl = (id) => manifest.bake.find((b) => b.id === id);
  const lines = extractItems(decl('lines'), bakePlan);
  assert.deepEqual(lines.problems, []);
  assert.equal(lines.items.length, 16);
  // After the (selftest) confirmation the members plan exists, but the sizing changed sections
  // the confirmed model did not carry: still a preview until they are applied and confirmed again.
  assert.equal(members.previewOnly, true);
  assert.equal(members.lines.length, 0);
  assert.match(members.notes.at(-1), /다시 확정/);
  const refused = extractItems(decl('members'), members);
  assert.ok(refused.problems.some((p) => /미확정 미리보기/.test(p)));
});

test('a real run waits at 해석 확정: sizing to the lines plan run, the members plan does not', async () => {
  const report = await run('drawn-two-bay', {}, 'confirmed', {});
  const status = Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  assert.equal(status.confirmAnalysis, 'waiting');
  for (const id of ['sizing', 'schedule', 'heights', 'bakePlan']) assert.equal(status[id], 'done');
  assert.equal(status.bakeMembers, 'blocked');
  assert.equal(report.blocked, false);
});

test('bakeMembers offers members only for the confirmed model with the same sections', async () => {
  const report = await run('drawn-two-bay');
  const { model, bakePlan, analysisConfirmed } = report.outputs;
  const sectionOf = new Map(model.model.members.map((m) => [m.id, m.section]));
  const same = {
    ...bakePlan,
    members: bakePlan.members.map((m) => ({
      ...m,
      sectionId: sectionOf.get(model.map.physical[m.memberId][0]),
    })),
  };
  const ok = bakeMembers({ steps: { bakePlan: same, model, analysisConfirmed } });
  assert.equal(ok.previewOnly, false);
  const manifest = read('jig.json');
  for (const id of ['members', 'member-columns']) {
    const result = extractItems(
      manifest.bake.find((b) => b.id === id),
      ok,
    );
    assert.deepEqual(result.problems, [], id);
    assert.ok(result.items.length > 0, id);
  }
  // Another model's confirmation, or none, keeps the plan a preview.
  const stale = bakeMembers({
    steps: { bakePlan: same, model, analysisConfirmed: { confirmed: { modelHash: 'other' } } },
  });
  assert.equal(stale.previewOnly, true);
  assert.equal(bakeMembers({ steps: { bakePlan: same, model } }).previewOnly, true);
});

test('recomputing keeps marks and bake keys; a changed setting reaches sizing and heights', async () => {
  // Fresh caches: both runs compute every step.
  const first = await run('drawn-two-bay');
  const again = await run('drawn-two-bay');
  assert.deepEqual(again.outputs.schedule.marks, first.outputs.schedule.marks);
  assert.deepEqual(
    again.outputs.bakePlan.lines.map((l) => l.key),
    first.outputs.bakePlan.lines.map((l) => l.key),
  );
  const shallow = await run('drawn-two-bay', { depthMax: 0.6, heightStep: 0.5 });
  const { sizing, heights } = shallow.outputs;
  for (const g of sizing.groups)
    if (g.role !== 'column' && g.status === 'ok')
      assert.ok(sizing.sectionsById[g.sectionId].h_mm <= 600, g.id);
  assert.equal(heights.summary.heightStep, 0.5);
  for (const row of heights.rows)
    assert.ok(Math.abs(row.length_m * 2 - Math.round(row.length_m * 2)) < 1e-9);
});
