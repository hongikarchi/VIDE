import test from 'node:test';
import assert from 'node:assert/strict';
import { markLedgerSchema } from '../../src/contracts/structure-model.ts';
import {
  buildFrameModel,
  markUnique,
  stableMarks,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { archPlan, bayPlan } from './frame-fixtures.mjs';
import { H500 } from './frame-fixtures.mjs';

// Stable marks (SPEC-06.12, PLAN-23 T-054): role prefix + number from 1 by position, grouped by
// section and curvature; a ledger keeps the same member on the same mark across recalculations,
// numbers are never reused, and new ids on old lines are reported as a correspondence.

const lcg = (seed) => () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const jitter = (plan, random, mm = 1) => {
  const move = (p) => p.map((v) => v + (random() - 0.5) * 2 * (mm / 1000));
  return {
    ...plan,
    columns: plan.columns.map((c) => ({ ...c, base: move(c.base), top: move(c.top) })),
    members: plan.members.map((m) => ({ ...m, rail: m.rail.map(move) })),
  };
};

test('bay: SC/SG/SB by role, one mark per role × section, ledger validates, gate passes', () => {
  const { model, map } = buildFrameModel(bayPlan());
  const result = stableMarks(model, map);
  assert.ok(markLedgerSchema.safeParse(result.ledger).success);
  const marks = result.marks;
  for (const c of ['C-0-0', 'C-9-0', 'C-0-5', 'C-9-5']) assert.equal(marks[c], 'SC1');
  assert.equal(marks['G-0'], 'SG1');
  assert.equal(marks['G-5'], 'SG1');
  for (const b of ['B-2.5', 'B-5', 'B-7.5']) assert.equal(marks[b], 'SB1');
  assert.deepEqual(result.ledger.next, { SC: 1, SG: 1, SB: 1 });
  assert.deepEqual(result.ledger.groups.SG1, {
    prefix: 'SG',
    role: 'girder',
    tag: 'girder',
    section: 'H500',
    curved: false,
  });
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.retired, []);
  assert.ok(
    result.assumptions.some((a) => a.includes('가정')),
    'prefix rule is assumed',
  );
  assert.deepEqual(markUnique(result, map), { gate: 'mark-unique', ok: true, reasons: [] });
  // A project prefix goes in front of every mark; the rule persists in the ledger.
  const prefixed = stableMarks(model, map, { rule: { projectPrefix: 'P1-' } });
  assert.equal(prefixed.marks['G-0'], 'P1-SG1');
  assert.equal(prefixed.ledger.rule.projectPrefix, 'P1-');
  assert.equal(stableMarks(model, map, { previous: prefixed.ledger }).marks['B-5'], 'P1-SB1');
});

test('recalculating after ±1 mm moves keeps every mark, with and without the ledger', () => {
  const base = buildFrameModel(bayPlan());
  const first = stableMarks(base.model, base.map);
  const random = lcg(2026);
  for (let run = 0; run < 10; run++) {
    const moved = buildFrameModel(jitter(bayPlan(), random));
    const withLedger = stableMarks(moved.model, moved.map, { previous: first.ledger });
    assert.deepEqual(withLedger.marks, first.marks, `run ${run}: same marks with the ledger`);
    assert.deepEqual(withLedger.changed, []);
    const fresh = stableMarks(moved.model, moved.map);
    assert.deepEqual(fresh.marks, first.marks, `run ${run}: same marks from scratch`);
  }
});

test('a changed section moves the member to a new number; numbers are never reused', () => {
  const { model, map } = buildFrameModel(bayPlan());
  const first = stableMarks(model, map);
  // The user sets one secondary beam to the girder section: it leaves SB1 for SB2.
  const edited = structuredClone(model);
  for (const m of edited.members) if (m.id.startsWith('B-5.')) m.section = 'H500';
  const second = stableMarks(edited, map, { previous: first.ledger });
  assert.equal(second.marks['B-5'], 'SB2');
  assert.equal(second.marks['B-2.5'], 'SB1');
  assert.deepEqual(second.changed, [{ id: 'B-5', from: 'SB1', to: 'SB2' }]);
  assert.equal(second.ledger.next.SB, 2);
  assert.ok(second.issues.some((i) => i.code === 'MARKS_CHANGED'));
  // Back to the original: SB1 again, SB2 retired but its number stays taken.
  const third = stableMarks(model, map, { previous: second.ledger });
  assert.equal(third.marks['B-5'], 'SB1');
  assert.deepEqual(third.retired, ['SB2']);
  assert.equal(third.ledger.next.SB, 2);
  // Another section for a different beam gets SB3, not the retired SB2; SB2 revives for H500.
  const fourth = structuredClone(model);
  for (const m of fourth.members) if (m.id.startsWith('B-7.5.')) m.section = 'H300';
  for (const m of fourth.members) if (m.id.startsWith('B-2.5.')) m.section = 'H500';
  const marks = stableMarks(fourth, map, { previous: third.ledger });
  assert.equal(marks.marks['B-7.5'], 'SB3');
  assert.equal(marks.marks['B-2.5'], 'SB2');
  assert.equal(marks.marks['B-5'], 'SB1');
  assert.deepEqual(markUnique(marks, map).ok, true);
});

