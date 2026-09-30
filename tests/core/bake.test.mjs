import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_FORMAT,
  decodeDataBlock,
  encodeDataBlock,
  itemProblems,
  originOf,
  unsafeArgs,
} from '../../src/jigs/bake/data-block.ts';
import {
  MAX_BODY_CHARS,
  PLACEHOLDER,
  loadTemplate,
  renderChunks,
  renderTemplate,
} from '../../src/jigs/bake/templates.ts';
import { curveOf, extractItems, planBake } from '../../src/jigs/bake/plan.ts';

// T-055 (PLAN-22): the data block is the only value a template receives; the rendered body is
// the template text with the one placeholder replaced by base64; large bakes split into chunks;
// replacement follows the record's GUIDs and fingerprints, never tags. No host here.

const header = (template, deleteIds = []) => ({
  template,
  jigId: 'project/example-grid',
  instanceId: 'inst-1',
  bakeId: 'columns',
  runId: 'run-1',
  layerPath: 'VIDE::격자::jig 기둥',
  deleteIds,
});
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const near = (a, b, tolerance = 1e-3) =>
  a.every((v, i) => Math.abs(v - b[i]) <= tolerance) || assert.fail(`${a} vs ${b}`);

test('data block: every template round-trips through the reference reader with metre precision', () => {
  const far = 123456.789; // survey-like coordinates: f64 origin + f32 differences
  const curves = [
    {
      key: 'ax:X1',
      attrs: [['vide-role', 'axis']],
      curve: {
        kind: 'polyline',
        points: [
          [far, 0, 0],
          [far + 30, 0, 0],
          [far + 30, 20, 0],
        ],
      },
    },
    {
      key: 'arc:1',
      attrs: [],
      curve: {
        kind: 'arc',
        points: [
          [far, 0, 3],
          [far + 5, 5, 3],
          [far + 10, 0, 3],
        ],
      },
    },
  ];
  const decoded = decodeDataBlock(
    encodeDataBlock(header('vide.bake.curves@1', ['a'.repeat(36)]), curves),
  );
  assert.equal(decoded.format, DATA_FORMAT);
  assert.equal(decoded.header.template, 'vide.bake.curves@1');
  assert.deepEqual(decoded.header.deleteIds, ['a'.repeat(36)]);
  assert.equal(decoded.header.layerPath, 'VIDE::격자::jig 기둥');
  assert.deepEqual(decoded.items[0].attrs, [['vide-role', 'axis']]);
  assert.equal(decoded.items[1].curve.kind, 'arc');
  decoded.items[0].curve.points.forEach((p, i) => near(p, curves[0].curve.points[i]));
  assert.deepEqual(originOf(curves), [Math.round(far + 75 / 6), 4, 2]);

  const sweep = decodeDataBlock(
    encodeDataBlock(header('vide.bake.sweep-h@1'), [
      {
        key: 'G:C1>C2',
        attrs: [['vide-mark', 'G1']],
        section: 'H-600x200x11x17',
        H_mm: 600,
        B_mm: 200,
        tw_mm: 11,
        tf_mm: 17,
        rail: {
          kind: 'polyline',
          points: [
            [0, 0, 4],
            [8, 0, 4],
          ],
        },
      },
    ]),
  );
  assert.equal(sweep.items[0].section, 'H-600x200x11x17');
  assert.equal(sweep.items[0].tf_mm, 17);
  near(sweep.items[0].rail.points[1], [8, 0, 4]);

  const column = decodeDataBlock(
    encodeDataBlock(header('vide.bake.extrude-column@1'), [
      {
        key: 'col:C1',
        attrs: [],
        section: 'H-400x400x13x21',
        H_mm: 400,
        B_mm: 400,
        tw_mm: 13,
        tf_mm: 21,
        base: [1, 2, 0],
        top: [1, 2, 4],
        strongAxis: [0, 1, 0],
      },
    ]),
  );
  near(column.items[0].top, [1, 2, 4]);
  assert.deepEqual(column.items[0].strongAxis, [0, 1, 0]);

  const dots = decodeDataBlock(
    encodeDataBlock(header('vide.bake.textdot@1'), [
      { key: 'mark:C1', attrs: [], text: 'C1', point: [1, 2, 4.5] },
    ]),
  );
  assert.equal(dots.items[0].text, 'C1');
  near(dots.items[0].point, [1, 2, 4.5]);
});

