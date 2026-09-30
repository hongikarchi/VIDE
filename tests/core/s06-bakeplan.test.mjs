import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bakePlan } from '../../extensions/jigs/s06-frame/steps/bakeplan.ts';
import { SAFE_ARG } from '../../src/jigs/bake/data-block.ts';

// S-06 frame jig ⑫ Rhino에 만들기 계획 (PLAN-23 T-056 part 3): top-of-steel lines only (arcs kept),
// H members from sizing and schedule with the web vertical, column lengths from the height check,
// keys stable across recomputation. Synthetic fixture only.
const FIXTURES = join(
  import.meta.dirname,
  '..',
  '..',
  'extensions',
  'jigs',
  's06-frame',
  'fixtures',
);
const fixture = () => JSON.parse(readFileSync(join(FIXTURES, 'bakeplan-two-bay.json'), 'utf8'));
const schemaOf = () =>
  JSON.parse(readFileSync(join(FIXTURES, '..', 'schemas', 'steps', 'bakePlan.json'), 'utf8'));

test('bakePlan: top lines for columns, girders (arc as three points), beams and cantilevers', () => {
  const f = fixture();
  const out = bakePlan(f.inputs, f.params);
  assert.equal(out.schema, 'vide.s06.bakePlan/1');
  for (const field of schemaOf().required) assert.ok(field in out, field);
  assert.deepEqual(
    out.lines.map((l) => l.key),
    [
      'column:c-1',
      'column:c-2',
      'column:c-3',
      'column:c-4',
      'girder:G1',
      'girder:G2',
      'girder:G3',
      'girder:G4',
      'beam:B01',
      'beam:B02',
      'cantilever:E01',
    ],
  );
  assert.ok(out.lines.every((l) => l.layer === 'jig 상단선' && SAFE_ARG.test(l.key)));
  const g2 = out.lines.find((l) => l.key === 'girder:G2');
  assert.equal(g2.points.length, 3, 'an arc girder is planned as start, interior, end');
  assert.deepEqual(g2.points[1], [4, 6, 6.3], 'the interior point is the arc apex');
  assert.equal(g2.arc.plane, 'vertical');
  assert.equal(out.lines.find((l) => l.key === 'girder:G1').arc, undefined);
  // Column lines follow the height check: floored to the 1 m step, not through the slab.
  const c1 = out.lines.find((l) => l.key === 'column:c-1');
  assert.deepEqual(c1.points, [
    [0, 0, 0],
    [0, 0, 5],
  ]);
  assert.equal(c1.mark, 'C1');
  assert.equal(out.lines.find((l) => l.key === 'cantilever:E01').mark, undefined);
});

test('bakePlan: members carry section, mark and sizes with the web vertical; no section → skipped', () => {
  const f = fixture();
  const out = bakePlan(f.inputs, f.params);
  assert.equal(out.previewOnly, false);
  assert.equal(out.members.length, 10);
  assert.ok(out.members.every((m) => m.webVertical === true && m.layer === 'jig 부재'));
  assert.ok(out.members.every((m) => SAFE_ARG.test(m.key)));
  assert.deepEqual(out.skipped, [{ memberId: 'A:E01', reason: '단면 후보 없음' }]);
  const g2 = out.members.find((m) => m.memberId === 'G:G2');
  assert.equal(g2.key, 'girder:G2');
  assert.equal(g2.sectionName, 'H-600x200x11x17');
  assert.equal(g2.mark, 'G2');
  assert.equal(g2.points.length, 3);
  assert.ok(g2.length_m > 8 && g2.length_m < 8.1, 'arc length, not chord');
  const b1 = out.members.find((m) => m.memberId === 'B:B01');
  assert.equal(b1.role, 'beam');
  assert.equal(b1.H_mm, 400);
  // Column c-1 carries G1 (8 m, along x) and G3 (6 m): flanges across G1, web along it.
  const c1 = out.members.find((m) => m.memberId === 'col:c-1');
  assert.equal(c1.role, 'column');
  assert.deepEqual(c1.strongAxis, [0, 1, 0]);
  assert.equal(c1.length_m, 5);
  const expected =
    (4 * 5 * 93.1 +
      out.members.filter((m) => m.role === 'girder').reduce((s, m) => s + m.length_m, 0) * 104.5 +
      out.members.filter((m) => m.role === 'beam').reduce((s, m) => s + m.length_m, 0) * 65.4) /
    1000;
  assert.ok(Math.abs(out.summary.steel_t - expected) < 1e-3);
  assert.deepEqual(out.summary, {
    lines: 11,
    members: 10,
    steel_t: out.summary.steel_t,
  });
});

test('bakePlan: keys are stable across recomputation and input order', () => {
  const f = fixture();
  const a = bakePlan(f.inputs, f.params);
  assert.deepEqual(bakePlan(f.inputs, f.params), a, 'same inputs, same plan');
  const shuffled = structuredClone(f.inputs);
  shuffled.steps.girders.girders.reverse();
  shuffled.steps.sizing.groups.reverse();
  shuffled.steps.schedule.marks.reverse();
  const b = bakePlan(shuffled, f.params);
  const keys = (out) => [...out.lines.map((l) => l.key)].sort();
  assert.deepEqual(keys(b), keys(a));
  assert.deepEqual(
    b.members.map((m) => [m.key, m.mark]).sort(),
    a.members.map((m) => [m.key, m.mark]).sort(),
  );
});

test('bakePlan: preview sizing is flagged; no sizing plans lines only; odd ids stay bake-safe', () => {
  const f = fixture();
  const preview = structuredClone(f.inputs);
  preview.steps.sizing.previewOnly = true;
  const p = bakePlan(preview);
  assert.equal(p.previewOnly, true);
  assert.ok(p.notes.some((n) => n.includes('미리보기')));

  const bare = structuredClone(f.inputs);
  delete bare.steps.sizing;
  delete bare.steps.heights;
  const b = bakePlan(bare);
  assert.equal(b.members.length, 0);
  assert.equal(b.previewOnly, true);
  assert.equal(b.lines.length, 11);
  assert.deepEqual(b.lines[0].points[1], [0, 0, 6], 'drawn height without the height check');

  const odd = structuredClone(f.inputs);
  odd.steps.girders.girders[0].id = "G 1'";
  const o = bakePlan(odd);
  assert.ok(o.lines.every((l) => SAFE_ARG.test(l.key)));
  assert.ok(o.lines.some((l) => l.key === 'girder:G_1_'));
});
