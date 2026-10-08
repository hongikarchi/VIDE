// Nested Rhino blocks on a real host (2026-10-08 report: "블록 안에 다른 블록이 들어 있는 중첩 구조가
// 되면 sync할 때 박스로 넘어온다", SPIKE-2026-10-08-nested-blocks). A synthetic document with simple,
// 2- and 3-level nested blocks (rotated, scaled, mirrored, sheared nested copies), a heavy nesting
// (a ~10k-vertex mesh in 8×8 copies, which used to come as a box) and a nested definition edited after
// the first Sync. Read the way the app reads it: the attached display Sync (displayPage, VGT1, typed),
// a Live change page (displayChanges), and the working copy's export (exportPage, JSON).
// Checks: every instance is a block with its expanded definition (never `oversized`), the expanded
// geometry lies inside the instance's bounding box (the transforms compose right), the heavy block
// holds every copy, and an inner edit changes the outer definition hash and geometry.
// Review cases (rows named `x-…`, checked on their own): a 40-level chain read with a 20-level use of
// it (every level, whichever is read first), members on a layer that is off (left out, like Rhino),
// dimension text in a block turned 180° (upright), and nested blocks too large to expand (the
// expansion is capped per definition and per read, marked partial, and the engine's memory stays
// bounded for the Sync and a Live read). An inner edit sends again only the blocks that nest it.
// No user document is opened; the test builds its own under .vide/. Without Rhino 8 it is skipped.
// Afterwards only the Rhino processes this test launched are closed and the installed VIDE's plugin
// registration is restored (VIDE_TEST_KEEP_REGISTRATION=1 keeps it).
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { coordinate } from '../../src/contracts/geometry-transfer.ts';
import { MAX_EXPANDED_VALUES, MAX_READ_EXPANDED_VALUES } from '../../hosts/rhino/block-nesting.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
if (process.env.VIDE_TEST_RHINO_PLUGIN) probe.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
if (!existsSync(probe.executable) || !existsSync(probe.plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${probe.plugin}) is not available`,
  );
  process.exit(0);
}

const HEAVY = 8;
const CHAIN = 40;
const HUGE_OUTERS = 4,
  HUGE_COPIES = 200;
const directory = runDirectory('rhino-nested-blocks');
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
options.plugin = probe.plugin;

// The synthetic document (metres); every top-level instance is named after its case.
const build = `
doc.ModelUnitSystem = Rhino.UnitSystem.Meters;
var style = doc.DimStyles.Current;
System.Func<string, GeometryBase[], int> def = (name, geometry) => {
  var attrs = new System.Collections.Generic.List<Rhino.DocObjects.ObjectAttributes>();
  foreach (var g in geometry) attrs.Add(new Rhino.DocObjects.ObjectAttributes());
  var index = doc.InstanceDefinitions.Add(name, "", Point3d.Origin, geometry, attrs);
  if (index < 0) throw new Exception("definition " + name);
  return index;
};
System.Func<int, Transform, GeometryBase> nest = (index, x) => new InstanceReferenceGeometry(doc.InstanceDefinitions[index].Id, x);
System.Action<string, int, Transform> place = (name, index, x) => {
  var a = new Rhino.DocObjects.ObjectAttributes { Name = name };
  if (doc.Objects.AddInstanceObject(index, x, a) == Guid.Empty) throw new Exception("instance " + name);
};
System.Func<double, GeometryBase[]> mixed = (s) => new GeometryBase[] {
  new Box(new BoundingBox(0, 0, 0, s, s * 0.5, s * 0.3)).ToBrep(),
  Extrusion.Create(new Circle(new Point3d(s * 1.5, 0, 0), s * 0.2).ToNurbsCurve(), s * 0.8, true),
  Mesh.CreateFromSphere(new Sphere(new Point3d(0, s * 1.5, 0), s * 0.3), 12, 12),
  new LineCurve(new Point3d(0, 0, 0), new Point3d(0, 0, s)),
  new ArcCurve(new Arc(new Point3d(-s, 0, 0), new Point3d(-s, s, 0), new Point3d(-2 * s, s * 0.5, 0))),
  TextEntity.Create("A", new Plane(new Point3d(0, -s, 0), Vector3d.ZAxis), style, false, 0, 0),
};
var turn = Transform.Rotation(30 * Math.PI / 180, Vector3d.ZAxis, Point3d.Origin);
var tilt = Transform.Rotation(15 * Math.PI / 180, Vector3d.XAxis, Point3d.Origin);
var mirror = Transform.Mirror(Plane.WorldYZ);
var scale2 = Transform.Scale(Point3d.Origin, 2);
var stretch = Transform.Scale(Plane.WorldXY, 1, 1.5, 0.5);
var plain = def("plain", mixed(1));
place("case1-plain", plain, Transform.Translation(0, 0, 0));
var inner2 = def("inner2", mixed(1));
var outer2 = def("outer2", new GeometryBase[] {
  nest(inner2, Transform.Translation(0, 0, 0)), nest(inner2, Transform.Translation(4, 0, 0) * turn),
  new Box(new BoundingBox(-1, -1, -0.2, 6, 3, 0)).ToBrep() });
place("case2-nested2", outer2, Transform.Translation(20, 0, 0));
var inner3 = def("inner3", mixed(0.5));
var mid3 = def("mid3", new GeometryBase[] {
  nest(inner3, Transform.Translation(0, 0, 0) * turn), nest(inner3, Transform.Translation(3, 0, 0) * scale2),
  nest(inner3, Transform.Translation(0, 4, 0) * mirror), nest(inner3, Transform.Translation(3, 4, 0) * stretch * tilt) });
var outer3 = def("outer3-only-nested", new GeometryBase[] {
  nest(mid3, Transform.Identity), nest(mid3, Transform.Translation(10, 0, 0) * mirror * turn),
  nest(mid3, Transform.Translation(0, 10, 0) * scale2) });
place("case3-nested3-xforms", outer3, Transform.Translation(40, 0, 0));
place("case3b-nested3-mirrored-instance", outer3, Transform.Translation(80, 0, 0) * mirror * turn);
var only2 = def("outer2-only-nested", new GeometryBase[] { nest(inner2, Transform.Identity), nest(inner2, Transform.Translation(0, 4, 0) * tilt) });
place("case4-only-nested2", only2, Transform.Translation(0, 40, 0));
var editInner = def("edit-inner", new GeometryBase[] { new Box(new BoundingBox(0, 0, 0, 1, 1, 1)).ToBrep() });
var editOuter = def("edit-outer", new GeometryBase[] { nest(editInner, Transform.Identity), nest(editInner, Transform.Translation(2, 0, 0)) });
place("case5-edit-inner-after-sync", editOuter, Transform.Translation(20, 40, 0));
var heavyInner = def("heavy-inner", new GeometryBase[] { Mesh.CreateFromSphere(new Sphere(Point3d.Origin, 0.5), 100, 100) });
var heavyRow = new GeometryBase[${HEAVY}];
for (int i = 0; i < ${HEAVY}; i++) heavyRow[i] = nest(heavyInner, Transform.Translation(i * 1.2, 0, 0));
var heavyMid = def("heavy-mid", heavyRow);
var heavyCol = new GeometryBase[${HEAVY}];
for (int j = 0; j < ${HEAVY}; j++) heavyCol[j] = nest(heavyMid, Transform.Translation(0, j * 1.2, 0));
var heavyOuter = def("heavy-outer", heavyCol);
place("case6-heavy-nested", heavyOuter, Transform.Translation(0, 80, 0));
place("case6c-heavy-nested-again", heavyOuter, Transform.Translation(0, 100, 0) * turn);
place("case6d-heavy-inner", heavyInner, Transform.Translation(40, 80, 0));
// Review cases. A 40-level chain: each level a marker line and the next level 10 m up.
var next = -1;
for (int i = ${CHAIN - 1}; i >= 0; i--)
{
  var parts = new System.Collections.Generic.List<GeometryBase> { new LineCurve(new Point3d(0, 0, 0), new Point3d(1, 0, 0)) };
  if (next >= 0) parts.Add(nest(next, Transform.Translation(0, 0, 10)));
  next = def("chain" + i, parts.ToArray());
  if (i == ${CHAIN / 2}) place("x-chain-level${CHAIN / 2}", next, Transform.Translation(-40, 0, 0));
}
place("x-chain${CHAIN}", next, Transform.Translation(-20, 0, 0));
// Members on a layer that is off, inside a block and as a nested copy.
var red = doc.Layers.Add("Red", System.Drawing.Color.Red);
var offLayer = new Rhino.DocObjects.Layer { Name = "Off", IsVisible = false };
var off = doc.Layers.Add(offLayer);
System.Func<int, Rhino.DocObjects.ObjectAttributes> on = (layer) => new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer };
var cInner = doc.InstanceDefinitions.Add("c-inner", "", Point3d.Origin,
  new GeometryBase[] { new LineCurve(new Point3d(0, 0, 0), new Point3d(1, 0, 0)), new LineCurve(new Point3d(0, 1, 0), new Point3d(1, 1, 0)),
    new LineCurve(new Point3d(0, 2, 0), new Point3d(1, 2, 0)) },
  new[] { on(red), on(off), new Rhino.DocObjects.ObjectAttributes() });
