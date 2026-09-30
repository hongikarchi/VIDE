import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrameModel,
  hProps,
  ksCandidates,
  runAnalysis,
  sectionProps,
  sizeGroups,
  spanBand,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { hId, KS_H } from '../../src/jigs/structure/sections.ts';
import { bayPlan, gridPlan } from './frame-fixtures.mjs';

// Section sizing over KS H (SPEC-06.12, PLAN-23 T-054): every candidate under the depth limit is
// compared, the lightest that meets the target is taken, '후보 없음' is never replaced by the
// heaviest section, and the loop converges within six analyses. Analyses run synchronously here
// (runAnalysis) so the tests need no worker thread.

const near = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= rel * Math.abs(expected),
    `${what}: ${actual} vs ${expected}`,
  );
const sync = (model, map, options) => runAnalysis(model, map, options);

test('hProps mirrors the core and the KS D 3502 table (A, I, S, unit weight within 1 %)', () => {
  const p = hProps({ h: 400, b: 200, tw: 8, tf: 13, r: 16 });
  near(p.A_mm2 / 1e2, 84.12, 0.01, 'A');
  near(p.I3_mm4 / 1e4, 23700, 0.01, 'I3');
  near(p.I2_mm4 / 1e4, 1740, 0.01, 'I2');
  near(p.S3_mm3 / 1e3, 1190, 0.01, 'S3');
  near(p.weight_kgpm, 66.0, 0.01, 'unit weight');
  const c = hProps({ h: 300, b: 300, tw: 10, tf: 15, r: 18 });
  near(c.A_mm2 / 1e2, 119.8, 0.01, 'A');
  near(c.weight_kgpm, 94.0, 0.01, 'unit weight');
  // Explicit props win, missing moduli come from the dimensions.
  const given = sectionProps({
    shape: 'H',
    dims_mm: { h: 400, b: 200, tw: 8, tf: 13, r: 16 },
    props: { A_mm2: 8412, I2_mm4: 1.74e7, I3_mm4: 2.37e8, J_mm4: 3.56e5 },
  });
  assert.equal(given.A_mm2, 8412);
  near(given.Z3_mm3 / 1e3, 1330, 0.02, 'Z3 from dims');
  assert.equal(sectionProps({ shape: 'L', dims_mm: { a: 90 } }), undefined);
});

test('candidate tables: depth limit, lightest first, columns from the wide-flange series', () => {
  const beams = ksCandidates('beam', 900);
  assert.equal(beams.length, KS_H.length, 'every rolled H fits under 900');
  for (let k = 1; k < beams.length; k++)
    assert.ok(hProps(beams[k - 1]).weight_kgpm <= hProps(beams[k]).weight_kgpm, 'weight order');
  assert.ok(ksCandidates('girder', 400).every((s) => s.h <= 400));
  const columns = ksCandidates('column', 400);
  assert.ok(columns.length >= 9 && columns.every((s) => s.b / s.h >= 0.9 && s.h <= 400));
  assert.deepEqual(
    [3, 6, 7.5, 12, 13].map((l) => spanBand(l, [6, 9, 12])),
    ['≤6 m', '≤6 m', '6–9 m', '9–12 m', '>12 m'],
  );
});

