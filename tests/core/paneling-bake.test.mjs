import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeDataBlock,
  encodeDataBlock,
  itemProblems,
  surfaceHeaderProblems,
  unsafeArgs,
} from '../../src/jigs/bake/data-block.ts';
import {
  MAX_BODY_CHARS,
  PLACEHOLDER,
  loadTemplate,
  renderChunks,
} from '../../src/jigs/bake/templates.ts';
import {
  FAIL_LAYER,
  failureCode,
  jointRef,
  layoutHashOf,
  panelRows,
} from '../../src/jigs/bake/panels.ts';
import { runDirectBake } from '../../src/jigs/bake/bake.ts';
import { runGates } from '../../src/jigs/runtime/gates.ts';
import { validateManifest } from '../../src/jigs/runtime/manifest.ts';
import { makeKey, memberSetSchema, PANEL_ATTRS } from '../../src/contracts/paneling.ts';
import { faceSampler, layoutPanels } from '../../src/jigs/official/paneling-kit/index.ts';
import { hypar, plane, previewSettings, sampleOf } from '../fixtures/paneling-surfaces.mjs';

// PLAN-49 T-255: 패널링 만들기 틀 — the data blocks of vide.bake.panels-uv@1 and panel-solids@1,
// the adapter from the stage results (keys, faces, expected corners, offsets), chunking of 5,000
// panels, the confirmation gate, the template text (fingerprint before any write, failure layer),
// and a refused body (face changed). No host here: tests/integration/rhino-paneling-bake.mjs makes
// them in a hidden Rhino 8.

const JIG = join(import.meta.dirname, '..', '..', 'src', 'jigs', 'official', 'jigs', 'paneling');
const manifest = JSON.parse(readFileSync(join(JIG, 'jig.json'), 'utf8'));
const decl = (id) => manifest.bake.find((b) => b.id === id);
const OBJECT = '6f1c2b1e-1111-4a6b-9c1d-000000000002';
/** Every setting given by a person unless `by` says otherwise (engine `ParamValue`). */
const params = (by = {}, values = {}) =>
  Object.fromEntries(
    manifest.params.map((p) => [
      p.key,
      { value: values[p.key] ?? p.default, by: by[p.key] ?? 'user', at: '2026-10-08T00:00:00Z' },
    ]),
  );
const lay = (sample, over = {}) => {
  const result = layoutPanels(sample, previewSettings(over));
  assert.ok(result.ok, result.message);
  return result.layout;
};
/** A stage-2 result in the contract's shape: each panel's outline drawn 1 % toward its centre. */
function membersOf(layout, thickness = 0.05) {
  const members = layout.panels
    .filter((p) => p.failure?.code !== 'dropped')
    .map((p) => {
      const cu = p.uv.reduce((s, q) => s + q[0], 0) / p.uv.length;
      const cv = p.uv.reduce((s, q) => s + q[1], 0) / p.uv.length;
      return {
        panelId: p.id,
        uv: p.uv.map(([u, v]) => [cu + (u - cu) * 0.99, cv + (v - cv) * 0.99]),
        solid: null,
        flatSize: [p.width * 0.99, p.height * 0.99],
        flatSizeApprox: false,
        thickness,
        area: p.area,
        volume: p.area * thickness,
        jointGap: null,
        jointUneven: false,
        failure: p.failure,
      };
    });
  return memberSetSchema.parse({
    schema: 'vide.paneling.members@1',
    layoutHash: layoutHashOf(layout),
    settingsHash: 'ab'.repeat(32),
    members,
    joints: [
      {
        keys: ['0:1:1', '0:1:2'],
        line: [
          [0, 0, 0],
          [0, 0.6, 0],
        ],
      },
    ],
    overStock: [],
  });
}
const rowsInput = (over) => ({
  manifestParams: manifest.params,
  params: params(),
  layerRoot: 'VIDE::패널링',
  ...over,
});

