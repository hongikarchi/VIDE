import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync, align, elements, sectionPlan } from '../../src/jigs/sync.ts';
import { sectionOutline } from '../../src/jigs/official/geometry-kit/index.ts';

// The same beams in a Rhino model (metres, offset by 125/48/3.2 m) and a CAD drawing (Z = 0).
const beams = [
  [0, 0, 6, 0],
  [0, 3, 6, 3],
  [0, 6, 6, 6.0008], // 0.8 mm off in the model
  [0, 9, 6, 9], // only in the model
];
const grid = [-1, -1, -1, 11.5]; // a unique grid line both have
const offset = [125, 48, 3.2];
const b64 = (s) => Buffer.from(s).toString('base64');
const rhinoResult = (turn = 0) => {
  const c = Math.cos(turn),
    s = Math.sin(turn);
  const at = (x, y) => [c * x - s * y + offset[0], s * x + c * y + offset[1], offset[2]];
  const rows = [...beams, grid].map(([x0, y0, x1, y1], i) => ({
    id: 'r' + i,
    nativeId: 'r' + i,
    nativeType: 'Curve',
    line: [...at(x0, y0), ...at(x1, y1)],
    layer64: b64(i === 4 ? 'GRID' : '구조::girder'),
  }));
  return { scene: rows, objects: rows.map((r, i) => ({ id: r.id, name: 'B' + (i + 1) })) };
};
const cadResult = {
  scene: [...beams.slice(0, 2), [0, 6, 6, 6], grid].map(([x0, y0, x1, y1], i) => ({
    id: 'cad-' + (20 + i),
    nativeId: String(20 + i),
    nativeType: 'Line',
    segments: [x0, y0, 0, x1, y1, 0],
    layer64: b64(i === 3 ? 'X-GRID' : 'S-BEAM'),
  })),
};

test('the relation between a model and a drawing with different origins is computed', () => {
  const result = runSync(rhinoResult(), cadResult, { tolerance: 0.0005 });
  const a = result.alignment;
  assert.equal(a.source, 'computed');
  assert.equal(a.ambiguous, false);
  assert.ok(Math.abs(a.rotation) < 1e-6);
  assert.ok(Math.abs(a.translation[0] + 125) < 1e-6, String(a.translation));
  assert.ok(Math.abs(a.translation[1] + 48) < 1e-3);
  assert.ok(Math.abs(a.dz + 3.2) < 1e-9);
  assert.ok(a.pairs >= 3);
  assert.ok(a.residual.max < 0.001);
  // Mismatches first: the 0.8 mm beam, the beam only in the model.
  const [first, second] = result.rows;
  assert.equal(first.state, 'offset');
  assert.equal(first.rhino.name, 'B3');
  assert.equal(first.cad.nativeId, '22');
  assert.ok(Math.abs(first.deviation - 0.0008) < 1e-6);
  // The drawing's beam in model coordinates, for making the model follow the drawing.
  assert.deepEqual(
    first.inRhino.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6)),
    [
      [125, 54, 3.2],
      [131, 54, 3.2],
    ],
  );
  assert.equal(second.state, 'rhino-only');
  assert.equal(second.rhino.name, 'B4');
  assert.deepEqual(result.summary, { match: 3, offset: 1, rhinoOnly: 1, cadOnly: 0 });
  assert.deepEqual(result.layers[0], { rhino: '구조::girder', cad: 'S-BEAM', pairs: 3 });
  assert.equal(result.rows[0].id, 'R1');
});

test('a rotated model is aligned too', () => {
  const turn = (30 * Math.PI) / 180;
  const result = runSync(rhinoResult(turn), cadResult, { tolerance: 0.0005 });
  assert.ok(
    Math.abs(Math.abs(result.alignment.rotation) - turn) < 1e-3 ||
      Math.abs(Math.abs(result.alignment.rotation) - (Math.PI - turn)) < 1e-3,
    String(result.alignment.rotation),
  );
  assert.equal(result.summary.match, 3);
  assert.equal(result.summary.offset, 1);
});

test('evenly repeated beams without a reference are reported as ambiguous; an anchor settles it', () => {
  const noGrid = { scene: rhinoResult().scene.slice(0, 4), objects: rhinoResult().objects };
  const cadNoGrid = { scene: cadResult.scene.slice(0, 3) };
  const loose = align(elements(noGrid, 'rhino'), elements(cadNoGrid, 'zwcad'), {});
  assert.equal(loose.ambiguous, true);
  assert.ok(loose.candidates.length >= 2);
  const fixed = runSync(noGrid, cadNoGrid, {
    anchor: { rhino: 'r0', cad: '20' },
    tolerance: 0.0005,
  });
  assert.equal(fixed.alignment.source, 'anchor');
  assert.ok(Math.abs(fixed.alignment.translation[1] + 48) < 1e-3);
  assert.equal(fixed.summary.rhinoOnly, 1);
});

