// vide/paneling-kit stage 1 (PLAN-49 T-252, SPEC-16.2·16.4·16.5): synthetic sampled faces → the
// panel layout. Numbering P-<row>-<col> from the start corner, outlines counter-clockwise from the
// reference normal starting at the start-corner side, arc length vs equal parameter steps, the cut
// end opposite the start corner, staggered / diamond / triangle cells, closed seams, poles, folded
// projections, trim holes with shared lattice keys, the three boundary rules, determinism, the panel
// cap and the 5,000-panel time. Synthetic data only; no host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  layoutPanels,
  previewSettingsFromParams,
  previewStep,
  resolvePreviewSettings,
  fingerprint,
  RECOMMENDED_PREVIEW,
  RECOMMENDED_MEMBERS,
  RECOMMENDED_OPTIMIZE,
} from '../../src/jigs/official/paneling-kit/index.ts';
import { makeAllowed, panelLayoutSchema, stageConfirmed } from '../../src/contracts/paneling.ts';
import { JigRegistry, officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { selftestJig, validateJig } from '../../src/jigs/runtime/pack.ts';
import { JIGS } from '../../src/jigs/catalog.ts';
import { faceSampler } from '../../src/jigs/official/paneling-kit/sample.ts';
import {
  closedCylinder,
  cylinderBand,
  foldedArc,
  hypar,
  plane,
  previewSettings,
  sampleFace,
  sampleOf,
  sphereBand,
} from '../fixtures/paneling-surfaces.mjs';

const MM = 0.001;
const lay = (face, over = {}) => {
  const result = layoutPanels(sampleOf(face), previewSettings(over));
  assert.equal(result.ok, true, JSON.stringify(result));
  const parsed = panelLayoutSchema.safeParse(result.layout);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues?.slice(0, 3)));
  return result.layout;
};
const byId = (layout) => Object.fromEntries(layout.panels.map((p) => [p.id, p]));
const round = (xs) => xs.map((p) => p.map((x) => Math.round(x * 1e6) / 1e6 + 0));
const ccwFromZ = (corners) => {
  let a = 0;
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i],
      q = corners[(i + 1) % corners.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0;
};

test('plane 2.4 × 1.2 m with 1.2 × 0.6: four panels P-1-1…P-2-2, counter-clockwise from the start corner', () => {
  const layout = lay(plane(2.4, 1.2, { paramScale: 1000 }));
  assert.deepEqual(
    layout.panels.map((p) => p.id),
    ['P-1-1', 'P-1-2', 'P-2-1', 'P-2-2'],
  );
  const p = byId(layout);
  assert.deepEqual(round(p['P-1-1'].corners), [
    [0, 0, 0],
    [1.2, 0, 0],
    [1.2, 0.6, 0],
    [0, 0.6, 0],
  ]);
  assert.deepEqual(round(p['P-1-2'].corners)[0], [1.2, 0, 0], 'columns run along the pattern axis');
  assert.deepEqual(round(p['P-2-1'].corners)[0], [0, 0.6, 0], 'rows run across it');
  // UV stays in the face's own parameters (a mm domain here).
  assert.deepEqual(round(p['P-1-2'].uv), [
    [1200, 0],
    [2400, 0],
    [2400, 600],
    [1200, 600],
  ]);
  for (const panel of layout.panels) {
    assert.ok(ccwFromZ(panel.corners));
    assert.ok(Math.abs(panel.width - 1.2) < 1e-9 && Math.abs(panel.height - 0.6) < 1e-9);
    assert.ok(Math.abs(panel.area - 0.72) < 1e-9);
    assert.equal(panel.boundary, false);
  }
  assert.deepEqual(layout.counts, {
    total: 4,
    boundary: 0,
    pole: 0,
    failed: 0,
    dropped: 0,
    offTarget: 0,
  });
  assert.deepEqual(layout.module, [1.2, 0.6]);
  // Neighbours share their vertices by key (SPEC-16.5 5).
  assert.deepEqual(p['P-1-1'].vertexKeys.slice(1, 3), [
    p['P-1-2'].vertexKeys[0],
    p['P-1-2'].vertexKeys[3],
  ]);
  assert.equal(p['P-2-2'].vertexKeys[0], p['P-1-1'].vertexKeys[2]);
});