test('the official jig declares its makes: preview faces, members and joint lines, stage-3 types, marks and cuts; all but the preview gated', () => {
  assert.deepEqual(
    manifest.bake.map((b) => [b.id, b.template, b.layer, b.rows, b.requires ?? []]),
    [
      ['preview', 'vide.bake.panels-uv@1', '미리보기', 'paneling', []],
      ['openings', 'vide.bake.curves@1', '개구', 'paneling', []],
      ['members', 'vide.bake.panel-solids@1', '부재', 'paneling', ['paneling-confirmed']],
      ['joints', 'vide.bake.curves@1', '부재', 'paneling', ['paneling-confirmed']],
      ['types', 'vide.bake.block-instances@1', '타입', 'paneling', ['paneling-confirmed']],
      ['connections', 'vide.bake.textdot@1', '결합부', 'paneling', ['paneling-confirmed']],
      ['cuts', 'vide.bake.curves@1', '재단', 'paneling', ['paneling-confirmed']],
      ['cut-numbers', 'vide.bake.textdot@1', '재단', 'paneling', ['paneling-confirmed']],
    ],
  );
  assert.ok(manifest.capabilities.some((c) => c.name === 'host.bake'));
  const { issues } = validateManifest(manifest, { official: true, source: 'builtin' });
  assert.deepEqual(
    issues.filter((i) => i.level === 'error'),
    [],
  );
});

test('panel data block: ids, faces, status, failure codes, f64 UV and expected corners round-trip', () => {
  const surface = {
    objectId: OBJECT,
    faces: [
      { index: 0, hash: 'a1'.repeat(32) },
      { index: 3, hash: 'b2'.repeat(32) },
    ],
    keyPrefix: makeKey('preview', 'c3'.repeat(32), ''),
    offset: -0.05,
    budgetMs: 60000,
    failLayerPath: 'VIDE::패널링::실패',
    attrs: [
      ['vide-assumed', 'true'],
      ['vide-thickness', '50'],
    ],
  };
  const far = 200000.123;
  const items = [
    {
      key: surface.keyPrefix + 'P-1-1+1-2',
      attrs: [],
      id: 'P-1-1+1-2',
      faceIndex: 3,
      width: 2.4,
      height: 0.6,
      status: 1,
      fail: '',
      uv: [
        [1234.5678901234, 0.000123456789],
        [1236.5678901234, 0.000123456789],
        [1236.5678901234, 0.6],
      ],
      expect: [
        [far, 10, 5],
        [far + 2, 10, 5],
        [far + 2, 10.6, 5.1],
      ],
    },
    {
      key: surface.keyPrefix + 'P-2-1',
      attrs: [],
      id: 'P-2-1',
      faceIndex: 0,
      width: 1.2,
      height: 0.6,
      status: 0,
      fail: 'degenerate',
      uv: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      expect: [
        [far, 0, 0],
        [far + 1, 0, 0],
        [far + 1, 1, 0],
        [far, 1, 0],
      ],
    },
  ];
  for (const template of ['vide.bake.panels-uv@1', 'vide.bake.panel-solids@1']) {
    const header = {
      template,
      jigId: 'vide/paneling',
      instanceId: 'inst-1',
      bakeId: 'preview',
      runId: 'run-1',
      layerPath: 'VIDE::패널링::미리보기',
      deleteIds: ['00000000-0000-4000-8000-000000000009'],
      surface,
    };
    assert.deepEqual(itemProblems(template, items), []);
    assert.deepEqual(unsafeArgs(items), [], 'a merged id with + is a safe key');
    const decoded = decodeDataBlock(encodeDataBlock(header, items));
    assert.deepEqual(decoded.header.surface, surface);
    assert.deepEqual(decoded.header.deleteIds, header.deleteIds);
    decoded.items.forEach((item, i) => {
      assert.equal(item.key, items[i].key);
      assert.deepEqual(item.uv, items[i].uv, 'UV parameters stay f64');
      assert.equal(item.fail, items[i].fail);
      assert.equal(item.status, items[i].status);
      item.expect.forEach((p, k) =>
        p.forEach((c, j) => assert.ok(Math.abs(c - items[i].expect[k][j]) < 1e-4)),
      );
    });
  }
  // The key must be the prefix and the id; a missing header is refused before encoding.
  assert.throws(
    () =>
      encodeDataBlock(
        {
          template: 'vide.bake.panels-uv@1',
          jigId: 'j',
          instanceId: 'i',
          bakeId: 'b',
          runId: 'r',
          layerPath: 'a::b',
          deleteIds: [],
          surface,
        },
        [{ ...items[0], key: 'other' }],
      ),
    /BAKE_PANEL_KEY/,
  );
  assert.ok(surfaceHeaderProblems(undefined).length);
  assert.ok(
    surfaceHeaderProblems({ ...surface, attrs: [['vide-key', 'x']] }).length,
    'reserved names refused',
  );
  assert.ok(
    itemProblems('vide.bake.panels-uv@1', [{ ...items[0], expect: items[0].expect.slice(1) }])
      .length,
  );
});