test('templates: one placeholder each; rendering only inserts base64 and keeps every other character', () => {
  for (const name of [
    'vide.bake.curves@1',
    'vide.bake.sweep-h@1',
    'vide.bake.extrude-column@1',
    'vide.bake.textdot@1',
  ]) {
    const template = loadTemplate(name);
    assert.equal(template.text.split(PLACEHOLDER).length, 2, `${name} has one placeholder`);
    assert.match(template.hash, /^[a-f0-9]{64}$/);
    const block = encodeDataBlock(header(name), []);
    const rendered = renderTemplate(name, block);
    const [head, tail] = template.text.split(PLACEHOLDER);
    assert.ok(rendered.code.startsWith(head) && rendered.code.endsWith(tail));
    const inserted = rendered.code.slice(head.length, rendered.code.length - tail.length);
    assert.equal(inserted, block.toString('base64'));
    assert.match(inserted, /^[A-Za-z0-9+/=]+$/);
    assert.equal(rendered.templateHash, template.hash);
  }
});

test('keys with quotes, newlines or code characters are refused by bake-args-safe and can never reach the C# text', () => {
  const hostile = {
    key: 'x"); System.IO.File.Delete("c:/a"); //\n',
    attrs: [['vide-mark', 'G1\n"']],
    curve: {
      kind: 'polyline',
      points: [
        [0, 0, 0],
        [1, 0, 0],
      ],
    },
  };
  const failed = unsafeArgs([hostile]);
  assert.ok(failed.some((f) => f.endsWith(':key')) && failed.some((f) => f.endsWith(':vide-mark')));
  assert.deepEqual(
    unsafeArgs([{ key: 'col:C3-2', attrs: [['vide-mark', 'C3']], curve: hostile.curve }]),
    [],
  );
  assert.deepEqual(unsafeArgs([{ key: 'ok', attrs: [['vide-run', 'x']], curve: hostile.curve }]), [
    'ok:attr-name',
  ]);
  // Even when forced through, the body has exactly the template's own quotes and newlines.
  const template = loadTemplate('vide.bake.curves@1');
  const code = renderTemplate(
    'vide.bake.curves@1',
    encodeDataBlock(header('vide.bake.curves@1'), [hostile]),
  ).code;
  const count = (text, char) => text.split(char).length - 1;
  assert.equal(count(code, '"'), count(template.text, '"'));
  assert.equal(count(code, '\n'), count(template.text, '\n'));
  assert.equal(code.includes('System.IO'), false);
  assert.ok(
    decodeDataBlock(Buffer.from(code.split('"')[1], 'base64')).items[0].key === hostile.key,
  );
});

test('chunks: a bake past the worker body limit splits into several bodies; only the first deletes', () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({
    key: `col:${i}`,
    attrs: [['vide-mark', `C${i}`]],
    curve: {
      kind: 'polyline',
      points: [
        [i, 0, 0],
        [i, 0, 4],
        [i + 1, 0, 4],
      ],
    },
  }));
  const deleteIds = Array.from({ length: 10 }, (_, i) => `${i}`.padStart(36, '0'));
  const chunks = renderChunks(header('vide.bake.curves@1', deleteIds), items, 20000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.code.length <= 20000, `${chunk.code.length}`);
  assert.deepEqual(chunks[0].deleteIds, deleteIds);
  assert.ok(chunks.slice(1).every((chunk) => chunk.deleteIds.length === 0));
  assert.deepEqual(
    chunks.flatMap((chunk) => chunk.keys),
    items.map((item) => item.key),
  );
  // The decoded blocks share the origin, so a member split across chunks stays put.
  const origins = new Set(
    chunks.map((chunk) =>
      JSON.stringify(decodeDataBlock(Buffer.from(chunk.code.split('"')[1], 'base64')).origin),
    ),
  );
  assert.equal(origins.size, 1);
  assert.ok(
    renderChunks(header('vide.bake.curves@1'), items.slice(0, 5)).every(
      (c) => c.code.length <= MAX_BODY_CHARS,
    ),
  );
  assert.throws(
    () => renderChunks(header('vide.bake.curves@1'), items.slice(0, 1), 100),
    /BAKE_ITEM_TOO_LARGE/,
  );
});

