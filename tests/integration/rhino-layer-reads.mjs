// T-043 (PLAN-22) on a synthetic document in VIDE-owned Rhino processes: the read survey (hidden
// layers, hidden objects, block-definition geometry), the layer table, layer-limited and
// hidden-inclusive reads on both paths (work copy export = files opened in VIDE, and the attached
// display page), block definitions with a −21° instance rotation on the export path, and a two-level
// new layer applied under its new parent. No user document is opened; the test builds its own.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Applications } from '../../src/server/application.ts';
import { applyAttachedCandidate } from '../../src/server/attached-application.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('rhino-layer-reads');
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);

// The synthetic document: 3 column lines, a hidden layer '기존::기초' with 2 footing boxes and one
// cap instance, a hidden box on a visible layer, 3 cap instances turned −21°, an empty layer, and a
// block definition of 2 objects (a cap solid and an open-cut outline).
const build = `
var iColumns = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기둥" });
var iOld = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기존" });
var iFooting = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기초", ParentLayerId = doc.Layers[iOld].Id, IsVisible = false });
var iCaps = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "신설 기초" });
var iHidden = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "숨김" });
doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "빈 레이어" });
for (int i = 0; i < 3; i++) { var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iColumns }; doc.Objects.AddLine(new Point3d(i * 6, 0, 0), new Point3d(i * 6, 0, 4), a); }
for (int i = 0; i < 2; i++) { var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iFooting }; doc.Objects.AddBox(new Box(new BoundingBox(i * 6 - 1, -1, -1, i * 6 + 1, 1, 0)), a); }
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iHidden, Visible = false }; doc.Objects.AddBox(new Box(new BoundingBox(20, 20, 0, 21, 21, 1)), a); }
var geometry = new System.Collections.Generic.List<GeometryBase> { new Box(new BoundingBox(-1, -1, -0.5, 1, 1, 0)).ToBrep(), new PolylineCurve(new[] { new Point3d(-1.8, -1.8, 0), new Point3d(1.8, -1.8, 0), new Point3d(1.8, 1.8, 0), new Point3d(-1.8, 1.8, 0), new Point3d(-1.8, -1.8, 0) }) };
var attributes = new System.Collections.Generic.List<Rhino.DocObjects.ObjectAttributes> { new Rhino.DocObjects.ObjectAttributes(), new Rhino.DocObjects.ObjectAttributes() };
var idef = doc.InstanceDefinitions.Add("cap", "pile cap", Point3d.Origin, geometry, attributes);
if (idef < 0) throw new Exception("definition");
var turn = Transform.Rotation(-21 * Math.PI / 180, Vector3d.ZAxis, Point3d.Origin);
for (int i = 0; i < 3; i++) { var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iCaps }; doc.Objects.AddInstanceObject(idef, Transform.Translation(i * 6, 0, 0) * turn, a); }
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iFooting }; doc.Objects.AddInstanceObject(idef, Transform.Translation(30, 0, 0) * turn, a); }
return doc.Objects.Count;`;
const HIDDEN_LAYER = '기존::기초';
const degrees = (transform) => (Math.atan2(transform[4], transform[0]) * 180) / Math.PI;
const layerNames = (model) => model.layers.map((layer) => layer.fullPath);
const byLayer = (model) =>
  model.scene.map((row) => Buffer.from(row.layer64, 'base64').toString('utf8'));

function expectSurvey(model, expected, what) {
  const { omittedHidden, omittedFiltered, omittedBlockInternal, hiddenLayers } =
    model.displayCoverage;
  assert.deepEqual(
    { omittedHidden, omittedFiltered, omittedBlockInternal, hiddenLayers },
    expected,
    what,
  );
}

