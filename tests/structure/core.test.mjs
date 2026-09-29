import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { analyzeStructure } from '../../src/jigs/structure/core.ts';
import { structureModelSchema } from '../../src/contracts/structure-model.ts';
import { fixtures, baseModel, H400, SM355 } from './fixtures.mjs';

const close = (actual, expected, { rel = 1e-6, abs = 1e-9 } = {}, label = '') =>
  assert.ok(
    Math.abs(actual - expected) <= Math.max(abs, rel * Math.abs(expected)),
    `${label}: ${actual} vs ${expected}`,
  );

for (const fixture of fixtures) {
  test(`closed form · ${fixture.id}`, () => {
    const result = analyzeStructure(fixture.model);
    for (const e of fixture.expect) {
      const tol = { rel: e.rel ?? 1e-6, abs: e.abs ?? 1e-9 };
      if (e.kind === 'status') assert.equal(result.status, e.value, result.error);
      else if (e.kind === 'mechanism')
        assert.ok(result.diagnostics.mechanisms.length > 0, 'mechanism reported');
      else if (e.kind === 'autoRestrained')
        assert.ok(result.diagnostics.autoRestrained.length >= e.min);
      else {
        assert.equal(result.status, 'ok', result.error);
        if (e.kind === 'force')
          close(
            result.members[e.member].forces[e.combo][e.station][e.component],
            e.value,
            tol,
            `${e.member} ${e.component}`,
          );
        if (e.kind === 'disp')
          close(result.nodes[e.node].disp[e.combo][e.dof], e.value, tol, `${e.node} disp ${e.dof}`);
        if (e.kind === 'reaction')
          close(
            result.nodes[e.node].reaction[e.combo][e.dof],
            e.value,
            tol,
            `${e.node} reaction ${e.dof}`,
          );
        if (e.kind === 'deflection')
          close(
            result.members[e.member].deflection_mm[e.combo],
            e.value,
            tol,
            `${e.member} deflection`,
          );
      }
    }
    if (result.status === 'ok')
      for (const eq of result.diagnostics.equilibrium)
        assert.ok(eq.error_rel < 1e-9, `equilibrium ${eq.combo}`);
  });
}

const frameDir = new URL('./frames/', import.meta.url);
const frames = readdirSync(frameDir).filter((f) => f.endsWith('.json'));

for (const file of frames) {
  test(`PyNite cross-check · ${file}`, () => {
    const { model, expected, source } = JSON.parse(readFileSync(new URL(file, frameDir), 'utf8'));
    assert.match(source, /PyNite/);
    const result = analyzeStructure(model);
    assert.equal(result.status, 'ok', result.error);
    for (const [node, combos] of Object.entries(expected.disp))
      for (const [combo, values] of Object.entries(combos)) {
        const scale = Math.max(...values.map(Math.abs), 1e-9);
        values.forEach((v, d) =>
          close(
            result.nodes[node].disp[combo][d],
            v,
            { rel: 1e-6, abs: 1e-7 * scale },
            `${file} ${node} ${combo} d${d}`,
          ),
        );
      }
    for (const [node, combos] of Object.entries(expected.reaction))
      for (const [combo, values] of Object.entries(combos)) {
        const scale = Math.max(...values.map(Math.abs), 1e-9);
        values.forEach((v, d) =>
          close(
            result.nodes[node].reaction[combo][d],
            v,
            { rel: 1e-6, abs: 1e-7 * scale },
            `${file} ${node} ${combo} r${d}`,
          ),
        );
      }
  });
}

const frame = (name) => JSON.parse(readFileSync(new URL(`${name}.json`, frameDir), 'utf8')).model;

test('superposition: a factored combination equals the sum of pattern results', () => {
  const result = analyzeStructure(frame('portal'));
  for (const node of Object.keys(result.nodes))
    for (let d = 0; d < 6; d++) {
      const { D, W, U } = result.nodes[node].disp;
      close(U[d], 1.2 * D[d] + W[d], { rel: 1e-9, abs: 1e-15 }, `${node} ${d}`);
    }
});