test('extractItems maps step output fields onto template arguments and reports what it cannot use', () => {
  const decl = {
    id: 'beams',
    template: 'vide.bake.sweep-h@1',
    host: 'rhino',
    items: 'step.beams.beams',
    layer: 'jig 보',
    key: 'key',
    map: {
      rail: 'line',
      section: 'size.name',
      H_mm: 'size.H',
      B_mm: 'size.B',
      tw_mm: 'size.tw',
      tf_mm: 'size.tf',
    },
    attrs: { 'vide-mark': 'mark' },
    mode: 'replace-own',
  };
  const output = {
    beams: [
      {
        key: 'G:1',
        mark: 'G1',
        line: [
          [0, 0],
          [8, 0],
        ],
        size: { name: 'H-500', H: 500, B: 200, tw: 10, tf: 16 },
      },
      {
        key: 'G:2',
        mark: 'G2',
        line: { from: [0, 8, 4], to: [8, 8, 4] },
        size: { name: 'H-500', H: 500, B: 200, tw: 10, tf: 16 },
      },
      { key: 'G:3', mark: 'G3', size: { name: 'H-500', H: 500, B: 200, tw: 10, tf: 16 } },
      {
        key: 'G:4',
        mark: 'G4',
        line: [
          [0, 0],
          [8, 0],
        ],
        size: { name: 'H-500', H: -1, B: 200, tw: 10, tf: 16 },
      },
    ],
  };
  const { items, problems } = extractItems(decl, output);
  assert.deepEqual(
    items.map((i) => i.key),
    ['G:1', 'G:2', 'G:4'],
  );
  assert.deepEqual(items[0].rail, {
    kind: 'polyline',
    points: [
      [0, 0, 0],
      [8, 0, 0],
    ],
  });
  assert.deepEqual(items[1].rail.points, [
    [0, 8, 4],
    [8, 8, 4],
  ]);
  assert.deepEqual(items[0].attrs, [['vide-mark', 'G1']]);
  assert.equal(items[0].section, 'H-500');
  assert.ok(problems.some((p) => p.startsWith('G:3')) && problems.some((p) => p.startsWith('G:4')));
  assert.deepEqual(
    curveOf({
      kind: 'arc',
      points: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    }).kind,
    'arc',
  );
  assert.equal(curveOf([[0, 0]]), undefined);
  assert.deepEqual(
    itemProblems('vide.bake.curves@1', [
      {
        key: 'a',
        attrs: [],
        curve: {
          kind: 'arc',
          points: [
            [0, 0, 0],
            [1, 1, 0],
          ],
        },
      },
    ]).length,
    1,
  );
  const dots = extractItems(
    { ...decl, template: 'vide.bake.textdot@1', map: { point: 'at', text: 'mark' } },
    { beams: [{ key: 'G:1', mark: 'G1', at: [1, 2] }] },
  );
  assert.deepEqual(dots.items[0], {
    key: 'G:1',
    attrs: [['vide-mark', 'G1']],
    text: 'G1',
    point: [1, 2, 0],
  });
  assert.equal(extractItems(decl, { beams: 'nope' }).problems.length, 1);
});

const row = (nativeId, layer, hash, tags = {}, extra = {}) => ({
  id: nativeId,
  nativeId,
  layer64: b64(layer),
  geometryHash: hash,
  attributes64: Object.entries(tags).map(([k, v]) => [b64(k), b64(v)]),
  ...extra,
});
const tagged = (key, run = 'run-1') => ({
  'vide-instance': 'inst-1',
  'vide-bake': 'columns',
  'vide-run': run,
  'vide-key': key,
});
const guid = (n) => `${n}`.padStart(8, '0') + '-0000-4000-8000-000000000000';
const LAYER = 'VIDE::격자::jig 기둥';
const item = (key) => ({
  key,
  attrs: [],
  curve: {
    kind: 'polyline',
    points: [
      [0, 0, 0],
      [0, 0, 4],
    ],
  },
});
const record = (items, runId = 'run-1') => ({ runId, appliedAt: '2026-09-30T00:00:00Z', items });
const recorded = (n, extra = {}) => ({
  nativeId: guid(n),
  hash: `h${n}`,
  layer: LAYER,
  runId: 'run-1',
  state: 'jig',
  ...extra,
});
const model = (rows, layers = [{ fullPath: LAYER, visible: true, locked: false }]) => ({
  scene: rows,
  layers,
});

test('planBake replaces only recorded, unchanged objects and leaves human work, copies and untagged objects alone', () => {
  const prior = record({
    'col:1': recorded(1),
    'col:2': recorded(2),
    'col:3': recorded(3),
    'col:4': recorded(4),
    'col:5': recorded(5),
    'col:7': recorded(7, { state: 'kept' }),
    'col:8': recorded(8, { state: 'deleted' }),
  });
  const read = model([
    row(guid(1), LAYER, 'h1', tagged('col:1')), // unchanged → replaced
    row(guid(2), LAYER, 'h2-moved', tagged('col:2')), // edited → preserved
    // col:3 gone → human deleted
    row(guid(4), '기존::숨김', 'h4', tagged('col:4')), // moved to another layer → preserved
    row(guid(5), LAYER, 'h5', tagged('col:5')),
    row(guid(9), LAYER, 'h1', tagged('col:1')), // a copy: same tags, not in the record
    row(guid(10), LAYER, 'zz', {}), // a person's own object
    row(guid(11), LAYER, 'zz', { 'vide-instance': 'other', 'vide-bake': 'columns' }), // another instance
  ]);
  const plan = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1', 'col:2', 'col:3', 'col:4', 'col:6', 'col:7', 'col:8'].map(item),
    prior,
    read,
  });
  assert.deepEqual(plan.deleteIds, [guid(1), guid(5)]);
  assert.deepEqual(plan.replaced, ['col:1']);
  assert.deepEqual(plan.dropped, ['col:5']);
  assert.deepEqual(plan.added, ['col:6']);
  assert.deepEqual(
    plan.create.map((i) => i.key),
    ['col:1', 'col:6'],
  );
  assert.deepEqual(
    plan.preserved.map((p) => [p.key, p.reason]),
    [
      ['col:2', 'edited'],
      ['col:4', 'moved'],
    ],
  );
  assert.deepEqual(plan.deleted, ['col:3', 'col:8']);
  assert.deepEqual(plan.kept, ['col:7']);
  assert.equal(plan.copies, 1);
  assert.deepEqual(plan.hiddenTargets, []);
  assert.equal(plan.carry['col:3'].state, 'deleted');
  assert.equal(plan.carry['col:2'].state, 'jig');
  assert.equal(plan.carry['col:7'].state, 'kept');
});

