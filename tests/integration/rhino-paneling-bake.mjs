// PLAN-49 T-255: 패널링 만들기 틀 against a real hidden Rhino 8 — a synthetic saddle (30 × 20 m, a
// trimmed hole) made by a VIDE-owned worker under .vide/rhino-paneling-bake/, opened in a VIDE-owned
// hidden Rhino that attaches to the plugin. Never a user document, never the user's Rhino; only this
// script's processes are stopped. Afterwards the installed engine's connector status is read (and
// the plugin re-installed only when it is not current and no Rhino runs).
//
//   node tests/integration/rhino-paneling-bake.mjs
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp>
//
// Through the jig route with the official `vide/paneling`: [고른 면 쓰기] → 1단계 → [미리보기 만들기]
// of about 1,000 and 5,000 panels as open faces cut from the original face, [되돌리기] once removing a
// whole make, a person's edit kept by the next make of the same layout and counted '이전 배치에서
// 보존' after a size change, and a face changed after the read refused with nothing made. Through
// the templates directly (stage 2 is T-254's): closed members (CreateOffsetBrep) for the 1,000
// panels, and a panel pushed into the hole left on the failure layer with its outline and number.
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
import { layoutHashOf, panelRows } from '../../src/jigs/bake/panels.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import { memberSetSchema } from '../../src/contracts/paneling.ts';
import { runDirectory } from './run-directory.mjs';

const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
const directory = runDirectory('rhino-paneling-bake');
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