var cOuter = doc.InstanceDefinitions.Add("c-outer", "", Point3d.Origin,
  new GeometryBase[] { nest(cInner, Transform.Identity), nest(cInner, Transform.Translation(5, 0, 0)) },
  new[] { on(red), on(off) });
place("x-layers", cOuter, Transform.Translation(-60, 0, 0));
// Nested blocks too large to expand in full: ${HUGE_COPIES} copies of a ~23k-vertex sphere each.
var hugeInner = def("huge-inner", new GeometryBase[] { Mesh.CreateFromSphere(new Sphere(Point3d.Origin, 0.5), 150, 150) });
for (int k = 0; k < ${HUGE_OUTERS}; k++)
{
  var copies = new GeometryBase[${HUGE_COPIES}];
  for (int i = 0; i < ${HUGE_COPIES}; i++) copies[i] = nest(hugeInner, Transform.Translation(i % 20, i / 20, 0));
  place("x-huge-" + k, def("huge-outer" + k, copies), Transform.Translation(0, -40 - k * 15, 0));
}
return doc.Objects.Count;`;

// Dimension text in a block, flat and nested turned 180° (added in the attached Rhino: the working
// copy's save check does not read a dimension inside a block back as equal).
const dimensions = `
var style = doc.DimStyles.Current;
System.Func<string, GeometryBase[], int> def = (name, geometry) => {
  var attrs = new System.Collections.Generic.List<Rhino.DocObjects.ObjectAttributes>();
  foreach (var g in geometry) attrs.Add(new Rhino.DocObjects.ObjectAttributes());
  var index = doc.InstanceDefinitions.Add(name, "", Point3d.Origin, geometry, attrs);
  if (index < 0) throw new Exception("definition " + name);
  return index;
};
System.Func<int, Transform, GeometryBase> nest = (index, x) => new InstanceReferenceGeometry(doc.InstanceDefinitions[index].Id, x);
System.Action<string, int, Transform> place = (name, index, x) => {
  var a = new Rhino.DocObjects.ObjectAttributes { Name = name };
  if (doc.Objects.AddInstanceObject(index, x, a) == Guid.Empty) throw new Exception("instance " + name);
};
// Dimension text in a block, flat and nested turned 180°.
var dimension = LinearDimension.Create(AnnotationType.Aligned, style, Plane.WorldXY, Vector3d.XAxis,
  new Point3d(0, 0, 0), new Point3d(4, 0, 0), new Point3d(2, 1, 0), 0);
