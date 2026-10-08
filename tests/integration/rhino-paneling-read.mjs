// PLAN-49 T-251: 패널링 '기준 면 고르기' against a real hidden Rhino 8 — synthetic surfaces only,
// made by a VIDE-owned worker under .vide/tests/paneling-read/, opened in a VIDE-owned hidden
// Rhino that attaches to the plugin. Never a user document, never the user's Rhino; only this
// script's processes are stopped. Afterwards the installed engine's connector status is read (and
// the plugin re-installed only when it is not current and no Rhino runs).
//
//   node tests/integration/rhino-paneling-read.mjs
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp with direct-read>
//
// Checks: [고른 면 쓰기] from the Rhino selection → a `SurfaceSample` that passes the contract (trim
// loops, fingerprint), no undo record and no document change; [다시 읽기] gives the same fingerprint
// and a 1 mm move another; a 6-face polysurface on a smaller grid; a closed cylinder (seam) and a
// pole; a mesh refused with its reason (earlier sample kept); a writing body through `direct-read`
// refused and put back.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { surfaceSampleSchema } from '../../src/contracts/paneling.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { panelingRoutes } from '../../src/server/paneling-routes.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';
import { surfaceTestJig, SURFACE_TEST_JIG } from '../fixtures/paneling-jig.mjs';

const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve('.vide/tests/paneling-read', stamp);
await mkdir(directory, { recursive: true });
const options = { ...sdkOptions(directory), plugin };
const connectionDirectory = join(directory, 'rhino-connections');
const ms = (t) => Math.round(performance.now() - t);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Synthetic surfaces (metres): a saddle with a trimmed hole, a closed cylinder (seam), a sphere
// band up to the pole, a box (6 faces), a mesh. No project data.
const BUILD = `doc.AdjustModelUnitSystem(UnitSystem.Meters, false);
var tol = doc.ModelAbsoluteTolerance;
var ids = new System.Collections.Generic.Dictionary<string, string>();
void Add(string name, Brep b) { if (b == null || !b.IsValid) throw new Exception("build " + name); ids[name] = doc.Objects.AddBrep(b, new Rhino.DocObjects.ObjectAttributes { Name = name }).ToString(); }
var pts = new System.Collections.Generic.List<Point3d>();
for (var i = 0; i < 13; i++) for (var j = 0; j < 9; j++) { double x = 30.0 * i / 12, y = 20.0 * j / 8; pts.Add(new Point3d(x, y, (x - 15) * (x - 15) / 60 - (y - 10) * (y - 10) / 40 + 5)); }
var saddle = NurbsSurface.CreateThroughPoints(pts, 13, 9, 3, 3, false, false).ToBrep();
var circle = new Circle(new Plane(new Point3d(20, 12, 100), Vector3d.ZAxis), 2.5).ToNurbsCurve();
var projected = Curve.ProjectToBrep(circle, saddle, -Vector3d.ZAxis, tol);
var split = saddle.Faces[0].Split(projected, tol);
var a0 = AreaMassProperties.Compute(split.Faces[0].DuplicateFace(false)).Area;
var a1 = AreaMassProperties.Compute(split.Faces[1].DuplicateFace(false)).Area;
Add("saddle", split.Faces[a0 < a1 ? 1 : 0].DuplicateFace(false));
Add("cylinder", new Cylinder(new Circle(new Plane(new Point3d(80, 0, 0), Vector3d.ZAxis), 4), 6).ToBrep(false, false));
var meridian = new Circle(new Plane(new Point3d(110, 0, 0), Vector3d.XAxis, Vector3d.ZAxis), 5);
Add("sphere", RevSurface.Create(new ArcCurve(new Arc(meridian, new Interval(-Math.PI / 6, Math.PI / 2))), new Line(new Point3d(110, 0, 0), new Point3d(110, 0, 1))).ToBrep());
Add("box", new Box(new BoundingBox(140, 0, 0, 146, 4, 3)).ToBrep());
ids["mesh"] = doc.Objects.AddMesh(Mesh.CreateFromBox(new BoundingBox(190, 0, 0, 192, 2, 2), 1, 1, 1), new Rhino.DocObjects.ObjectAttributes { Name = "mesh" }).ToString();
return ids;`;

const wait = async (fn, timeout = 180000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error('Timed out');
};

