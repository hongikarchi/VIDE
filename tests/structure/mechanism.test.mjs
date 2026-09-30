// Joint rules that keep cantilevers and hinge joints stable, and the mechanism pre-check
// (PLAN-23 T-053 leftover). Synthetic plans only.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFrameModel,
  findMechanisms,
  mechanismIssues,
  runAnalysis,
} from '../../src/jigs/official/structure-analysis/index.ts';
import { bayPlan } from './frame-fixtures.mjs';

const segmentsOf = (build, key) => {
  const byId = new Map(build.model.members.map((m) => [m.id, m]));
  return build.map.physical[key].map((id) => byId.get(id));
};
const nodeAt = (model, [x, y, z]) =>
  model.nodes.find((n) => Math.hypot(n.xyz_m[0] - x, n.xyz_m[1] - y, n.xyz_m[2] - z) < 1e-6).id;

test('a cantilever rooted at a column off its strong axis stays rigid at the root', () => {
  const plan = bayPlan();
  // Column strong axes are X; the arm leaves the corner column along −Y (weak axis) and the
  // plan even asks for a pinned root.
  plan.members.push({
    key: 'A-1',
    role: 'arm',
    rail: [
      [0, 0, 6],
      [0, -2, 6],
    ],
    section: 'H400',
    ends: ['pinned', 'rigid'],
  });
  plan.lineLoads.push({ memberKey: 'A-1', case: 'D', value_kNpm: 4, source: 'edge' });
  const build = buildFrameModel(plan);
  const [arm] = segmentsOf(build, 'A-1');
  assert.equal(arm.releases, undefined, 'no release on the arm');
  assert.ok(build.assumptions.some((a) => a.includes('내민 부재 1개')));
  assert.deepEqual(findMechanisms(build.model), []);
  const { summary } = runAnalysis(build.model, build.map, { mode: 'confirmed', stability: true });
  assert.equal(summary.status, 'ok', JSON.stringify(summary.issues));
});

test('a joint where only pinned ends meet is spliced: two members stay continuous', () => {
  const plan = bayPlan();
  // Two secondary beams meet end to end at mid-bay with nothing else there.
  for (const [key, a, b] of [
    ['B-a', [1, 0, 6], [1, 2.5, 6]],
    ['B-b', [1, 2.5, 6], [1, 5, 6]],
  ])
    plan.members.push({
      key,
      role: 'beam',
      rail: [a, b],
      section: 'H400',
      ends: ['pinned', 'pinned'],
    });
  plan.lineLoads.push({ memberKey: 'B-a', case: 'L', value_kNpm: 5, source: 'area' });
  const build = buildFrameModel(plan);
  const mid = nodeAt(build.model, [1, 2.5, 6]);
  const [a] = segmentsOf(build, 'B-a');
  const [b] = segmentsOf(build, 'B-b');
  assert.equal(a.j, mid);
  assert.equal(a.releases?.j, undefined, 'B-a continuous at the splice');
  assert.equal(b.releases?.i, undefined, 'B-b continuous at the splice');
  assert.ok(a.releases.i && b.releases.j, 'girder ends stay pinned');
  assert.ok(build.assumptions.some((t) => t.includes('모든 단부가 핀인 절점 1곳')));
  const { summary } = runAnalysis(build.model, build.map, { mode: 'confirmed', stability: true });
  assert.equal(summary.status, 'ok', JSON.stringify(summary.issues));
});

test('pre-check: a hinged cantilever stops the run with its nodes; a released tip warns', () => {
  const build = buildFrameModel(bayPlan());
  const model = structuredClone(build.model);
  // Hand-made arm off the corner column top with a hinge at its root.
  const corner = nodeAt(model, [0, 0, 6]);
  model.nodes.push({ id: 'TIP', xyz_m: [0, -2, 6] });
  model.members.push({
    id: 'ARM',
    i: corner,
    j: 'TIP',
    section: 'H400',
    material: model.materials[0].id,
    role: 'beam',
    kind: 'frame',
    betaDeg: 0,
    releases: { i: { ry: true, rz: true } },
  });
  const found = findMechanisms(model);
  assert.deepEqual(found, [
    { kind: 'hinged-cantilever', nodes: ['TIP', corner], members: ['ARM'] },
  ]);
  const { summary } = runAnalysis(model, undefined, { mode: 'preview' });
  assert.equal(summary.status, 'unstable');
  const issue = summary.issues.find((i) => i.code === 'MECHANISM');
  assert.deepEqual(issue.nodes, ['TIP', corner]);
  assert.match(issue.message, /뿌리/);
  // A release at the free tip itself: a warning only. Along a global axis the core restrains the
  // loose rotation and the run is ok; a skew arm is a mechanism the core reports at the tip.
  model.members.at(-1).releases = { j: { ry: true, rz: true } };
  assert.deepEqual(
    mechanismIssues(model).map((i) => [i.level, i.code, i.nodes]),
    [['warning', 'RELEASED_TIP', ['TIP']]],
  );
  const straight = runAnalysis(model, undefined, { mode: 'preview' }).summary;
  assert.equal(straight.status, 'ok', JSON.stringify(straight.issues));
  model.nodes.at(-1).xyz_m = [-1.4, -1.4, 6];
  const skew = runAnalysis(model, undefined, { mode: 'preview' }).summary;
  assert.equal(skew.status, 'unstable');
  assert.ok(skew.issues.some((i) => i.code === 'RELEASED_TIP'));
  assert.ok(skew.issues.some((i) => i.code === 'MECHANISM' && i.nodes.includes('TIP')));
});

test('pre-check: an arm held only by girder torsion is a warning; a backspan clears it', () => {
  const arm = {
    key: 'A-2',
    role: 'arm',
    rail: [
      [5, 0, 6],
      [5, -2, 6],
    ],
    section: 'H400',
    ends: ['rigid', 'rigid'],
  };
  // The arm roots on girder G-0 where secondary beam B-5 frames in pinned: only the girder's
  // twist holds the root moment.
  const plan = bayPlan();
  plan.members.push(arm);
  const build = buildFrameModel(plan);
  const root = nodeAt(build.model, [5, 0, 6]);
  const tip = nodeAt(build.model, [5, -2, 6]);
  const issues = mechanismIssues(build.model);
  assert.deepEqual(
    issues.map((i) => [i.level, i.code, i.nodes]),
    [['warning', 'TORSION_ROOT', [tip, root]]],
  );
  // B-5 made continuous over the girder: the arm has a backspan.
  const backed = bayPlan();
  backed.members = backed.members.map((m) =>
    m.key === 'B-5' ? { ...m, ends: ['rigid', 'pinned'] } : m,
  );
  backed.members.push(arm);
  assert.deepEqual(mechanismIssues(buildFrameModel(backed).model), []);
});