const wait = async (fn) => {
  const end = Date.now() + 120000;
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

let worker, host;
const result = { directory };
try {
  // 1. Work-copy export (the path of files opened in VIDE): survey, layer table, blocks.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  assert.equal(receipt.value, 12, 'document count includes hidden objects and definition geometry');
  const exported = await worker.exportModel();
  await worker.stop();
  worker = undefined;
  assert.equal(exported.objects.length, 6, 'the display read lists visible objects only');
  expectSurvey(
    exported,
    {
      omittedHidden: 4,
      omittedFiltered: 0,
      omittedBlockInternal: 2,
      hiddenLayers: [{ path: HIDDEN_LAYER, count: 3 }],
    },
    'export survey',
  );
  for (const name of ['기둥', '기존', HIDDEN_LAYER, '신설 기초', '숨김', '빈 레이어'])
    assert.ok(layerNames(exported).includes(name), `layer table lists ${name}`);
  const table = Object.fromEntries(exported.layers.map((layer) => [layer.fullPath, layer]));
  assert.equal(table[HIDDEN_LAYER].visible, false);
  assert.equal(table[HIDDEN_LAYER].objectCount, 3, 'hidden objects count on their layer');
  assert.equal(table[HIDDEN_LAYER].parentId, table['기존'].id);
  assert.equal(table['빈 레이어'].objectCount, 0, 'empty layers are listed');
  assert.equal(table['숨김'].visible, true);
  const caps = exported.scene.filter((row) => row.block);
  assert.equal(caps.length, 3);
  for (const cap of caps) {
    assert.ok(Math.abs(degrees(cap.block.transform) + 21) < 1e-9, 'rotation kept at −21°');
    const definition = exported.definitions[cap.block.definition];
    assert.ok(
      definition.vertices.length >= 24 && definition.indices.length >= 36,
      'cap solid mesh',
    );
    assert.equal(definition.segments.length, 4 * 6, 'open-cut outline as 4 segments');
    assert.match(definition.hash, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(
    caps.map((cap) => cap.block.transform[3]).sort((a, b) => a - b),
    [0, 6, 12],
    'translation in meters',
  );
  assert.equal(exported.displayCoverage.omitted, 0, 'instances with a definition are displayed');
  result.exportSurvey = exported.displayCoverage;
  result.exportLayers = exported.layers.length;

  // 2. Export arguments: a layer filter, and hidden objects when asked (importFile → worker).
  const sdk = new SdkExecution({ ...options, tools: {}, origin: () => '' });
  const columnsOnly = await sdk.importFile(receipt.filename, () => {}, [], { layers: ['기둥'] });
  assert.equal(columnsOnly.objects.length, 3);
  assert.deepEqual(new Set(byLayer(columnsOnly)), new Set(['기둥']));
  expectSurvey(
    columnsOnly,
    { omittedHidden: 0, omittedFiltered: 7, omittedBlockInternal: 2, hiddenLayers: [] },
    'layer-limited export survey',
  );
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'hidden-layer'),
    source: { filename: receipt.filename, fileHash: receipt.fileHash },
    exportScope: { layers: [HIDDEN_LAYER], includeHidden: true },
  });
  const hiddenLayer = await worker.exportModel();
  await worker.stop();
  worker = undefined;
  assert.equal(hiddenLayer.objects.length, 3, 'hidden layer read with includeHidden');
  assert.deepEqual(new Set(byLayer(hiddenLayer)), new Set([HIDDEN_LAYER]));
  assert.equal(hiddenLayer.scene.filter((row) => row.block).length, 1);
  expectSurvey(
    hiddenLayer,
    { omittedHidden: 0, omittedFiltered: 7, omittedBlockInternal: 2, hiddenLayers: [] },
    'hidden-layer export survey',
  );
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'everything'),
    source: { filename: receipt.filename, fileHash: receipt.fileHash },
    exportScope: { includeHidden: true },
  });
  const everything = await worker.exportModel();
  await worker.stop();
  worker = undefined;
  assert.equal(everything.objects.length, 10, 'every top-level object with includeHidden');
  expectSurvey(
    everything,
    { omittedHidden: 0, omittedFiltered: 0, omittedBlockInternal: 2, hiddenLayers: [] },
    'hidden-inclusive export survey',
  );

  // 3. Attached display page of the same document in a VIDE-owned visible-class Rhino.
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic.3dm');
  await copyFile(receipt.filename, source);
  const script = join(attachedDirectory, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attachedDirectory.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
source=${JSON.stringify(source.replaceAll('\\', '/'))}
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
try:
    opened,already=Rhino.RhinoDoc.Open(source)
    doc=Rhino.RhinoDoc.ActiveDoc
    assert doc.Path and doc.Path.lower().replace('\\\\','/')==source.lower(), doc.Path
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    report('ready',dict(ok=True,documentId=int(doc.RuntimeSerialNumber),objects=int(doc.Objects.Count)))
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
    JSON.parse(await readFile(join(attachedDirectory, 'ready.json'), 'utf8')),
  );
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const attachedSdk = new SdkExecution({
    ...options,
    connectionDirectory,
    tools: {},
    origin: () => '',
  });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };
  const display = await attachedSdk.syncEditor(target, () => {});
  assert.equal(display.displayOnly, true);
  assert.equal(display.objects.length, 6, 'display Sync lists visible objects only');
  expectSurvey(
    display,
    {
      omittedHidden: 4,
      omittedFiltered: 0,
      omittedBlockInternal: 2,
      hiddenLayers: [{ path: HIDDEN_LAYER, count: 3 }],
    },
    'display survey',
  );
  assert.deepEqual(
    Object.fromEntries(display.layers.map((layer) => [layer.fullPath, layer.objectCount])),
    Object.fromEntries(exported.layers.map((layer) => [layer.fullPath, layer.objectCount])),
    'same layer table on both paths',
  );
  const displayed = display.scene.filter((row) => row.block);
  assert.equal(displayed.length, 3);
  for (const cap of displayed) assert.ok(Math.abs(degrees(cap.block.transform) + 21) < 1e-9);
  const limited = await attachedSdk.readLayers(target, {
    layers: [HIDDEN_LAYER],
    includeHidden: true,
  });
  assert.equal(limited.objects.length, 3, 'layer-limited read of a hidden layer');
  assert.deepEqual(new Set(byLayer(limited)), new Set([HIDDEN_LAYER]));
  expectSurvey(
    limited,
    { omittedHidden: 0, omittedFiltered: 7, omittedBlockInternal: 2, hiddenLayers: [] },
    'layer-limited display survey',
  );
  const visibleOnly = await attachedSdk.readLayers(target, { layers: [HIDDEN_LAYER] });
  assert.equal(visibleOnly.objects.length, 0, 'without includeHidden a hidden layer reads empty');
  expectSurvey(
    visibleOnly,
    {
      omittedHidden: 3,
      omittedFiltered: 7,
      omittedBlockInternal: 2,
      hiddenLayers: [{ path: HIDDEN_LAYER, count: 3 }],
    },
    'hidden layer without includeHidden',
  );
  // The reads did not move the connection's revision (no Live Sync basis change).
  const after = await sessions.inspect(target);
  assert.equal(after.documentHash, display.sourceDocument.documentHash, 'reads change nothing');
  // Live Sync change pages carry the survey too.
  const changes = await sessions.changes(target, 0);
  assert.equal(changes.coverage.displayed, 6);
  assert.equal(changes.layers.length, exported.layers.length);
  result.displaySurvey = display.displayCoverage;

  // 4. A two-level new layer applied to the attached document lands under its new parent.
  const basis = await attachedSdk.captureEditor(target, () => {});
  assert.equal(basis.sourceDocument.connection, 'attached-editor');
  worker = await launchRhinoWorker({
    ...options,
    directory: join(options.directory, 'candidate'),
    source: basis,
  });
  const edit = await worker.execute(
    randomUUID(),
    0,
    `var iJig = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "JIG" });
var iSub = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기둥", ParentLayerId = doc.Layers[iJig].Id });
var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iSub };
doc.Objects.AddLine(new Point3d(0, 10, 0), new Point3d(0, 10, 4), a);`,
  );
  assert.equal(edit.ok, true, JSON.stringify(edit).slice(0, 400));
  await worker.stop();
  worker = undefined;
  const candidate = {
    ...basis,
    ...edit,
    sourceDocument: basis.sourceDocument,
    hostExecuted: true,
    host: 'rhino',
    executionMode: 'sdk',
  };
  const preview = await sessions.preview(target, candidate);
  assert.equal(preview.added, 1);
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('Layer reads test');
  const input = {
    id: 'basis',
    body: 'Sync',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
    host: 'rhino',
  };
  workspace.submit(project.id, input);
  workspace.update(project.id, 'basis', 'succeeded', {
    ...basis,
    hostExecuted: true,
    host: 'rhino',
  });
  const request = workspace.submit(project.id, {
    ...input,
    id: 'edit',
    body: 'Add a column on JIG::기둥',
    baseRequestId: 'basis',
    applyToSource: true,
  }).request;
  const application = new Applications(store, workspace, { sdk: sessions });
  const applied = await applyAttachedCandidate(
    workspace,
    application,
    attachedSdk,
    request,
    candidate,
    new AbortController().signal,
  );
  store.close();
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied.result).slice(0, 400));
  const layered = await attachedSdk.readLayers(target, {});
  const jig = layered.layers.find((layer) => layer.fullPath === 'JIG');
  const sub = layered.layers.find((layer) => layer.fullPath === 'JIG::기둥');
  assert.ok(jig && sub, 'both new layers exist: ' + layerNames(layered).join(', '));
  assert.equal(sub.parentId, jig.id, 'the new sublayer is under the new parent, not in the root');
  assert.equal(sub.objectCount, 1);
  assert.equal(layered.objects.length, 7);
  result.twoLevelNewLayerUnderParent = true;
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await worker?.stop();
  await host?.stop();
}