test('planBake blocks replacement on hidden or locked layers and honours keep, overwrite and absorb', () => {
  const prior = record({ 'col:1': recorded(1), 'col:2': recorded(2), 'col:3': recorded(3) });
  const hidden = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1'].map(item),
    prior,
    read: model(
      [row(guid(1), LAYER, 'h1', tagged('col:1'))],
      [
        { fullPath: 'VIDE', visible: true, locked: false },
        { fullPath: 'VIDE::격자', visible: false, locked: false },
        { fullPath: LAYER, visible: true, locked: false },
      ],
    ),
  });
  assert.deepEqual(
    hidden.hiddenTargets.map((t) => t.key),
    ['col:1'],
  );
  assert.deepEqual(hidden.deleteIds, []);
  const locked = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1'].map(item),
    prior,
    read: model(
      [row(guid(1), LAYER, 'h1', tagged('col:1'))],
      [{ fullPath: LAYER, visible: true, locked: true }],
    ),
  });
  assert.equal(locked.hiddenTargets[0].locked, true);
  const read = model([
    row(guid(1), LAYER, 'h1-edited', tagged('col:1')),
    row(guid(2), LAYER, 'h2-edited', tagged('col:2')),
    row(guid(3), LAYER, 'h3-edited', tagged('col:3')),
  ]);
  const resolved = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1', 'col:2', 'col:3'].map(item),
    prior,
    read,
    resolve: { 'col:1': 'keep', 'col:2': 'overwrite', 'col:3': 'absorb' },
  });
  assert.deepEqual(resolved.kept, ['col:1']);
  assert.equal(resolved.carry['col:1'].state, 'kept');
  assert.deepEqual(resolved.deleteIds, [guid(2), guid(3)]);
  assert.deepEqual(resolved.replaced, ['col:2', 'col:3']);
  assert.equal(resolved.absorbed.length, 1);
  assert.equal(resolved.absorbed[0].target.identity.key, 'col:3');
  assert.equal(resolved.absorbed[0].origin, 'host-edit');
  // A kept key comes back only when the person overwrites it; a deleted one too.
  const again = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1', 'col:4'].map(item),
    prior: record({
      'col:1': recorded(1, { state: 'kept' }),
      'col:4': recorded(4, { state: 'deleted' }),
    }),
    read: model([row(guid(1), LAYER, 'h1', tagged('col:1'))]),
    resolve: { 'col:1': 'overwrite', 'col:4': 'overwrite' },
  });
  assert.deepEqual(again.deleteIds, [guid(1)]);
  assert.deepEqual(
    again.create.map((i) => i.key),
    ['col:1', 'col:4'],
  );
});

test('planBake preserves objects whose baseline read never succeeded until it does', () => {
  const read = model([
    row(guid(1), LAYER, 'h1', tagged('col:1')),
    row(guid(2), LAYER, 'h2', tagged('col:2', 'run-2')),
  ]);
  // The record has no fingerprint (hash '') for col:1: applied, read failed.
  const withoutHash = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:1'].map(item),
    prior: record({ 'col:1': recorded(1, { hash: '' }) }),
    read,
  });
  assert.deepEqual(withoutHash.preserved, [
    { key: 'col:1', nativeId: guid(1), reason: 'pending-baseline' },
  ]);
  assert.deepEqual(withoutHash.deleteIds, []);
  // A record that was never baselined at all (appliedAt null) but whose objects are present.
  const pending = planBake({
    instanceId: 'inst-1',
    bakeId: 'columns',
    planned: ['col:2'].map(item),
    pending: [{ runId: 'run-2', items: { 'col:2': recorded(2, { runId: 'run-2', hash: '' }) } }],
    read,
  });
  assert.deepEqual(
    pending.preserved.map((p) => p.reason),
    ['pending-baseline'],
  );
  assert.deepEqual(pending.create, []);
  assert.equal(pending.copies, 1, 'the unrelated run-1 object is a copy for this plan');
});
