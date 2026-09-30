// S-06 frame jig M3 steps ⑨ sizing, ⑪ schedule, ⑩ heights (PLAN-23 T-056). Synthetic fixtures only.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeAnalysisWorker } from '../../src/jigs/official/structure-analysis/index.ts';
import { checkSchema } from '../../src/jigs/runtime/schema.ts';
import { model } from '../../extensions/jigs/s06-frame/steps/model.ts';
import { analysis } from '../../extensions/jigs/s06-frame/steps/analysis.ts';
import { sizing } from '../../extensions/jigs/s06-frame/steps/sizing.ts';
import { schedule } from '../../extensions/jigs/s06-frame/steps/schedule.ts';
import { heights } from '../../extensions/jigs/s06-frame/steps/heights.ts';

const root = new URL('../../extensions/jigs/s06-frame/', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const twoBay = json('fixtures/analysis-two-bay.json');
const handSizing = json('fixtures/m3-sizing-two-bay.json').sizing;
const slope = json('fixtures/m3-heights-slope.json');
const schemas = {
  sizing: json('schemas/steps/sizing.json'),
  schedule: json('schemas/steps/schedule.json'),
  heights: json('schemas/steps/heights.json'),
};
const schemaOk = (name, value) => {
  const problems = checkSchema(schemas[name], value);
  assert.deepEqual(problems, [], JSON.stringify(problems));
};
const modelOut = model(
  {
    site: twoBay.site,
    planterZones: twoBay.planterZones,
    dryZones: twoBay.dryZones,
    steps: twoBay.steps,
  },
  twoBay.params,
);
let previewAnalysis;
const preview = async () =>
  (previewAnalysis ??= await analysis({ steps: { model: modelOut } }, { stability: false }));

after(() => closeAnalysisWorker());

test('sizing: KS H within the depth limit, starting from the preview (previewOnly)', async () => {
  const a = await preview();
  assert.equal(a.summary.status, 'ok');
  const out = await sizing({ steps: { model: modelOut, analysis: a } });
  schemaOk('sizing', out);
  assert.equal(out.previewOnly, true);
  assert.equal(out.basis, 'preview');
  assert.ok(out.iterations >= 1 && out.iterations <= 6);
  // Every design member of a sized role is in exactly one group.
  const members = out.groups.flatMap((g) => g.memberIds).sort();
  assert.deepEqual(members, Object.keys(modelOut.map.physical).sort());
  assert.ok(out.groups.some((g) => g.role === 'column'));
  assert.ok(out.groups.some((g) => g.role === 'girder'));
  assert.ok(out.groups.some((g) => g.role === 'beam'));
  // The curved girder G4 is grouped apart from the straight ones.
  const g4 = out.groups.find((g) => g.memberIds.includes('G:G4'));
  assert.ok(g4.id.includes('곡선'), g4.id);
  assert.ok(!g4.memberIds.includes('G:G1'));
  for (const g of out.groups) {
    assert.ok(g.sectionId && out.sectionsById[g.sectionId], `${g.id} section`);
    const s = out.sectionsById[g.sectionId];
    if (g.status === 'ok') {
      assert.ok(s.h_mm <= (g.role === 'column' ? 400 : 900), `${g.id} ${s.name}`);
      assert.ok(g.maxRatio !== null && g.maxRatio <= 0.9 + 1e-6, `${g.id} ratio ${g.maxRatio}`);
    }
    assert.ok(s.kgpm > 0);
  }
  assert.ok(out.notes.some((n) => n.includes('미확정 미리보기')));
});

test('sizing: the confirmed result of this model is reused for the first iteration', async () => {
  const a = await preview();
  const confirmed = {
    ...a,
    confirmed: {
      result: { ...a.preview, mode: 'confirmed' },
      at: '2026-09-30T00:00:00Z',
      modelHash: a.modelHash,
    },
  };
  let calls = 0;
  const out = await sizing(
    { steps: { model: modelOut, analysis: confirmed } },
    { maxIterations: 1 },
    [],
    {
      analyze: () => {
        calls++;
        throw new Error('must not run');
      },
    },
  );
  schemaOk('sizing', out);
  assert.equal(calls, 0);
  assert.equal(out.previewOnly, false);
  assert.equal(out.basis, 'confirmed');
  assert.equal(out.iterations, 1);
  // A confirmation of another model is not used.
  const stale = await sizing(
    {
      steps: {
        model: modelOut,
        analysis: { ...confirmed, confirmed: { ...confirmed.confirmed, modelHash: 'other' } },
      },
    },
    { maxIterations: 1 },
  );
  assert.equal(stale.previewOnly, true);
  assert.equal(stale.basis, 'preview');
});

test("sizing: '후보 없음' under a tight depth limit keeps the current section", async () => {
  const a = await preview();
  const out = await sizing({ steps: { model: modelOut, analysis: a } }, { depthMax_mm: 200 });
  schemaOk('sizing', out);
  const none = out.groups.filter((g) => g.status === 'no-candidate');
  assert.ok(
    none.some((g) => g.role !== 'column'),
    JSON.stringify(out.groups.map((g) => [g.id, g.status])),
  );
  for (const g of none) {
    assert.equal(g.judgement, '후보 없음');
    // Unchanged: the section the model had.
    const seg = modelOut.map.physical[g.memberIds[0]][0];
    const was = modelOut.model.members.find((m) => m.id === seg).section;
    assert.equal(g.sectionId, was);
  }
  assert.equal(out.summary.noCandidate, none.length);
  // The jig setting in metres wins over the mm default.
  const metres = await sizing({ steps: { model: modelOut, analysis: a } }, { depthMax: 0.2 });
  assert.equal(metres.summary.noCandidate, out.summary.noCandidate);
});

test('sizing: without any analysis the groups are listed unchecked', async () => {
  const out = await sizing({ steps: { model: modelOut, analysis: null } }, {}, [], {
    analyze: () => {
      throw new Error('코어 없음');
    },
  });
  schemaOk('sizing', out);
  assert.equal(out.status, 'unavailable');
  assert.equal(out.basis, 'none');
  assert.ok(out.groups.length > 0);
  assert.ok(out.groups.every((g) => g.status === 'unchecked' && g.maxRatio === null));
  assert.ok(out.notes.some((n) => n.includes('코어 없음')));
});

test('schedule: marks with the project prefix, rows, totals and CSV', () => {
  const out = schedule({ steps: { model: modelOut, sizing: handSizing } });
  schemaOk('schedule', out);
  assert.equal(out.prefix, 'S06');
  assert.equal(out.marks.length, Object.keys(modelOut.map.physical).length);
  assert.ok(
    out.marks.every((m) => m.mark.startsWith('S06-')),
    JSON.stringify(out.marks),
  );
  const markOf = Object.fromEntries(out.marks.map((m) => [m.memberId, m.mark]));
  // Same role and section share a mark; the curved G4 and the other section differ.
  assert.equal(markOf['G:G1'], markOf['G:G2']);
  assert.notEqual(markOf['G:G4'], markOf['G:G1']);
  assert.equal(markOf['col:col-1'], 'S06-SC1');
  const g = out.rows.find((r) => r.mark === markOf['G:G1']);
  assert.equal(g.section, 'H-700x300x13x24');
  assert.equal(g.count, 4);
  assert.equal(g.maxRatio, 0.88);
  assert.ok(g.kgpm > 175 && g.kgpm < 190, String(g.kgpm));
  assert.ok(Math.abs(g.t - (g.kgpm * g.totalLength_m) / 1000) < 0.01);
  const g4 = out.rows.find((r) => r.mark === markOf['G:G4']);
  assert.equal(g4.curved, true);
  assert.equal(g4.section, 'H-600x200x11x17');
  // The cantilever keeps its own tag.
  assert.equal(out.rows.find((r) => r.memberIds.includes('A:E1')).roleLabel, '내민보');
  assert.equal(out.totals.count, out.marks.length);
  const sum = out.rows.reduce((s, r) => s + (r.t ?? 0), 0);
  assert.ok(Math.abs(out.totals.t - sum) < 0.01);
  // CSV (BOM, quoted cells, CRLF): title with the preview label, header, one line per mark, totals.
  const lines = out.csv.trim().split(/\r?\n/);
  assert.ok(lines[0].includes('미확정 미리보기'));
  assert.ok(lines[1].startsWith('"부호",'));
  assert.equal(lines.length, 2 + out.rows.length + 1);
  assert.ok(lines.at(-1).startsWith('"합계"'));
  assert.ok(out.issues.some((i) => i.code === 'SCHEDULE_NO_CANDIDATE'));
});

test('schedule: marks stay with the previous ledger; known marks warn; prefix is a setting', () => {
  const first = schedule({ steps: { model: modelOut, sizing: handSizing } });
  // Beams change section: the columns and girders keep their marks, numbers are not reused.
  const changed = structuredClone(handSizing);
  const beams = changed.groups.find((g) => g.id === 'beam|6–9 m');
  beams.sectionId = 'H450x200x9x14';
  beams.sectionName = 'H-450x200x9x14';
  changed.sectionsById.H450x200x9x14 = {
    name: 'H-450x200x9x14',
    h_mm: 450,
    b_mm: 200,
    tw_mm: 9,
    tf_mm: 14,
    kgpm: 76,
  };
  const second = schedule({ steps: { model: modelOut, sizing: changed, schedule: first } });
  schemaOk('schedule', second);
  const before = Object.fromEntries(first.marks.map((m) => [m.memberId, m.mark]));
  const after_ = Object.fromEntries(second.marks.map((m) => [m.memberId, m.mark]));
  for (const id of ['col:col-1', 'G:G1', 'G:G4', 'A:E1']) assert.equal(after_[id], before[id], id);
  assert.notEqual(after_['B:K1-B2'], before['B:K1-B2']);
  assert.ok(!Object.values(before).includes(after_['B:K1-B2']));

  const warned = schedule(
    { steps: { model: modelOut, sizing: handSizing } },
    { knownMarks: ['S06-SC1', 'X-1'] },
  );
  assert.ok(
    warned.issues.some((i) => i.code === 'MARK_IN_LINKED' && i.message.includes('S06-SC1')),
  );

  const other = schedule(
    { steps: { model: modelOut, sizing: handSizing, schedule: first } },
    { markPrefix: 'P2' },
  );
  assert.ok(other.marks.every((m) => m.mark.startsWith('P2-')));
  const none = schedule({ steps: { model: modelOut, sizing: handSizing } }, { markPrefix: '' });
  assert.ok(none.marks.some((m) => m.mark === 'SC1'));
});

test('heights (height-floor): column length floored to 1 m below the girder underside', () => {
  const out = heights({ site: slope.site, steps: { model: slope.model, sizing: slope.sizing } });
  schemaOk('heights', out);
  const row = Object.fromEntries(out.rows.map((r) => [r.sourceId, r]));
  // c-1: 6.35 − 0.60 (model section) = 5.75 above 0.0 → 5 m, bearing 0.75.
  assert.deepEqual(
    [row['c-1'].length_m, row['c-1'].gap_m, row['c-1'].topZ, row['c-1'].depthFrom],
    [5, 0.75, 5, 'model'],
  );
  assert.equal(row['c-1'].drawnLength_m, 6.2);
  assert.equal(row['c-1'].levelDiff_m, 0.15);
  // c-2 carries G1 (600) and G2 (sizing 900): the deeper one decides. 6.0 − 0.9 − 0.4 = 4.7 → 4.
  assert.deepEqual(
    [row['c-2'].length_m, row['c-2'].gap_m, row['c-2'].topZ, row['c-2'].bottomZ],
    [4, 0.7, 4.4, 0.4],
  );
  assert.equal(row['c-2'].depth_mm, 900);
  assert.equal(row['c-2'].depthFrom, 'sizing');
  assert.deepEqual([row['c-3'].length_m, row['c-3'].gap_m], [4, 0.72]);
  // c-4: less than one step → short, no steel.
  assert.equal(row['c-4'].status, 'short');
  assert.equal(row['c-4'].length_m, 0);
  // Steel never reaches the girder underside (the slab).
  for (const r of out.rows) {
    assert.ok(r.topZ <= r.girderBottomZ + 1e-9, r.columnId);
    assert.ok(Math.abs(r.length_m / 1 - Math.round(r.length_m)) < 1e-9);
  }
  assert.deepEqual(
    [out.summary.columns, out.summary.floored, out.summary.short, out.summary.maxGap_m],
    [4, 4, 1, 0.75],
  );
  assert.equal(out.summary.depthFinishOver, 0);
  // Depth + finish limit and a 0.5 m step.
  const tight = heights(
    { site: slope.site, steps: { model: slope.model, sizing: slope.sizing } },
    { depthFinishMax_m: 1.0, heightStep: 0.5 },
  );
  assert.equal(tight.summary.depthFinishOver, 2);
  assert.equal(tight.rows.find((r) => r.sourceId === 'c-1').length_m, 5.5);
  // Without sizing: the model section, and a note.
  const plain = heights({ site: slope.site, steps: { model: slope.model } });
  assert.equal(plain.rows.find((r) => r.sourceId === 'c-2').depth_mm, 600);
  assert.ok(plain.notes.some((n) => n.includes('단면 선정 전')));
});

test('heights on the two-bay model: every drawn column gets a whole-metre length', async () => {
  const out = heights({ site: twoBay.site, steps: { model: modelOut, sizing: handSizing } });
  schemaOk('heights', out);
  assert.equal(out.rows.length, 6);
  for (const r of out.rows) {
    assert.equal(r.drawnLength_m, 5.5);
    // Top of steel 6.0, H-700 girders → underside 5.3 → 5 m, bearing 0.3.
    assert.equal(r.length_m, 5);
    assert.ok(Math.abs(r.gap_m - 0.3) < 1e-6, `${r.columnId} ${r.gap_m}`);
  }
});
