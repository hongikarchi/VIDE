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

/** A cache that also keeps each step's last result, as the runtime does with `jig_runs`. */
class KeptCache extends MemoryCache {
  last = new Map();
  async put(stepId, hash, output) {
    this.last.set(stepId, { inputHash: hash, output });
    return super.put(stepId, hash, output);
  }
  async previous(stepId) {
    return this.last.get(stepId) ?? null;
  }
}

async function run(name, overrides = {}, mode = 'selftest', confirmations, extra = {}) {
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
    ...extra,
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
    tabs.slice(4, 8).map((t) => t.title),
    ['단면', '일람표', '높이', '만들기'],
  );
  // The drawer holds 12 tabs, so the four layout proposal tabs are back.
  assert.deepEqual(
    tabs.slice(8).map((t) => t.title),
    ['간섭 · 제안', '배치 대안 · 제안', '확인 목록', '입력 조립'],
  );
  assert.ok(
    panel.spec.actions.some(
      (a) => a.id === 'apply-sections' && a.step === 'applySections' && a.tier === 'T2',
    ),
  );
  // 선정 단면 적용: a person confirms, then the action step writes the sections (SPEC-06.12).
  assert.equal(step('applySections').kind, 'human');
  assert.deepEqual(step('applySections').blocks, ['sectionsApplied']);
  assert.equal(step('sectionsApplied').entry, 'steps/apply-sections.ts#applySections');
  // The schedule reads its own previous output: the marks ledger (ARCH-03 §6.2).
  assert.ok(step('schedule').reads.includes('step.schedule'));
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

test('선정 단면 적용: confirm → overrides → the confirmed analysis waits again → members bake', async () => {
  const st = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.status]));
  const hash = (r, id) => r.steps.find((s) => s.id === id).inputHash;
  const first = await run('drawn-two-bay', {}, 'confirmed', {});
  assert.equal(st(first).applySections, 'waiting');
  assert.equal(st(first).sectionsApplied, 'blocked');
  assert.deepEqual(first.applies, []);

  // The person confirms the analysis and the application of the chosen sections.
  const confirmed = {
    confirmAnalysis: hash(first, 'confirmAnalysis'),
    applySections: hash(first, 'applySections'),
  };
  const applying = await run('drawn-two-bay', {}, 'confirmed', confirmed);
  const applied = applying.outputs.sectionsApplied;
  assert.equal(applied.schema, 'vide.s06.applySections/1');
  assert.equal(applied.summary.changed, 16);
  assert.equal(applying.applies.length, 1);
  assert.equal(applying.applies[0].stepId, 'sectionsApplied');
  const overrides = applying.applies[0].overrides;
  assert.equal(overrides.length, 16);
  assert.ok(overrides.every((o) => o.id === `s06-section:${o.target.identity.key}`));
  // The members plan still refuses: the sections were chosen on a preview.
  assert.equal(applying.outputs.bakeMembers.previewOnly, true);

  // Written into the instance, the sections change the model: both confirmations wait again.
  const written = overrides.map((o) => ({ ...o, at: '2026-09-30T00:00:00Z' }));
  const after = await run('drawn-two-bay', {}, 'confirmed', confirmed, { overrides: written });
  assert.notEqual(after.outputs.model.modelHash, applying.outputs.model.modelHash);
  assert.equal(st(after).confirmAnalysis, 'reconfirm');
  assert.equal(st(after).analysisConfirmed, 'blocked');
  assert.equal(st(after).bakeMembers, 'blocked');
  assert.equal(st(after).applySections, 'reconfirm');
  assert.deepEqual(after.applies, []);
  const sectionOf = new Map(after.outputs.model.model.members.map((m) => [m.id, m.section]));
  for (const g of applying.outputs.sizing.groups)
    for (const id of g.memberIds)
      for (const seg of after.outputs.model.map.physical[id])
        assert.equal(sectionOf.get(seg), g.sectionId, id);

  // Confirmed again: the members plan offers members with the applied sections.
  const again = await run(
    'drawn-two-bay',
    {},
    'confirmed',
    {
      confirmAnalysis: hash(after, 'confirmAnalysis'),
    },
    { overrides: written },
  );
  assert.equal(st(again).analysisConfirmed, 'done');
  assert.equal(again.outputs.bakeMembers.previewOnly, false);
  assert.ok(again.outputs.bakeMembers.members.length > 0);
  // The schedule and the bake plan use the applied sections.
  const names = new Map(
    Object.entries(again.outputs.sizing.sectionsById).map(([id, s]) => [id, s.name]),
  );
  for (const m of again.outputs.bakePlan.members)
    assert.equal(
      sectionOf.get(again.outputs.model.map.physical[m.memberId][0]),
      m.sectionId,
      m.key,
    );
  assert.ok(again.outputs.schedule.rows.every((r) => [...names.values()].includes(r.section)));
});