/** A stage-2 result in the contract's shape (T-254 builds the real one): outlines 1 % inward. */
function membersOf(layout, thickness) {
  return memberSetSchema.parse({
    schema: 'vide.paneling.members@1',
    layoutHash: layoutHashOf(layout),
    settingsHash: 'ab'.repeat(32),
    members: layout.panels
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
      }),
    joints: [],
    overStock: [],
  });
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
  const source = join(attachedDirectory, 'paneling-bake.3dm');
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
  /** Objects of the instance by bake and layer, closed solids, the document's undo serial. */
  const census = (iid) =>
    action(`s=Rhino.DocObjects.ObjectEnumeratorSettings()
s.HiddenObjects=True
s.LockedObjects=True
rows={}
solids=0
faces=0
total=0
for o in doc.Objects.GetObjectList(s):
    total+=1
    if o.Attributes.GetUserString('vide-instance')!=${JSON.stringify(iid)}:continue
    k=(o.Attributes.GetUserString('vide-bake') or '')+'|'+doc.Layers[o.Attributes.LayerIndex].FullPath
    rows[k]=rows.get(k,0)+1
    g=o.Geometry
    if isinstance(g,Rhino.Geometry.Brep):
        if g.IsSolid: solids+=1
        else: faces+=1
result=dict(rows=rows,solids=solids,faces=faces,total=total,undo=int(doc.NextUndoRecordSerialNumber))`);
  const select = (id) =>
    action(`doc.Objects.UnselectAll()\ndoc.Objects.Select(System.Guid('${id}'))\nresult=True`);

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
  const project = store.createProject('패널링 만들기 시험');
  const link = links.link(project.id, { host: 'rhino', name: 'paneling-bake.3dm', ...target });
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
    title: '패널링 만들기 시험',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created));
  const iid = created.data.id;
  const ibase = `${base}/jig-instances/${iid}`;
  await select(saddleId);
  const picked = await call('POST', `${base}/paneling/surface/read`, { instanceId: iid });
  assert.equal(picked.data.ok, true, JSON.stringify(picked.data));
  const compute = async (width, height) => {
    const set = await call('PUT', `${ibase}/params`, {
      values: [
        { key: 'width', value: width },
        { key: 'height', value: height },
      ],
    });
    assert.equal(set.status, 200, JSON.stringify(set.data));
    const run = await call('POST', `${ibase}/run`, { mode: 'confirmed' });
    assert.equal(run.status, 200, JSON.stringify(run.data));
    return run.data.outputs.preview;
  };
  const bake = async (ids, label) => {
    const s = performance.now();
    const made = await call('POST', `${ibase}/bake`, { bake: ids });
    const took = ms(s);
    log(label, made.status, made.data?.text ?? made.data?.code, took, 'ms');
    return { ...made, ms: took };
  };
  const madeLayer = 'VIDE::패널링::미리보기';
  const failLayer = 'VIDE::패널링::실패';

  // 4. About 1,000 panels → [미리보기 만들기]: open faces cut from the original face.
  const layout1 = await compute(0.95, 0.6);
  const listed1 = layout1.panels.filter((p) => p.failure?.code !== 'dropped');
  result.layout1 = { panels: listed1.length, failed: layout1.counts.failed };
  const census0 = await census(iid);
  const make1 = await bake(['preview'], 'preview 1k');
  assert.equal(make1.status, 200, JSON.stringify(make1.data).slice(0, 2000));
  assert.equal(make1.data.status, 'applied');
  const summary1 = make1.data.bake;
  const outcome1 = summary1.bakes[0];
  const madeFaces1 = outcome1.added.length;
  if (outcome1.failures?.length) log('failures', JSON.stringify(outcome1.failures.slice(0, 8)));
  log('deviation mm', outcome1.deviationMax * 1000);
  assert.equal(
    madeFaces1 + outcome1.failed.filter((k) => !k.endsWith(':no')).length,
    listed1.length,
  );
  assert.ok(madeFaces1 >= listed1.length - 2, `${madeFaces1} of ${listed1.length}`);
  assert.equal(summary1.undos, make1.data.undoIds.length);
  assert.equal(summary1.undos, make1.data.chunks);
  assert.ok(outcome1.deviationMax !== undefined && outcome1.deviationMax < 0.003);
  const census1 = await census(iid);
  assert.equal(census1.rows[`preview|${madeLayer}`], madeFaces1);
  assert.equal(census1.faces, madeFaces1, 'open faces, no solids');
  result.preview1k = {
    panels: listed1.length,
    made: madeFaces1,
    failed: outcome1.failures ?? [],
    bodies: summary1.undos,
    ms: make1.ms,
    deviationMm: outcome1.deviationMax * 1000,
  };

  // [되돌리기] once removes the whole make.
  t = performance.now();
  const undo1 = await call('POST', `${ibase}/bakes/${outcome1.recordId}/undo`);
  assert.equal(undo1.status, 200, JSON.stringify(undo1.data));
  const afterUndo = await census(iid);
  assert.deepEqual(afterUndo.rows, census0.rows, 'every object of the make is gone');
  assert.equal(afterUndo.total, census0.total);
  result.preview1k.undoMs = ms(t);

  // 5. Make again, a person moves one panel, the next make of the same layout keeps it.
  const make2 = await bake(['preview'], 'preview 1k again');
  assert.equal(make2.status, 200);
  const records = (await call('GET', `${ibase}/bakes`)).data.bakes;
  const record2 = records.find((r) => r.runId === make2.data.runId);
  const editedKey = make2.data.bake.bakes[0].added[5];
  const editedId = record2.items[editedKey].nativeId;
  await action(
    `doc.Objects.Transform(System.Guid('${editedId}'), Rhino.Geometry.Transform.Translation(0,0,0.1), True)\nresult=True`,
  );
  const make3 = await bake(['preview'], 'preview 1k, one edited');
  assert.equal(make3.status, 200, JSON.stringify(make3.data).slice(0, 1500));
  const outcome3 = make3.data.bake.bakes[0];
  assert.deepEqual(
    outcome3.preserved.map((p) => [p.key, p.reason]),
    [[editedKey, 'edited']],
  );
  assert.equal(outcome3.replaced.length, madeFaces1 - 1);
  const census3 = await census(iid);
  assert.equal(census3.rows[`preview|${madeLayer}`], madeFaces1, 'every key once');
  result.keptEdited = { key: editedKey, replaced: outcome3.replaced.length };

  // 6. Another size (about 5,000 panels): unedited old panels go, the edited one stays and is
  // counted '이전 배치에서 보존'.
  const layout5 = await compute(0.36, 0.33);
  const listed5 = layout5.panels.filter((p) => p.failure?.code !== 'dropped');
  const make5 = await bake(['preview'], 'preview 5k');
  assert.equal(make5.status, 200, JSON.stringify(make5.data).slice(0, 1500));
  const outcome5 = make5.data.bake.bakes[0];
  assert.equal(outcome5.preservedEarlier, 1);
  assert.equal(outcome5.dropped.length, madeFaces1 - 1);
  assert.match(make5.data.bake.text, /이전 배치에서 보존 1/);
  assert.match(make5.data.bake.text, /Rhino Ctrl\+Z \d+번/);
  const census5 = await census(iid);
  assert.equal(census5.rows[`preview|${madeLayer}`], outcome5.added.length + 1);
  assert.ok(outcome5.added.length >= listed5.length - 3, `${outcome5.added.length}`);
  assert.ok(listed5.length >= 4500, `${listed5.length}`);
  result.preview5k = {
    panels: listed5.length,
    made: outcome5.added.length,
    failed: outcome5.failures ?? [],
    bodies: make5.data.bake.undos,
    ms: make5.ms,
    deviationMm: outcome5.deviationMax * 1000,
  };
  t = performance.now();
  const undo5 = await call('POST', `${ibase}/bakes/${outcome5.recordId}/undo`);
  assert.equal(undo5.status, 200, JSON.stringify(undo5.data));
  const afterUndo5 = await census(iid);
  assert.deepEqual(afterUndo5.rows, census3.rows, 'one [되돌리기] puts the 1k make back');
  result.preview5k.undoMs = ms(t);

  // 7. Members (stage 2 is T-254's; its shape here) through the template: closed solids, 50 mm.
  const kept = jigRuntimeFor(workspace, dataDir).hostSurface(project.id, iid, 'surface');
  const sample = kept.sample;
  const manifestParams = (
    await jigRuntimeFor(workspace, dataDir).registry.resolve('vide/paneling', '0.1.0')
  ).manifest.params;
  const params = Object.fromEntries(
    manifestParams.map((p) => [p.key, { value: p.default, by: 'user', at: '' }]),
  );
  params.thickness = { value: 0.05, by: 'user', at: '' };
  const runTemplate = async (decl, rows, label) => {
    const chunks = renderChunks(
      {
        template: decl.template,
        jigId: 'vide/paneling',
        instanceId: 'template-test',
        bakeId: decl.id,
        runId: randomUUID(),
        layerPath: `VIDE::패널링::${decl.layer}`,
        deleteIds: [],
        surface: rows.surface,
      },
      rows.items,
    );
    const s = performance.now();
    const undoIds = [];
    const receipts = [];
    for (const chunk of chunks) {
      const run = await sdk.runDirect(
        target,
        chunk.code,
        { confirmed: false, maxDeletes: 0 },
        { requestId: randomUUID(), label: `VIDE jig: 패널링 시험 ${label}` },
      );
      assert.equal(run.ok, true, JSON.stringify(run).slice(0, 1500));
      if (run.undoId) undoIds.push(run.undoId);
      receipts.push(run.value);
    }
    return { chunks: chunks.length, ms: ms(s), undoIds, receipts };
  };
  const undoAll = async (undoIds) => {
    for (const id of [...undoIds].reverse()) {
      const undone = await sdk.undoDirect(target, id);
      assert.equal(undone.ok, true, JSON.stringify(undone));
    }
  };
  const membersDecl = { id: 'members', template: 'vide.bake.panel-solids@1', layer: '부재' };
  const memberRows = panelRows({
    decl: membersDecl,
    stepId: 'members',
    output: membersOf(layout1, 0.05),
    layout: layout1,
    sample,
    manifestParams,
    params,
    layerRoot: 'VIDE::패널링',
  });
  assert.deepEqual(memberRows.problems, []);
  const beforeMembers = (await census(iid)).total;
  const members = await runTemplate(membersDecl, memberRows, 'members');
  const madeMembers = members.receipts.flatMap((r) => r.keys);
  const failedMembers = members.receipts.flatMap((r) => r.failed);
  const solidCount = await action(`s=Rhino.DocObjects.ObjectEnumeratorSettings()
n=0
for o in doc.Objects.GetObjectList(s):
    if o.Attributes.GetUserString('vide-instance')=='template-test' and isinstance(o.Geometry,Rhino.Geometry.Brep) and o.Geometry.IsSolid and o.Geometry.SolidOrientation==Rhino.Geometry.BrepSolidOrientation.Outward: n+=1
result=n`);
  assert.equal(solidCount, madeMembers.length - 2 * failedMembers.length);
  assert.ok(failedMembers.length <= 2, JSON.stringify(failedMembers));
  result.members1k = {
    members: memberRows.items.length,
    solids: solidCount,
    failed: failedMembers,
    bodies: members.chunks,
    ms: members.ms,
  };
  await undoAll(members.undoIds);
  assert.equal((await census(iid)).total, beforeMembers, 'the members are gone');

  // 8. A panel pushed into the hole: not made, left on the failure layer as outline and number.
  const previewDecl = { id: 'preview', template: 'vide.bake.panels-uv@1', layer: '미리보기' };
  const broken = structuredClone(layout1);
  const target0 = broken.panels.find((p) => !p.boundary && p.uv.length === 4);
  const cu = target0.uv.reduce((s, q) => s + q[0], 0) / 4;
  const cv = target0.uv.reduce((s, q) => s + q[1], 0) / 4;
  // The middle of the hole in the face's own parameters: the mean of the samples trimmed away.
  const f0 = sample.faces[0];
  let holeU = 0,
    holeV = 0,
    holeN = 0;
  for (let j = 0; j < f0.nv; j++)
    for (let i = 0; i < f0.nu; i++)
      if (!f0.inside[j * f0.nu + i]) {
        holeU += f0.domainU[0] + ((f0.domainU[1] - f0.domainU[0]) * i) / (f0.nu - 1);
        holeV += f0.domainV[0] + ((f0.domainV[1] - f0.domainV[0]) * j) / (f0.nv - 1);
        holeN++;
      }
  assert.ok(holeN > 50, 'the hole is sampled');
  holeU /= holeN;
  holeV /= holeN;
  target0.uv = target0.uv.map(([u, v]) => [u - cu + holeU, v - cv + holeV]);
  broken.panels = [target0, ...broken.panels.filter((p) => p !== target0).slice(0, 20)];
  const brokenRows = panelRows({
    decl: previewDecl,
    stepId: 'preview',
    output: broken,
    layout: broken,
    sample,
    manifestParams,
    params,
    layerRoot: 'VIDE::패널링',
  });
  const brokenRun = await runTemplate(previewDecl, brokenRows, 'broken');
  const receipt = brokenRun.receipts[0];
  assert.deepEqual(receipt.failed, [brokenRows.items[0].key]);
  assert.deepEqual(receipt.reasons, ['UV_OUTSIDE_TRIM']);
  assert.ok(receipt.keys.includes(brokenRows.items[0].key));
  assert.ok(receipt.keys.includes(brokenRows.items[0].key + ':no'));
  const onFail = await action(`s=Rhino.DocObjects.ObjectEnumeratorSettings()
n=[]
for o in doc.Objects.GetObjectList(s):
    status=o.Attributes.GetUserString('vide-status') or ''
    if o.Attributes.GetUserString('vide-instance')=='template-test' and status.startswith('failed'):
        n.append([o.ObjectType.ToString(), status, doc.Layers[o.Attributes.LayerIndex].FullPath])
result=sorted(n)`);
  // (Korean layer names are compared here: the action file is not read as UTF-8 by Python.)
  assert.deepEqual(onFail, [
    ['Curve', 'failed:UV_OUTSIDE_TRIM', failLayer],
    ['TextDot', 'failed:UV_OUTSIDE_TRIM', failLayer],
  ]);
  result.failureLayer = onFail;
  await undoAll(brokenRun.undoIds);

  // 9. The face changes after the read: the make refuses, nothing is made, no undo record.
  await action(
    `doc.Objects.Transform(System.Guid('${saddleId}'), Rhino.Geometry.Transform.Translation(0,0,0.001), True)\nresult=True`,
  );
  const beforeRefused = await census(iid);
  const refused = await bake(['preview'], 'preview after a face change');
  assert.equal(refused.status, 409, JSON.stringify(refused.data).slice(0, 800));
  assert.equal(refused.data.code, 'BAKE_SURFACE_CHANGED');
  const afterRefused = await census(iid);
  assert.deepEqual(afterRefused.rows, beforeRefused.rows);
  // The body ran in an empty host record (DirectExecution keeps it as its own); nothing to undo.
  assert.equal(afterRefused.total, beforeRefused.total, 'no object added or removed');
  assert.equal(refused.data.undoIds, undefined);
  // Members wait for stage 2 (T-254).
  await assert.rejects(
    call('POST', `${ibase}/bake`, { bake: ['members', 'joints'] }),
    (error) => error.code === 'BAKE_NOT_COMPUTED',
  );
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
