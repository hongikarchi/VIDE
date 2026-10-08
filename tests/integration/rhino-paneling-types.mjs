// PLAN-49 T-257: 패널링 3단계 [타입 만들기] against a real hidden Rhino 8 — a synthetic saddle (30 × 20 m,
// a trimmed hole) made by a VIDE-owned worker under .vide/rhino-paneling-types/, opened in a
// VIDE-owned hidden Rhino that attaches to the plugin. Never a user document, never the user's
// Rhino; only this script's processes are stopped. Afterwards the installed engine's connector
// status is read (and the plugin re-installed only when it is not current and no Rhino runs).
//
//   node tests/integration/rhino-paneling-types.mjs
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp>   (one with `direct-read`, PLAN-49 T-251)
//
// Through the jig route with the official `vide/paneling`, every setting given by a person:
// [고른 면 쓰기] → stages 1·2·3 → [타입 만들기] (types, connection marks, cut outlines, numbers):
// block definitions = types, placements = typed panels, failures on the failure layer; [되돌리기]
// once removes everything including the definitions; a person's moved placement kept by the next
// make; another type tolerance (types renumbered) replaces the placements under new definitions and
// removes the older definitions no placement uses (the kept one keeps its own); a definition of the
// same name a person made is left alone and its type's panels fail with the reason. The CSV tables
// and the report page from the same results. About 5,000 panels for the time.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes, jigRuntimeFor } from '../../src/server/jig-routes.ts';
import { panelingRoutes } from '../../src/server/paneling-routes.ts';
import { typingHashOf } from '../../src/jigs/bake/panels.ts';
import { SCHEDULE_COLUMNS } from '../../src/contracts/paneling.ts';
import { scheduleCsv, scheduleRows } from '../../src/jigs/official/paneling-kit/index.ts';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
const directory = runDirectory('rhino-paneling-types');
const options = { ...sdkOptions(directory), plugin };
const connectionDirectory = join(directory, 'rhino-connections');
const ms = (t) => Math.round(performance.now() - t);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The synthetic saddle of SPIKE-2026-10-08-paneling (metres): z = (x−15)²/60 − (y−10)²/40 + 5 with a
// 2.5 m hole. No project data.
const BUILD = `doc.AdjustModelUnitSystem(UnitSystem.Meters, false);
var tol = doc.ModelAbsoluteTolerance;
var pts = new System.Collections.Generic.List<Point3d>();
for (var i = 0; i < 13; i++) for (var j = 0; j < 9; j++) { double x = 30.0 * i / 12, y = 20.0 * j / 8; pts.Add(new Point3d(x, y, (x - 15) * (x - 15) / 60 - (y - 10) * (y - 10) / 40 + 5)); }
var saddle = NurbsSurface.CreateThroughPoints(pts, 13, 9, 3, 3, false, false).ToBrep();
var circle = new Circle(new Plane(new Point3d(20, 12, 100), Vector3d.ZAxis), 2.5).ToNurbsCurve();
var projected = Curve.ProjectToBrep(circle, saddle, -Vector3d.ZAxis, tol);
var split = saddle.Faces[0].Split(projected, tol);
var a0 = AreaMassProperties.Compute(split.Faces[0].DuplicateFace(false)).Area;
var a1 = AreaMassProperties.Compute(split.Faces[1].DuplicateFace(false)).Area;
var face = split.Faces[a0 < a1 ? 1 : 0].DuplicateFace(false);
return doc.Objects.AddBrep(face, new Rhino.DocObjects.ObjectAttributes { Name = "saddle" }).ToString();`;

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
  const saddleId = String(built.value);
  await worker.stop();
  worker = undefined;
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'paneling-types.3dm');
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
  /**
   * Objects of the instance by bake and layer (layer names come back as JSON escapes: Python does
   * not read the action file as UTF-8), placements, and the block definitions by name with their
   * owner (`mine`: this instance's description) and placement count.
   */
  const census = (iid) =>
    action(`s=Rhino.DocObjects.ObjectEnumeratorSettings()
s.HiddenObjects=True
s.LockedObjects=True
rows={}
placements=0
total=0
for o in doc.Objects.GetObjectList(s):
    total+=1
    if o.Attributes.GetUserString('vide-instance')!=${JSON.stringify(iid)}:continue
    k=(o.Attributes.GetUserString('vide-bake') or '')+'|'+doc.Layers[o.Attributes.LayerIndex].FullPath
    rows[k]=rows.get(k,0)+1
    if o.ObjectType==Rhino.DocObjects.ObjectType.InstanceReference: placements+=1
defs={}
for d in doc.InstanceDefinitions:
    if d is None or d.IsDeleted: continue
    defs[d.Name]=dict(mine=(d.Description or '').endswith(${JSON.stringify(iid)}+u' \\u00b7 types'),vide=(d.Description or '').startswith('VIDE '),uses=len(d.GetReferences(0)),objects=len(d.GetObjects()))
result=dict(rows=rows,placements=placements,total=total,defs=defs)`);

  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. A project with the link and a work copy of the official 패널링 jig.
  const dataDir = join(directory, 'engine');
  await mkdir(dataDir, { recursive: true });
  store = new Store(join(directory, 'workspace.sqlite'));
  workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('패널링 타입 만들기 시험');
  links.link(project.id, { host: 'rhino', name: 'paneling-types.3dm', ...target });
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
        sdk,
        remote: false,
      }));
    assert.ok(handled, path);
    return last;
  };
  const base = `/api/v1/projects/${project.id}`;
  const created = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/paneling',
    version: '0.1.0',
    title: '패널링 타입 만들기 시험',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const iid = created.data.id;
  const ibase = `${base}/jig-instances/${iid}`;
  await action(
    `doc.Objects.UnselectAll()\ndoc.Objects.Select(System.Guid('${saddleId}'))\nresult=True`,
  );
  const picked = await call('POST', `${base}/paneling/surface/read`, { instanceId: iid });
  assert.equal(picked.data.ok, true, JSON.stringify(picked.data));
  const manifestParams = (
    await jigRuntimeFor(workspace, dataDir).registry.resolve('vide/paneling', '0.1.0')
  ).manifest.params;
  /** Every setting given by a person (so the make is allowed), then stages 1·2·3. */
  const compute = async (values) => {
    const merged = Object.fromEntries(manifestParams.map((p) => [p.key, p.default]));
    Object.assign(merged, values);
    const set = await call('PUT', `${ibase}/params`, {
      values: Object.entries(merged).map(([key, value]) => ({ key, value })),
    });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    const s = performance.now();
    const run = await call('POST', `${ibase}/run`, { mode: 'confirmed' });
    assert.equal(run.status, 200, JSON.stringify(run.data).slice(0, 1500));
    const outputs = run.data.outputs;
    assert.equal(outputs.optimize?.schema, 'vide.paneling.typing@1', Object.keys(outputs).join());
    return { ...outputs, ms: ms(s) };
  };
  const MAKE = ['types', 'connections', 'cuts', 'cut-numbers'];
  const bake = async (ids, label) => {
    const s = performance.now();
    const made = await call('POST', `${ibase}/bake`, { bake: ids });
    const took = ms(s);
    log(label, made.status, made.data?.text ?? made.data?.code, took, 'ms');
    return { ...made, ms: took };
  };
  const outcomeOf = (made, id) => made.data.bake.bakes.find((b) => b.bakeId === id);
  const typeLayer = (type) => `VIDE::패널링::타입::${type}`;
  const failLayer = 'VIDE::패널링::실패';

  // 4. About 1,000 panels, 10 mm joints → [타입 만들기].
  const r1 = await compute({ width: 0.95, height: 0.6, joint: 0.01, thickness: 0.05 });
  const typing1 = r1.optimize;
  const hash1 = typingHashOf(typing1).slice(0, 6);
  const typed1 = typing1.panels.filter((p) => !p.failure && p.type !== 'T-00');
  const flat1 = typing1.panels.filter((p) => p.flat && p.type !== 'T-00');
  log('stages', r1.ms, 'ms ·', typing1.panels.length, 'panels', typing1.types.length, 'types');
  const census0 = await census(iid);
  const make1 = await bake(MAKE, 'types 1k');
  assert.equal(make1.status, 200, JSON.stringify(make1.data).slice(0, 2000));
  assert.equal(make1.data.status, 'applied');
  const types1 = outcomeOf(make1, 'types');
  if (types1.failures?.length) log('failures', JSON.stringify(types1.failures.slice(0, 6)));
  const census1 = await census(iid);
  const mine1 = Object.entries(census1.defs).filter(([, d]) => d.mine);
  // Every type gets its solid (a cut panel along the trim included).
  assert.deepEqual(
    (types1.failures ?? []).filter((f) => f.reason.startsWith('BLOCK_')),
    [],
    'no block definition failed',
  );
  // Block definitions = types; placements = typed panels; each type on its own layer.
  assert.equal(mine1.length, typing1.types.length, JSON.stringify(mine1.slice(0, 3)));
  assert.ok(mine1.every(([name]) => name.endsWith(`-${hash1}`)));
  assert.equal(census1.placements, typed1.length);
  assert.equal(
    mine1.reduce((n, [, d]) => n + d.uses, 0),
    typed1.length,
    'every placement uses one of this make’s definitions',
  );
  for (const type of typing1.types)
    assert.equal(
      census1.rows[`types|${typeLayer(type.type)}`],
      type.count -
        typing1.overTypeTol.filter(
          (id) => typing1.panels.find((p) => p.panelId === id).type === type.type,
        ).length,
      type.type,
    );
  const failedPanels = typing1.panels.length - typed1.length;
  assert.equal(types1.failed.filter((k) => !k.endsWith(':no')).length, failedPanels);
  if (failedPanels) assert.equal(census1.rows[`types|${failLayer}`], 2 * failedPanels);
  assert.equal(census1.rows['cuts|VIDE::패널링::재단'], flat1.length);
  assert.equal(census1.rows['cut-numbers|VIDE::패널링::재단'], flat1.length);
  const marks = census1.rows['connections|VIDE::패널링::결합부'];
  assert.ok(marks >= typing1.nodeAt.length, `${marks}`);
  assert.equal(make1.data.bake.undos, make1.data.undoIds.length);
  result.types1k = {
    panels: typing1.panels.length,
    types: typing1.types.length,
    placements: census1.placements,
    failed: failedPanels,
    marks,
    cuts: flat1.length,
    bodies: make1.data.bake.undos,
    ms: make1.ms,
    stagesMs: r1.ms,
  };

  // [되돌리기] once removes everything the make made, definitions included.
  t = performance.now();
  const undo1 = await call('POST', `${ibase}/bakes/${types1.recordId}/undo`);
  assert.equal(undo1.status, 200, JSON.stringify(undo1.data));
  const afterUndo = await census(iid);
  assert.deepEqual(afterUndo.rows, census0.rows, 'every object of the make is gone');
  assert.equal(afterUndo.total, census0.total);
  assert.deepEqual(afterUndo.defs, census0.defs, 'the definitions are gone too');
  result.types1k.undoMs = ms(t);

  // 5. Make again; a person moves one placement; the next make keeps it and replaces the rest.
  const make2 = await bake(MAKE, 'types again');
  assert.equal(make2.status, 200, JSON.stringify(make2.data).slice(0, 1500));
  const records = (await call('GET', `${ibase}/bakes`)).data.bakes;
  const record2 = records.find((r) => r.runId === make2.data.runId && r.bakeId === 'types');
  const placedKeys = outcomeOf(make2, 'types').added;
  const editedKey = placedKeys[7];
  const editedId = record2.items[editedKey].nativeId;
  const editedType = typing1.panels.find((p) => editedKey.endsWith(`:${p.panelId}`)).type;
  await action(
    `doc.Objects.Transform(System.Guid('${editedId}'), Rhino.Geometry.Transform.Translation(0,0,0.2), True)\nresult=True`,
  );
  const make3 = await bake(MAKE, 'types, one moved');
  assert.equal(make3.status, 200, JSON.stringify(make3.data).slice(0, 1500));
  const types3 = outcomeOf(make3, 'types');
  assert.deepEqual(
    types3.preserved.map((p) => [p.key, p.reason]),
    [[editedKey, 'edited']],
  );
  assert.equal(types3.replaced.length, typed1.length - 1);
  const census3 = await census(iid);
  assert.equal(census3.placements, typed1.length, 'every placement once');
  result.keptEdited = { key: editedKey, replaced: types3.replaced.length };

  // 6. Another type tolerance: the types are renumbered under a new fingerprint. Same layout, so the
  // same keys: placements replaced (the moved one kept), new definitions; the older definitions go
  // except the one the kept placement uses.
  const r4 = await compute({
    width: 0.95,
    height: 0.6,
    joint: 0.01,
    thickness: 0.05,
    typeTol: 0.005,
  });
  const typing4 = r4.optimize;
  const hash4 = typingHashOf(typing4).slice(0, 6);
  assert.notEqual(hash4, hash1);
  const typed4 = typing4.panels.filter((p) => !p.failure && p.type !== 'T-00');
  const make4 = await bake(MAKE, 'types, tolerance 5 mm');
  assert.equal(make4.status, 200, JSON.stringify(make4.data).slice(0, 1500));
  const types4 = outcomeOf(make4, 'types');
  assert.deepEqual(
    types4.preserved.map((p) => p.key),
    [editedKey],
  );
  const census4 = await census(iid);
  const mine4 = Object.entries(census4.defs).filter(([, d]) => d.mine);
  const old4 = mine4.filter(([name]) => name.endsWith(`-${hash1}`));
  const new4 = mine4.filter(([name]) => name.endsWith(`-${hash4}`));
  assert.equal(new4.length, typing4.types.length);
  assert.deepEqual(
    old4.map(([name, d]) => [name, d.uses]),
    [[`vide-panel-${editedType}-${hash1}`, 1]],
    'only the definition of the kept placement stays',
  );
  assert.equal(census4.placements, typed4.length);
  result.renumbered = {
    typesBefore: typing1.types.length,
    typesAfter: typing4.types.length,
    oldKept: old4.map(([n]) => n),
  };

  // 7. A definition of the same name a person made: left alone; that type's panels fail.
  const r5 = await compute({
    width: 0.95,
    height: 0.6,
    joint: 0.01,
    thickness: 0.05,
    typeTol: 0.003,
  });
  const typing5 = r5.optimize;
  const hash5 = typingHashOf(typing5).slice(0, 6);
  const takenType = typing5.types[0];
  const taken = `vide-panel-${takenType.type}-${hash5}`;
  await action(`b=Rhino.Geometry.Sphere(Rhino.Geometry.Point3d(0,0,0),0.3).ToBrep()
i=doc.InstanceDefinitions.Add(${JSON.stringify(taken)},'',Rhino.Geometry.Point3d.Origin,System.Array[Rhino.Geometry.GeometryBase]([b]))
result=i`);
  const make5 = await bake(MAKE, 'types, a name taken');
  assert.equal(make5.status, 200, JSON.stringify(make5.data).slice(0, 1500));
  const types5 = outcomeOf(make5, 'types');
  const takenFailures = (types5.failures ?? []).filter((f) => f.reason === 'BLOCK_NAME_TAKEN');
  assert.equal(
    takenFailures.length,
    typing5.panels.filter((p) => p.type === takenType.type && !p.failure).length,
  );
  const census5 = await census(iid);
  assert.equal(census5.defs[taken].mine, false);
  assert.equal(census5.defs[taken].vide, false);
  assert.equal(census5.defs[taken].uses, 0, 'nothing placed with the person’s definition');
  assert.equal(census5.defs[taken].objects, 1, 'the person’s definition is unchanged');
  result.nameTaken = { name: taken, failed: takenFailures.length };

  // 8. The schedules and the report of the same results.
  const tables = scheduleRows(r5.preview, r5.members, typing5);
  for (const table of Object.keys(SCHEDULE_COLUMNS)) {
    const csv = scheduleCsv(table, tables[table]);
    assert.ok(csv.startsWith('﻿'), 'BOM for Korean Excel');
    const head = csv.slice(1).split('\r\n')[0];
    assert.equal(head, SCHEDULE_COLUMNS[table].map(([, label]) => label).join(','));
    assert.equal(Buffer.from(csv, 'utf8').toString('utf8'), csv, 'valid UTF-8');
  }
  assert.equal(tables.panels.length, typing5.panels.length);
  const report = await call('GET', `${ibase}/reports/paneling`);
  assert.equal(report.status, 200, JSON.stringify(report.data).slice(0, 800));
  assert.match(report.data.model.headline.text, new RegExp(`타입 ${typing5.types.length}개`));
  assert.ok(report.data.html.includes('패널링'));
  result.report = { headline: report.data.model.headline.text };

  // 9. About 5,000 panels: stages and the make, then [되돌리기].
  const r6 = await compute({
    width: 0.36,
    height: 0.33,
    joint: 0.01,
    thickness: 0.05,
    typeTol: 0.002,
  });
  const typing6 = r6.optimize;
  const typed6 = typing6.panels.filter((p) => !p.failure && p.type !== 'T-00');
  const before6 = await census(iid);
  const make6 = await bake(MAKE, 'types 5k');
  assert.equal(make6.status, 200, JSON.stringify(make6.data).slice(0, 1500));
  const census6 = await census(iid);
  assert.equal(
    Object.entries(census6.defs).filter(
      ([n, d]) => d.mine && n.endsWith(typingHashOf(typing6).slice(0, 6)),
    ).length,
    typing6.types.length,
  );
  assert.ok(census6.placements >= typed6.length, `${census6.placements} ${typed6.length}`);
  result.types5k = {
    panels: typing6.panels.length,
    types: typing6.types.length,
    placements: typed6.length,
    bodies: make6.data.bake.undos,
    ms: make6.ms,
    stagesMs: r6.ms,
  };
  t = performance.now();
  const undo6 = await call('POST', `${ibase}/bakes/${outcomeOf(make6, 'types').recordId}/undo`);
  assert.equal(undo6.status, 200, JSON.stringify(undo6.data));
  const after6 = await census(iid);
  assert.deepEqual(after6.rows, before6.rows, 'one [되돌리기] puts the previous make back');
  assert.deepEqual(after6.defs, before6.defs);
  result.types5k.undoMs = ms(t);
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
  console.log(JSON.stringify({ ...result, directory: undefined }, null, 2));
}