var dimInner = def("dim-inner", new GeometryBase[] { dimension });
var dimOuter = def("dim-outer", new GeometryBase[] { nest(dimInner, Transform.Rotation(Math.PI, Vector3d.ZAxis, Point3d.Origin)) });
place("x-dim-flat", dimInner, Transform.Translation(-80, 0, 0));
place("x-dim-nested-rot180", dimOuter, Transform.Translation(-80, 10, 0));
output.Append("ok");`;

// After the first Sync the nested definition edit-inner becomes a sphere and a line.
const editInner = `
var index = doc.InstanceDefinitions.Find("edit-inner").Index;
var g = new GeometryBase[] { new Sphere(new Point3d(0.5, 0.5, 0.5), 0.8).ToBrep(), new LineCurve(new Point3d(0, 0, 0), new Point3d(0, 0, 3)) };
var a = new Rhino.DocObjects.ObjectAttributes[] { new Rhino.DocObjects.ObjectAttributes(), new Rhino.DocObjects.ObjectAttributes() };
if (!doc.InstanceDefinitions.ModifyGeometry(index, g, a)) throw new Exception("modify");
output.Append("ok");`;

const wait = async (fn, ms = 180000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Timed out');
};

/** After the test: put the installed VIDE's Rhino plugin registration back (launch.json token). */
async function restoreInstalledPlugin() {
  try {
    const launch = JSON.parse(
      await readFile(join(process.env.LOCALAPPDATA ?? '', 'VIDE', 'launch.json'), 'utf8'),
    );
    const url = new URL(launch.url);
    const origin = url.origin;
    const session = await fetch(new URL('/api/v1/session', origin), {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: url.hash.slice(1) }),
      signal: AbortSignal.timeout(5000),
    });
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    if (!session.ok || !cookie) return { restored: false, status: session.status };
    const install = await fetch(new URL('/api/v1/connectors/rhino8/install', origin), {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie },
      signal: AbortSignal.timeout(60000),
    });
    return { restored: install.ok, status: install.status };
  } catch (error) {
    return { restored: false, error: String(error) };
  }
}

const len = (a) => (a ? a.length : 0);
const nameOf = (row) => Buffer.from(row.name64 ?? '', 'base64').toString('utf8');
const rowsByName = (model) => new Map(model.scene.map((row) => [nameOf(row), row]));

/** World bounds of an instance's expanded definition (mesh vertices and wire segments). */
function placedBounds(definition, m) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const values of [definition.vertices, definition.segments])
    for (let i = 0; i < len(values); i += 3) {
      const x = coordinate(values, i),
        y = coordinate(values, i + 1),
        z = coordinate(values, i + 2);
      const p = [
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
      ];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]);
        max[k] = Math.max(max[k], p[k]);
      }
    }
  return { min, max };
}

/** Every instance is a block with its expanded definition inside the instance's bounding box. */
function checkBlocks(model, label, { bounds = true } = {}) {
  const scale = 1;
  const summary = {};
  for (const row of model.scene) {
    const name = nameOf(row);
    if (name.startsWith('x-')) continue;
    assert.ok(row.block, `${label} ${name}: a block, not a box`);
    assert.notEqual(row.oversized, true, `${label} ${name}: not oversized`);
    const definition = model.definitions[row.block.definition];
    assert.ok(definition && len(definition.vertices) > 0, `${label} ${name}: definition geometry`);
    assert.equal(definition.children, undefined, `${label} ${name}: expanded`);
    assert.notEqual(definition.partial, true, `${label} ${name}: complete`);
    const { min, max } = placedBounds(definition, row.block.transform);
    // Display meshes lie on the surfaces: inside Rhino's tight bounding box, and close to it.
    const tolerance = 0.05 * scale;
    for (let k = 0; bounds && k < 3; k++) {
      const lo = row.origin[k],
        hi = row.origin[k] + row.boundsSize[k];
      assert.ok(
        min[k] >= lo - tolerance && max[k] <= hi + tolerance,
        `${label} ${name}: axis ${k} [${min[k]}, ${max[k]}] inside [${lo}, ${hi}]`,
      );
      // Labels (not in the expanded mesh) can widen Rhino's box; the geometry still spans most of it.
      assert.ok(
        max[k] - min[k] >= 0.5 * (hi - lo) - tolerance,
        `${label} ${name}: axis ${k} [${min[k]}, ${max[k]}] spans [${lo}, ${hi}]`,
      );
    }
    summary[name] = {
      vertices: len(definition.vertices) / 3,
      triangles: len(definition.indices) / 3,
      segments: len(definition.segments) / 6,
      texts: len(definition.texts),
      hash: definition.hash.slice(0, 12),
    };
  }
  return summary;
}

/** The review cases (rows `x-…`) of a read. */
function checkReview(model, label, { huge = true } = {}) {
  const rows = rowsByName(model);
  const definitionOf = (name) => {
    const row = rows.get(name);
    assert.ok(row?.block, `${label} ${name}: a block`);
    return model.definitions[row.block.definition];
  };
  const out = {};
  if (huge) out.huge = checkHuge(model, label);
  // Every level of the chain, whichever instance was read first; nothing left out.
  for (const [name, levels] of [
    [`x-chain${CHAIN}`, CHAIN],
    [`x-chain-level${CHAIN / 2}`, CHAIN / 2],
  ]) {
    const definition = definitionOf(name);
    assert.equal(len(definition.segments) / 6, levels, `${label} ${name} levels`);
    assert.notEqual(definition.partial, true, `${label} ${name} complete`);
    out[name] = len(definition.segments) / 6;
  }
  // Members on the layer that is off are left out: the Red and by-parent lines of the first copy.
  const layers = definitionOf('x-layers');
  assert.equal(len(layers.segments) / 6, 2, `${label} x-layers lines`);
  const ys = [];
  for (let i = 1; i < len(layers.segments); i += 6) ys.push(coordinate(layers.segments, i));
  assert.deepEqual(ys.sort(), [0, 2]);
  out['x-layers'] = len(layers.segments) / 6;
  if (!rows.has('x-dim-flat')) return out;
  // Dimension text reads left to right in a block turned 180°, at the turned position.
  const flat = definitionOf('x-dim-flat').texts[0];
  const turned = definitionOf('x-dim-nested-rot180').texts[0];
  assert.ok(flat && turned, `${label} dimension labels`);
  assert.ok(Math.abs(flat.r) < 1e-6, `${label} flat label r ${flat.r}`);
  assert.ok(Math.abs(turned.r) < 1e-6, `${label} turned label r ${turned.r}`);
  assert.ok(Math.abs(turned.p[0] + flat.p[0]) < 1e-6, `${label} turned label x`);
  assert.ok(Math.abs(turned.h - flat.h) < 1e-9, `${label} label height`);
  out.dimension = { flat: flat.r, turned: turned.r };
  return out;
}

/** The blocks too large to expand: capped per definition and per read, marked partial. */
function checkHuge(model, label) {
  const sizes = [];
  for (const row of model.scene) {
    const name = nameOf(row);
    if (!name.startsWith('x-huge-')) continue;
    assert.ok(row.block && row.oversized !== true, `${label} ${name}: a block, not a box`);
    const definition = model.definitions[row.block.definition];
    assert.equal(definition.partial, true, `${label} ${name} partial`);
    const values = len(definition.vertices) + len(definition.segments);
    assert.ok(values <= MAX_EXPANDED_VALUES, `${label} ${name} ${values} values`);
    sizes.push(values);
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(total <= MAX_READ_EXPANDED_VALUES, `${label} huge total ${total}`);
  return sizes;
}

let worker, host;
const result = { directory, heavy: HEAVY };
try {
  // 1. The synthetic document, made and read back by a hidden working copy (exportPage, JSON).
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 800));
  const exported = await worker.exportModel();
  result.workerExport = checkBlocks(exported, 'export');
  await worker.stop();
  worker = undefined;

  // 2. A copy open in a hidden Rhino this test launches, attached like the user's open document.
  const attached = join(directory, 'attached');
  await mkdir(attached);
  const source = join(attached, 'nested.3dm');
  await copyFile(receipt.filename, source);
  const script = join(attached, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attached.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
source=${JSON.stringify(source.replaceAll('\\', '/'))}
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
try:
    opened,already=Rhino.RhinoDoc.Open(source)
    doc=Rhino.RhinoDoc.ActiveDoc
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    report('ready',dict(ok=True,pid=System.Diagnostics.Process.GetCurrentProcess().Id,objects=int(doc.Objects.Count)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
  );
  host = await launchOwnedHost({
    executable: options.executable,
    environment: { ...process.env, VIDE_CONNECT_DIR: connectionDirectory },
    visible: false,
    spawnProcess: (f, a, o) => spawn(f, a, { ...o, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  const ready = await wait(async () =>
    JSON.parse(await readFile(join(attached, 'ready.json'), 'utf8')),
  );
  assert.equal(ready.ok, true, JSON.stringify(ready));
  result.rhinoPid = ready.pid;
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. The display Sync (VGT1, typed arrays, as stored).
  const first = await sdk.syncEditor(target, () => {});
  result.firstSync = checkBlocks(first, 'sync');
  result.coverage = first.displayCoverage;
  // Only the blocks too large to expand are not shown in full (marked, never boxes).
  assert.equal(first.displayCoverage.omitted, HUGE_OUTERS, JSON.stringify(first.displayCoverage));
  assert.deepEqual(first.displayCoverage.omittedTypes, {
    'InstanceReference (중첩 블록 일부 생략)': HUGE_OUTERS,
  });
  result.review = checkReview(first, 'sync');
  // Only the definitions the rows use are kept (nested ones are inside them).
  const usedDefinitions = new Set(first.scene.map((row) => row.block?.definition));
  assert.deepEqual(
    Object.keys(first.definitions).filter((id) => !usedDefinitions.has(id)),
    [],
  );
  result.definitions = Object.keys(first.definitions).length;
  result.reviewExport = checkReview(exported, 'export', { huge: false });
  const rows = rowsByName(first);
  const heavy = first.definitions[rows.get('case6-heavy-nested').block.definition];
  const single = first.definitions[rows.get('case6d-heavy-inner').block.definition];
  // Every one of the 64 nested copies is there; both instances of it share the definition.
  assert.equal(len(heavy.vertices), len(single.vertices) * HEAVY * HEAVY);
  assert.equal(len(heavy.indices), len(single.indices) * HEAVY * HEAVY);
  assert.equal(
    rows.get('case6c-heavy-nested-again').block.definition,
    rows.get('case6-heavy-nested').block.definition,
  );
  // The working copy's export expands to the same geometry as the display Sync.
  for (const name of Object.keys(result.firstSync))
    for (const key of ['vertices', 'triangles', 'segments', 'texts'])
      assert.equal(result.workerExport[name][key], result.firstSync[name][key], `${name} ${key}`);

  // 4. Edit the nested definition: the Live change page and a new Sync carry the new geometry.
  const before = await sessions.inspect(target);
  const edit = await sessions.directExecute(target, {
    requestId: randomUUID(),
    code: editInner,
    label: 'nested edit',
  });
  assert.equal(edit.ok, true, JSON.stringify(edit).slice(0, 400));
  const changes = await sessions.changes(target, before.revision ?? 0);
  const changed = rowsByName(changes).get('case5-edit-inner-after-sync');
  assert.ok(changed, 'the outer instance is reported changed');
  // Only the blocks that nest the edited definition are sent again (not every block).
  result.liveChangedRows = changes.scene.map(nameOf).sort();
  assert.deepEqual(result.liveChangedRows, ['case5-edit-inner-after-sync']);
  // Rhino keeps reporting part of the instance's earlier bounding box after a definition edit
  // (seen on Rhino 8: min x stays at the old box), so the edited block is checked against where its
  // new geometry must be: the sphere (centre 0.5, radius 0.8) and the 3 m line, at x 0 and x 2,
  // placed at (20, 40, 0).
  const expected = { min: [19.7, 39.7, -0.3], max: [23.3, 41.3, 3] };
  const editedBounds = (model, row) =>
    placedBounds(model.definitions[row.block.definition], row.block.transform);
  result.liveChanges = checkBlocks({ ...changes, scene: [changed] }, 'live', { bounds: false })[
    'case5-edit-inner-after-sync'
  ];
  const second = await sdk.syncEditor(target, () => {});
  const secondRow = rowsByName(second).get('case5-edit-inner-after-sync');
  result.secondSync = checkBlocks({ ...second, scene: [secondRow] }, 'second sync', {
    bounds: false,
  })['case5-edit-inner-after-sync'];
  for (const [label, bounds] of [
    ['live', editedBounds(changes, changed)],
    ['second sync', editedBounds(second, secondRow)],
  ])
    for (let k = 0; k < 3; k++)
      assert.ok(
        Math.abs(bounds.min[k] - expected.min[k]) < 0.02 &&
          Math.abs(bounds.max[k] - expected.max[k]) < 0.02,
        `${label} edited block axis ${k}: [${bounds.min[k]}, ${bounds.max[k]}]`,
      );
  // The rest of the document is unchanged and still checks against Rhino's boxes.
  checkBlocks({ ...second, scene: second.scene.filter((row) => row !== secondRow) }, 'second sync');
  const firstEdit = result.firstSync['case5-edit-inner-after-sync'];
  assert.notEqual(result.liveChanges.hash, firstEdit.hash);
  assert.ok(result.liveChanges.vertices > firstEdit.vertices * 10);
  assert.deepEqual(result.secondSync, result.liveChanges);

  // 5. A Live read of the blocks too large to expand: moved, read again, capped and marked.
  const heapBefore = process.memoryUsage().heapUsed;
  const moved = await sessions.inspect(target);
  const move = await sessions.directExecute(target, {
    requestId: randomUUID(),
    code: `foreach (var o in new System.Collections.Generic.List<Rhino.DocObjects.RhinoObject>(doc.Objects)) if (o.Name != null && o.Name.StartsWith("x-huge-")) doc.Objects.Transform(o, Transform.Translation(0, 0, 1), true);