test('start corner, axis and 뒤집기 change numbering and vertex order (SPEC-16.5 2, 16.10)', () => {
  const face = plane(2.4, 1.2);
  const fromMax = byId(
    lay(face, { direction: { axis: 'u', startCorner: 'max-min', flip: false } }),
  );
  assert.deepEqual(round(fromMax['P-1-1'].corners), [
    [2.4, 0, 0],
    [2.4, 0.6, 0],
    [1.2, 0.6, 0],
    [1.2, 0, 0],
  ]);
  assert.ok(ccwFromZ(fromMax['P-1-1'].corners), 'still counter-clockwise from the face normal');
  assert.deepEqual(round(fromMax['P-1-2'].corners)[0], [1.2, 0, 0]);

  const alongV = byId(
    lay(face, { size: [0.6, 1.2], direction: { axis: 'v', startCorner: 'min-min', flip: false } }),
  );
  assert.deepEqual(Object.keys(alongV).sort(), ['P-1-1', 'P-1-2', 'P-2-1', 'P-2-2']);
  assert.deepEqual(round(alongV['P-1-2'].corners)[0], [0, 0.6, 0], 'columns now run along V');
  assert.deepEqual(round(alongV['P-2-1'].corners)[0], [1.2, 0, 0]);
  assert.ok(Math.abs(alongV['P-1-1'].width - 0.6) < 1e-9, 'width is along the pattern axis');

  const flipped = byId(lay(face, { direction: { axis: 'u', startCorner: 'min-min', flip: true } }));
  assert.deepEqual(round(flipped['P-1-1'].corners), [
    [0, 0, 0],
    [0, 0.6, 0],
    [1.2, 0.6, 0],
    [1.2, 0, 0],
  ]);
  assert.equal(ccwFromZ(flipped['P-1-1'].corners), false, 'counter-clockwise from −Z');
});

test('arc length: on a cylinder band the size holds along the reference isocurves; equal parameter steps do not', () => {
  // Pattern axis V (straight, 6 m), panel height 0.6 m along the arc (R 8 m, non-uniform U).
  const face = cylinderBand(8, (2 * Math.PI) / 3, 6);
  const settings = {
    size: [1.2, 0.6],
    direction: { axis: 'v', startCorner: 'min-min', flip: false },
  };
  const arc = lay(face, settings);
  const inner = arc.panels.filter((p) => !p.boundary);
  assert.ok(inner.length > 50);
  for (const p of inner) {
    assert.ok(Math.abs(p.width - 1.2) <= 1 * MM, `${p.id} width ${p.width}`);
    assert.ok(Math.abs(p.height - 0.6) <= 1 * MM, `${p.id} height ${p.height}`);
  }
  assert.equal(arc.counts.offTarget, 0);
  // The arc between two grid lines on the reference isocurve is the target ±1 mm.
  const p = byId(arc)['P-1-1'];
  const angles = p.corners.map((c) => Math.atan2(c[1], c[0]));
  const arcLen = (Math.max(...angles) - Math.min(...angles)) * 8;
  assert.ok(Math.abs(arcLen - 0.6) <= 1 * MM, `arc ${arcLen}`);

  const param = lay(face, { ...settings, measure: 'parameter' });
  const L = (8 * 2 * Math.PI) / 3;
  const rows = Math.max(...param.panels.map((q) => q.row));
  assert.equal(rows, Math.round(L / 0.6), 'n = round(L / size)');
  assert.equal(param.counts.boundary, 0, 'equal steps leave no cut end');
  const heights = param.panels.map((q) => q.height);
  assert.ok(Math.max(...heights) - Math.min(...heights) > 0.2, 'sizes follow the parameter');
  assert.ok(param.counts.offTarget > 0, '목표와 다름 is reported');
});

test('equal parameter steps on a plane: n = round(L / size), every panel off target', () => {
  const layout = lay(plane(3.0, 1.2), { measure: 'parameter' });
  assert.equal(layout.counts.total, 6);
  assert.equal(layout.counts.boundary, 0);
  assert.equal(layout.counts.offTarget, 6, '1.0 m against 1.2 m is more than 15 % off');
  for (const p of layout.panels) assert.ok(Math.abs(p.width - 1.0) < 1e-9);
});

