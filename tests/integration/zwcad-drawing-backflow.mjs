// 역반영 적용 on closed drawings with the real ZWCAD 2023 (PLAN-47 T-233, SPEC-14.6·14.7·14.11 2,
// H-ZWCAD-16). Skipped when ZWCAD 2023 or the built worker is missing. Hidden ZWCADs this test
// starts write SYNTHETIC drawings (VIDEBACKFLOWFIXTURE: a 2018 root with a line, an arc-segment
// polyline, an arc, a circle, a block insert, a dimension, a text, a locked layer and a 2013 xref
// child) into a new folder under .vide/, then:
//  1. VIDEDRAWINGENTITIES reads copies (geometry per type, kept properties, dimensions);
//  2. VIDEDRAWINGAPPLY rewrites each type in place, adds marked entities, and writes new files
//     through output tokens in the source's version (2018 root, 2013 child); the preservation
//     check finds nothing but the rows; the dimension on the moved line is listed to check;
//  3. a refused op (locked layer, missing layer) writes nothing at all;
//  4. the engine's service end to end: T-227 read, rows, the save card, [저장] → a new file
//     `<name>-VIDE반영-<stamp>.dwg` beside the original, original unchanged, baseline recorded,
//     then the same rows computed again on the new file are in sync.
// Only the processes started here are stopped; no user drawing is opened and the user's own ZWCAD
// is never touched. Run: node tests/integration/zwcad-drawing-backflow.mjs
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import {
  applyDrawingCopies,
  readDrawingEntities,
  writeBackflowFixture,
} from '../../hosts/zwcad/drawing-backflow.ts';
import { zwcadDrawingInspector } from '../../hosts/zwcad/drawing-inspect.ts';
import { zwcadCrashDumps } from '../../hosts/zwcad/hidden-run.ts';
import { OutputTokens, dwgVersionOf } from '../../src/core/drawing-output.ts';
import { dimensionsToCheck, preservation } from '../../src/core/drawing-backflow-apply.ts';
import { DrawingBackflowStore } from '../../src/core/drawing-backflow.ts';
import { DrawingLayerStore } from '../../src/core/drawing-layers.ts';
import { XrefStore } from '../../src/core/xref-store.ts';
import { Store } from '../../src/core/store.ts';
import { DrawingLayerService } from '../../src/server/drawing-layers.ts';
import { DrawingBackflowService } from '../../src/server/drawing-backflow.ts';
import { ZwcadBackflowHost } from '../../src/server/drawing-backflow-host.ts';
import { runDirectory } from './run-directory.mjs';

const options = inspectorOptions();
try {
  await Promise.all([access(options.executable), access(options.plugin)]);
} catch {
  console.log(JSON.stringify({ skipped: 'ZWCAD 2023 or the built worker is not available' }));
  process.exit(0);
}
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const run = runDirectory('zwcad-drawing-backflow');
const fixtures = join(run, 'fixtures'),
  work = join(run, 'work');
await mkdir(fixtures, { recursive: true });
await mkdir(work, { recursive: true });
const dumps = new Set(await zwcadCrashDumps());
let at = Date.now();
await writeBackflowFixture(fixtures, options);
const timings = { fixtureMs: Date.now() - at };
const root = join(fixtures, 'root.dwg'),
  child = join(fixtures, 'child.dwg');
assert.equal(await dwgVersionOf(root), 'AC1032');
assert.equal(await dwgVersionOf(child), 'AC1027');
const originals = { root: await hash(root), child: await hash(child) };

// 1. Read copies.
const src = join(work, 'src');
await mkdir(src, { recursive: true });
await copyFile(root, join(src, 'root.dwg'));
await copyFile(child, join(src, 'child.dwg'));
at = Date.now();
const reads = await readDrawingEntities(
  [
    { id: 1, path: join(src, 'root.dwg') },
    { id: 2, path: join(src, 'child.dwg') },
  ],
  work,
  options,
);
timings.readMs = Date.now() - at;
const r = reads.get(1),
  c = reads.get(2);
