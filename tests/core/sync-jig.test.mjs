import test from 'node:test';
import assert from 'node:assert/strict';
import { runSync, align, elements } from '../../src/jigs/sync.ts';

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