test('the remainder is a cut panel at the end opposite the start corner', () => {
  const layout = lay(plane(2.5, 1.2));
  const cut = layout.panels.filter((p) => p.boundary);
  assert.deepEqual(
    cut.map((p) => p.id),
    ['P-1-3', 'P-2-3'],
  );
  for (const p of cut) {
    assert.ok(Math.abs(p.width - 0.1) < 1e-9);
    assert.ok(p.corners.every((c) => c[0] >= 2.4 - 1e-9));
  }
  assert.ok(Math.abs(layout.sizeRange.minW - 0.1) < 1e-9);
  assert.ok(Math.abs(layout.sizeRange.area - 3) < 1e-9);
  const fromMax = lay(plane(2.5, 1.2), {
    direction: { axis: 'u', startCorner: 'max-min', flip: false },
  });
  for (const p of fromMax.panels.filter((q) => q.boundary))
    assert.ok(
      p.corners.every((c) => c[0] <= 0.1 + 1e-9),
      'now at the x = 0 end',
    );
});

test('staggered: even rows move w/2 and keep the T-junction points; diamond and triangle cells', () => {
  const stag = byId(lay(plane(2.4, 1.2), { pattern: 'staggered' }));
  // The shifted row starts with a cell reaching past the start corner: columns renumber from it.
  assert.deepEqual(Object.keys(stag).sort(), ['P-1-2', 'P-1-3', 'P-2-1', 'P-2-2', 'P-2-3']);
  const xs = (p) => p.corners.map((c) => c[0]);
  assert.deepEqual(
    [Math.min(...xs(stag['P-2-2'])), Math.max(...xs(stag['P-2-2']))].map((x) => +x.toFixed(9)),
    [0.6, 1.8],
  );
  assert.deepEqual(
    [Math.min(...xs(stag['P-1-2'])), Math.max(...xs(stag['P-1-2']))].map((x) => +x.toFixed(9)),
    [0, 1.2],
  );
  assert.equal(stag['P-2-2'].uv.length, 6);
  assert.equal(stag['P-2-1'].boundary, true);
  // The brick above shares the lower row's corner at x = 1.2 as a vertex of its long edge.
  const corner = stag['P-1-2'].corners.findIndex(
    (c) => Math.abs(c[0] - 1.2) < 1e-9 && Math.abs(c[1] - 0.6) < 1e-9,
  );
  assert.ok(corner >= 0);
  assert.ok(stag['P-2-2'].vertexKeys.includes(stag['P-1-2'].vertexKeys[corner]));

  const tri = byId(lay(plane(2.4, 1.2), { pattern: 'triangle' }));
  assert.equal(Object.keys(tri).length, 8);
  assert.deepEqual(round(tri['P-1-1a'].corners), [
    [0, 0, 0],
    [1.2, 0, 0],
    [1.2, 0.6, 0],
  ]);
  assert.deepEqual(round(tri['P-1-1b'].corners), [
    [0, 0, 0],
    [1.2, 0.6, 0],
    [0, 0.6, 0],
  ]);
  for (const p of Object.values(tri)) {
    assert.ok(Math.abs(p.width - 1.2) < 1e-9 && Math.abs(p.height - 0.6) < 1e-9);
    assert.ok(Math.abs(p.area - 0.36) < 1e-9);
  }

  const dia = lay(plane(2.4, 1.2), { pattern: 'diamond' });
  const whole = dia.panels.filter((p) => !p.boundary);
  assert.ok(whole.length >= 3);
  for (const p of whole) {
    assert.equal(p.uv.length, 4);
    assert.ok(Math.abs(p.width - 1.2) < 1e-9 && Math.abs(p.height - 0.6) < 1e-9);
    assert.ok(Math.abs(p.area - 0.36) < 1e-9);
  }
  assert.ok(
    Math.abs(dia.sizeRange.area - 2.88) < 1e-9,
    'diamonds and their cut halves tile the face',
  );
  assert.ok(
    dia.panels.some((p) => p.id === 'P-1-1'),
    'numbers start at 1 after shifting',
  );
});