assert.equal(r.error, null);
assert.equal(r.units, 4);
const of = (kind, layer) =>
  r.entities.find((e) => e.geometry?.kind === kind && (!layer || e.layer === layer));
const line = of('line', '벽'),
  bent = of('polyline', '벽'),
  arc = of('arc', '벽'),
  circle = of('circle', '가구'),
  chair = of('insert', '가구'),
  locked = of('line', '잠금');
for (const entity of [line, bent, arc, circle, chair, locked]) assert.ok(entity, 'fixture entity');
assert.deepEqual(line.geometry.points, [
  [0, 0, 0],
  [4000, 0, 0],
]);
assert.deepEqual(line.props, { color: 5, linetype: 'ByLayer', lineweight: 30 });
assert.deepEqual(bent.geometry.bulges, [0, 0.5, 0]);
assert.equal(chair.geometry.block, '의자');
assert.ok(r.entities.some((e) => e.type === 'DBText' && e.geometry === null));
assert.ok(
  r.entities.some((e) => e.xref),
  'the xref insert is marked',
);
assert.equal(r.dims.length, 1);
assert.equal(r.dims[0].associative, false);
assert.ok(r.layers.includes('벽') && r.layers.includes('가구'));
assert.ok(c.entities.some((e) => e.geometry?.kind === 'arc'));

// 2. Apply every type to the copies; one token per DWG version.
const P = (x, y) => [x, y, 0];
const rootOps = [
  {
    id: 'B1',
    op: 'modify',
    handle: line.handle,
    geometry: { kind: 'line', points: [P(0, 0), P(4500, 0)] },
    origin: 'L1:a',
  },
  {
    id: 'B2',
    op: 'modify',
    handle: bent.handle,
    geometry: {
      kind: 'polyline',
      points: [P(0, 1000), P(2500, 1000), P(3000, 2500), P(3500, 2500)],
      bulges: [0, -0.3, 0, 0],
      closed: false,
    },
    origin: 'L1:b',
  },
  {
    id: 'B3',
    op: 'modify',
    handle: arc.handle,
    geometry: { kind: 'arc', center: P(6000, 0), radius: 1200, start: 0, end: Math.PI },
    origin: 'L1:c',
  },
  {
    id: 'B4',
    op: 'modify',
    handle: circle.handle,
    geometry: { kind: 'circle', center: P(6100, 3100), radius: 500 },
    origin: 'L1:d',
  },
  {
    id: 'B5',
    op: 'modify',
    handle: chair.handle,
    geometry: {
      kind: 'insert',
      block: '',
      position: P(1200, 3000),
      rotation: Math.PI / 2,
      scale: [1, 1, 1],
    },
    origin: 'L1:e',
  },
  {
    id: 'B6',
    op: 'add',
    layer: '가구',
    geometry: { kind: 'arc', center: P(0, 6000), radius: 300, start: 0, end: Math.PI / 2 },
    origin: 'L1:f',
  },
  {
    id: 'B7',
    op: 'add',
    layer: '벽',
    geometry: {
      kind: 'polyline',
      points: [P(0, 7000), P(1000, 7000), P(1000, 8000)],
      bulges: [0.4, 0, 0],
      closed: true,
    },
    origin: 'L1:g',
  },
];
const childArc = c.entities.find((e) => e.geometry?.kind === 'arc');
const childOps = [
  {
    id: 'B8',
    op: 'modify',
    handle: childArc.handle,
    geometry: { ...childArc.geometry, radius: 150 },
    origin: 'L1:h',
  },
];
const tokens = new OutputTokens({ workRoot: work });
const out2018 = join(work, 'v2018'),
  out2013 = join(work, 'v2013');