test('curved members: same radius and rise share a mark, a different rise does not', () => {
  const plan = archPlan();
  const second = (rise, key, y) => {
    const span = 12,
      z = 6;
    const R = (span * span) / (8 * rise) + rise / 2;
    const rail = [];
    for (let k = 0; k <= 24; k++) {
      const x = (span * k) / 24;
      const dx = x - span / 2;
      rail.push([x, y, z + Math.sqrt(R * R - dx * dx) - (R - rise)]);
    }
    return { key, role: 'girder', rail, section: 'H500', ends: ['rigid', 'rigid'] };
  };
  plan.columns.push(
    { key: 'C-2', base: [0, 6, 0], top: [0, 6, 6], section: 'H300' },
    { key: 'C-3', base: [12, 6, 0], top: [12, 6, 6], section: 'H300' },
    { key: 'C-4', base: [0, 12, 0], top: [0, 12, 6], section: 'H300' },
    { key: 'C-5', base: [12, 12, 0], top: [12, 12, 6], section: 'H300' },
  );
  plan.members.push(second(1.0, 'A-2', 6), second(1.3, 'A-3', 12));
  const { model, map, issues } = buildFrameModel(plan);
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  const result = stableMarks(model, map);
  assert.equal(result.marks['A-1'], 'SG1');
  assert.equal(result.marks['A-2'], 'SG1', 'same arc → same mark');
  assert.equal(result.marks['A-3'], 'SG2', 'different rise → its own mark');
  assert.equal(result.ledger.groups.SG1.curved, true);
  assert.ok(Math.abs(result.ledger.groups.SG1.rise_m - 1) < 0.01);
  assert.ok(Math.abs(result.ledger.groups.SG1.radius_m - 18.5) < 0.05);
  assert.ok(Math.abs(result.ledger.groups.SG2.rise_m - 1.3) < 0.01);
  // A straight girder of the same section is a third group.
  plan.members.push({
    key: 'G-s',
    role: 'girder',
    rail: [
      [0, 6, 6],
      [0, 12, 6],
    ],
    section: 'H500',
    ends: ['pinned', 'pinned'],
  });
  const again = buildFrameModel(plan);
  const more = stableMarks(again.model, again.map, { previous: result.ledger });
  assert.equal(more.marks['G-s'], 'SG3');
  assert.equal(more.marks['A-2'], 'SG1');
  assert.equal(markUnique(more, again.map).ok, true);
});

test('new ids on old lines are reported as split, same-line and moved correspondences', () => {
  const base = buildFrameModel(bayPlan());
  const first = stableMarks(base.model, base.map);
  const plan = bayPlan();
  // Girder G-0 split in two at x = 4.5; beam B-5 renamed; girder G-5 moved down 0.3 m.
  plan.members = plan.members.flatMap((m) => {
    if (m.key === 'G-0')
      return [
        {
          ...m,
          key: 'G-0a',
          rail: [
            [0, 0, 6],
            [4.5, 0, 6],
          ],
          bracedAt: [2.5 / 4.5],
        },
        {
          ...m,
          key: 'G-0b',
          rail: [
            [4.5, 0, 6],
            [9, 0, 6],
          ],
          bracedAt: [0.5 / 4.5, 3 / 4.5],
        },
      ];
    if (m.key === 'B-5') return [{ ...m, key: 'B-mid' }];
    if (m.key === 'G-5')
      return [{ ...m, key: 'G-5-low', rail: m.rail.map((p) => [p[0], p[1], 5.7]) }];
    return [m];
  });
  plan.columns = plan.columns.map((c) =>
    c.key.endsWith('-5') ? { ...c, top: [c.top[0], c.top[1], 5.7] } : c,
  );
  const next = buildFrameModel(plan);
  const result = stableMarks(next.model, next.map, { previous: first.ledger });
  const by = Object.fromEntries(result.correspondence.map((c) => [c.id, c]));
  assert.deepEqual(by['G-0a'], { id: 'G-0a', from: ['G-0'], kind: 'split' });
  assert.deepEqual(by['G-0b'], { id: 'G-0b', from: ['G-0'], kind: 'split' });
  assert.deepEqual(by['B-mid'], { id: 'B-mid', from: ['B-5'], kind: 'same-line' });
  assert.deepEqual(by['G-5-low'], { id: 'G-5-low', from: ['G-5'], kind: 'moved' });
  // The renamed and split members keep the group's mark; G-0 and B-5 are gone, their marks live on.
  assert.equal(result.marks['B-mid'], 'SB1');
  assert.equal(result.marks['G-0a'], 'SG1');
  assert.deepEqual(result.retired, []);
});

test('a bad prefix rule is refused as an issue and the gate catches a missing or foreign mark', () => {
  const { model, map } = buildFrameModel(bayPlan());
  const bad = stableMarks(model, map, { rule: { projectPrefix: 'P 1' } });
  assert.ok(bad.issues.some((i) => i.code === 'MARK_RULE' && i.level === 'error'));
  const result = stableMarks(model, map);
  const missing = {
    ...result,
    marks: Object.fromEntries(Object.entries(result.marks).filter(([id]) => id !== 'B-5')),
  };
  assert.equal(markUnique(missing, map).ok, false);
  const twoMarks = {
    marks: { ...result.marks, 'B-5': 'SB9' },
    ledger: { groups: { ...result.ledger.groups, SB9: { ...result.ledger.groups.SB1 } } },
  };
  const verdict = markUnique(twoMarks, map);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes('같은 묶음')));
  assert.equal(markUnique({ marks: { 'B-5': 'S B' }, ledger: { groups: {} } }).ok, false);
  // The fixture's section list is untouched by marking.
  assert.equal(model.sections.find((s) => s.id === 'H500').name, H500.name);
});