test('templates: the fingerprint text of the read template, checked before any layer, delete or object', () => {
  const read = loadTemplate('vide.read.surface-grid@1').text;
  const hashText = readFileSync(
    join(import.meta.dirname, '..', '..', 'src', 'jigs', 'bake', 'templates', 'face-hash.cs'),
    'utf8',
  )
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '');
  assert.ok(read.includes(hashText));
  for (const name of ['vide.bake.panels-uv@1', 'vide.bake.panel-solids@1']) {
    const text = loadTemplate(name).text;
    assert.equal(text.split(PLACEHOLDER).length, 2);
    assert.doesNotMatch(text, /^\/\/@include/m, 'includes are expanded');
    assert.equal(text.split(hashText).length, 2, `${name} carries the fingerprint text once`);
    const rejected = text.indexOf('rejected = "SURFACE_CHANGED"');
    assert.ok(rejected > 0);
    for (const write of [
      '// The output layer',
      'doc.Objects.Delete(',
      'doc.Objects.AddBrep(',
      'doc.Layers.Add(',
    ])
      assert.ok(text.indexOf(write) > rejected, `${write} only after the fingerprint check`);
    assert.match(text, /BAKE_TIMEOUT/);
    // A corner outside the trim fails, unless it is within 10 mm of the real trim (the read sends
    // each trim loop as 64 points): then it moves onto the trimmed face's edge.
    assert.match(
      text,
      /IsPointOnFace\(w\.X, w\.Y, tol\) != PointFaceRelation\.Exterior\) continue;/,
    );
    assert.match(text, /var snapLimit = Math\.Max\(tol \* 10, 0\.01 \* scale\);/);
    assert.match(
      text,
      /outside\.DistanceTo\(edge\) > snapLimit[^\n]+\{ reason = "UV_OUTSIDE_TRIM"; break; \}/,
    );
    assert.match(text, /Brep\.ChangeSeam\(face, direction, at, tol\)/);
    assert.match(text, /AddPolyline\(outline, failAttributes\)/);
    assert.match(text, /AddTextDot\(panelId, centre, dotAttributes\)/);
    assert.doesNotMatch(text, /MergeCoplanarFaces|Rhino\.RhinoDoc\.ActiveDoc/);
  }
  assert.match(loadTemplate('vide.bake.panel-solids@1').text, /var solid = true;/);
  assert.match(loadTemplate('vide.bake.panels-uv@1').text, /var solid = false;/);
  assert.match(
    loadTemplate('vide.bake.panel-solids@1').text,
    /CreateOffsetBrep\(made, offset \* scale, true, false, tol, out _, out _\)/,
  );
  // The template writes the per-panel names of the contract's attribute list.
  const text = loadTemplate('vide.bake.panels-uv@1').text;
  for (const name of ['vide-panel-id', 'vide-panel-size', 'vide-status', 'vide-deviation-mm'])
    assert.ok(PANEL_ATTRS.includes(name) && text.includes(`"${name}"`), name);
});