await mkdir(out2018, { recursive: true });
await mkdir(out2013, { recursive: true });
const t1 = tokens.issue({ folder: out2018, names: ['root.dwg'], version: 'AC1032' });
at = Date.now();
const [applied] = await applyDrawingCopies({
  tokens,
  token: t1.id,
  jobs: [
    {
      id: 'root',
      source: join(src, 'root.dwg'),
      target: join(out2018, 'root.dwg'),
      ops: rootOps,
      revision: 3,
    },
  ],
  work,
  options,
});
timings.applyMs = Date.now() - at;
assert.equal(await dwgVersionOf(applied.path), 'AC1032');
const after = new Map(applied.after.entities.map((e) => [e.handle, e]));
// Same handles, layers and properties; the new shapes; origin marks with the entity's own handle.
for (const entity of [line, bent, arc, circle, chair]) {
  const now = after.get(entity.handle);
  assert.ok(now, entity.handle);
  assert.equal(now.layer, entity.layer);
  assert.deepEqual(now.props, entity.props);
  assert.equal(now.origin.handle, entity.handle);
  assert.equal(now.origin.revision, 3);
}
assert.deepEqual(after.get(line.handle).geometry.points[1], [4500, 0, 0]);
assert.deepEqual(after.get(bent.handle).geometry.bulges, [0, -0.3, 0, 0]);
assert.equal(after.get(arc.handle).geometry.radius, 1200);
assert.deepEqual(after.get(chair.handle).geometry.position, [1200, 3000, 0]);
assert.equal(after.get(chair.handle).geometry.block, '의자');
const added = applied.results.filter((x) => x.id === 'B6' || x.id === 'B7').map((x) => x.handle);
assert.equal(added.length, 2);
for (const handle of added) {
  assert.equal(after.get(handle).origin.handle, handle);
  assert.deepEqual(after.get(handle).props, { color: 256, linetype: 'ByLayer', lineweight: -1 });
}
assert.equal(after.get(added[1]).geometry.closed, true);
const check = preservation(applied.before, applied.after, {
  modified: [line, bent, arc, circle, chair].map((e) => e.handle),
  added,
  deleted: [],
});
assert.equal(check.ok, true, JSON.stringify(check));
assert.equal(check.version.same, true);
const dims = dimensionsToCheck(applied.before.dims, applied.after.dims, [
  { handle: line.handle, before: line.geometry, after: after.get(line.handle).geometry },
]);
assert.deepEqual(
  dims.map((d) => d.reason),
  ['NOT_LINKED'],
);
// The xref child keeps 2013.
const t2 = tokens.issue({ folder: out2013, names: ['child.dwg'], version: 'AC1027' });
const [childApplied] = await applyDrawingCopies({
  tokens,
  token: t2.id,
  jobs: [
    {
      id: 'child',
      source: join(src, 'child.dwg'),
      target: join(out2013, 'child.dwg'),
      ops: childOps,
      revision: 1,
    },
  ],
  work,
  options,
});
assert.equal(await dwgVersionOf(childApplied.path), 'AC1027');
assert.equal(
  preservation(childApplied.before, childApplied.after, {
    modified: [childArc.handle],
    added: [],
    deleted: [],
  }).ok,
  true,
);

// 3. A refused op writes nothing (all or nothing).
const t3 = tokens.issue({ folder: out2018, names: ['refused.dwg'], version: 'AC1032' });
await assert.rejects(
  applyDrawingCopies({
    tokens,
    token: t3.id,
    jobs: [
      {
        id: 'root',
        source: join(src, 'root.dwg'),
        target: join(out2018, 'refused.dwg'),
        ops: [
          rootOps[0],
          {
            id: 'X1',
            op: 'modify',
            handle: locked.handle,
            geometry: { kind: 'line', points: [P(0, -2000), P(1, -2000)] },
            origin: 'L1:x',
          },
          {
            id: 'X2',
            op: 'add',
            layer: '없는레이어',
            geometry: { kind: 'line', points: [P(0, 0), P(1, 1)] },
            origin: 'L1:y',
          },
        ],
        revision: 1,
      },
    ],
    work,
    options,
  }),
  (error) => {
    assert.equal(error.code, 'APPLY_FAILED');
    assert.deepEqual(
      error.jobs[0].failed.map((f) => [f.id, f.code]),
      [
        ['X1', 'LAYER_LOCKED'],
        ['X2', 'LAYER_MISSING'],
      ],
    );
    return true;
  },
);
assert.ok(!existsSync(join(out2018, 'refused.dwg')));
assert.ok(!(await readdir(out2018)).some((name) => name.startsWith('~vide-')));