test('a side without straight elements says what it read (T-283)', () => {
  const solids = {
    scene: [
      ...[0, 1, 2].map((i) => ({
        id: 'b' + i,
        nativeType: 'Brep',
        vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0],
        indices: [0, 1, 2],
        layer64: b64('철골'),
      })),
      { id: 'i0', nativeType: 'InstanceReference', layer64: b64('3D') },
    ],
  };
  const result = runSync(solids, cadResult, {});
  assert.equal(result.counts.rhino, 0);
  assert.deepEqual(result.rhinoLayers, []);
  assert.deepEqual(result.read.rhino, {
    objects: 4,
    comparable: 0,
    rules: { curves: 0, sections: 0, solids: 0 },
    skipped: [
      { type: 'Brep', count: 3 },
      { type: 'InstanceReference', count: 1 },
    ],
  });
  assert.equal(result.read.cad.objects, 4);
  assert.equal(result.read.cad.comparable, 4);
  // Nothing stored at all (a pruned or empty Sync) reads as 0 objects.
  assert.equal(runSync({ scene: [] }, cadResult, {}).read.rhino.objects, 0);
  // Chosen layers without elements: the Sync still has comparable elements elsewhere.
  const picked = runSync(rhinoResult(), cadResult, { rhinoLayers: ['없음'] });
  assert.equal(picked.counts.rhino, 0);
  assert.equal(picked.read.rhino.comparable, 5);
});

// T-283 (SPEC-05.8, 2026-10-14): Rhino solids are compared through their plan section outline.
// A box as Sync sends a Brep: one render mesh per face, so the seams repeat vertices. `split`
// cuts the front face in two (a seam vertex mid-edge, merged back into one straight edge).
function box([x0, y0, z0], [x1, y1, z1], split = false) {
  const vertices = [],
    indices = [];
  const quad = (...corners) => {
    const o = vertices.length / 3;
    for (const c of corners) vertices.push(...c);
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  const xm = (x0 + x1) / 2;
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  if (split) {
    quad([x0, y0, z0], [xm, y0, z0], [xm, y0, z1], [x0, y0, z1]);
    quad([xm, y0, z0], [x1, y0, z0], [x1, y0, z1], [xm, y0, z1]);
  } else quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  return { vertices, indices };
}
const solidRow = (id, lo, hi, extra = {}) => ({
  id,
  nativeId: 'n-' + id,
  nativeType: 'Brep',
  ...box(lo, hi, extra.split),
  origin: lo,
  boundsSize: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  layer64: b64('구조'),
  ...(extra.hash ? { geometryHash: extra.hash } : {}),
});
// Column 400×400×3400 at the origin, beam 300×500 under the slab (z 2.9–3.4), a LEVEL point at 0.
const column = solidRow('col', [-0.2, -0.2, 0], [0.2, 0.2, 3.4], { split: true });
const beam = solidRow('beam', [0.2, -0.15, 2.9], [6.2, 0.15, 3.4]);
const level = {
  id: 'lv',
  nativeId: 'n-lv',
  nativeType: 'Point',
  origin: [0, 0, 0],
  boundsSize: [0, 0, 0],
  layer64: b64('기준::LEVEL'),
};
const lengths = (list) => list.map((e) => Math.round(e.length * 1000) / 1000).sort((a, b) => a - b);

test('a box mesh cut at 1.2 m gives its four outline edges (seams merged)', () => {
  const cut = sectionOutline(column.vertices, column.indices, 1.2);
  assert.equal(cut.loops.length, 1);
  assert.equal(cut.closed[0], true);
  assert.equal(cut.edges.length, 4);
  for (const [a, b] of cut.edges) {
    assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.4) < 1e-9);
    assert.equal(a[2], 1.2);
  }
  // Below or above the solid there is nothing.
  assert.equal(sectionOutline(column.vertices, column.indices, 3.5).edges.length, 0);
});

