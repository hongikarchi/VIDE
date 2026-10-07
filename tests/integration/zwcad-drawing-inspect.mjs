// 도면 읽기와 레이어 대응 with the real ZWCAD 2023 (PLAN-47 T-227, SPEC-14.3, H-ZWCAD-15). Skipped
// when ZWCAD 2023 or the built worker is missing. Hidden ZWCADs this test starts write SYNTHETIC
// drawings (VIDEDRAWINGFIXTURE: 2013/2018 mm with a ZWCAD-made dimension, an inch drawing;
// VIDEXREFFIXTURE: a root with xrefs) into a new folder under .vide/, then the engine reads them
// through DrawingLayerService: copies only, one hidden ZWCAD running VIDEDRAWINGINSPECT on side
// databases. Only the processes started here are stopped; no user drawing is opened and the user's
// own ZWCAD is never touched. The dimension proves the T-225 crash members are not read: the read
// ends with every drawing answered and no new ZWCAD crash report.
// Run: node tests/integration/zwcad-drawing-inspect.mjs
import assert from 'node:assert/strict';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { writeDrawingFixture } from '../../hosts/zwcad/drawing-output.ts';
import { writeXrefFixture } from '../../hosts/zwcad/xref-dwg.ts';
import { zwcadDrawingInspector } from '../../hosts/zwcad/drawing-inspect.ts';
import { zwcadCrashDumps } from '../../hosts/zwcad/hidden-run.ts';
import { DrawingLayerService } from '../../src/server/drawing-layers.ts';
import { DrawingLayerStore } from '../../src/core/drawing-layers.ts';
import { Store } from '../../src/core/store.ts';
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
const run = runDirectory('zwcad-drawing-inspect');
const drawings = join(run, 'drawings'),
  xrefs = join(drawings, 'xref'),
  work = join(run, 'work');
await mkdir(xrefs, { recursive: true });
await mkdir(work, { recursive: true });
let at = Date.now();
await writeDrawingFixture(drawings, options);
await writeXrefFixture(xrefs, options);
const timings = { fixturesMs: Date.now() - at };
const paths = ['v2013.dwg', 'v2018.dwg', 'inch.dwg']
  .map((name) => join(drawings, name))
  .concat(join(xrefs, 'parent.dwg'));
const before = await Promise.all(paths.map(hash));
const dumps = new Set(await zwcadCrashDumps());

const store = new Store(':memory:');
const project = store.createProject('도면 읽기 실호스트');
const service = new DrawingLayerService({
  store: new DrawingLayerStore(store),
  inspector: zwcadDrawingInspector(options),
  folders: () => [drawings],
  denied: () => false,
  workRoot: work,
});
at = Date.now();
const state = await service.read(project.id, paths, true);
timings.readMs = Date.now() - at;
assert.equal(state.state, 'done', JSON.stringify(state.error));
const byName = Object.fromEntries(state.drawings.map((d) => [d.name, d]));
assert.deepEqual(
  paths.map((p) => byName[p.split('\\').at(-1)].error),
  [null, null, null, null],
  'every drawing answered',
);
assert.deepEqual(
  ['v2013.dwg', 'v2018.dwg'].map((n) => [byName[n].version, byName[n].release, byName[n].eligible]),
  [
    ['AC1027', '2013', true],
    ['AC1032', '2018', true],
  ],
);
assert.deepEqual([byName['inch.dwg'].eligible, byName['inch.dwg'].reason], [false, 'UNITS_NOT_MM']);

const plan = await service.drawing(project.id, join(drawings, 'v2013.dwg'));
const { read } = plan;
assert.equal(read.units, 4);
const wall = read.layers.find((layer) => layer.name === '벽');
assert.equal(wall.linetype, 'VIDE점선');
assert.ok(read.linetypes.some((type) => type.name === 'VIDE점선'));
const font = read.textStyles.find((style) => style.name === 'VIDE문자');
assert.equal(font.font, 'txt.shx');
// Arrowheads from the style record (SafeRead.DimensionArrows), not from the dimension.
const dim = read.dimStyles.find((style) => style.name === 'VIDE치수');
assert.deepEqual(
  [dim.textStyle, dim.arrows, dim.scale],
  ['VIDE문자', ['VIDE틱', 'VIDE틱', ''], 100],
);
const frame = read.blocks.find((block) => block.name === '도곽');
assert.deepEqual([frame.inserts, frame.attributes], [1, true]);
assert.ok(!read.blocks.some((block) => block.name.startsWith('*')), 'no layout/anonymous blocks');

const parent = (await service.drawing(project.id, join(xrefs, 'parent.dwg'))).read;
assert.deepEqual(parent.xrefs.map((x) => [x.name, x.overlay, x.inserts]).sort(), [
  ['child', false, 1],
  ['grand', true, 1],
  ['missing', false, 1],
]);
assert.equal(parent.xrefs.find((x) => x.name === 'grand').path, 'sub\\grand.dwg');

// The layer table on the real read.
const map = await service.saveMap(project.id, {
  path: join(drawings, 'v2018.dwg'),
  sources: ['건축::벽', '건축::창호'],
});
assert.deepEqual(
  map.entries.map((e) => [e.layer, e.how]),
  [
    ['벽', 'same'],
    [null, 'none'],
  ],
);
const copied = await service.copyMap(project.id, {
  from: join(drawings, 'v2018.dwg'),
  to: join(drawings, 'v2013.dwg'),
});
assert.equal(copied.map.entries[0].layer, '벽');

// Originals unchanged, no crash report from this read.
assert.deepEqual(await Promise.all(paths.map(hash)), before);
const newDumps = (await zwcadCrashDumps()).filter((name) => !dumps.has(name));
assert.deepEqual(newDumps, []);
store.close();
console.log(
  JSON.stringify({
    ok: true,
    drawings: state.drawings.length,
    layers: read.layers.length,
    dimStyles: read.dimStyles.length,
    timings,
  }),
);