test('a bay converges within six analyses to the lightest sections that meet the target', async () => {
  const { model, map, assumptions } = buildFrameModel(bayPlan());
  const started = performance.now();
  const result = await sizeGroups(model, map, { assumptions, key: 'bay' }, sync);
  const elapsed = performance.now() - started;
  assert.equal(result.status, 'converged', JSON.stringify(result.issues));
  assert.ok(result.iterations <= 6, `${result.iterations} analyses`);
  assert.ok(elapsed <= 1000, `sizing took ${elapsed.toFixed(0)} ms`);
  assert.equal(result.mode, 'preview');
  assert.equal(result.label, '미확정 미리보기');
  assert.ok(result.summary, 'the converged proposal was analysed');
  assert.equal(result.summary.mode, 'preview');
  assert.deepEqual(result.groups.map((g) => g.id).sort(), [
    'beam|≤6 m',
    'column|≤6 m',
    'girder|6–9 m',
  ]);
  for (const g of result.groups) {
    assert.equal(g.status, 'ok', `${g.id}: ${g.status}`);
    assert.ok(g.section && g.name, `${g.id} has a section`);
    assert.ok(g.ratio !== null && g.ratio <= 0.9 + 1e-6, `${g.id} ratio ${g.ratio}`);
    assert.ok(g.deflectionRatio === null || g.deflectionRatio <= 1 + 1e-6);
    assert.ok(g.history.length === result.iterations, 'one history entry per analysis');
    assert.equal(g.history[g.history.length - 1].section, g.section, 'last analysed = chosen');
    assert.ok(g.candidates > 0);
    // The proposal carries the section on every segment of every member of the group.
    for (const id of g.members) {
      assert.equal(result.assignments[id], g.section);
      for (const seg of map.physical[id])
        assert.equal(result.model.members.find((m) => m.id === seg).section, g.section);
    }
    // Every candidate was compared: the next lighter one fails the target or the deflection limit.
    const table = ksCandidates(g.role).map(hId);
    const k = table.indexOf(g.section);
    assert.ok(k >= 0, `${g.section} is a candidate`);
    if (k > 0) {
      const lighter = ksCandidates(g.role)[k - 1];
      const trial = structuredClone(result.model);
      if (!trial.sections.some((s) => s.id === hId(lighter)))
        trial.sections.push({
          id: hId(lighter),
          name: hId(lighter),
          shape: 'H',
          dims_mm: { ...lighter },
          source: 'KS D 3502',
        });
      const segments = new Set(g.members.flatMap((id) => map.physical[id]));
      for (const m of trial.members) if (segments.has(m.id)) m.section = hId(lighter);
      const { summary } = runAnalysis(trial, map, { mode: 'preview' });
      const rows = summary.members.filter((r) => g.members.includes(r[0]));
      const ratio = Math.max(...rows.map((r) => r[2] ?? 0));
      const deflection = Math.max(...rows.map((r) => (r[4] !== null && r[5] ? r[4] / r[5] : 0)));
      assert.ok(
        ratio > 0.9 || deflection > 1,
        `${g.id}: lighter ${hId(lighter)} would pass (ratio ${ratio.toFixed(3)}, deflection ${deflection.toFixed(3)})`,
      );
    }
  }
  // Unused sections are dropped from the proposal; the chosen ones are KS sections with a note.
  const used = new Set(result.model.members.map((m) => m.section));
  assert.ok(result.model.sections.every((s) => used.has(s.id)));
  for (const g of result.groups) {
    const s = result.model.sections.find((x) => x.id === g.section);
    assert.equal(s.source, 'KS D 3502');
    assert.equal(s.name, g.name);
  }
  assert.ok(result.note.includes('다시 확정'));
  assert.ok(result.assumptions.some((a) => a.includes('목표 검정비 0.9')));
  console.log(
    `sizing ${result.iterations} analyses · ${elapsed.toFixed(0)} ms · ` +
      result.groups.map((g) => `${g.id} ${g.from.join('+')} → ${g.name} (${g.ratio})`).join(' · '),
  );
});

test("'후보 없음' keeps the section, names the depth needed and never picks the heaviest silently", async () => {
  const plan = bayPlan();
  // Heavier deck loads with a 250 mm depth limit for girders: nothing under the limit can carry it.
  plan.lineLoads = plan.lineLoads.map((l) => ({ ...l, value_kNpm: l.value_kNpm * 4 }));
  const { model, map } = buildFrameModel(plan);
  const result = await sizeGroups(
    model,
    map,
    { depthMax_mm: { girder: 250 }, roles: ['girder', 'beam'] },
    sync,
  );
  const girders = result.groups.find((g) => g.role === 'girder');
  assert.equal(girders.status, 'no-candidate');
  assert.equal(girders.section, null);
  assert.ok(girders.beyondLimit && girders.beyondLimit.h_mm > 250, 'depth beyond the limit named');
  assert.ok(
    result.issues.some((i) => i.code === 'SIZING_NO_CANDIDATE' && i.message.includes('후보 없음')),
  );
  // The girders keep the section they started with (H500), no heavier candidate slipped in.
  for (const id of girders.members)
    for (const seg of map.physical[id])
      assert.equal(result.model.members.find((m) => m.id === seg).section, 'H500');
  // Beams (no limit change) were still sized.
  const beams = result.groups.find((g) => g.role === 'beam');
  assert.equal(beams.status, 'ok');
  assert.equal(result.status, 'converged');
});