test('Rhino solids are compared by their section at level + 1.2 m, or the chosen height', () => {
  const model = { scene: [level, column, beam], objects: [{ id: 'col', name: 'C1' }] };
  assert.deepEqual(sectionPlan(model), { heights: [1.2], source: 'levels', levels: [0] });
  const atLevel = elements(model, 'rhino', undefined, undefined, sectionPlan(model));
  // The beam lies above 1.2 m: only the column's four edges.
  assert.equal(atLevel.length, 4);
  assert.deepEqual(lengths(atLevel), [0.4, 0.4, 0.4, 0.4]);
  assert.ok(atLevel.every((e) => e.rule === 'section' && e.height === 1.2 && e.object === 'col'));
  assert.equal(atLevel[0].name, 'C1');
  // The person's height cuts the beam too.
  const high = elements(model, 'rhino', undefined, undefined, sectionPlan(model, 3.2));
  assert.deepEqual(lengths(high), [0.3, 0.3, 0.4, 0.4, 0.4, 0.4, 6, 6]);
  // Without levels: the middle of the solids' height range (0–3.4 → 1.7).
  const noLevel = { scene: [column, beam] };
  assert.deepEqual(sectionPlan(noLevel), { heights: [1.7], source: 'range', levels: [] });

  // A drawing with three edges of the column: the relation and the pairs come from the section.
  const cad = {
    scene: [
      [-0.2, -0.2, 0.2, -0.2],
      [-0.2, -0.2, -0.2, 0.2],
      [0.2, -0.2, 0.2, 0.2],
    ].map(([x0, y0, x1, y1], i) => ({
      id: 'c' + i,
      nativeId: String(30 + i),
      nativeType: 'Line',
      segments: [x0 + 10, y0 + 20, 0, x1 + 10, y1 + 20, 0],
      layer64: b64('S-COL'),
    })),
  };
  const result = runSync(model, cad, { tolerance: 0.0005 });
  assert.deepEqual(result.section, { heights: [1.2], source: 'levels', levels: [0] });
  assert.equal(result.counts.rhino, 4);
  assert.deepEqual(result.read.rhino.rules, { curves: 0, sections: 4, solids: 1 });
  assert.equal(result.read.rhino.skipped.find((t) => t.type === 'Brep')?.count, 1); // the beam
  assert.ok(Math.abs(result.alignment.translation[0] - 10) < 1e-6);
  assert.ok(Math.abs(result.alignment.translation[1] - 20) < 1e-6);
  assert.ok(Math.abs(result.alignment.dz + 1.2) < 1e-9);
  assert.deepEqual(result.summary, { match: 3, offset: 0, rhinoOnly: 1, cadOnly: 0 });
  const pair = result.rows.find((row) => row.state === 'match');
  assert.deepEqual(
    {
      id: pair.rhino.id,
      nativeId: pair.rhino.nativeId,
      rule: pair.rhino.rule,
      h: pair.rhino.height,
    },
    { id: 'col', nativeId: 'n-col', rule: 'section', h: 1.2 },
  );
  assert.deepEqual(result.layers, [{ rhino: '구조', cad: 'S-COL', pairs: 3 }]);
});

test('3,000 solids are cut and compared well under 10 s (cached per geometry and height)', (t) => {
  const scene = [],
    lines = [];
  for (let i = 0; i < 3000; i++) {
    const x = (i % 60) * 1.7,
      y = Math.floor(i / 60) * 2.3;
    scene.push(solidRow('s' + i, [x, y, 0], [x + 0.4, y + 0.6, 3.4], { hash: 'h' + i }));
    lines.push({
      id: 'l' + i,
      nativeId: String(i),
      nativeType: 'Line',
      segments: [x + 5, y + 7, 0, x + 5.4, y + 7, 0],
      layer64: b64('S-COL'),
    });
  }
  const model = { scene },
    drawing = { scene: lines };
  const time = () => {
    const start = performance.now();
    const result = runSync(model, drawing, {});
    return { ms: performance.now() - start, result };
  };
  const cold = time();
  const warm = time();
  t.diagnostic(`3,000 solids: cold ${cold.ms.toFixed(0)} ms, cached ${warm.ms.toFixed(0)} ms`);
  console.log(
    `# sync section 3,000 solids: cold ${cold.ms.toFixed(0)} ms, cached ${warm.ms.toFixed(0)} ms`,
  );
  assert.equal(cold.result.counts.rhino, 12000);
  assert.equal(cold.result.read.rhino.rules.solids, 3000);
  assert.ok(cold.ms < 10000, `cold ${cold.ms} ms`);
  assert.ok(warm.ms < 10000, `cached ${warm.ms} ms`);
});
