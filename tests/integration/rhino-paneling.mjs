// PLAN-49 T-258 통합 VERIFY: the official 패널링 jig end to end against a real hidden Rhino 8 —
// SPEC-16.1 완료 기준. A VIDE-owned worker makes a synthetic document under .vide/rhino-paneling/ (a
// hyperbolic paraboloid 30 × 20 m with a trimmed hole, a tight cylinder band R 0.25 m, a mesh box);
// a VIDE-owned hidden Rhino opens it and attaches to the plugin. Never a user document, never the
// user's Rhino; only this script's processes are stopped, and afterwards the installed engine's
// Rhino connector is put back (reported pending while another Rhino runs).
//
//   node tests/integration/rhino-paneling.mjs
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp with direct-read>   (default: this checkout's build)
//   VIDE_WRITE_EVIDENCE=1   screenshots to docs/assets/verify-2026-10-08-paneling/
//
// ① Opened from a request (the rules route "이 면 패널로 나눠 줘" to vide/paneling, no output layer
//    yet): a mesh pick refused, [고른 면 쓰기], 1단계 with assumed values, [미리보기 만들기] asking for
//    the layer first, [부재 만들기] closed by '가정' until the question card is answered, then made.
// ② The saddle at about 5,000 panels: four patterns, 2단계 members and joints, 3단계 typing; every
//    stage's [Rhino에 만들기] and one [되돌리기] removing it ('types' when the jig declares it).
// ③ Failures: mesh face, document without units, thickness over curvature, stock exceeded, more
//    types than allowed, the face moved after the read ('기준 면이 바뀜' and the make refused).
// ④ The SCR-33 screen in a browser over the real routes and results: numbers, schedule, CSV,
//    [미리보기 만들기] into the hidden Rhino.
// ⑤ Times of the read, each stage and each make.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { closeJigRuntime, jigRoutes, jigStatuses } from '../../src/server/jig-routes.ts';
import { panelingRoutes, panelingStatuses } from '../../src/server/paneling-routes.ts';
import { runDocumentSync } from '../../src/server/document-sync.ts';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';
import { routeJigsOf, skillCatalog } from '../../src/server/skill-catalog.ts';
import { decisiveRoute, instanceRouteContext, requestValues } from '../../src/ui/request-route.ts';
import {
  SCHEDULE_COLUMNS,
  memberSetSchema,
  panelLayoutSchema,
  panelTypingSchema,
} from '../../src/contracts/paneling.ts';
import { evidencePath, runDirectory } from './run-directory.mjs';
import {
  reportRestore,
  restoreInstalledPlugin,
  warnIfRhinoRunning,
} from './installed-connector.mjs';

const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
await warnIfRhinoRunning();
const directory = runDirectory('rhino-paneling');
const options = { ...sdkOptions(directory), plugin };
const connectionDirectory = join(directory, 'rhino-connections');
const ms = (t) => Math.round(performance.now() - t);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ASSETS = 'docs/assets/verify-2026-10-08-paneling';

// Synthetic geometry only (metres). The saddle of SPIKE-2026-10-08-paneling: z = (x−15)²/60 −
// (y−10)²/40 + 5 with a 2.5 m hole; a cylinder band R 0.25 m (120°, 2 m high) whose concave side
// cannot take 200 mm (0.2 × 4 ≥ 0.7, SPEC-16.6 2); a mesh box.
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
var saddleId = doc.Objects.AddBrep(face, new Rhino.DocObjects.ObjectAttributes { Name = "saddle" });
var arc = new Arc(new Circle(new Plane(new Point3d(40, 0, 0), Vector3d.ZAxis), 0.25), Math.PI * 2 / 3);
var band = Surface.CreateExtrusion(arc.ToNurbsCurve(), new Vector3d(0, 0, 2)).ToBrep();
var bandId = doc.Objects.AddBrep(band, new Rhino.DocObjects.ObjectAttributes { Name = "band" });
var box = Mesh.CreateFromBox(new BoundingBox(new Point3d(50, 0, 0), new Point3d(51, 1, 1)), 1, 1, 1);
var meshId = doc.Objects.AddMesh(box, new Rhino.DocObjects.ObjectAttributes { Name = "mesh" });
return saddleId + "," + bandId + "," + meshId;`;

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
const digits = (text) => Number(String(text ?? '').replace(/[^\d]/g, ''));

let worker, host, store, workspace, browser;
const result = { plugin: plugin.replace(/^.*[\\/]\.vide[\\/]/, '<checkout>/.vide/'), times: {} };
const times = result.times;
try {
  // 1. The synthetic document, made and saved by a hidden worker.
  let t = performance.now();
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const built = await worker.execute(randomUUID(), 0, BUILD);
  assert.equal(built.ok, true, JSON.stringify(built).slice(0, 1500));
  const [saddleId, bandId, meshId] = String(built.value).split(',');
  await worker.stop();
  worker = undefined;
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'paneling-verify.3dm');
  await copyFile(built.filename, source);
  times.document = ms(t);

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
  times.attach = ms(t);
  log('attached Rhino', ready.rhino, times.attach, 'ms');
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
  /** Objects of an instance by bake and layer, solids, open faces, block instances and definitions. */
  const census = (iid) =>
    action(`s=Rhino.DocObjects.ObjectEnumeratorSettings()
s.HiddenObjects=True
s.LockedObjects=True
rows={}
solids=0
faces=0
blocks=0
assumed=0
total=0
for o in doc.Objects.GetObjectList(s):
    total+=1
    if o.Attributes.GetUserString('vide-instance')!=${JSON.stringify(iid)}:continue
    k=(o.Attributes.GetUserString('vide-bake') or '')+'|'+doc.Layers[o.Attributes.LayerIndex].FullPath
    rows[k]=rows.get(k,0)+1
    if o.Attributes.GetUserString('vide-assumed')=='true': assumed+=1
    g=o.Geometry
    if isinstance(g,Rhino.Geometry.Brep):
        if g.IsSolid and g.SolidOrientation==Rhino.Geometry.BrepSolidOrientation.Outward: solids+=1
        elif not g.IsSolid: faces+=1
    if isinstance(o,Rhino.DocObjects.InstanceObject): blocks+=1
defs=len([d for d in doc.InstanceDefinitions if d is not None and not d.IsDeleted and d.Name.startswith('vide-panel-')])
result=dict(rows=rows,solids=solids,faces=faces,blocks=blocks,defs=defs,assumed=assumed,total=total)`);
  const select = (id) =>
    action(`doc.Objects.UnselectAll()\ndoc.Objects.Select(System.Guid('${id}'))\nresult=True`);
  const move = (id, dz) =>
    action(
      `doc.Objects.Transform(System.Guid('${id}'), Rhino.Geometry.Transform.Translation(0,0,${dz}), True)\nresult=True`,
    );

  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. A project with the link (as the VIDE window holds it).
  const dataDir = join(directory, 'engine');
  await mkdir(dataDir, { recursive: true });
  store = new Store(join(directory, 'workspace.sqlite'));
  workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const project = store.createProject('패널링 통합 검수');
  const link = links.link(project.id, { host: 'rhino', name: 'paneling-verify.3dm', ...target });
  /** One engine route; a thrown domain error comes back as the HTTP answer the screen would see. */
  const call = async (method, path, payload) => {
    let last;
    const url = new URL(path, 'http://127.0.0.1');
    const send = (status, data) => (last = { status, data });
    try {
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
      if (!handled) return { status: 404, data: { code: 'NOT_FOUND', message: path } };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
      return {
        status: jigStatuses[code] ?? panelingStatuses[code] ?? 400,
        data: { code, message: String(error?.message ?? error) },
      };
    }
    return last;
  };
  const base = `/api/v1/projects/${project.id}`;
  /** A full Sync of the document (the Live Sync model '기준 면이 바뀜' compares with). */
  const sync = async () => {
    const s = performance.now();
    const { result: synced } = await runDocumentSync(
      {
        workspace,
        sdk,
        rhinoImport: undefined,
        host: undefined,
        documentSyncs: new SyncCoalescer(),
        diagnostics: { write() {} },
      },
      project.id,
      { id: randomUUID(), ...target, linkId: link.id, fresh: true },
    );
    assert.equal(synced.state, 'succeeded', JSON.stringify(synced).slice(0, 800));
    return ms(s);
  };
  times.firstSync = await sync();

  // ── ① 대화로 열기 → 질문 카드 → 가정 값 미리보기 → 확인 뒤 부재 만들기 ───────────────────────────
  const skills = await skillCatalog(workspace, dataDir, project.id);
  const routeJigs = routeJigsOf(skills);
  const spoken = '이 면 패널로 나눠 줘';
  const route = decisiveRoute(spoken, { jigs: routeJigs });
  assert.equal(route?.target, 'jig', JSON.stringify(route));
  assert.equal(route.jig.id, 'vide/paneling');
  const entry = skills.find((s) => s.id === 'vide/paneling');
  assert.deepEqual(entry.autorun, { until: 'preview', step: 'preview' });
  // A request with values gives them as the person's (from_request).
  const withValues = '패널 가로 1200, 세로 600으로 패널 나눠 줘';
  assert.equal(decisiveRoute(withValues, { jigs: routeJigs })?.jig?.id, 'vide/paneling');
  // The skill.md examples as said (recorded: which open the jig and which settings they give).
  result.chatExamples = [];
  for (const body of [
    '이 면 패널로 나눠 줘',
    '곡면 패널 분할 1200 x 600으로',
    '패널링 엇갈림 패턴으로 미리 보여 줘',
  ])
    result.chatExamples.push({
      body,
      route: decisiveRoute(body, { jigs: routeJigs })?.jig?.id ?? null,
    });
  const conversationId = randomUUID();
  const chat = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/paneling',
    title: '패널링 · 대화',
    conversationId,
    layerRootLater: true,
  });
  assert.equal(chat.status, 200, JSON.stringify(chat.data));
  const cid = chat.data.id;
  const cbase = `${base}/jig-instances/${cid}`;
  {
    const view = (await call('GET', cbase)).data;
    const ctx = instanceRouteContext(view.params);
    const given = requestValues(withValues, ctx.params, ctx.values, entry.fromRequest);
    assert.deepEqual(
      given.map((g) => [g.key, g.change.value]),
      [
        ['width', 1.2],
        ['height', 0.6],
      ],
    );
    const set = await call('PUT', `${cbase}/params`, {
      values: given.map((g) => ({ key: g.key, value: g.change.value })),
      by: 'user',
    });
    assert.equal(set.status, 200, JSON.stringify(set.data));
  }
  // No 기준 면 yet: the preview waits for the person's step.
  const blocked = await call('POST', `${cbase}/run`, { until: 'preview', mode: 'geometry' });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.data));
  assert.equal(blocked.data.outputs.preview, undefined);
  // A mesh is refused with its reason; the face is read.
  await select(meshId);
  const meshRead = await call('POST', `${base}/paneling/surface/read`, { instanceId: cid });
  assert.equal(meshRead.data.ok, false, JSON.stringify(meshRead.data));
  assert.equal(meshRead.data.code, 'MESH_NOT_ACCEPTED');
  assert.match(meshRead.data.message, /메쉬 기준 면은 아직 받지 않습니다/);
  result.failures = { mesh: meshRead.data.code };
  await select(saddleId);
  t = performance.now();
  const picked = await call('POST', `${base}/paneling/surface/read`, { instanceId: cid });
  times.read = ms(t);
  assert.equal(picked.data.ok, true, JSON.stringify(picked.data));
  assert.equal(picked.data.picked.objectId.toLowerCase(), saddleId.toLowerCase());
  // 1단계 with the assumed values (the rest of stage 1 is '가정').
  const chatRun = await call('POST', `${cbase}/run`, { mode: 'confirmed' });
  assert.equal(chatRun.status, 200, JSON.stringify(chatRun.data).slice(0, 800));
  const chatLayout = panelLayoutSchema.parse(chatRun.data.outputs.preview);
  const assumedOf = (view) =>
    view.params.filter((p) => p.by === 'default' || p.source?.by === 'default').map((p) => p.key);
  const chatView = (await call('GET', cbase)).data;
  const assumed1 = assumedOf(chatView);
  assert.ok(assumed1.includes('pattern') && assumed1.includes('measure'), assumed1.join(','));
  assert.ok(!assumed1.includes('width'));
  result.chat = { panels: chatLayout.counts.total, assumedBefore: assumed1.length };
  // [미리보기 만들기] with assumed values: the output layer is asked first (opened from a request).
  const noLayer = await call('POST', `${cbase}/bake`, { bake: ['preview'] });
  assert.equal(noLayer.data.code, 'LAYER_ROOT_MISSING', JSON.stringify(noLayer.data));
  assert.equal(
    (await call('PUT', `${cbase}/layer-root`, { layerRoot: 'VIDE::패널링 대화' })).status,
    200,
  );
  t = performance.now();
  const chatPreview = await call('POST', `${cbase}/bake`, { bake: ['preview'] });
  times.chatPreviewMake = ms(t);
  assert.equal(chatPreview.status, 200, JSON.stringify(chatPreview.data).slice(0, 1500));
  const chatCensus = await census(cid);
  assert.ok(chatCensus.faces > 0);
  assert.equal(chatCensus.assumed, chatCensus.faces, 'every preview face says vide-assumed');
  // [부재 만들기] is closed while values are assumed.
  const closed = await call('POST', `${cbase}/bake`, { bake: ['members', 'joints'] });
  assert.equal(closed.status, 422, JSON.stringify(closed.data).slice(0, 800));
  assert.equal(closed.data.code, 'GATE_BLOCKED');
  assert.ok(closed.data.blocked.includes('paneling-confirmed'));
  assert.ok(closed.data.hints.some((h) => /가정 값/.test(h)));
  // The question card answered (recommended values taken as they are: `by: 'decision'`).
  const asked = chatView.params
    .filter(
      (p) =>
        assumedOf(chatView).includes(p.key) &&
        /^(1|2)단계/.test(p.group ?? '') &&
        !['projection', 'mergeBelow'].includes(p.key),
    )
    .map((p) => ({ key: p.key, value: p.value }));
  const answered = await call('PUT', `${cbase}/params`, { values: asked, by: 'decision' });
  assert.equal(answered.status, 200, JSON.stringify(answered.data).slice(0, 800));
  const chatRun2 = await call('POST', `${cbase}/run`, { mode: 'confirmed' });
  assert.equal(chatRun2.status, 200);
  t = performance.now();
  const chatMembers = await call('POST', `${cbase}/bake`, { bake: ['members', 'joints'] });
  times.chatMembersMake = ms(t);
  assert.equal(chatMembers.status, 200, JSON.stringify(chatMembers.data).slice(0, 1500));
  const chatCensus2 = await census(cid);
  assert.ok(chatCensus2.solids > 0, JSON.stringify(chatCensus2));
  result.chat.asked = asked.map((a) => a.key);
  result.chat.members = chatCensus2.solids;
  // One [되돌리기] per make; the preview stays when the members go (SPEC-16.9 1).
  const undoOf = async (iid, made) => {
    const s = performance.now();
    const undone = await call(
      'POST',
      `${base}/jig-instances/${iid}/bakes/${made.data.bake.bakes[0].recordId}/undo`,
    );
    assert.equal(undone.status, 200, JSON.stringify(undone.data));
    return ms(s);
  };
  await undoOf(cid, chatMembers);
  const afterChatUndo = await census(cid);
  assert.equal(afterChatUndo.solids, 0);
  assert.equal(afterChatUndo.faces, chatCensus.faces, 'the preview faces stay');
  await undoOf(cid, chatPreview);
  assert.equal((await census(cid)).total, chatCensus.total - chatCensus.faces);
  log('chat path', JSON.stringify(result.chat));

  // ── ② 쌍곡 포물면 약 5천 패널: 네 패턴 → 2단계 → 3단계, 단계별 만들기·되돌리기 ─────────────────
  const created = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/paneling',
    title: '패널링 통합 검수',
    layerRoot: 'VIDE::패널링',
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const iid = created.data.id;
  const ibase = `${base}/jig-instances/${iid}`;
  await select(saddleId);
  assert.equal(
    (await call('POST', `${base}/paneling/surface/read`, { instanceId: iid })).data.ok,
    true,
  );
  // Every setting a person's (the recommended values taken, or set here).
  const manifestParams = (await call('GET', ibase)).data.params;
  const setAll = async (values) => {
    const r = await call('PUT', `${ibase}/params`, {
      values: Object.entries(values).map(([key, value]) => ({ key, value })),
      by: 'user',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 800));
  };
  await setAll(Object.fromEntries(manifestParams.map((p) => [p.key, p.value])));
  const run = async (until) => {
    const s = performance.now();
    const r = await call('POST', `${ibase}/run`, {
      mode: 'confirmed',
      ...(until ? { until } : {}),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 1500));
    return { outputs: r.data.outputs, steps: r.data.steps, ms: ms(s) };
  };
  const bake = async (ids, label) => {
    const s = performance.now();
    const made = await call('POST', `${ibase}/bake`, { bake: ids });
    const took = ms(s);
    log(label, made.status, made.data?.bake?.text ?? made.data?.code, took, 'ms');
    return { ...made, ms: took };
  };

  // Four patterns at one module (0.36 × 0.33 m on the grid ≈ 5,400 panels).
  result.patterns = {};
  for (const pattern of ['grid', 'staggered', 'diamond', 'triangle']) {
    await setAll({ pattern, width: 0.36, height: 0.33 });
    const r = await run('preview');
    const layout = panelLayoutSchema.parse(r.outputs.preview);
    const stepMs = r.steps.find((s) => s.id === 'preview')?.ms ?? null;
    result.patterns[pattern] = {
      panels: layout.counts.total,
      boundary: layout.counts.boundary,
      failed: layout.counts.failed,
      offTarget: layout.counts.offTarget,
      stepMs,
      roundTripMs: r.ms,
    };
    assert.ok(layout.counts.total > 3000, `${pattern}: ${layout.counts.total}`);
    log('pattern', pattern, JSON.stringify(result.patterns[pattern]));
  }
  // Back to the grid; stage 2 and 3 with the members' recommended values.
  await setAll({ pattern: 'grid', width: 0.36, height: 0.33 });
  const all = await run();
  const layout = panelLayoutSchema.parse(all.outputs.preview);
  const members = memberSetSchema.parse(all.outputs.members);
  const typing = panelTypingSchema.parse(all.outputs.optimize);
  const stepMs = Object.fromEntries(all.steps.map((s) => [s.id, s.ms]));
  times.stages = { ...stepMs, roundTripMs: all.ms };
  const listed = layout.panels.filter((p) => p.failure?.code !== 'dropped');
  assert.ok(listed.length >= 4500, `${listed.length}`);
  assert.equal(members.members.length, listed.length);
  const failedMembers = members.members.filter((m) => m.failure);
  result.saddle = {
    panels: layout.counts.total,
    boundary: layout.counts.boundary,
    failed: layout.counts.failed,
    members: members.members.length,
    memberFailures: Object.fromEntries(
      [...new Set(failedMembers.map((m) => m.failure.code))].map((c) => [
        c,
        failedMembers.filter((m) => m.failure.code === c).length,
      ]),
    ),
    joints: members.joints.length,
    jointUneven: members.members.filter((m) => m.jointUneven).length,
    types: typing.types.length,
    nodeTypes: typing.nodes.length,
    jointTypes: typing.joints.length,
    overTypeTol: typing.overTypeTol.length,
    maxFlatnessMm: Math.max(...typing.panels.map((p) => p.flatness)) * 1000,
    cutOutlines: typing.panels.filter((p) => p.flat).length,
    classes: Object.fromEntries(
      ['flat', 'single', 'double'].map((c) => [
        c,
        typing.panels.filter((p) => p.class === c).length,
      ]),
    ),
  };
  log('saddle', JSON.stringify(result.saddle));

  // [미리보기 만들기] ≈ 5천 panels, one [되돌리기].
  const census0 = await census(iid);
  const preview = await bake(['preview'], 'preview 5k');
  assert.equal(preview.status, 200, JSON.stringify(preview.data).slice(0, 1500));
  const previewOut = preview.data.bake.bakes[0];
  const census1 = await census(iid);
  assert.equal(census1.faces, previewOut.added.length);
  assert.ok(previewOut.added.length >= listed.length - 3, `${previewOut.added.length}`);
  assert.equal(census1.assumed, 0, 'no assumed values');
  assert.match(preview.data.bake.text, /Rhino Ctrl\+Z \d+번/);
  result.makes = {
    preview: {
      added: previewOut.added.length,
      failed: previewOut.failures ?? [],
      bodies: preview.data.bake.undos,
      ms: preview.ms,
      deviationMm: previewOut.deviationMax * 1000,
    },
  };
  // [부재 만들기]: closed solids and joint lines; the preview faces stay.
  const membersMade = await bake(['members', 'joints'], 'members 5k');
  assert.equal(membersMade.status, 200, JSON.stringify(membersMade.data).slice(0, 1500));
  const census2 = await census(iid);
  const [solidOut, jointOut] = membersMade.data.bake.bakes;
  assert.equal(census2.faces, census1.faces, 'members leave the preview as it is');
  assert.ok(census2.solids >= members.members.length - failedMembers.length - 5, census2.solids);
  result.makes.members = {
    solids: census2.solids,
    added: solidOut.added.length,
    joints: jointOut?.added.length ?? 0,
    failed: solidOut.failures ?? [],
    bodies: membersMade.data.bake.undos,
    ms: membersMade.ms,
  };
  result.makes.members.undoMs = await undoOf(iid, membersMade);
  const census3 = await census(iid);
  assert.equal(census3.solids, 0);
  assert.deepEqual(census3.rows, census1.rows, 'one [되돌리기] removes the members and joints');
  // [타입 만들기] when the jig declares it (T-257): the makes of `vide/paneling` beyond stage 1·2.
  const declared = JSON.parse(
    await readFile(
      new URL('../../src/jigs/official/jigs/paneling/jig.json', import.meta.url),
      'utf8',
    ),
  ).bake.map((b) => b.id);
  result.declaredMakes = declared;
  const typeIds = declared.filter((id) => !['preview', 'members', 'joints'].includes(id));
  if (typeIds.length) {
    const types = await bake(typeIds, 'types');
    assert.equal(types.status, 200, JSON.stringify(types.data).slice(0, 1500));
    const census4 = await census(iid);
    result.makes.types = {
      bakes: typeIds,
      blocks: census4.blocks,
      defs: census4.defs,
      bodies: types.data.bake.undos,
      ms: types.ms,
    };
    assert.equal(census4.defs, typing.types.length);
    result.makes.types.undoMs = await undoOf(iid, types);
    const census5 = await census(iid);
    assert.equal(census5.blocks, 0);
    assert.equal(census5.defs, 0, 'the definitions go with the [되돌리기]');
  } else result.makes.types = { pending: 'T-257: the jig declares no types make yet' };
  result.makes.preview.undoMs = await undoOf(iid, preview);
  assert.deepEqual((await census(iid)).rows, census0.rows, 'every make is gone');

  // ── ③ 실패 주입 ───────────────────────────────────────────────────────────────────────────────
  // More types than allowed: at most 3, the rest marked over the tolerance.
  await setAll({ maxTypes: 3 });
  const capped = panelTypingSchema.parse((await run()).outputs.optimize);
  assert.ok(
    capped.types.length <= 3 || capped.maxTypesUnmet !== null,
    `${capped.types.length} types`,
  );
  assert.ok(capped.overTypeTol.length > 0, 'the panels beyond the tolerance are marked');
  result.failures.maxTypes = {
    types: capped.types.length,
    overTypeTol: capped.overTypeTol.length,
    maxTypesUnmet: capped.maxTypesUnmet,
  };
  await setAll({ maxTypes: 0 });
  // Stock exceeded: listed, not split and not a failure.
  await setAll({ stockWidth: 0.3, stockHeight: 0.3 });
  const stocked = memberSetSchema.parse((await run('members')).outputs.members);
  assert.ok(stocked.overStock.length > 0);
  assert.equal(
    stocked.members.filter((m) => m.failure?.code === 'over-stock').length,
    0,
    '판재 초과 is not a failure',
  );
  result.failures.stock = { overStock: stocked.overStock.length, of: stocked.members.length };
  // Rotated by 90° it fits: 0.33 × 0.36 stock is not exceeded by 0.35 × 0.32 plates.
  await setAll({ stockWidth: 0.33, stockHeight: 0.36 });
  const rotated = memberSetSchema.parse((await run('members')).outputs.members);
  result.failures.stock.rotatedOver = rotated.overStock.length;
  assert.ok(rotated.overStock.length < stocked.overStock.length);
  await setAll({ stockWidth: 0, stockHeight: 0 });
  // Thickness over the curvature: the band's concave side refuses 200 mm, the other side takes it.
  const bandCreated = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/paneling',
    title: '패널링 · 두께 곡률',
    layerRoot: 'VIDE::패널링 곡률',
  });
  const bid = bandCreated.data.id;
  const bandRead = await call('POST', `${base}/paneling/surface/read`, {
    instanceId: bid,
    objectId: bandId,
  });
  assert.equal(bandRead.data.ok, true, JSON.stringify(bandRead.data));
  const curvature = {};
  for (const side of ['outside', 'inside']) {
    await call('PUT', `${base}/jig-instances/${bid}/params`, {
      values: [
        { key: 'width', value: 0.2 },
        { key: 'height', value: 0.4 },
        { key: 'thickness', value: 0.2 },
        { key: 'thicknessSide', value: side },
      ],
      by: 'user',
    });
    const r = await call('POST', `${base}/jig-instances/${bid}/run`, {
      mode: 'confirmed',
      until: 'members',
    });
    assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 800));
    const set = memberSetSchema.parse(r.data.outputs.members);
    const bad = set.members.filter((m) => m.failure?.code === 'thickness-curvature');
    curvature[side] = { members: set.members.length, failed: bad.length, message: bad[0]?.failure };
  }
  assert.ok(
    (curvature.outside.failed === 0) !== (curvature.inside.failed === 0),
    JSON.stringify(curvature),
  );
  const badSide = curvature.outside.failed ? curvature.outside : curvature.inside;
  assert.equal(badSide.failed, badSide.members, 'every panel of the concave side');
  assert.match(badSide.message.message, /두께 불가 · 곡률 반지름 \d+/);
  result.failures.curvature = curvature;
  // A document without units: the read refuses and the earlier sample stays.
  await action('doc.AdjustModelUnitSystem(Rhino.UnitSystem.None, False)\nresult=True');
  const noUnits = await call('POST', `${base}/paneling/surface/read`, {
    instanceId: iid,
    mode: 'reread',
  });
  await action('doc.AdjustModelUnitSystem(Rhino.UnitSystem.Meters, False)\nresult=True');
  assert.equal(noUnits.data.ok, false, JSON.stringify(noUnits.data));
  assert.equal(noUnits.data.code, 'UNKNOWN_UNITS');
  const kept = await call('GET', `${base}/paneling/surface?instanceId=${iid}`);
  assert.equal(kept.data.picked.objectId.toLowerCase(), saddleId.toLowerCase());
  result.failures.units = noUnits.data.code;
  // The face moved after the read: '기준 면이 바뀜', the make refused with nothing made.
  const unchanged = await call('GET', `${base}/paneling/surface?instanceId=${iid}`);
  result.failures.watching = unchanged.data.watching;
  await move(saddleId, 0.001);
  times.secondSync = await sync();
  const changed = await call('GET', `${base}/paneling/surface?instanceId=${iid}`);
  result.failures.changed = changed.data.changed;
  if (unchanged.data.watching) {
    assert.equal(unchanged.data.changed, null);
    assert.equal(changed.data.changed?.reason, 'geometry', JSON.stringify(changed.data.changed));
    assert.equal(changed.data.changed.message, '기준 면이 바뀜 · 다시 읽기');
  }
  const beforeRefused = await census(iid);
  const refused = await bake(['preview'], 'preview after a face change');
  assert.equal(refused.status, 409, JSON.stringify(refused.data).slice(0, 800));
  assert.equal(refused.data.code, 'BAKE_SURFACE_CHANGED');
  assert.deepEqual((await census(iid)).rows, beforeRefused.rows, 'nothing made');
  result.failures.surfaceChanged = refused.data.code;
  // [다시 읽기] takes the moved face; the mark clears.
  const reread = await call('POST', `${base}/paneling/surface/read`, {
    instanceId: iid,
    mode: 'reread',
  });
  assert.equal(reread.data.ok, true, JSON.stringify(reread.data));
  const cleared = await call('GET', `${base}/paneling/surface?instanceId=${iid}`);
  assert.equal(cleared.data.changed, null);
  await run();

  // ── ④ 브라우저: SCR-33 over the real routes and results ────────────────────────────────────
  const { chromium } = await import('playwright');
  const { build } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const bundle = await build({
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: false,
      cssCodeSplit: false,
      lib: {
        entry: fileURLToPath(new URL('./browser-paneling-fixture.mjs', import.meta.url)),
        formats: ['es'],
        fileName: 'fixture',
      },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
  const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
  const code = output.find((item) => item.type === 'chunk' && item.isEntry)?.code;
  const css = output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => String(item.source))
    .join('\n');
  const ORIGIN = 'http://vide.test';
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
    acceptDownloads: true,
  });
  page.setDefaultTimeout(60000);
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(`${ORIGIN}/api/v1/**`, async (routed) => {
    const request = routed.request();
    const url = new URL(request.url());
    const body = request.postData() ? JSON.parse(request.postData()) : undefined;
    const answer = await call(request.method(), url.pathname + url.search, body);
    requests.push({ method: request.method(), path: url.pathname, status: answer.status });
    await routed.fulfill({ status: answer.status, json: answer.data ?? null });
  });
  await page.route(`${ORIGIN}/fixture.mjs`, (r) =>
    r.fulfill({ contentType: 'text/javascript', body: code }),
  );
  await page.route(`${ORIGIN}/`, (r) =>
    r.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>${css}</style></head><body></body></html>`,
    }),
  );
  t = performance.now();
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(
    async (o) => {
      const { mount } = await import('/fixture.mjs');
      window.paneling = mount(o);
    },
    { projectId: project.id, instanceId: iid },
  );
  const panel = page.locator('[data-jig-panel="vide/paneling"]');
  await panel.waitFor();
  const kpi = (label) => panel.locator(`.pnl-kpis .kit-kpi[data-kpi="${label}"] .kit-kpi-value`);
  await panel.locator('.pnl-surface').getByText('paneling-verify.3dm').waitFor();
  /** A number in the head reaches the computed one (on timeout: what the head showed). */
  const waitKpi = async (label, n) => {
    const end = Date.now() + 60000;
    let text;
    while (Date.now() < end) {
      text = await kpi(label)
        .textContent()
        .catch(() => null);
      if (digits(text) === n) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    const head = await panel
      .locator('.pnl-kpis')
      .textContent()
      .catch(() => '');
    await page.screenshot({ path: join(directory, 'kpi-timeout.png'), fullPage: false });
    throw Error(
      `${label}: ${text} (head ${head}) ≠ ${n}; ${JSON.stringify(requests.filter((r) => !r.path.endsWith('/surface')).slice(0, 12))}`,
    );
  };
  await waitKpi('패널', layout.counts.total);
  times.screenFirstPanels = ms(t);
  const shownPanels = digits(await kpi('패널').textContent());
  const overlayCount = await page.evaluate(
    () => window.paneling.view.overlayInfo().find((l) => l.key === 'paneling-panels')?.items.length,
  );
  assert.equal(overlayCount, layout.counts.total - layout.counts.dropped);
  // Schedule row → 3D focus.
  const drawer = panel.locator('.pnl-drawer');
  const table = drawer.getByRole('table', { name: '패널 일람표' });
  const firstRow = table.locator('tr[data-panel]').first();
  const firstId = await firstRow.getAttribute('data-panel');
  await firstRow.click();
  const focus = await page.evaluate(() => window.paneling.record.focus.at(-1));
  assert.deepEqual(focus, { overlay: 'paneling-panels', itemId: firstId });
  // Stage 3: types and joints as computed.
  await panel.locator('.pnl-rail button[data-stage="optimize"]').click();
  await waitKpi('타입', typing.types.length);
  await drawer.getByRole('tab', { name: /^결합부/ }).click();
  await drawer.getByRole('table', { name: '노드 타입' }).getByText('N-01').waitFor();
  // CSV of the real schedule: the contract head, one row per panel.
  await drawer.locator('.pnl-csv > summary').click();
  const csv = {};
  for (const kind of ['panels', 'types', 'nodes', 'joints']) {
    const [file] = await Promise.all([
      page.waitForEvent('download'),
      drawer.locator(`[data-csv="${kind}"]`).click(),
    ]);
    const text = await readFile(await file.path(), 'utf8');
    assert.ok(text.startsWith('﻿'), 'BOM');
    const lines = text.trimEnd().split('\r\n');
    const head = lines[0].replace(/^﻿/, '').split(',');
    assert.equal(head.length, SCHEDULE_COLUMNS[kind].length, kind);
    csv[kind] = lines.length - 1;
  }
  assert.equal(csv.types, typing.types.length);
  assert.ok(csv.panels >= listed.length, `${csv.panels} rows`);
  if (true) {
    const shot = evidencePath(`${ASSETS}/scr-33-optimize.png`);
    await page.screenshot({ path: shot, fullPage: false });
  }
  // [미리보기 만들기] on the screen goes into the hidden Rhino.
  await panel.locator('.pnl-rail button[data-stage="preview"]').click();
  const before = await census(iid);
  t = performance.now();
  await panel.locator('.pnl-make').getByRole('button', { name: '미리보기 만들기' }).click();
  await wait(async () => requests.some((r) => r.method === 'POST' && /\/bake$/.test(r.path)));
  await wait(async () => (await census(iid)).faces > before.faces, 120000);
  times.screenPreviewMake = ms(t);
  const screenMade = await census(iid);
  const bakeAnswer = requests.find((r) => r.method === 'POST' && /\/bake$/.test(r.path));
  assert.equal(bakeAnswer.status, 200);
  await page.screenshot({
    path: evidencePath(`${ASSETS}/scr-33-preview-made.png`),
    fullPage: false,
  });
  const records = (await call('GET', `${ibase}/bakes`)).data.bakes;
  const lastRecord = records.filter((r) => r.appliedAt).at(-1);
  assert.equal(
    (await call('POST', `${ibase}/bakes/${lastRecord.id}/undo`)).status,
    200,
    'the screen make is undone',
  );
  assert.equal((await census(iid)).faces, before.faces);
  result.browser = {
    panels: shownPanels,
    overlay: overlayCount,
    csv,
    screenMade: screenMade.faces - before.faces,
    errors,
  };
  assert.deepEqual(errors, []);
  await browser.close();
  browser = undefined;

  result.passed = true;
  log('passed');
} finally {
  await browser?.close().catch(() => {});
  await worker?.stop().catch(() => {});
  await host?.stop().catch(() => {});
  if (workspace) await closeJigRuntime(workspace).catch(() => {});
  store?.close();
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2)).catch(() => {});
  console.log(JSON.stringify(result, null, 2));
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1')
    reportRestore(await restoreInstalledPlugin());
}