test('adapter: stage 1 → one item per listed panel, keys by the layout fingerprint, corners from the sample', () => {
  const sample = sampleOf(hypar(), { objectId: OBJECT });
  const layout = lay(sample, { size: [1.2, 0.6], boundary: { rule: 'drop', mergeBelow: 0.3 } });
  const dropped = layout.panels.filter((p) => p.failure?.code === 'dropped').length;
  assert.ok(dropped > 0, 'the drop rule leaves dropped panels listed');
  const rows = panelRows(
    rowsInput({ decl: decl('preview'), stepId: 'preview', output: layout, layout, sample }),
  );
  assert.deepEqual(rows.problems, []);
  const hash = layoutHashOf(layout);
  assert.equal(rows.layoutHash, hash);
  assert.equal(rows.items.length, layout.panels.length - dropped, 'dropped panels are not made');
  const first = rows.items[0];
  assert.equal(first.key, makeKey('preview', hash, first.id));
  assert.equal(first.key, `preview:${hash.slice(0, 8)}:${first.id}`);
  const panel = layout.panels.find((p) => p.id === first.id);
  assert.deepEqual(first.uv, panel.uv);
  assert.deepEqual(first.expect, panel.corners);
  assert.deepEqual(rows.surface.faces, [{ index: 0, hash: sample.faces[0].geometryHash }]);
  assert.equal(rows.surface.objectId, OBJECT);
  assert.equal(rows.surface.offset, 0);
  assert.equal(rows.surface.failLayerPath, `VIDE::패널링::${FAIL_LAYER}`);
  assert.deepEqual(rows.surface.attrs, [['vide-assumed', 'false']]);
  const boundary = rows.items.find((i) => layout.panels.find((p) => p.id === i.id).boundary);
  assert.equal(boundary.status, 1);
  // Same layout → same keys; another size → all keys new.
  const again = panelRows(
    rowsInput({ decl: decl('preview'), stepId: 'preview', output: layout, layout, sample }),
  );
  assert.deepEqual(
    again.items.map((i) => i.key),
    rows.items.map((i) => i.key),
  );
  const other = lay(sample, { size: [1.0, 0.6], boundary: { rule: 'drop', mergeBelow: 0.3 } });
  const changed = panelRows(
    rowsInput({ decl: decl('preview'), stepId: 'preview', output: other, layout: other, sample }),
  );
  const before = new Set(rows.items.map((i) => i.key));
  assert.ok(changed.items.every((i) => !before.has(i.key)));
  // Assumed preview values are allowed and tagged.
  const assumed = panelRows(
    rowsInput({
      decl: decl('preview'),
      stepId: 'preview',
      output: layout,
      layout,
      sample,
      params: params({ width: 'default' }),
    }),
  );
  assert.deepEqual(assumed.surface.attrs, [['vide-assumed', 'true']]);
  // A failed panel is sent with its code (drawn on the failure layer, never filled in).
  const failedLayout = structuredClone(layout);
  failedLayout.panels[0].failure = { code: 'degenerate', message: '퇴화' };
  const failed = panelRows(
    rowsInput({
      decl: decl('preview'),
      stepId: 'preview',
      output: failedLayout,
      layout: failedLayout,
      sample,
    }),
  );
  assert.equal(failed.items[0].fail, 'degenerate');
  // No sample: nothing to make, and the reason.
  assert.match(
    panelRows(
      rowsInput({ decl: decl('preview'), stepId: 'preview', output: layout, layout, sample: null }),
    ).problems[0],
    /기준 면 표본이 없습니다/,
  );
});