test('closed cylinder: the count rounds to the circumference, no cut panel at the seam, keys wrap', () => {
  const layout = lay(closedCylinder(4, 6));
  const C = 2 * Math.PI * 4;
  assert.equal(layout.counts.boundary, 0);
  assert.equal(layout.counts.total, 21 * 10);
  assert.ok(Math.abs(layout.module[0] - C / 21) < 1e-3, `module ${layout.module[0]}`);
  assert.equal(layout.module[1], 0.6);
  const p = byId(layout);
  // The last column closes on the first one: shared keys across the seam.
  assert.deepEqual(
    [p['P-1-21'].vertexKeys[1], p['P-1-21'].vertexKeys[2]],
    [p['P-1-1'].vertexKeys[0], p['P-1-1'].vertexKeys[3]],
  );
  // Its UV runs past the domain end by less than a period (the maker wraps it).
  assert.ok(p['P-1-21'].uv.some((uv) => uv[0] > 2 * Math.PI - 1e-9));
  assert.ok(p['P-1-21'].uv.every((uv) => uv[0] <= 4 * Math.PI));
  // Staggered needs an even count.
  const stag = lay(closedCylinder(4, 6), { pattern: 'staggered' });
  assert.equal(stag.counts.boundary, 0);
  assert.ok(Math.abs(stag.module[0] - C / 22) < 1e-3);
});

test('sphere band: cells at the pole become triangles sharing one pole key', () => {
  const layout = lay(sphereBand(5));
  assert.ok(layout.counts.pole > 0);
  const poles = layout.panels.filter((p) => p.pole);
  assert.equal(poles.length, layout.counts.pole);
  for (const p of poles) {
    // A triangle on the surface, a quad in UV: the two pole vertices share the one pole key and
    // the one point, and each keeps the u of its edge, so both edges into the pole are meridians.
    assert.equal(p.uv.length, 4, p.id);
    assert.equal(p.vertexKeys.filter((k) => k === '0:p:vMax').length, 2, p.id);
    const distinct = new Set(p.corners.map((c) => c.map((x) => Math.round(x * 1e6) + 0).join()));
    assert.equal(distinct.size, 3, p.id);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const intoPole = (p.vertexKeys[i] === '0:p:vMax') !== (p.vertexKeys[j] === '0:p:vMax');
      if (intoPole) assert.ok(Math.abs(p.uv[i][0] - p.uv[j][0]) < 1e-12, `${p.id} meridian`);
    }
    assert.equal(p.failure, null);
  }
});

/** The largest distance on the surface between two panels along each edge they share (by keys),
 *  at ¼, ½ and ¾ of it; edges into a pole are told apart by their UV like the members do. */
function sharedEdgeGap(sample, layout) {
  const s = faceSampler(sample.faces[0]);
  const owners = new Map();
  for (const p of layout.panels) {
    if (p.failure) continue;
    const n = p.uv.length;
    for (let i = 0; i < n; i++) {
      const a = p.vertexKeys[i],
        b = p.vertexKeys[(i + 1) % n];
      if (a === b) continue;
      const fwd = a < b;
      const ua = fwd ? p.uv[i] : p.uv[(i + 1) % n],
        ub = fwd ? p.uv[(i + 1) % n] : p.uv[i];
      const pts = [0.25, 0.5, 0.75].map((l) =>
        s.point(ua[0] + (ub[0] - ua[0]) * l, ua[1] + (ub[1] - ua[1]) * l),
      );
      const key = fwd ? `${a}|${b}` : `${b}|${a}`;
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(pts);
    }
  }
  let worst = 0,
    pairs = 0;
  for (const list of owners.values())
    for (let x = 0; x < list.length; x++) {
      // Pair each edge with its closest same-key edge (a pole fan has several).
      let best = Infinity;
      for (let y = 0; y < list.length; y++) {
        if (x === y) continue;
        best = Math.min(
          best,
          Math.max(...list[x].map((q, k) => Math.hypot(...q.map((c, d) => c - list[y][k][d])))),
        );
      }
      if (Number.isFinite(best)) {
        worst = Math.max(worst, best);
        pairs++;
      }
    }
  return { worst, pairs };
}