test('the reference deflection sizes a split girder up although its segments pass', async () => {
  // 12 m pinned girders braced by three secondary beams: every 3 m segment is stiff and short, but
  // the chord over the whole span (A8 reference deflection) is what limits the section.
  const plan = bayPlan();
  plan.columns = plan.columns.map((c) =>
    c.key.startsWith('C-9') ? { ...c, base: [12, c.base[1], 0], top: [12, c.top[1], 6] } : c,
  );
  plan.members = plan.members.map((m) =>
    m.role === 'girder'
      ? {
          ...m,
          rail: [
            [0, m.rail[0][1], 6],
            [12, m.rail[1][1], 6],
          ],
          ends: ['pinned', 'pinned'],
          bracedAt: [0.25, 0.5, 0.75],
        }
      : { ...m, rail: m.rail.map((p) => [p[0] * 1.2, p[1], p[2]]) },
  );
  const { model, map, issues } = buildFrameModel(plan);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  const result = await sizeGroups(model, map, { roles: ['girder'] }, sync);
  assert.equal(result.status, 'converged', JSON.stringify(result.issues));
  const girders = result.groups.find((g) => g.role === 'girder');
  assert.equal(girders.status, 'ok');
  assert.ok(girders.deflectionRatio <= 1 + 1e-6, `deflection ratio ${girders.deflectionRatio}`);
  assert.ok(girders.ratio <= 0.9 + 1e-6);
  const chosen = KS_H.find((s) => hId(s) === girders.section);
  // The same loop with the reference-deflection criterion relaxed picks a lighter section whose
  // chord deflection breaks L/360: the reference deflection, not strength, set the size above.
  const loose = await sizeGroups(model, map, { roles: ['girder'], deflectionTarget: 10 }, sync);
  const looseGirders = loose.groups.find((g) => g.role === 'girder');
  assert.equal(looseGirders.status, 'ok');
  assert.ok(
    hProps(KS_H.find((s) => hId(s) === looseGirders.section)).weight_kgpm <
      hProps(chosen).weight_kgpm,
    `${looseGirders.name} lighter than ${girders.name}`,
  );
  assert.ok(looseGirders.ratio <= 0.9 + 1e-6, 'strength alone passes');
  assert.ok(looseGirders.deflectionRatio > 1, `loose deflection ${looseGirders.deflectionRatio}`);
});

test('an iteration cap below convergence reports 수렴 안 됨 and takes the heavier of the last two', async () => {
  const { model, map } = buildFrameModel(bayPlan());
  const result = await sizeGroups(model, map, { maxIterations: 1 }, sync);
  assert.equal(result.iterations, 1);
  assert.ok(['converged', 'not-converged'].includes(result.status));
  if (result.status === 'not-converged') {
    assert.ok(result.issues.some((i) => i.code === 'SIZING_NOT_CONVERGED'));
    assert.equal(result.summary, undefined, 'the final proposal was not analysed');
    for (const g of result.groups.filter((x) => x.status === 'not-converged')) {
      const weight = (id) =>
        hProps(KS_H.find((s) => hId(s) === id) ?? { h: 1, b: 1, tw: 1, tf: 1 });
      const last = g.history[g.history.length - 1].section;
      const lastWeight = KS_H.some((s) => hId(s) === last) ? weight(last).weight_kgpm : 0;
      assert.ok(weight(g.section).weight_kgpm >= lastWeight, `${g.id}: heavier of the last two`);
    }
  }
});

test('a model with check errors stops sizing with an error issue instead of a proposal', async () => {
  const { model, map } = buildFrameModel(bayPlan());
  const broken = { ...model, nodes: model.nodes.map((n) => ({ id: n.id, xyz_m: n.xyz_m })) };
  const result = await sizeGroups(broken, map, {}, sync);
  assert.equal(result.status, 'error');
  assert.ok(result.issues.some((i) => i.code === 'SIZING_ANALYSIS'));
  assert.ok(result.groups.every((g) => g.status === 'unchanged' && g.section === null));
});

test("'후보 없음' after a failed candidate returns the group to its starting section", async () => {
  const { model, map } = buildFrameModel(bayPlan());
  const girderIds = new Set(Object.keys(map.physical).filter((id) => map.roles[id] === 'girder'));
  // Every candidate the girders take does ten times worse than the estimate expects: each one
  // fails when analysed and leaves nothing that fits, so the group ends '후보 없음'.
  const worse = (m, mapArg, options) => {
    const outcome = runAnalysis(m, mapArg, options);
    const sectionOf = new Map(m.members.map((x) => [x.id, x.section]));
    for (const row of outcome.summary.members ?? [])
      if (girderIds.has(row[0]) && sectionOf.get(map.physical[row[0]][0]) !== 'H500')
        row[2] = row[2] === null ? null : row[2] * 10;
    return outcome;
  };
  const result = await sizeGroups(model, map, { roles: ['girder'] }, worse);
  const girders = result.groups.find((g) => g.role === 'girder');
  assert.ok(girders.history.length > 1, JSON.stringify(girders.history));
  assert.equal(girders.status, 'no-candidate');
  for (const id of girders.members)
    for (const seg of map.physical[id])
      assert.equal(result.model.members.find((m) => m.id === seg).section, 'H500');
  assert.equal(result.assignments[girders.members[0]], 'H500');
});
