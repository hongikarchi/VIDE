// Rhino sublayers as a tree (user request 2026-10-08, SPEC-01.9 4): a synthetic document with a
// four-level layer tree (Bldg › L1 › Walls › Ext, a second Walls under L2, an empty parent and a
// separate root) is opened in a VIDE-owned hidden Rhino 8 with the plugin attached. The display
// Sync must carry the whole layer table (ids, parents, Rhino order, own counts, empty layers), and
// the tree built from it (src/core/layer-tree.ts) must nest it as Rhino does. Then the parent is
// turned off: its sublayers are reported off too and their objects are left out of the Sync. Then
// the layers are reordered: the next read carries the new order (a newer plugin also bumps the
// document revision on `Sorted`, AttachedConnection.ChangedLayer).
// No user document is opened; the test builds its own under .vide/. Without Rhino 8 it is skipped.
// Afterwards only the Rhino processes this test launched are closed and the installed VIDE's plugin
// registration is restored. VIDE_TEST_RHINO_PLUGIN picks the plugin build to load.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { buildLayerTree, flattenTree } from '../../src/core/layer-tree.ts';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
if (process.env.VIDE_TEST_RHINO_PLUGIN) probe.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
if (!existsSync(probe.executable) || !existsSync(probe.plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${probe.plugin}) is not available`,
  );
  process.exit(0);
}

const directory = runDirectory('rhino-layer-tree');
const options = { ...sdkOptions(directory), plugin: probe.plugin };
const connectionDirectory = join(directory, 'rhino-connections');

// The synthetic document: four levels, a duplicate leaf name under two parents, an empty parent
// with one child, a separate root. Objects sit on several levels; Bldg is expanded in the panel.
const build = `
System.Func<string, int, int> add = (name, parent) => {
  var layer = new Rhino.DocObjects.Layer { Name = name };
  if (parent >= 0) layer.ParentLayerId = doc.Layers[parent].Id;
  return doc.Layers.Add(layer);
};
var site = add("Site", -1);
var bldg = add("Bldg", -1);
var l1 = add("L1", bldg);
var walls1 = add("Walls", l1);
var ext = add("Ext", walls1);
var l2 = add("L2", bldg);
var walls2 = add("Walls", l2);
var empty = add("Empty", -1);
add("Child", empty);
doc.Layers[bldg].IsExpanded = true;
System.Action<int, double> box = (layer, x) => {
  var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer };
  doc.Objects.AddBox(new Box(new BoundingBox(x, 0, 0, x + 1, 1, 1)), a);
};
box(site, 0);
box(walls1, 2); box(walls1, 4);
box(ext, 6);
box(walls2, 8); box(walls2, 10); box(walls2, 12);
box(bldg, 14);
return doc.Objects.Count;`;

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

const decode = (value) => Buffer.from(value, 'base64').toString('utf8');
const shape = (nodes) =>
  nodes.map((node) => (node.children.length ? [node.name, shape(node.children)] : node.name));

let worker, host;
const result = { directory, plugin: options.plugin };
try {
  // 1. The synthetic document, saved by a work copy.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  await worker.stop();
  worker = undefined;

  // 2. The document open in a VIDE-owned hidden Rhino with the plugin attached, and an action loop.
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic-layers.3dm');
  await copyFile(receipt.filename, source);
  const script = join(attachedDirectory, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attachedDirectory.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
source=${JSON.stringify(source.replaceAll('\\', '/'))}
last=0
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
def idle(sender,args):
    global last
    try:
        path=os.path.join(folder,'action.json')
        if not os.path.exists(path):return
        with open(path) as f: action=json.load(f)
        if action['id']==last:return
        last=action['id']
        scope={'doc':Rhino.RhinoDoc.ActiveDoc,'Rhino':Rhino,'System':System,'result':None}
        exec(action['code'],scope)
        report('action-'+str(last),dict(ok=True,value=scope.get('result')))
    except Exception as e: report('action-'+str(last),dict(ok=False,error=str(e),trace=traceback.format_exc()))
try:
    opened,already=Rhino.RhinoDoc.Open(source)
    doc=Rhino.RhinoDoc.ActiveDoc
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),rhino=str(Rhino.RhinoApp.Version),plugin=assembly.Location))
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
  Object.assign(result, { rhino: ready.rhino, loaded: ready.plugin });
  let step = 0;
  const action = async (code) => {
    step++;
    await writeFile(join(attachedDirectory, 'action.tmp'), JSON.stringify({ id: step, code }));
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(join(attachedDirectory, 'action.tmp'), join(attachedDirectory, 'action.json'));
        break;
      } catch (error) {
        if (error.code !== 'EPERM' || attempt === 19) throw error;
        await new Promise((accept) => setTimeout(accept, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(attachedDirectory, 'action-' + step + '.json'), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1, 'only the test Rhino is seen');
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };
  const sync = async () => {
    const display = await sdk.syncEditor(target, () => {});
    const paths = new Map();
    for (const item of display.scene) paths.set(item.id, decode(item.layer64));
    return { display, rows: display.objects.map((o) => ({ id: o.id, path: paths.get(o.id) })) };
  };

  // 3. The first Sync: the whole layer table, nested as Rhino nests it.
  const first = await sync();
  const table = first.display.layers;
  assert.ok(Array.isArray(table), 'the Sync carries the layer table');
  const byPath = new Map(table.map((layer) => [layer.fullPath, layer]));
  for (const path of [
    'Site',
    'Bldg',
    'Bldg::L1',
    'Bldg::L1::Walls',
    'Bldg::L1::Walls::Ext',
    'Bldg::L2',
    'Bldg::L2::Walls',
    'Empty',
    'Empty::Child',
  ])
    assert.ok(byPath.has(path), 'layer ' + path);
  assert.equal(byPath.get('Bldg::L1::Walls::Ext').parentId, byPath.get('Bldg::L1::Walls').id);
  assert.equal(byPath.get('Bldg::L2::Walls').parentId, byPath.get('Bldg::L2').id);
  assert.equal(byPath.get('Bldg').parentId, null);
  assert.equal(byPath.get('Bldg::L2::Walls').objectCount, 3, 'own objects only');
  assert.equal(byPath.get('Bldg').objectCount, 1);
  result.expandedSent = 'expanded' in byPath.get('Bldg');
  if (result.expandedSent) assert.equal(byPath.get('Bldg').expanded, true);
  const tree = buildLayerTree(table, first.rows, (row) => row.path);
  result.firstTree = shape(tree.roots);
  // Rhino's order: Site was added first, then Bldg; empty leaves drop, Empty has no listed objects.
  assert.deepEqual(result.firstTree, [
    'Site',
    [
      'Bldg',
      [
        ['L1', [['Walls', ['Ext']]]],
        ['L2', ['Walls']],
      ],
    ],
  ]);
  const bldg = tree.roots[1];
  assert.equal(bldg.total, 7);
  assert.equal(bldg.own.length, 1);
  assert.equal(flattenTree(tree.roots).at(-1).depth, 2);

  // 4. The parent turned off: Rhino reports its sublayers off and the Sync leaves them out.
  await action(`