/** The installed engine's connectors through the launch.json session (token never printed). */
async function installedConnectors({ install = false } = {}) {
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
  if (!session.ok || !cookie) return { ok: false, status: session.status };
  const headers = { Origin: origin, Cookie: cookie };
  let installed;
  if (install) {
    const r = await fetch(new URL('/api/v1/connectors/rhino8/install', origin), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(60000),
    });
    installed = { status: r.status };
  }
  const list = await fetch(new URL('/api/v1/connectors', origin), {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const body = await list.json();
  return {
    installed,
    rhino8: (body.connectors ?? body).find((c) => c.id === 'rhino8')?.plugin ?? null,
  };
}

let worker, host, store, workspace;
const result = { directory, plugin };
try {
  // 1. The synthetic document, made and saved by a hidden worker.
  let t = performance.now();
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const built = await worker.execute(randomUUID(), 0, BUILD);
  assert.equal(built.ok, true, JSON.stringify(built).slice(0, 1500));
  const ids = built.value;
  await worker.stop();
  worker = undefined;
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'paneling-read.3dm');
  await copyFile(built.filename, source);
  log('document', ms(t), 'ms');

  // 2. The document in a VIDE-owned hidden Rhino attached to the plugin, with an action loop.
  const script = join(attachedDirectory, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attachedDirectory.replaceAll('\\', '/'))}