test('node order does not change results', () => {
  const model = frame('two-story');
  const a = analyzeStructure(model);
  const b = analyzeStructure({
    ...model,
    nodes: [...model.nodes].reverse(),
    members: [...model.members].reverse(),
  });
  for (const node of Object.keys(a.nodes))
    for (let d = 0; d < 6; d++)
      close(
        b.nodes[node].disp.C1[d],
        a.nodes[node].disp.C1[d],
        { rel: 1e-9, abs: 1e-15 },
        `${node} ${d}`,
      );
});

test('rigid rotation about Z keeps member force magnitudes under gravity', () => {
  const model = frame('two-story');
  const gravityOnly = {
    ...model,
    loads: model.loads.filter((l) => l.direction === '-Z'),
    combinations: [{ id: 'G', terms: [{ pattern: 'D', factor: 1 }], limitState: 'strength' }],
  };
  const t = (37 * Math.PI) / 180;
  const rotated = {
    ...gravityOnly,
    nodes: gravityOnly.nodes.map((n) => ({
      ...n,
      xyz_m: [
        n.xyz_m[0] * Math.cos(t) - n.xyz_m[1] * Math.sin(t),
        n.xyz_m[0] * Math.sin(t) + n.xyz_m[1] * Math.cos(t),
        n.xyz_m[2],
      ],
    })),
  };
  const a = analyzeStructure(gravityOnly);
  const b = analyzeStructure(rotated);
  const mag = (f) => [f.N, f.T, Math.hypot(f.V2, f.V3), Math.hypot(f.M2, f.M3)];
  for (const [id, m] of Object.entries(a.members))
    m.forces.G.forEach((f, s) =>
      mag(f).forEach((v, k) =>
        close(mag(b.members[id].forces.G[s])[k], v, { rel: 1e-7, abs: 1e-8 }, `${id} ${s} ${k}`),
      ),
    );
});

test('a symmetric portal under gravity has symmetric base reactions', () => {
  const model = frame('portal');
  const result = analyzeStructure({ ...model, combinations: [model.combinations[0]] });
  const [l, r] = [result.nodes.BL.reaction.D, result.nodes.BR.reaction.D];
  close(l[2], r[2], { rel: 1e-9 }, 'vertical');
  close(l[0], -r[0], { rel: 1e-9, abs: 1e-12 }, 'horizontal');
});

// Member checks (KDS 14 31 10 / AISC 360 structure).
const beam = (w, extra = {}) =>
  baseModel({
    nodes: [
      { id: 'N1', xyz_m: [0, 0, 0], support: { dx: true, dy: true, dz: true, rx: true } },
      { id: 'N2', xyz_m: [8, 0, 0], support: { dy: true, dz: true } },
    ],
    members: [
      {
        id: 'B1',
        i: 'N1',
        j: 'N2',
        section: 'H400',
        material: 'SM355',
        role: 'beam',
        kind: 'frame',
        ...extra,
      },
    ],
    loadPatterns: [
      { id: 'D', nature: 'D' },
      { id: 'L', nature: 'L' },
    ],
    loads: [
      {
        id: 'd',
        pattern: 'D',
        type: 'memberUniform',
        targets: ['B1'],
        direction: '-Z',
        value_kNpm: w,
      },
      {
        id: 'l',
        pattern: 'L',
        type: 'memberUniform',
        targets: ['B1'],
        direction: '-Z',
        value_kNpm: w,
      },
    ],
    combinations: [
      {
        id: 'U',
        terms: [
          { pattern: 'D', factor: 1.2 },
          { pattern: 'L', factor: 1.6 },
        ],
        limitState: 'strength',
      },
      {
        id: 'S',
        terms: [
          { pattern: 'D', factor: 1 },
          { pattern: 'L', factor: 1 },
        ],
        limitState: 'service',
      },
    ],
  });

