import test from 'node:test';
import assert from 'node:assert/strict';
import { structureModelSchema } from '../../src/contracts/structure-model.ts';
import {
  buildFrameModel,
  designForBeam,
  designForColumn,
  isCurved,
  memberMapFrom,
  sectionArea_mm2,
  segmentCurve,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { archPlan, bayPlan, H300 } from './frame-fixtures.mjs';

const close = (actual, expected, eps = 1e-9, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} ${actual} ≠ ${expected}`);
const byId = (model) => new Map(model.members.map((m) => [m.id, m]));
const nodeById = (model) => new Map(model.nodes.map((n) => [n.id, n]));

test('lb-k: design lengths follow the physical member, not the analysis segment', () => {
  const { model, map, issues, assumptions } = buildFrameModel(bayPlan());
  assert.equal(issues.filter((i) => i.level === 'error').length, 0, JSON.stringify(issues));
  assert.ok(structureModelSchema.safeParse(model).success, 'model satisfies the contract');
  const members = byId(model);
  // Girder G-0: rigid ends, no negative zones given → Lb = whole 9 m for every segment; K3·L = 9.
  assert.deepEqual(
    map.physical['G-0'].map((id) => members.get(id).design.Lb_m),
    [9, 9, 9, 9],
  );
  for (const id of map.physical['G-0']) {
    const m = members.get(id);
    const nodes = nodeById(model);
    const L = Math.hypot(
      ...[0, 1, 2].map((k) => nodes.get(m.j).xyz_m[k] - nodes.get(m.i).xyz_m[k]),
    );
    close(m.design.K3 * L, 9, 1e-9, `${id} K3·L`);
    close(m.design.K2 * L, 9, 1e-9, `${id} K2·L`);
    assert.equal(m.design.Cb, 1);
    assert.equal(m.role, 'girder');
  }
  // With negative zones the middle segments use the 2.5 m brace spacing.
  const zoned = buildFrameModel(
    bayPlan({
      members: bayPlan().members.map((m) =>
        m.key === 'G-0'
          ? {
              ...m,
              negativeZones: [
                [0, 0.15],
                [0.85, 1],
              ],
            }
          : m,
      ),
    }),
  );
  const zonedMembers = byId(zoned.model);
  assert.deepEqual(
    zoned.map.physical['G-0'].map((id) => zonedMembers.get(id).design.Lb_m),
    [2.5, 2.5, 2.5, 1.5],
  );
  // Secondary beams: one segment, pinned both ends, Lb = span, K = 1.
  const beam = members.get(map.physical['B-5'][0]);
  assert.deepEqual(map.physical['B-5'].length, 1);
  assert.deepEqual(beam.design, { Lb_m: 5, K2: 1, K3: 1, Cb: 1 });
  assert.deepEqual(beam.releases, { i: { ry: true, rz: true }, j: { ry: true, rz: true } });
  // Columns: braced below the 4 m restraint (K 1.0), sway zone above it (swayK 2.0).
  const column = map.physical['C-0-0'].map((id) => members.get(id).design);
  assert.deepEqual(column, [
    { Lb_m: 4, K2: 1, K3: 1, Cb: 1 },
    { Lb_m: 2, K2: 2, K3: 2, Cb: 1 },
  ]);
  assert.ok(assumptions.some((a) => a.includes('흔들림 골조')));
  // Design members list every segment once and carry provenance.
  assert.equal(model.designMembers.length, 4 + 2 + 3);
  const owned = model.designMembers.flatMap((d) => d.segments);
  assert.equal(new Set(owned).size, model.members.length);
  assert.deepEqual(memberMapFrom(structureModelSchema.parse(model)).physical, map.physical);
});

test('restraint nodes are the column nodes at the level only; self-weight, notional loads, combos', () => {
  const { model } = buildFrameModel(bayPlan());
  const nodes = nodeById(model);
  const restraint = model.analysis.lateralRestraint;
  assert.deepEqual(restraint.dofs, ['dx', 'dy']);
  assert.equal(restraint.nodes.length, 4);
  for (const id of restraint.nodes) close(nodes.get(id).xyz_m[2], 4, 1e-9, id);
  assert.equal('aboveZ_m' in restraint, false);
  // Base nodes are pinned supports, nothing else is supported.
  const supported = model.nodes.filter((n) => n.support);
  assert.equal(supported.length, 4);
  assert.ok(supported.every((n) => n.xyz_m[2] === 0 && n.support.rz && !n.support.rx));
  // Self-weight is on for D; notional patterns exist for both directions and both gravity cases.
  assert.deepEqual(
    model.loadPatterns.map((p) => [p.id, p.nature, p.selfWeight]),
    [
      ['D', 'D', true],
      ['L', 'L', false],
      ['NX_D', 'N', false],
      ['NX_L', 'N', false],
      ['NY_D', 'N', false],
      ['NY_L', 'N', false],
    ],
  );
  const notional = model.loads.filter((l) => l.pattern === 'NX_D');
  assert.ok(
    notional.length > 0 && notional.every((l) => l.type === 'nodePoint' && l.direction === '+X'),
  );
  // Sum of NX_D = 0.002 × (D line loads + steel weight).
  const lineD = 3 * 6 * 5 + 2 * 2 * 9;
  const weight = model.members.reduce((sum, m) => {
    const section = model.sections.find((s) => s.id === m.section);
    const a = nodes.get(m.i).xyz_m,
      b = nodes.get(m.j).xyz_m;
    return (
      sum + 77 * sectionArea_mm2(section) * 1e-6 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    );
  }, 0);
  close(
    notional.reduce((s, l) => s + l.value_kN, 0),
    0.002 * (lineD + weight),
    1e-6,
    'notional sum',
  );
  // Named combinations with the notional terms scaled by the gravity factors.
  assert.deepEqual(
    model.combinations.map((c) => [
      c.id,
      c.limitState,
      c.terms.map((t) => `${t.pattern}×${t.factor}`).join('+'),
    ]),
    [
      ['1.2D+1.6L', 'strength', 'D×1.2+L×1.6'],
      ['1.2D+1.6L+NX', 'strength', 'D×1.2+L×1.6+NX_D×1.2+NX_L×1.6'],
      ['1.2D+1.6L+NY', 'strength', 'D×1.2+L×1.6+NY_D×1.2+NY_L×1.6'],
      ['D+L', 'service', 'D×1+L×1'],
    ],
  );
  // Line loads target every segment of the physical member.
  const girderLoad = model.loads.find((l) => l.id === 'D:G-0:1');
  assert.equal(girderLoad.targets.length, 4);
});

test('joint rule: a rigid end off the column strong axis becomes a pin; overrides are user values', () => {
  const plan = bayPlan();
  plan.members.push({
    key: 'G-Y',
    role: 'girder',
    rail: [
      [0, 0, 6],
      [0, 5, 6],
    ],
    section: 'H500',
    ends: ['rigid', 'rigid'],
    K: { K2: 1.2, K3: 1.2 },
    Lb_m: 3,
  });
  const { model, map, assumptions } = buildFrameModel(plan);
  const members = byId(model);
  // Both ends sit on columns whose strong axis is X, so both rigid ends are demoted to pins.
  const gy = map.physical['G-Y'].map((id) => members.get(id));
  assert.equal(gy.length, 1);
  assert.deepEqual(gy[0].releases, { i: { ry: true, rz: true }, j: { ry: true, rz: true } });
  assert.ok(assumptions.some((a) => a.includes('2곳을 핀으로 둠')));
  // A girder along the strong axis keeps its rigid ends.
  assert.equal(members.get(map.physical['G-0'][0]).releases, undefined);
  assert.equal(gy[0].design.Lb_m, 3);
  close(gy[0].design.K3, (1.2 * 5) / 5, 1e-9, 'K override');
  const design = model.designMembers.find((d) => d.id === 'G-Y');
  assert.equal(design.provenance.by, 'user');
  // Columns take betaDeg from the strong axis.
  assert.equal(members.get(map.physical['C-0-0'][0]).betaDeg, 0);
  const rotated = buildFrameModel({
    ...bayPlan(),
    columns: bayPlan().columns.map((c) => ({ ...c, strongAxis: [0, 1, 0] })),
  });
  close(byId(rotated.model).get(rotated.map.physical['C-0-0'][0]).betaDeg, 90, 1e-9, 'betaDeg');
});

test('plan errors are reported, not guessed', () => {
  const plan = bayPlan();
  plan.members[0].section = 'H999';
  plan.members.push({ ...plan.members[1], key: 'G-0' });
  plan.lineLoads.push({ memberKey: 'nope', case: 'D', value_kNpm: 1 });
  plan.notional = false;
  const { issues } = buildFrameModel(plan);
  const codes = issues.filter((i) => i.level === 'error').map((i) => i.code);
  for (const code of ['SECTION_UNKNOWN', 'KEY_DUPLICATE', 'LOAD_TARGET', 'NOTIONAL_DISABLED'])
    assert.ok(codes.includes(code), `${code} in ${codes}`);
});

test('curved rails are segmented by chord and sag; straight rails only at joints', () => {
  const { model, map, issues } = buildFrameModel(archPlan());
  assert.equal(issues.filter((i) => i.level === 'error').length, 0);
  const members = byId(model);
  const nodes = nodeById(model);
  const arch = map.physical['A-1'];
  assert.ok(arch.length >= 12 && arch.length <= 24, `arch pieces ${arch.length}`);
  for (const id of arch) {
    const m = members.get(id);
    assert.equal(m.role, 'girder', 'no piece becomes a brace');
    const a = nodes.get(m.i).xyz_m,
      b = nodes.get(m.j).xyz_m;
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1.0 + 1e-9, 'chord ≤ 1 m');
  }
  // Restraint holds the two column tops only, none of the arch's interior nodes.
  assert.equal(model.analysis.lateralRestraint.nodes.length, 2);
  for (const id of model.analysis.lateralRestraint.nodes) {
    const p = nodes.get(id).xyz_m;
    assert.ok((p[0] === 0 || p[0] === 12) && p[2] === 6, `restraint at column top ${p}`);
  }
  // Straight members with joints: the bay girder splits at the three beam joints only.
  const bay = buildFrameModel(bayPlan());
  assert.equal(bay.map.physical['G-0'].length, 4);
  assert.equal(bay.map.physical['B-2.5'].length, 1);
});

test('segmentCurve keeps split points, honours limits and returns straight rails unchanged', () => {
  const rail = [];
  for (let k = 0; k <= 40; k++) rail.push([k * 0.25, Math.sin((k * 0.25 * Math.PI) / 10), 0]);
  const pieces = segmentCurve(rail, { maxLen_m: 1.0, maxSag_m: 0.005, splitAt: [[3.1, 0.83, 0]] });
  assert.deepEqual(pieces[0], rail[0]);
  assert.deepEqual(pieces[pieces.length - 1], rail[40]);
  assert.ok(
    pieces.some((p) => Math.abs(p[0] - 3.1) < 0.02),
    'split point becomes a vertex',
  );
  for (let k = 1; k < pieces.length; k++)
    assert.ok(Math.hypot(...[0, 1, 2].map((c) => pieces[k][c] - pieces[k - 1][c])) <= 1.0 + 1e-9);
  assert.equal(isCurved(rail, 0.005), true);
  assert.equal(
    isCurved(
      [
        [0, 0, 0],
        [5, 0, 0],
        [10, 0, 0],
      ],
      0.005,
    ),
    false,
  );
  assert.deepEqual(
    segmentCurve(
      [
        [0, 0, 0],
        [4, 0, 0],
      ],
      { maxLen_m: 1, maxSag_m: 0.005 },
    ),
    [
      [0, 0, 0],
      [4, 0, 0],
    ],
  );
  assert.throws(() => segmentCurve([[0, 0, 0]], { maxLen_m: 1, maxSag_m: 0.005 }));
});

test('design length helpers: beams, cantilevers and columns', () => {
  const beam = designForBeam({
    segments: [{ length_m: 3 }, { length_m: 3 }],
    ends: ['pinned', 'pinned'],
    bracedAt: [0.5],
  });
  assert.deepEqual(beam.segments, [
    { Lb_m: 3, K2: 1, K3: 2, Cb: 1 },
    { Lb_m: 3, K2: 1, K3: 2, Cb: 1 },
  ]);
  const arm = designForBeam({
    segments: [{ length_m: 2 }],
    ends: ['rigid', 'pinned'],
    cantilever: true,
  });
  assert.deepEqual(arm.segments, [{ Lb_m: 2, K2: 2, K3: 2, Cb: 1 }]);
  const column = designForColumn({
    segments: [
      { z0_m: 0, z1_m: 3 },
      { z0_m: 3, z1_m: 6 },
    ],
    restraintZ_m: [],
    swayK: 2,
  });
  assert.deepEqual(column.segments, [
    { Lb_m: 6, K2: 4, K3: 4, Cb: 1 },
    { Lb_m: 6, K2: 4, K3: 4, Cb: 1 },
  ]);
  const braced = designForColumn({ segments: [{ z0_m: 0, z1_m: 6 }], restraintZ_m: [6], swayK: 2 });
  assert.deepEqual(braced.segments, [{ Lb_m: 6, K2: 1, K3: 1, Cb: 1 }]);
  assert.ok(Math.abs(sectionArea_mm2(H300) - 11980) / 11980 < 0.01, 'KS table area');
});