test('applySections leaves 후보 없음 groups and already applied members alone', async () => {
  const { applySections } = await import('../../extensions/jigs/s06-frame/steps/apply-sections.ts');
  const report = await run('drawn-two-bay');
  const { sizing, model } = report.outputs;
  const [kept, ...rest] = sizing.groups;
  const partial = {
    ...sizing,
    groups: [{ ...kept, status: 'no-candidate', judgement: '후보 없음' }, ...rest],
  };
  const out = applySections({ steps: { sizing: partial, model } });
  assert.equal(out.groups[0].kept, '후보 없음');
  assert.equal(out.summary.kept, 1);
  assert.ok(out.apply.overrides.every((o) => !kept.memberIds.includes(o.target.identity.key)));
  // A model that already carries every chosen section asks for nothing.
  const written = out.apply.overrides.map((o) => ({ ...o, at: 'x' }));
  const all = applySections({ steps: { sizing, model } }).apply.overrides.map((o) => ({
    ...o,
    at: 'x',
  }));
  const redone = await run('drawn-two-bay', {}, 'selftest', undefined, { overrides: all });
  const none = applySections({ steps: { sizing, model: redone.outputs.model } });
  assert.equal(none.summary.changed, 0);
  assert.deepEqual(none.apply.overrides, []);
  assert.ok(written.length < all.length);
});

test('the marks ledger carries over: numbers continue after a change instead of restarting', async () => {
  const cache = new KeptCache();
  const first = await run('drawn-two-bay', {}, 'selftest', undefined, { cache });
  const changed = await run('drawn-two-bay', { depthMax: 0.5 }, 'selftest', undefined, { cache });
  const fresh = await run('drawn-two-bay', { depthMax: 0.5 });
  const next = (r) => r.outputs.schedule.ledger.next;
  // Numbers are never reused: a new girder group gets the next number after the old ones.
  for (const [prefix, n] of Object.entries(next(first)))
    assert.ok(next(changed)[prefix] >= n, prefix);
  assert.ok(next(changed).SG > next(fresh).SG);
  // Members whose group did not change keep their mark.
  const before = new Map(first.outputs.schedule.marks.map((m) => [m.memberId, m.mark]));
  const beams = changed.outputs.schedule.marks.filter((m) => m.memberId.startsWith('B:'));
  assert.ok(beams.length > 0);
  for (const m of beams) if (before.get(m.memberId) === 'S06-SB1') assert.equal(m.mark, 'S06-SB1');
});

