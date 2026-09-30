import test from 'node:test';
import assert from 'node:assert/strict';
import { structureScheduleSchema } from '../../src/contracts/structure-model.ts';
import {
  buildFrameModel,
  runAnalysis,
  schedule,
  scheduleComplete,
  stableMarks,
  toCsv,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { archPlan, bayPlan } from './frame-fixtures.mjs';

// Schedule and CSV (SPEC-06.12, PLAN-23 T-054): one row per mark with count, length, quantity
// weights from the section dimensions, the worst verdict and the largest ratio; curved rows carry
// radius, rise and chord; every member is listed once; the CSV guards formula cells.

const near = (actual, expected, rel, what) =>
  assert.ok(
    Math.abs(actual - expected) <= rel * Math.abs(expected),
    `${what}: ${actual} vs ${expected}`,
  );

test('bay schedule: rows per mark, KS unit weights, verdict columns from the confirmed summary', () => {
  const { model, map, assumptions } = buildFrameModel(bayPlan());
  const { summary } = runAnalysis(model, map, { mode: 'confirmed', key: 'bay', assumptions });
  assert.equal(summary.status, 'ok');
  const marks = stableMarks(model, map);
  const table = schedule(model, map, marks, { summary, assumptions: marks.assumptions });
  assert.ok(
    structureScheduleSchema.safeParse(table).success,
    JSON.stringify(structureScheduleSchema.safeParse(table).error?.issues?.slice(0, 3)),
  );
  assert.equal(table.mode, 'confirmed');
  assert.equal(table.label, '확정 결과');
  assert.equal(table.modelHash, summary.modelHash);
  assert.deepEqual(
    table.rows.map((r) => r.mark),
    ['SC1', 'SG1', 'SB1'],
    'columns, girders, beams in mark order',
  );
  const [sc, sg, sb] = table.rows;
  assert.equal(sc.count, 4);
  assert.equal(sc.totalLength_m, 24);
  near(sc.unitWeight_kgpm, 94.0, 0.01, 'H-300x300 unit weight');
  assert.equal(sg.count, 2);
  assert.equal(sg.totalLength_m, 18);
  near(sg.unitWeight_kgpm, 89.6, 0.01, 'H-500x200 unit weight');
  near(sg.weight_t, (89.6 * 18) / 1000, 0.01, 'girder weight');
  assert.equal(sb.count, 3);
  assert.equal(sb.totalLength_m, 15);
  near(sb.unitWeight_kgpm, 66.0, 0.01, 'H-400x200 unit weight');
  assert.equal(sb.sectionName, 'H-400x200x8x13');
  assert.equal(sb.tag, 'beam');
  assert.equal(sb.curved, false);
  assert.equal(table.totals.count, 9);
  near(table.totals.length_m, 57, 1e-9, 'total length');
  near(table.totals.weight_t, sc.weight_t + sg.weight_t + sb.weight_t, 1e-6, 'total weight');
  // Verdict columns agree with the summary rows of the members.
  const rows = new Map(summary.members.map((r) => [r[0], r]));
  for (const row of table.rows) {
    const ratios = row.members.map((id) => rows.get(id)[2]).filter((r) => r !== null);
    assert.equal(row.maxRatio, Math.max(...ratios));
    const codes = row.members.map((id) => rows.get(id)[1]);
    const sum = Object.values(row.counts).reduce((s, v) => s + v, 0);
    assert.equal(sum, row.count);
    assert.equal(row.counts.na, codes.filter((c) => c === 3).length);
    assert.ok(row.status !== null && row.governing !== null);
    if (codes.includes(2)) assert.equal(row.status, 'ng');
  }
  assert.deepEqual(table.unlisted, []);
  assert.deepEqual(scheduleComplete(table, map), {
    gate: 'schedule-complete',
    ok: true,
    reasons: [],
  });
  assert.ok(table.assumptions.some((a) => a.includes('물량용')));
  assert.ok(table.assumptions.some((a) => a.includes('부호 접두')));
});

test('a schedule without an analysis, or from a preview, never says 확정', () => {
  const { model, map } = buildFrameModel(bayPlan());
  const marks = stableMarks(model, map);
  const bare = schedule(model, map, marks.marks);
  assert.equal(bare.mode, 'preview');
  assert.equal(bare.label, '미확정 미리보기');
  assert.ok(bare.rows.every((r) => r.status === null && r.maxRatio === null));
  assert.ok(
    bare.rows.every((r) => r.unitWeight_kgpm > 0),
    'quantities need no analysis',
  );
  const { summary } = runAnalysis(model, map, { mode: 'preview' });
  const preview = schedule(model, map, marks, { summary });
  assert.equal(preview.label, '미확정 미리보기');
  const csv = toCsv(preview);
  assert.ok(csv.includes('미확정 미리보기'));
  assert.ok(!csv.includes('확정 결과'));
});

test('curved rows carry radius, rise and chord; a missing mark fails schedule-complete', () => {
  const { model, map } = buildFrameModel(archPlan());
  const { summary } = runAnalysis(model, map, { mode: 'confirmed' });
  const marks = stableMarks(model, map);
  const table = schedule(model, map, marks, { summary });
  const arch = table.rows.find((r) => r.mark === 'SG1');
  assert.equal(arch.curved, true);
  assert.ok(Math.abs(arch.chord_m - 12) < 1e-6);
  assert.ok(Math.abs(arch.rise_m - 1) < 0.01);
  assert.ok(Math.abs(arch.radius_m - 18.5) < 0.05);
  assert.ok(arch.totalLength_m > 12, 'arc length exceeds the chord');
  const columns = table.rows.find((r) => r.mark === 'SC1');
  assert.equal(columns.curved, false);
  assert.equal(columns.radius_m, undefined);
  // Drop a mark: the member is unlisted and the gate says so.
  const partial = schedule(model, map, { ...marks.marks, 'C-1': undefined }, { summary });
  assert.deepEqual(partial.unlisted, ['C-1']);
  const verdict = scheduleComplete(partial, map);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((r) => r.includes('C-1')));
  // A row listing a member twice also fails.
  const doubled = { rows: [...table.rows, { ...table.rows[0] }], unlisted: [] };
  assert.equal(scheduleComplete(doubled, map).ok, false);
});

test('CSV: BOM, CRLF, quoted cells, header row, totals, and formula text neutralised', () => {
  const plan = bayPlan();
  // A member key that a spreadsheet would run as a formula ends up in the members column.
  plan.members = plan.members.map((m) => (m.key === 'B-5' ? { ...m, key: '=SUM(1)' } : m));
  const { model, map } = buildFrameModel(plan);
  const marks = stableMarks(model, map);
  const table = schedule(model, map, marks);
  const csv = toCsv(table);
  assert.ok(csv.startsWith('﻿"부재 일람표","미확정 미리보기"'));
  assert.ok(csv.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(csv), 'every line break is CRLF');
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.ok(lines[1].startsWith('"부호","역할","단면","개수"'));
  assert.equal(lines.length, 2 + table.rows.length + 1, 'title, header, rows, totals');
  assert.ok(lines[lines.length - 1].startsWith('"합계"'));
  const beams = lines.find((l) => l.startsWith('"SB1"'));
  assert.ok(beams.includes("'=SUM(1)"), 'formula-looking text gets an apostrophe');
  assert.ok(beams.includes('"작은보"'));
  assert.ok(!beams.includes(',=SUM'));
  // Numbers stay numbers (quoted, no apostrophe) and null cells are empty.
  assert.ok(beams.includes('"3","15"'));
  assert.ok(beams.includes('"",""'));
});