test('sphere poles: shared edges into the pole lie on one curve for both panels (grid, diamond)', () => {
  // The reviewer's case: before, the pole vertex took one panel corner's UV, so the edge into the
  // pole was a UV diagonal and missed its neighbour by up to 18.5 mm (diamond: 24 failed 'area 0'
  // with a non-zero area).
  const sample = sampleOf(sphereBand(5, -Math.PI / 6, { nu: 97, nv: 49 }));
  for (const pattern of ['grid', 'diamond', 'triangle']) {
    const result = layoutPanels(sample, previewSettings({ pattern }));
    assert.equal(result.ok, true);
    const { worst, pairs } = sharedEdgeGap(sample, result.layout);
    assert.ok(pairs > 100, pattern);
    assert.ok(worst < 1e-6, `${pattern}: shared edges ${worst} m apart`);
    for (const p of result.layout.panels) {
      if (p.failure?.code === 'degenerate' && /넓이가 0/.test(p.failure.message))
        assert.equal(p.area, 0, `${p.id}: the failure says area 0, so the area is 0`);
      if (!p.failure) assert.ok(p.area > 0, p.id);
    }
    assert.equal(result.layout.counts.failed, 0, pattern);
  }
});

test('projected grid: a face folding over the plan fails those panels as folded-projection', () => {
  const layout = lay(foldedArc(3, 6), { measure: 'projected' });
  const folded = layout.panels.filter((p) => p.failure?.code === 'folded-projection');
  assert.ok(folded.length > 0);
  assert.equal(
    layout.counts.failed,
    layout.panels.filter((p) => p.failure).length,
    'failures are counted, never dropped',
  );
  // On a face that does not fold, the plan grid is 1 × 1 m in plan.
  const flat = lay(plane(4, 3), { measure: 'projected', size: [1, 1] });
  assert.equal(flat.counts.total, 12);
  assert.equal(flat.counts.boundary, 0);
  assert.equal(flat.counts.failed, 0);
});

test('trim hole: panels around it are boundary panels and neighbours share the cut points by key', () => {
  const layout = lay(hypar(), { size: [1.2, 0.6] });
  const cut = layout.panels.filter((p) => p.boundary);
  assert.ok(cut.length > 10);
  assert.ok(cut.every((p) => p.vertexKeys.some((k) => k.includes(':t:1:') || k.includes(':x:'))));
  const uses = new Map();
  for (const p of layout.panels)
    for (const [i, k] of p.vertexKeys.entries())
      if (k.includes(':x:')) uses.set(k, [...(uses.get(k) ?? []), p.corners[i]]);
  assert.ok(uses.size > 10);
  // A cut point is shared by both cells of its lattice edge, unless it lies on the face's own edge
  // or the other cell came out in two pieces (kept as its larger piece and failed, never silent).
  const split = layout.panels.filter((p) => p.failure?.code === 'degenerate');
  for (const [k, at] of uses) {
    if (at.length === 2) continue;
    const [x, y] = at[0];
    const onEdge = Math.min(Math.abs(x), Math.abs(x - 30), Math.abs(y), Math.abs(y - 20)) < 1e-6;
    assert.ok(onEdge || split.length > 0, `${k} used ${at.length}×`);
  }
  assert.equal(layout.counts.failed, split.length);
  // Nothing inside the hole (r 2.5 m around (15.3, 9.7) in plan).
  for (const p of layout.panels)
    for (const c of p.corners) assert.ok(Math.hypot(c[0] - 15.3, c[1] - 9.7) >= 2.5 - 0.01);
  const hole = Math.PI * 2.5 * 2.5;
  assert.ok(layout.sizeRange.area > 600 - hole && layout.sizeRange.area < 640);
});