test('adapter: stage 2 → members on the sample, signed offset by side and [뒤집기], joint lines by vertex keys', () => {
  const sample = sampleOf(hypar(), { objectId: OBJECT });
  const layout = lay(sample, { size: [1.2, 0.6] });
  const members = membersOf(layout);
  const rows = panelRows(
    rowsInput({
      decl: decl('members'),
      stepId: 'members',
      output: members,
      layout,
      sample,
      params: params({}, { thickness: 0.05, joint: 0.01 }),
    }),
  );
  assert.deepEqual(rows.problems, []);
  assert.equal(rows.items.length, members.members.length);
  assert.equal(rows.surface.offset, 0.05);
  assert.equal(
    rows.items[0].key,
    makeKey('member', members.layoutHash, members.members[0].panelId),
  );
  assert.deepEqual(rows.surface.attrs, [
    ['vide-assumed', 'false'],
    ['vide-thickness', '50'],
    ['vide-joint', '10'],
  ]);
  const s = faceSampler(sample.faces[0]);
  const [u, v] = members.members[0].uv[0];
  assert.deepEqual(rows.items[0].expect[0], s.point(u, v));
  assert.deepEqual(rows.items[0].uv, members.members[0].uv);
  const offset = (values) =>
    panelRows(
      rowsInput({
        decl: decl('members'),
        stepId: 'members',
        output: members,
        layout,
        sample,
        params: params({}, { thickness: 0.05, ...values }),
      }),
    ).surface.offset;
  assert.equal(offset({ thicknessSide: 'inside' }), -0.05);
  assert.equal(offset({ flip: true }), -0.05);
  assert.equal(offset({ flip: true, thicknessSide: 'inside' }), 0.05);
  const joints = panelRows(
    rowsInput({
      decl: decl('joints'),
      stepId: 'members',
      output: members,
      layout,
      sample,
      params: params({}, { joint: 0.01 }),
    }),
  );
  assert.deepEqual(joints.problems, []);
  assert.equal(joints.items.length, 1);
  assert.equal(
    joints.items[0].key,
    makeKey('joint', members.layoutHash, jointRef(['0:1:1', '0:1:2'])),
  );
  assert.equal(jointRef(['0:1:2', '0:1:1']), jointRef(['0:1:1', '0:1:2']), 'order-free');
  assert.deepEqual(joints.items[0].attrs, [
    ['vide-assumed', 'false'],
    ['vide-joint', '10'],
  ]);
  assert.deepEqual(unsafeArgs(joints.items), []);
  assert.equal(failureCode('UV_OUTSIDE_TRIM'), 'outside-trim');
  assert.equal(failureCode('NOT_CLOSED'), 'not-closed');
  assert.equal(failureCode('SEAM'), 'make-failed');
  assert.equal(failureCode('thickness-curvature'), 'thickness-curvature');
});

test('5,000 panels go in bodies within the worker limit, every key once; the count is the Ctrl+Z count', (t) => {
  const sample = sampleOf(hypar(), { objectId: OBJECT });
  const layout = lay(sample, { size: [0.34, 0.34] });
  assert.ok(layout.panels.length >= 5000, `${layout.panels.length}`);
  for (const [id, stepId, output] of [
    ['preview', 'preview', layout],
    ['members', 'members', membersOf(layout)],
  ]) {
    const rows = panelRows(
      rowsInput({
        decl: decl(id),
        stepId,
        output,
        layout,
        sample,
        params: params({}, { thickness: 0.05 }),
      }),
    );
    assert.deepEqual(rows.problems, []);
    const chunks = renderChunks(
      {
        template: decl(id).template,
        jigId: 'vide/paneling',
        instanceId: 'inst-1',
        bakeId: id,
        runId: 'run-1',
        layerPath: `VIDE::패널링::${decl(id).layer}`,
        deleteIds: [],
        surface: rows.surface,
      },
      rows.items,
    );
    assert.ok(chunks.every((c) => c.code.length <= MAX_BODY_CHARS));
    const keys = chunks.flatMap((c) => c.keys);
    assert.equal(new Set(keys).size, rows.items.length);
    t.diagnostic(
      `${id}: ${rows.items.length} panels in ${chunks.length} bodies (${Math.round(rows.items.length / chunks.length)} per body)`,
    );
    // Stage 1 shares lattice corners (about 400 quads a body); members are reduced per panel (about 210).
    assert.ok(chunks.length <= Math.ceil(rows.items.length / (id === 'preview' ? 380 : 200)));
  }
});