layer=doc.Layers.FindByFullPath('Bldg',-1)
doc.Layers[layer].IsVisible=False
doc.Layers[layer].CommitChanges()
result=[(l.FullPath,l.IsVisible) for l in doc.Layers if not l.IsDeleted]`);
  const off = await sync();
  const offPaths = new Map(off.display.layers.map((layer) => [layer.fullPath, layer]));
  result.offVisible = Object.fromEntries(
    [...offPaths].map(([path, layer]) => [path, layer.visible]),
  );
  assert.equal(offPaths.get('Bldg').visible, false);
  assert.equal(off.rows.length, 1, 'only Site stays in the Sync');
  const offTree = buildLayerTree(off.display.layers, off.rows, (row) => row.path);
  const hidden = flattenTree(offTree.roots).filter((node) => node.fullPath.startsWith('Bldg'));
  assert.ok(hidden.length >= 1, 'the off branch is kept for its uncounted objects');
  assert.ok(
    hidden.every((node) => node.hidden),
    'every layer under the off parent is hidden',
  );
  assert.equal(hidden[0].hostTotal, 7, 'the host counts what the Sync left out');
  result.hiddenLayers = off.display.displayCoverage?.hiddenLayers;

  // 5. Back on, then reordered (Bldg's children swapped): the next read has the new order.
  const before = off.display.sourceDocument.revision;
  await action(`
layer=doc.Layers.FindByFullPath('Bldg',-1)
doc.Layers[layer].IsVisible=True
doc.Layers[layer].CommitChanges()
result=True`);
  const on = await sync();
  const onRevision = on.display.sourceDocument.revision;
  const sorted = await action(`
order=[l.Index for l in doc.Layers if not l.IsDeleted]
l1=doc.Layers.FindByFullPath('Bldg::L1',-1)
l2=doc.Layers.FindByFullPath('Bldg::L2',-1)
i,j=order.index(l1),order.index(l2)
order[i],order[j]=order[j],order[i]
ok=False
try:
    doc.Layers.Sort(System.Array[int](order)); ok=True
except Exception as e:
    ok=str(e)
result=ok`);
  result.sortAvailable = sorted === true;
  if (sorted === true) {
    const after = await sync();
    const afterTree = buildLayerTree(after.display.layers, after.rows, (row) => row.path);
    result.sortedTree = shape(afterTree.roots);
    assert.deepEqual(
      afterTree.roots[1].children.map((node) => node.name),
      ['L2', 'L1'],
      'the tree follows the new Rhino order',
    );
    result.sortedRevision = { before: onRevision, after: after.display.sourceDocument.revision };
    // A plugin that sends `expanded` also marks the document changed on a reorder, so Live Sync
    // brings the new order without another edit (an older one keeps the revision).
    if (result.expandedSent)
      assert.ok(
        result.sortedRevision.after > result.sortedRevision.before,
        'reorder bumps the revision',
      );
  }
  result.revisions = { off: before, on: onRevision };
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  // Only the Rhino processes this test launched; other Rhino windows are never touched.
  await worker?.stop();
  await host?.stop();
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1') {
    const restored = await restoreInstalledPlugin();
    console.log('installed plugin registration: ' + JSON.stringify(restored));
  }
}