test('boundary rules: merge joins a small cut panel to the longest-edge neighbour, drop lists it as dropped', () => {
  const merged = lay(plane(2.5, 1.2), { boundary: { rule: 'merge', mergeBelow: 0.3 } });
  assert.deepEqual(
    merged.panels.map((p) => [p.id, p.mergedFrom]),
    [
      ['P-1-1', []],
      ['P-1-2+1-3', ['P-1-3']],
      ['P-2-1', []],
      ['P-2-2+2-3', ['P-2-3']],
    ],
  );
  const m = byId(merged)['P-1-2+1-3'];
  assert.equal(m.boundary, true);
  assert.ok(Math.abs(m.width - 1.3) < 1e-9);
  assert.ok(Math.abs(m.area - 0.78) < 1e-9);
  // Above the share it stays cut.
  const kept = lay(plane(2.5, 1.2), { boundary: { rule: 'merge', mergeBelow: 0.05 } });
  assert.equal(kept.counts.total, 6);

  const dropped = lay(plane(2.5, 1.2), { boundary: { rule: 'drop', mergeBelow: 0.3 } });
  assert.equal(dropped.counts.dropped, 2);
  assert.equal(dropped.counts.total, 4);
  assert.equal(dropped.panels.length, 6, 'dropped panels keep their place in the list');
  assert.deepEqual(
    dropped.panels.filter((p) => p.failure?.code === 'dropped').map((p) => p.id),
    ['P-1-3', 'P-2-3'],
  );
  assert.ok(Math.abs(dropped.sizeRange.area - 2.88) < 1e-9);
});

test('same input twice: same numbers, keys and fingerprints; a setting change changes the settings hash', () => {
  const a = lay(hypar(), { size: [1.2, 0.6], pattern: 'staggered' });
  const b = lay(hypar(), { size: [1.2, 0.6], pattern: 'staggered' });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.deepEqual(
    a.panels.map((p) => p.id),
    b.panels.map((p) => p.id),
  );
  const c = lay(hypar(), { size: [1.2, 0.6], pattern: 'grid' });
  assert.equal(c.surfaceHash, a.surfaceHash);
  assert.notEqual(c.settingsHash, a.settingsHash);
  // Sources do not change the computation.
  const assumed = layoutPanels(sampleOf(hypar()), {
    ...previewSettings({ size: [1.2, 0.6], pattern: 'staggered' }),
    pattern: { value: 'staggered', source: 'assumed' },
  });
  assert.equal(assumed.layout.settingsHash, a.settingsHash);
});

test('stage failures: no panel, past the panel cap; empty settings take the 추천값 as assumed', () => {
  const none = layoutPanels(
    sampleOf(plane(0.5, 0.5)),
    previewSettings({ boundary: { rule: 'drop', mergeBelow: 0.3 } }),
  );
  assert.equal(none.ok, false);
  assert.equal(none.code, 'NO_PANELS');
  assert.match(none.message, /패널이 0개/);

  const many = layoutPanels(sampleOf(plane(100, 100)), previewSettings({ size: [0.5, 0.5] }));
  assert.equal(many.ok, false);
  assert.equal(many.code, 'TOO_MANY_PANELS');
  assert.match(many.message, /크기를 키우거나 면을 나누세요/);

  const empty = resolvePreviewSettings();
  for (const [key, setting] of Object.entries(empty)) {
    assert.equal(setting.source, 'assumed', key);
    assert.deepEqual(setting.value, RECOMMENDED_PREVIEW[key]);
  }
  assert.deepEqual(empty.size.value, [1.2, 0.6]);
  assert.equal(stageConfirmed(empty), false);
  assert.equal(
    makeAllowed('preview', { preview: empty }),
    true,
    'a preview may use assumed values',
  );
  const fromParams = previewSettingsFromParams({ pattern: 'diamond', width: 0.9, height: 0.45 }, [
    'height',
  ]);
  assert.deepEqual(fromParams.pattern, { value: 'diamond', source: 'person' });
  assert.deepEqual(fromParams.size, { value: [0.9, 0.45], source: 'assumed' });
  assert.equal(fromParams.measure.source, 'assumed');
  // The rest of SPEC-16.4 1's table, for the later stages.
  assert.equal(RECOMMENDED_MEMBERS.thickness, 0.05);
  assert.equal(RECOMMENDED_MEMBERS.joint, 0.01);
  assert.equal(RECOMMENDED_OPTIMIZE.flatnessTol, 0.003);
  assert.equal(RECOMMENDED_OPTIMIZE.maxTypes, null);
  // The step reports why.
  assert.throws(() => previewStep({}, {}), /기준 면이 없습니다/);
});