test('바로 적용: the confirmed plans bake straight in the document, one undo record per body', async () => {
  const { planBake } = await import('../../src/jigs/bake/plan.ts');
  const { renderChunks } = await import('../../src/jigs/bake/templates.ts');
  const { runDirectBake, undoBake } = await import('../../src/jigs/bake/bake.ts');
  const hash = (r, id) => r.steps.find((s) => s.id === id).inputHash;
  const first = await run('drawn-two-bay', {}, 'confirmed', {});
  const confirmed = {
    confirmAnalysis: hash(first, 'confirmAnalysis'),
    applySections: hash(first, 'applySections'),
  };
  const applying = await run('drawn-two-bay', {}, 'confirmed', confirmed);
  const overrides = applying.applies[0].overrides.map((o) => ({
    ...o,
    at: '2026-09-30T00:00:00Z',
  }));
  const after = await run('drawn-two-bay', {}, 'confirmed', confirmed, { overrides });
  const again = await run(
    'drawn-two-bay',
    {},
    'confirmed',
    { confirmAnalysis: hash(after, 'confirmAnalysis') },
    { overrides },
  );
  const manifest = read('jig.json');
  const decls = ['lines', 'members', 'member-columns'].map((id) =>
    manifest.bake.find((b) => b.id === id),
  );

  // A fake attached document: each body is one undo record; undo restores the record's snapshot.
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const doc = new Map();
  const stack = [];
  const bodies = new Map();
  let serial = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
  const direct = {
    async execute(_target, command) {
      const body = bodies.get(command.code);
      const before = new Map([...doc].map(([k, v]) => [k, { ...v }]));
      const removed = body.deleteIds
        .filter((id) => doc.delete(id))
        .map((nativeId) => ({ nativeId }));
      assert.ok(removed.length <= command.guard.maxDeletes);
      assert.equal(command.label, `VIDE jig: ${manifest.name}`);
      const ids = body.keys.map((key) => {
        const nativeId = uuid();
        const tags = { 'vide-run': body.runId, 'vide-key': key, 'vide-bake': body.bakeId };
        doc.set(nativeId, {
          nativeId,
          geometryHash: `g-${key}`,
          layer: body.layerPath,
          attributes64: Object.entries(tags).map(([k, v]) => [b64(k), b64(v)]),
        });
        return nativeId;
      });
      const undoId = uuid();
      stack.push({ undoId, before });
      return {
        ok: true,
        undoId,
        changes: { removed },
        value: { removed: removed.length, keys: body.keys, ids, failed: [] },
      };
    },
    async undo(_target, undoId) {
      if (stack.at(-1)?.undoId !== undoId) return { ok: false, reason: 'not-latest' };
      const { before } = stack.pop();
      doc.clear();
      for (const [k, v] of before) doc.set(k, v);
      return { ok: true };
    },
  };
  const records = new Map();
  const store = {
    addBake: (_i, r) => {
      const record = { id: uuid(), instanceId: 'i', appliedAt: null, ...r };
      records.set(record.id, record);
      return record;
    },
    updateBake: (_i, id, patch) => Object.assign(records.get(id), patch),
    bake: (_i, id) => records.get(id),
  };
  const ctx = {
    store,
    direct,
    runtime: { recordRead: () => ({ id: uuid() }) },
    // `cut`: the read lost the tags of every other object (a page's shared string budget, as the
    // Rhino scene page did before it ended pages there).
    read: async () => ({
      linkId: 'L',
      revisionKey: 'r',
      model: {
        scene: [...doc.values()].map((row, i) =>
          cut && i % 2 ? { ...row, attributes64: [] } : row,
        ),
      },
    }),
  };
  let cut = false;
  const outputs = { lines: again.outputs.bakePlan, members: again.outputs.bakeMembers };
  const bake = async (prior = {}) => {
    const runId = uuid();
    const plans = decls.map((decl) => {
      const layerPath = `VIDE::S06::${decl.layer}`;
      const plan = planBake({
        instanceId: 'i',
        bakeId: decl.id,
        planned: extractItems(decl, outputs[decl.id] ?? outputs.members).items,
        prior: prior[decl.id],
        read: { scene: [...doc.values()] },
      });
      const chunks = renderChunks(
        {
          template: decl.template,
          jigId: 'project/s06-frame',
          instanceId: 'i',
          bakeId: decl.id,
          runId,
          layerPath,
          deleteIds: plan.deleteIds,
        },
        plan.create,
      );
      for (const c of chunks) bodies.set(c.code, { ...c, runId, bakeId: decl.id, layerPath });
      return { decl, plan, chunks };
    });
    const prepared = {
      projectId: 'P',
      instanceId: 'i',
      readId: 'r0',
      read: { linkId: 'L', model: { scene: [] } },
      runId,
      linkId: 'L',
      gates: [],
      blocked: [],
      problems: [],
      absorbed: 0,
      layers: decls.map((decl) => `VIDE::S06::${decl.layer}`),
      plans,
      codes: plans.flatMap((p) => p.chunks.map((c) => c.code)),
      jig: { manifest },
      view: { body: { layerRoot: 'VIDE::S06' } },
    };
    const made = await runDirectBake(ctx, prepared, { host: 'rhino' });
    const recs = Object.fromEntries(
      made.summary.bakes.map((b) => [b.bakeId, records.get(b.recordId)]),
    );
    return { made, recs };
  };

  const one = await bake();
  const planned =
    again.outputs.bakePlan.lines.length + again.outputs.bakeMembers.members.length * 2;
  assert.equal(one.made.undoIds.length, 3);
  assert.ok(one.made.summary.direct);
  assert.ok(Object.values(one.recs).every((r) => r.appliedAt && r.baselineReadId));
  const made = doc.size;
  assert.ok(made > 0 && made <= planned);

  // A person moves one member and draws an own object; the next bake replaces only recorded ones.
  const edited = Object.values(one.recs.members.items)[0].nativeId;
  doc.get(edited).geometryHash = 'moved';
  doc.set('own', {
    nativeId: 'own',
    geometryHash: 'x',
    layer: 'VIDE::S06::jig 부재',
    attributes64: [],
  });
  const two = await bake(one.recs);
  const members = two.made.summary.bakes.find((b) => b.bakeId === 'members');
  assert.deepEqual(
    members.preserved.map((p) => p.reason),
    ['edited'],
  );
  assert.equal(two.made.result.removed, made - 1);
  assert.ok(doc.has('own') && doc.has(edited));
  assert.equal(doc.size, made + 1);

  // [되돌리기]: the second run's records come off newest first; the first bake is back.
  const undone = await undoBake(ctx, 'i', members.recordId);
  assert.equal(undone.records.length, 3);
  assert.ok(undone.records.every((id) => records.get(id).appliedAt === null));
  assert.equal(doc.size, made + 1);
  assert.ok(Object.values(one.recs.lines.items).every((item) => doc.has(item.nativeId)));

  // A read whose tags came back incomplete does not turn made objects into failures: the receipt
  // says what was made, so every one is recorded and the next bake replaces it instead of adding
  // a duplicate.
  cut = true;
  const three = await bake();
  assert.ok(
    three.made.summary.bakes.every((b) => b.failed === 0 || b.failed?.length === 0),
    JSON.stringify(three.made.summary.bakes.map((b) => b.failed)),
  );
  const recorded = Object.values(three.recs).flatMap((r) => Object.values(r.items));
  assert.ok(recorded.length > 0 && recorded.every((item) => doc.has(item.nativeId)));
  cut = false;
  const size = doc.size;
  await bake(three.recs);
  assert.equal(doc.size, size, 'the same bake again replaces, never duplicates');
});
