import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadJig } from '../../src/jigs/runtime/loader.ts';
import { EngineRunner, MemoryCache, executeSteps } from '../../src/jigs/runtime/runner.ts';
import { initialParams } from '../../src/jigs/runtime/params.ts';
import { validateJig } from '../../src/jigs/runtime/pack.ts';
import { scopeOf, validatePanel } from '../../src/ui/jig-panel/spec.ts';
import { closeAnalysisWorker } from '../../src/jigs/official/structure-analysis/index.ts';
import { CASES, fixtureFiles } from '../../extensions/jigs/s06-frame/fixtures/cases.ts';

// S-06 frame jig 0.2, M2 drawn mode (PLAN-23 T-053, M2 머리말 2026-09-30) end to end on the
// synthetic `drawn-two-bay` case in the engine runner: the drawn girders are corrected (snapped,
// merged, cut over columns, a dangling end listed), cells and beams follow, the frame model carries
// the flat load settings, the analysis is a '미확정 미리보기' until a person confirms, and the
// proposed-layout branch stays empty unless `layoutSource` is 'proposed'.
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

test('the package and the panel declare the drawn chain with its settings, tabs and actions', async () => {
  const validation = await validateJig(JIG);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  const manifest = read('jig.json');
  const ids = manifest.steps.map((s) => s.id);
  for (const id of ['girders', 'cells', 'beams', 'model', 'analysis', 'confirmAnalysis'])
    assert.ok(ids.includes(id), id);
  assert.equal(manifest.params.find((p) => p.key === 'layoutSource').default, 'drawn');
  for (const key of ['snapTol_m', 'mergeTol_m', 'beamSpacing_m', 'beamDirection', 'restraintLevel'])
    assert.ok(
      manifest.params.some((p) => p.key === key),
      key,
    );
  assert.equal(manifest.steps.find((s) => s.id === 'confirmAnalysis').slot, 'confirm-analysis');
  const panel = validatePanel(read('panel.json'), scopeOf(manifest));
  assert.deepEqual(panel.issues, []);
  assert.deepEqual(
    panel.spec.drawer.tabs.slice(0, 4).map((t) => t.title),
    ['거더 보정 목록', '칸·작은보', '해석 요약', '참고 처짐'],
  );
  const ratio = panel.spec.center.kpis.items.find((k) => k.label === '최대 검정비');
  assert.equal(ratio.note, '미확정 미리보기');
  assert.ok(panel.spec.actions.some((a) => a.step === 'confirmAnalysis' && a.tier === 'T2'));
});

test('drawn-two-bay: girders corrected, cells and beams, model and preview analysis end to end', async () => {
  const report = await run('drawn-two-bay');
  const status = Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  for (const id of ['girders', 'cells', 'beams', 'model', 'analysis', 'analysisConfirmed'])
    assert.equal(status[id], 'done', id);
  assert.equal(report.blocked, false);
  const { girders, cells, beams, model, analysis, analysisConfirmed } = report.outputs;

  // Girders: two ends really moved (0.2 and 0.15 m), the duplicate merged, one dangling end.
  const moved = girders.girders.flatMap((g) => g.snapped).filter((s) => s.moved_m > 0.01);
  assert.deepEqual(moved.map((s) => s.moved_m).sort(), [0.15, 0.2]);
  assert.equal(girders.girders.filter((g) => g.mergedFrom?.length).length, 1);
  assert.equal(girders.dangling.length, 1);
  assert.equal(girders.danglingAt[0].at.length, 3);
  assert.ok(girders.girders.every((g) => typeof g.note === 'string' && g.note.length));
  assert.ok(girders.girders.some((g) => /끝 붙임/.test(g.note)));
  // The 16 m bottom girder is cut over the middle column: two 8 m spans, none over 12 m.
  assert.equal(girders.spans.filter((s) => Math.abs(s.planLength_m - 8) < 0.01).length >= 2, true);
  assert.equal(girders.summary.spansOver, 0);

  assert.equal(cells.cells.length, 2);
  assert.ok(cells.cells.every((c) => Math.abs(c.area_m2 - 56) < 0.5));
  assert.equal(beams.summary.beams, 4);
  // Parallel to each cell's longest edge (8 m).
  assert.ok(beams.beams.every((b) => Math.abs(b.length_m - 8) < 0.3));

  // Model: restraint at EL 3 (setting), planter loads on the left bay, SM355 assumption listed.
  assert.equal(model.issues.filter((i) => i.level === 'error').length, 0);
  assert.equal(model.params.restraintLevel, 3);
  assert.ok(model.loads.some((l) => l.zone === 'planter'));
  assert.ok(model.assumptions.some((a) => /SM355/.test(a)));

  // Preview: labelled, not confirmed; the rows the panel shows are sorted by ratio.
  assert.equal(analysis.label, '미확정 미리보기');
  assert.equal(analysis.preview.mode, 'preview');
  assert.equal(analysis.summary.status, 'ok');
  assert.equal(analysis.summary.confirmed, false);
  assert.ok(Number.isFinite(analysis.summary.maxRatio) && analysis.summary.maxRatio > 0);
  assert.ok(analysis.summary.steel_t > 0);
  assert.equal(analysis.rows[0].ratio, Number(analysis.summary.maxRatio.toFixed(3)));
  assert.ok(analysis.rows.every((r) => /통과|주의|초과|미완|오류/.test(r.judgement)));
  assert.ok(analysis.deflections.length > 0);
  // The confirmed run (after the human step) stores its result with the model hash.
  assert.equal(analysisConfirmed.confirmed.result.mode, 'confirmed');
  assert.equal(analysisConfirmed.confirmed.modelHash, model.modelHash);
  assert.equal(analysisConfirmed.summary.confirmed, true);

  // Drawn mode: the proposed-layout branch is empty and says why.
  assert.equal(report.outputs.axes.skipped, true);
  assert.equal(report.outputs.columns.count, 0);
  assert.ok(report.outputs.interference.skipped);
});

test('a real run waits at 해석 확정: the preview is there, the confirmed run is not', async () => {
  const report = await run('drawn-two-bay', {}, 'confirmed', {});
  const status = Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
  assert.equal(status.analysis, 'done');
  assert.equal(status.confirmAnalysis, 'waiting');
  assert.equal(status.analysisConfirmed, 'blocked');
  assert.equal(report.blocked, false);
  assert.equal(report.outputs.analysis.summary.confirmed, false);
});

test('settings reach the steps: loads, cantilever limit, beam pitch and the layout source', async () => {
  const base = await run('drawn-two-bay');
  const heavy = await run('drawn-two-bay', { planterD: 20 });
  assert.ok(heavy.outputs.model.totals.D_kN > base.outputs.model.totals.D_kN);
  const off = await run('drawn-two-bay', { restraintOn: false });
  assert.equal(off.outputs.model.params.restraintLevel, null);
  const tight = await run('drawn-two-bay', { cantileverMax: 0.5 });
  assert.ok(tight.outputs.beams.edgeCantilevers.length > 0);
  const dense = await run('drawn-two-bay', { beamSpacing_m: 2.0 });
  assert.ok(dense.outputs.beams.summary.beams > base.outputs.beams.summary.beams);
  const proposed = await run('drawn-two-bay', { layoutSource: 'proposed' });
  assert.equal(proposed.outputs.axes.skipped, undefined);
  assert.ok(proposed.outputs.axes.axes.length > 0);
});
