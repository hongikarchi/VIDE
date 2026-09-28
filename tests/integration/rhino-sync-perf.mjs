// Sync timing on a copied Rhino document in an owned test Rhino. Never opens a user original.
// Usage: node tests/integration/rhino-sync-perf.mjs [.vide/sync-perf/model.3dm]
// VIDE_TEST_RHINO_PLUGIN selects the RHP build to measure.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { launchOwnedHost, inspectWindowsProcess } from '../../hosts/common/owned-process.ts';
import { sendHostCommand } from '../../hosts/common/transport.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { resumeEditor } from '../../hosts/rhino/editor-channel.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { applyDisplayDelta } from '../../src/core/display-delta.ts';

const model = resolve(process.argv[2] || '.vide/sync-perf/model.3dm');
const copies = relative(resolve('.vide'), model);
assert.ok(
  copies && !copies.startsWith('..') && !isAbsolute(copies),
  'model must be a copy under .vide/',
);
const directory = resolve('.vide/sync-perf', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
const script = join(directory, 'fixture.py');
const slash = (path) => path.replaceAll('\\', '/');
await writeFile(
  script,
  `import Rhino, System, json, os, traceback
folder=${JSON.stringify(slash(directory))}
last=0
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
def first(doc):
    return sorted(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.Brep),key=lambda o:str(o.Id))[0]
def idle(sender,args):
    global last
    try:
        path=os.path.join(folder,'action.json')
        if not os.path.exists(path):return
        with open(path) as f: action=json.load(f)
        if action['id']==last:return
        last=action['id'];command=action['command'];doc=Rhino.RhinoDoc.ActiveDoc;extra={}
        if command=='move':
            obj=first(doc);extra['id']=str(obj.Id)
            assert doc.Objects.Transform(obj.Id,Rhino.Geometry.Transform.Translation(1000,0,0),True)!=System.Guid.Empty
        elif command=='moveBlock':
            obj=sorted(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.InstanceReference),key=lambda o:str(o.Id))[0];extra['id']=str(obj.Id)
            assert doc.Objects.Transform(obj.Id,Rhino.Geometry.Transform.Translation(0,2000,0),True)!=System.Guid.Empty
        elif command=='delete':
            obj=first(doc);extra['id']=str(obj.Id)
            assert doc.Objects.Delete(obj.Id,True)
        elif command=='add':
            extra['id']=str(doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,1000,1000,1000))))
        elif command=='layerColor':
            layer=doc.Layers[first(doc).Attributes.LayerIndex];layer.Color=System.Drawing.Color.FromArgb(255,10,20,30);layer.CommitChanges()
        elif command=='undo': assert Rhino.RhinoApp.RunScript('_Undo',False)
        report('action-'+str(last),dict(ok=True,**extra))
    except Exception as e: report('action-'+str(last),dict(ok=False,error=str(e)))
try:
    read=Rhino.FileIO.FileReadOptions();read.BatchMode=True;read.ImportMode=False
    assert Rhino.RhinoDoc.ReadFile(${JSON.stringify(slash(model))},read)
    doc=Rhino.RhinoDoc.ActiveDoc
    Rhino.PlugIns.PlugIn.LoadPlugIn(${JSON.stringify(slash(options.plugin))})
    assert Rhino.RhinoApp.RunScript('_VIDEConnect',False)
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,objects=doc.Objects.Count))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
);
const wait = async (fn, ms = 600000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error('Timed out');
};
const time = async (fn) => {
  const began = performance.now();
  const value = await fn();
  return [value, Math.round(performance.now() - began)];
};
let host,
  step = 0;
const result = { model: slash(copies), plugin: slash(options.plugin), directory };
try {
  const [, openMs] = await time(async () => {
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
      JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')),
    );
    assert.equal(ready.ok, true, JSON.stringify(ready));
    result.documentObjects = ready.objects;
  });
  result.openMs = openMs;
  const action = async (command) => {
    step++;
    await writeFile(join(directory, 'action.tmp'), JSON.stringify({ id: step, command }));
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(join(directory, 'action.tmp'), join(directory, 'action.json'));
        break;
      } catch (error) {
        if (error.code !== 'EPERM' || attempt === 19) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(directory, 'action-' + step + '.json'), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  };
  const identity = [];
  const inspect = async (pid, port) => {
    const began = performance.now();
    try {
      return await inspectWindowsProcess(pid, port);
    } finally {
      identity.push(Math.round(performance.now() - began));
    }
  };
  const sessions = new EditorSessions({
    ...options,
    connectionDirectory,
    resume: (connection, executable) => resumeEditor(connection, executable, inspect),
  });
  const catalog = await sessions.list(true);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };
  const record = JSON.parse(
    await readFile(
      join(
        connectionDirectory,
        (await readdir(connectionDirectory)).find((n) => n.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  // Raw host calls skip the ownership check to isolate the Rhino-side cost.
  const raw = async (method, extra = {}) => {
    const began = performance.now();
    const reply = await sendHostCommand(
      'vide',
      { ...record.identity, token: record.token, method, ...extra },
      { port: record.identity.port, timeoutMs: 600000, maxResponseBytes: 64 * 1024 * 1024 },
    );
    return [reply, Math.round(performance.now() - began)];
  };
  identity.length = 0;
  const [, statusMs] = await time(() => sessions.list(true));
  const [, statusAgainMs] = await time(() => sessions.list(true));
  result.statusPollMs = [statusMs, statusAgainMs];
  result.identityCheckMs = identity.slice();
  const [, inspectMs] = await raw('inspectEditor');
  result.rawInspectEditorMs = inspectMs;
  // Product path first, while the plugin's display cache is still cold.
  identity.length = 0;
  const [display, productMs] = await time(() => sessions.display(target));
  // Kept locally (never committed) for a browser check of the same display model.
  await writeFile(join(directory, 'display.json'), JSON.stringify(display));
  result.productDisplay = {
    ms: productMs,
    objects: display.objects.length,
    coverage: display.displayCoverage,
    identityChecks: identity.length,
    identityMs: identity.reduce((a, b) => a + b, 0),
  };
  const [, secondMs] = await time(() => sessions.display(target));
  result.productDisplaySecondMs = secondMs;
  const pages = [];
  let offset = 0,
    limit = 1000,
    revision,
    total;
  do {
    const [reply, ms] = await raw('displayPage', {
      offset,
      limit,
      ...(revision === undefined ? {} : { revision }),
    });
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    if (reply.ok === false) {
      pages.push({ offset, limit, ms, code: reply.code });
      assert.equal(reply.code, 'HOST_RESULT_TOO_LARGE');
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    pages.push({ offset, limit, ms, objects: reply.objects.length, bytes });
    revision = reply.page.revision;
    total = reply.page.total;
    offset = reply.page.nextOffset;
  } while (offset < total);
  result.rawPages = pages;
  result.rawDisplayMs = pages.reduce((sum, page) => sum + page.ms, 0);
  result.rawDisplayBytes = pages.reduce((sum, page) => sum + (page.bytes ?? 0), 0);
  result.discardedPages = pages.filter((page) => page.code).length;
  // Live Sync: each edit's delta merged into the previous display must equal a fresh full Sync.
  const signature = (model) =>
    JSON.stringify(
      model.scene
        .map((item) => [item.nativeId, item.geometryHash, item.layerColor, item.displayColor])
        .sort(),
    );
  let basis = display;
  const live = [];
  for (const command of ['move', 'moveBlock', 'delete', 'add', 'layerColor', 'undo']) {
    await action(command);
    let delta, deltaMs;
    try {
      [delta, deltaMs] = await time(() => sessions.changes(target, basis.source.revision));
    } catch (error) {
      live.push({ command, code: error.code });
      break;
    }
    const merged = applyDisplayDelta(basis, delta);
    const [full, fullMs] = await time(() => sessions.display(target));
    assert.equal(signature(merged), signature(full), `${command}: delta differs from full Sync`);
    live.push({
      command,
      deltaMs,
      changed: delta.scene.length,
      removed: delta.removed.length,
      fullMs,
    });
    basis = { ...full };
  }
  result.liveSync = live;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await host?.stop();
}