plugin=${JSON.stringify(plugin.replaceAll('\\', '/'))}
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
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),rhino=str(Rhino.RhinoApp.Version)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
  );
  t = performance.now();
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
  result.rhino = ready.rhino;
  log('attached Rhino', ready.rhino, ms(t), 'ms');
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
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(attachedDirectory, `action-${step}.json`), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  const documentState = async () =>
    action(
      'result=[len(list(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectEnumeratorSettings()))), int(doc.NextUndoRecordSerialNumber), bool(doc.Modified)]',
    );
  const select = (id) =>
    action(`doc.Objects.UnselectAll()\ndoc.Objects.Select(System.Guid('${id}'))\nresult=True`);

  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. A project with the link and a work copy of the test jig (engine data under the run folder).
  const dataDir = join(directory, 'engine');
  mkdirSync(dataDir, { recursive: true });
  store = new Store(join(directory, 'workspace.sqlite'));
  workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('패널링 기준 면 시험');
  const link = links.link(project.id, { host: 'rhino', name: 'paneling-read.3dm', ...target });
  const call = async (method, path, payload) => {
    let last;
    const url = new URL(path, 'http://127.0.0.1');
    const send = (status, data) => (last = { status, data });
    const handled =
      (await panelingRoutes(url, method, {
        workspace,
        dataDirectory: dataDir,
        body: async () => payload ?? {},
        send,
        remote: false,
        links,
        sdk,
      })) ||
      (await jigRoutes(url, Object.assign(Readable.from([]), { method, headers: {} }), {
        workspace,
        body: async () => payload ?? {},
        send,
        dataDirectory: dataDir,
        links,
        remote: false,
      }));
    assert.ok(handled);
    return last;
  };
  const packed = await packJig(surfaceTestJig(directory), {
    dataDir,
    bundle: false,
    skipTests: true,
  });
  await importPack(packed.bytes, { store: new JigStore(store), dataDir });
  const base = `/api/v1/projects/${project.id}`;
  const created = await call('POST', `${base}/jig-instances`, {
    jig: SURFACE_TEST_JIG,
    version: '0.1.0',
    title: '패널링 시험 작업본',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const iid = created.data.id;
  const read = async (payload) => {
    const s = performance.now();
    const r = await call('POST', `${base}/paneling/surface/read`, { instanceId: iid, ...payload });
    assert.equal(r.status, 200, JSON.stringify(r));
    return { ...r.data, ms: ms(s) };
  };
  const keptSample = () =>
    jigRuntimeFor(workspace, dataDir).hostSurface(project.id, iid, 'surface');

  // 4. [고른 면 쓰기] from the Rhino selection: the saddle with a hole.
  await select(ids.saddle);
  const before = await documentState();
  const picked = await read({});
  assert.equal(picked.ok, true, JSON.stringify(picked));
  const after = await documentState();
  assert.deepEqual(after, before, 'a read adds no object, no undo record, no modified flag');
  const kept = keptSample();
  const sample = surfaceSampleSchema.parse(kept.sample);
  assert.equal(sample.source.objectId, ids.saddle.toLowerCase());
  assert.equal(sample.source.path, 'attached-template');
  assert.equal(sample.source.toMeters, 1);
  assert.equal(sample.faces.length, 1);
  const face = sample.faces[0];
  assert.equal(face.nu, 128);
  assert.ok(face.trimLoops.length >= 2, 'outer loop and the hole');
  assert.ok(face.inside.includes(0) && face.inside.includes(1));
  assert.match(face.geometryHash, /^[a-f0-9]{64}$/);
  const flat = face.points.every(Number.isFinite) && face.normals.every(Number.isFinite);
  assert.ok(flat);
  result.saddle = { ms: picked.ms, inside: picked.summary.faces[0].inside };
  log('saddle 128²', picked.ms, 'ms');

  // The step reads the kept sample.
  const run = await call('POST', `${base}/jig-instances/${iid}/run`, { mode: 'confirmed' });
  assert.equal(run.status, 200, JSON.stringify(run));
  assert.deepEqual(run.data.outputs.look, {
    read: true,
    objectId: ids.saddle.toLowerCase(),
    points: 128 * 128,
  });

  // [다시 읽기]: the same fingerprint; after a 1 mm move another one.
  const again = await read({ mode: 'reread' });
  assert.equal(again.ok, true);
  assert.deepEqual(again.picked.faceHashes, picked.picked.faceHashes);
  await action(
    `doc.Objects.Transform(System.Guid('${ids.saddle}'), Rhino.Geometry.Transform.Translation(0,0,0.001), True)\nresult=True`,
  );
  const moved = await read({ mode: 'reread' });
  assert.equal(moved.ok, true);
  assert.notDeepEqual(moved.picked.faceHashes, picked.picked.faceHashes);
  // The moved face is a new input copy: the step needs computing again.
  const view = await call('GET', `${base}/jig-instances/${iid}`);
  assert.equal(view.data.status, 'stale');

  // 5. A polysurface (box, 6 faces) on a smaller grid; a seam and a pole.
  const box = await read({ objectId: ids.box });
  assert.equal(box.ok, true, JSON.stringify(box));
  assert.deepEqual(box.picked.faces, [0, 1, 2, 3, 4, 5]);
  assert.equal(box.picked.grid, 104);
  surfaceSampleSchema.parse(keptSample().sample);
  const cylinder = await read({ objectId: ids.cylinder });
  assert.equal(cylinder.ok, true, JSON.stringify(cylinder));
  assert.equal(cylinder.summary.faces[0].closedU || cylinder.summary.faces[0].closedV, true);
  const sphere = await read({ objectId: ids.sphere });
  assert.equal(sphere.ok, true, JSON.stringify(sphere));
  const poles = Object.values(sphere.summary.faces[0].singular).filter(Boolean).length;
  assert.equal(poles, 1);
  surfaceSampleSchema.parse(keptSample().sample);
  result.reads = { box: box.ms, cylinder: cylinder.ms, sphere: sphere.ms };

  // 6. Failures keep the earlier sample: a mesh, a missing object, too fine a grid.
  const keptBefore = keptSample().hash;
  await select(ids.mesh);
  const mesh = await read({});
  assert.equal(mesh.ok, false);
  assert.equal(mesh.code, 'MESH_NOT_ACCEPTED');
  assert.equal(mesh.message, '메쉬 기준 면은 아직 받지 않습니다 · Rhino에서 서피스로 바꾸세요');
  const missing = await read({ objectId: randomUUID() });
  assert.equal(missing.code, 'FACE_NOT_FOUND');
  const tooFine = await read({ mode: 'reread', grid: 512 });
  assert.equal(tooFine.code, 'SAMPLE_LIMIT');
  assert.equal(keptSample().hash, keptBefore);

  // 7. direct-read refuses a body that writes, and puts back what it added.
  const state0 = await documentState();
  const writing = await sdk.readDirect(
    target,
    'doc.Objects.AddPoint(new Point3d(1, 2, 3)); return 1;',
  );
  assert.equal(writing.ok, false);
  assert.equal(writing.code, 'READ_CHANGED_DOCUMENT');
  assert.equal(writing.reverted, true);
  const state1 = await documentState();
  assert.equal(state1[0], state0[0], 'the added point is gone');
  assert.equal(state1[1], state0[1], 'no undo record');
  result.passed = true;
  log('passed');
} finally {
  await worker?.stop().catch(() => {});
  await host?.stop().catch(() => {});
  if (workspace) await closeJigRuntime(workspace).catch(() => {});
  store?.close();
  // Installed engine connectors: read; re-install only when not current and no Rhino runs.
  try {
    let status = await installedConnectors();
    let running = false;
    try {
      running = /Rhino\.exe/i.test(
        execSync('tasklist /FI "IMAGENAME eq Rhino.exe" /NH', { encoding: 'utf8' }),
      );
    } catch {}
    if (status.rhino8 && status.rhino8 !== 'current' && !running)
      status = await installedConnectors({ install: true });
    result.connectors = { ...status, rhinoRunning: running };
  } catch (error) {
    result.connectors = { error: String(error) };
  }
  console.log('installed connectors: ' + JSON.stringify(result.connectors));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
}