output.Append("ok");`,
    label: 'move huge',
  });
  assert.equal(move.ok, true, JSON.stringify(move).slice(0, 400));
  const hugeChanges = await sessions.changes(target, moved.revision ?? 0);
  const hugeRows = hugeChanges.scene.filter((row) => nameOf(row).startsWith('x-huge-'));
  assert.equal(hugeRows.length, HUGE_OUTERS);
  result.liveHuge = checkHuge(hugeChanges, 'live');
  // The Live read keeps plain arrays (about 50 bytes a value at its peak): it expands half of what a
  // typed read may, and the engine's heap grows by about 1 GB at most (it used to run out of 4 GB).
  result.liveHeapGrowthMB = Math.round((process.memoryUsage().heapUsed - heapBefore) / 2 ** 20);
  assert.ok(result.liveHeapGrowthMB < 1600, `Live read heap growth ${result.liveHeapGrowthMB} MB`);

  // 6. Dimension text inside a block turned 180° reads left to right after a Sync.
  const dim = await sessions.directExecute(target, {
    requestId: randomUUID(),
    code: dimensions,
    label: 'dimensions',
  });
  assert.equal(dim.ok, true, JSON.stringify(dim).slice(0, 400));
  const third = await sdk.syncEditor(target, () => {});
  result.thirdSync = checkReview(third, 'third sync');

  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await worker?.stop();
  await host?.stop();
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1') {
    const restored = await restoreInstalledPlugin();
    console.log('installed plugin registration: ' + JSON.stringify(restored));
  }
}