test('member check reports the factored moment, clause values and a pass/fail status', () => {
  const light = analyzeStructure(beam(5));
  const check = light.checks.find((c) => c.member === 'B1');
  const flexure = check.parts.find((p) => p.clause.startsWith('F2'));
  close(flexure.values.Mu_kNm, (2.8 * 5 * 64) / 8, { rel: 1e-9 }, 'Mu');
  assert.ok(
    flexure.values.Cb > 1.1 && flexure.values.Cb < 1.2,
    `Cb for a uniform simple span ≈ 1.14, got ${flexure.values.Cb}`,
  );
  assert.ok(check.parts.some((p) => p.clause === '처짐'));
  assert.equal(check.status, 'pass');
  assert.ok(light.notChecked.length > 0);
  const heavy = analyzeStructure(beam(60));
  assert.equal(heavy.checks[0].status, 'fail');
  assert.equal(heavy.summary.failCount, 1);
});

test('a section the checks do not cover is incomplete, not pass', () => {
  // Load small enough that deflection passes; a real failure would outrank incomplete.
  const model = beam(0.01);
  model.sections = [
    {
      id: 'H400',
      name: 'angle',
      shape: 'L',
      dims_mm: { h: 100, b: 100, t: 10 },
      source: 'user',
      props: { A_mm2: 1900, I2_mm4: 1.75e6, I3_mm4: 1.75e6, J_mm4: 6.3e4 },
    },
  ];
  const result = analyzeStructure(model);
  assert.equal(result.checks[0].status, 'incomplete');
});

test('the contract rejects dangling references and duplicate ids', () => {
  const bad = baseModel({
    nodes: [
      { id: 'N1', xyz_m: [0, 0, 0] },
      { id: 'N1', xyz_m: [1, 0, 0] },
    ],
    members: [
      {
        id: 'B',
        i: 'N1',
        j: 'NX',
        section: 'H400',
        material: 'SM355',
        role: 'beam',
        kind: 'frame',
      },
    ],
  });
  const parsed = structureModelSchema.safeParse(bad);
  assert.equal(parsed.success, false);
  const messages = parsed.error.issues.map((i) => i.message).join(' | ');
  assert.match(messages, /duplicate node/);
  assert.match(messages, /NX missing/);
  assert.ok(H400 && SM355);
});

test('B1 for a pinned column with a transverse load is 1 / (1 − Pr/Pe1) with Cm = 1', () => {
  const L = 6,
    P = 500;
  const model = baseModel({
    nodes: [
      { id: 'B', xyz_m: [0, 0, 0], support: { dx: true, dy: true, dz: true, rz: true } },
      { id: 'T', xyz_m: [0, 0, L], support: { dx: true, dy: true } },
    ],
    members: [
      {
        id: 'C',
        i: 'B',
        j: 'T',
        section: 'H400',
        material: 'SM355',
        role: 'column',
        kind: 'frame',
      },
    ],
    loads: [
      { id: 'p', pattern: 'D', type: 'nodePoint', targets: ['T'], direction: '-Z', value_kN: P },
      {
        id: 'h',
        pattern: 'D',
        type: 'memberPoint',
        targets: ['C'],
        direction: '+X',
        value_kN: 10,
        position: 0.5,
      },
    ],
    combinations: [{ id: 'U', terms: [{ pattern: 'D', factor: 1 }], limitState: 'strength' }],
  });
  const result = analyzeStructure(model);
  assert.equal(result.status, 'ok', result.error);
  const h1 = result.checks[0].parts.find((p) => p.clause.startsWith('H1-1'));
  // Vertical member: local 2 = +X, so the +X load bends the strong axis (I3).
  const pe1 = (Math.PI ** 2 * 205000e3 * 2.37e8 * 1e-12) / L ** 2;
  close(h1.values.B1_3, 1 / (1 - P / pe1), { rel: 1e-9 }, 'B1_3');
  assert.equal(h1.values.Cm3, 1);
});