test('about 5,000 panels on a 128² sample: layout time (ARCH-03 §13 live 100 ms)', (t) => {
  const sample = sampleOf(hypar());
  const settings = previewSettings({ size: [0.34, 0.34] });
  layoutPanels(sample, settings); // warm up
  const times = [];
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    const result = layoutPanels(sample, settings);
    times.push(performance.now() - start);
    total = result.layout.counts.total;
  }
  times.sort((a, b) => a - b);
  const median = times[2];
  t.diagnostic(
    `${total} panels: median ${median.toFixed(1)} ms (${times.map((x) => x.toFixed(0)).join(', ')})`,
  );
  assert.ok(total >= 5000 && total <= 6000, `${total}`);
  assert.ok(median < 400, `median ${median} ms`);
});

test('the official jig is built in: registry, validation, self-test; J-07 available since T-258', async () => {
  const dir = join(officialJigRoot(), 'paneling');
  const registry = new JigRegistry({ dataDir: tmpdir() });
  const entry = (await registry.list()).find((e) => e.id === 'vide/paneling');
  assert.equal(entry?.stage, 'official');
  assert.equal(entry?.kind, 'tool');
  assert.deepEqual(
    (await validateJig(dir, { source: 'builtin' })).issues.filter((i) => i.level === 'error'),
    [],
  );
  const report = await selftestJig(dir, { source: 'builtin' });
  assert.deepEqual(
    report.cases.map((c) => [c.name, c.ok]),
    [
      ['plane-grid', true],
      ['plane-merge', true],
    ],
    JSON.stringify(report.cases.filter((c) => !c.ok)),
  );
  const j07 = JIGS.find((j) => j.code === 'J-07');
  assert.equal(j07.status, 'available');
});

test('projected grid on a C-shaped face: outlines counter-clockwise from the reference normal', () => {
  // The orientation was measured only at the middle of the (s, t) box; on a C or ring shape that
  // point is off the face and the default +1 left every outline clockwise.
  for (const span of [1.5, 0.5]) {
    const face = sampleFace(
      (u, v) => ({
        p: [v * Math.cos(u), v * Math.sin(u), 0.3 * Math.sin(u)],
        n: [0, 0, 1],
        k: [0, 0],
      }),
      { domainU: [0, span * Math.PI], domainV: [5, 9], nu: 96, nv: 24 },
    );
    const sample = sampleOf(face);
    const layout = lay(face, { measure: 'projected' });
    const s = faceSampler(sample.faces[0]);
    let checked = 0;
    for (const p of layout.panels) {
      if (p.failure) continue;
      const n = [0, 0, 0];
      p.corners.forEach((a, i) => {
        const b = p.corners[(i + 1) % p.corners.length];
        n[0] += (a[1] - b[1]) * (a[2] + b[2]);
        n[1] += (a[2] - b[2]) * (a[0] + b[0]);
        n[2] += (a[0] - b[0]) * (a[1] + b[1]);
      });
      const cu = p.uv.reduce((a, q) => a + q[0], 0) / p.uv.length;
      const cv = p.uv.reduce((a, q) => a + q[1], 0) / p.uv.length;
      const ref = s.normal(cu, cv);
      assert.ok(n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] > 0, `${span}π ${p.id}`);
      checked++;
    }
    assert.ok(checked > 50, `${span}π: ${checked}`);
  }
});

test('several faces: 목표와 다름 compares each panel with its own face module', () => {
  // A closed cylinder stretches its module to the girth; a plane beside it keeps the target. Each
  // face counted alone and together must agree (before, every face used face 0's module).
  const cyl = closedCylinder(1, 6, { faceIndex: 0 });
  const flat = plane(6, 3, { faceIndex: 1 });
  const size = [3, 0.6];
  const both = layoutPanels(sampleOf([cyl, flat]), previewSettings({ size }));
  assert.equal(both.ok, true);
  const alone = (face) => {
    const r = layoutPanels(sampleOf([face]), previewSettings({ size }));
    assert.equal(r.ok, true);
    return r.layout;
  };
  const a = alone(cyl),
    b = alone(flat);
  assert.notDeepEqual(a.module, b.module, 'the cylinder fitted its module');
  assert.equal(both.layout.counts.offTarget, a.counts.offTarget + b.counts.offTarget);
  assert.deepEqual(
    both.layout.faceModules.map((f) => f.faceIndex),
    [0, 1],
  );
  assert.deepEqual(both.layout.faceModules[1].module, b.module);
});