test('paneling-confirmed: a preview is always allowed; members wait until stages 1·2 are given or taken', () => {
  const run = (stepId, by) =>
    runGates([{ use: 'paneling-confirmed' }], 'before-bake', {
      manifest,
      stepId,
      inputs: {},
      params: params(by),
    });
  assert.deepEqual(run('preview', { width: 'default', thickness: 'default' }).blocked, []);
  const blocked = run('members', { width: 'default', thickness: 'default' });
  assert.deepEqual(blocked.blocked, ['paneling-confirmed']);
  assert.deepEqual(blocked.results[0].failed.sort(), ['thickness', 'width']);
  assert.match(blocked.results[0].message, /가정 값 2개/);
  assert.deepEqual(run('members', {}).blocked, []);
  // A setting read only with another value counts only then (합치기 기준 with 합치기).
  assert.deepEqual(run('members', { mergeBelow: 'default' }).blocked, []);
  const merged = runGates([{ use: 'paneling-confirmed' }], 'before-bake', {
    manifest,
    stepId: 'members',
    inputs: {},
    params: {
      ...params({ mergeBelow: 'default' }),
      boundaryRule: { value: 'merge', by: 'user', at: '' },
    },
  });
  assert.deepEqual(merged.results[0].failed, ['mergeBelow']);
  // 3단계 settings do not hold back a member make.
  assert.deepEqual(run('members', { typeTol: 'default' }).blocked, []);
  // A decision answered by a question card counts as given.
  assert.deepEqual(run('members', { thickness: 'decision' }).blocked, []);
});

test('direct make: a body refused because the face changed undoes the bodies before it and says so', async () => {
  const undone = [];
  let n = 0;
  const direct = {
    async execute() {
      n++;
      return n === 1
        ? {
            ok: true,
            undoId: 'u1',
            changes: { added: [] },
            value: { removed: 0, keys: [], ids: [], failed: [] },
          }
        : {
            ok: true,
            value: { removed: 0, keys: [], ids: [], failed: [], rejected: 'SURFACE_CHANGED' },
          };
    },
    async undo(_target, id) {
      undone.push(id);
      return { ok: true };
    },
  };
  const prepared = {
    codes: ['a', 'b'],
    plans: [
      {
        chunks: [
          { code: 'a', deleteIds: [], keys: [] },
          { code: 'b', deleteIds: [], keys: [] },
        ],
      },
    ],
    jig: { manifest: { name: '패널링' } },
    read: { model: {} },
  };
  await assert.rejects(
    runDirectBake({ direct }, prepared, { instance: 'x', documentId: 1 }),
    (error) => error.code === 'BAKE_SURFACE_CHANGED' && error.reason === 'SURFACE_CHANGED',
  );
  assert.deepEqual(undone, ['u1']);
  // A plane sample at another face index than the header names cannot be made.
  const sample = sampleOf(plane(2.4, 1.2, { faceIndex: 2 }), { objectId: OBJECT });
  const layout = lay(sample);
  const wrong = structuredClone(layout);
  wrong.panels[0].faceIndex = 5;
  const rows = panelRows(
    rowsInput({ decl: decl('preview'), stepId: 'preview', output: wrong, layout: wrong, sample }),
  );
  assert.match(rows.problems.join(), /표본에 없는 면 5/);
});