// 4. The service end to end on the closed root: rows → save card → [저장] → a new file beside it.
const store = new Store(':memory:');
const project = store.createProject('역반영 실호스트');
const layers = new DrawingLayerStore(store);
const read = new DrawingLayerService({
  store: layers,
  inspector: zwcadDrawingInspector(options),
  folders: () => [fixtures],
  denied: () => false,
  workRoot: work,
});
assert.equal((await read.read(project.id, [root], true)).state, 'done');
const host = new ZwcadBackflowHost({
  attached: undefined,
  workspace: { list: () => [], lazy: () => ({}) },
  workRoot: work,
  options,
});
// The source: the Rhino objects paired with the line and the circle, in metres; the line moved.
let source = {
  linkId: 'L1',
  revision: 'r1',
  objects: [
    { id: 'a', layer: '벽', type: 'Curve', geometry: { kind: 'line', points: [P(0, 0), P(4, 0)] } },
    {
      id: 'd',
      layer: '가구',
      type: 'Curve',
      geometry: { kind: 'circle', center: P(6, 3), radius: 0.5 },
    },
  ],
};
const reader = {
  available: () => host.available(),
  source: async () => source,
  drawings: (projectId, paths) => host.drawings(projectId, paths),
  fingerprints: (projectId, paths) => host.fingerprints(projectId, paths),
};
const service = new DrawingBackflowService({
  store: new DrawingBackflowStore(store),
  layers,
  xref: new XrefStore(store),
  reader,
  writer: host,
  tokens: new OutputTokens({ workRoot: work }),
  workRoot: work,
  folders: () => [fixtures],
  denied: () => false,
});
const relation = { rotation: 0, translation: [0, 0], dz: 0 };
const pairs = [
  { sourceId: 'a', path: root, handle: line.handle },
  { sourceId: 'd', path: root, handle: circle.handle },
];
await service.establish(project.id, { root, link: 'L1', pairs });
source = {
  ...source,
  revision: 'r2',
  objects: [
    { ...source.objects[0], geometry: { kind: 'line', points: [P(0, 0), P(4.25, 0)] } },
    source.objects[1],
  ],
};
const diff = await service.diff(project.id, { root, link: 'L1', relation });
assert.equal(diff.settled, true);
assert.deepEqual(
  diff.rows.map((row) => [row.kind, row.handle]),
  [['modify', line.handle]],
);
at = Date.now();
const card = await service.apply(project.id, { diff: diff.id });
timings.serviceComputeMs = Date.now() - at;
assert.equal(card.state, 'confirm', JSON.stringify(card));
assert.equal(card.files.length, 1);
assert.match(card.files[0].written, /root-VIDE반영-\d{8}-\d{4}\.dwg$/);
assert.equal(card.files[0].check.ok, true);
assert.equal(card.files[0].dimensions.length, 1);
assert.ok(!existsSync(card.files[0].written), 'nothing beside the drawing before [저장]');
const saved = await service.confirm(project.id, card.id);
assert.equal(saved.state, 'applied');
const written = saved.files[0].written;
assert.ok(existsSync(written));
assert.equal(await dwgVersionOf(written), 'AC1032');
assert.equal(await hash(root), originals.root, 'the original is never written');
// The new file holds the change: computed again from it, the line is in sync.
const again = await host.drawings(project.id, [written]);
const moved = again.get(written).entities.find((e) => e.handle === line.handle);
assert.deepEqual(moved.geometry.points[1], [4250, 0, 0]);
assert.equal(moved.origin.id, 'L1:a');
assert.equal(new DrawingBackflowStore(store).baseline(project.id, written).pairs.length, 2);

assert.equal(await hash(root), originals.root);
assert.equal(await hash(child), originals.child);
const newDumps = (await zwcadCrashDumps()).filter((name) => !dumps.has(name));
assert.deepEqual(newDumps, [], 'no ZWCAD crash report');
console.log(JSON.stringify({ ok: true, timings }));
