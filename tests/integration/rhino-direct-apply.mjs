// PLAN-24 T-070/T-072/T-073 on a real Rhino (VIDE-owned, hidden): the engine (startServer, the same
// server `node src/server/main.ts --dev` starts) with a scripted provider over its agent tools, and
// a synthetic document open in an agent-launched Rhino linked to a project. Auto-mode turns run
// `execute` as the host's direct-execute: added boxes with an undo id, [되돌리기] of the latest only,
// the guards (bulk delete, layer delete, purge), a failing body left undone, capture_view and
// measure, and a Rhino-side Undo that makes VIDE's [되돌리기] a no-op.
// No user document is opened. Data: VIDE_TEST_DATA_DIR (default .vide/rhino-direct-apply/<id>),
// port VIDE_TEST_PORT (default any). The Rhino it launched is closed afterwards; the installed
// VIDE and its plugin registration are not touched.
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { runDirectory } from './run-directory.mjs';

const dataDir = resolve(process.env.VIDE_TEST_DATA_DIR || runDirectory('rhino-direct-apply'));
const docDir = resolve(process.env.VIDE_TEST_DOC_DIR || join(dataDir, 'document'));
await mkdir(dataDir, { recursive: true });
await mkdir(docDir, { recursive: true });
const options = sdkOptions(dataDir);
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
// The engine discovers attached connections next to its sdk-models folder.
const connectionDirectory = join(dataDir, 'rhino-connections');

// The synthetic document (metres): 60 boxes, 10 curves, a block (definition + 2 instances), an
// empty layer and a box on another layer.
const build = `
var iBox = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "상자" });
var iCurve = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "선" });
var iBlock = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "블록" });
var iOther = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기타" });
doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "비움" });
for (var i = 0; i < 60; i++) { var x = (i % 10) * 3.0; var y = (i / 10) * 3.0;
  doc.Objects.AddBox(new Box(new BoundingBox(x, y, 0, x + 1, y + 1, 1)), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iBox }); }
for (var i = 0; i < 5; i++) doc.Objects.AddLine(new Line(new Point3d(0, -2 - i, 0), new Point3d(10 + i, -2 - i, 0)), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iCurve });
for (var i = 0; i < 5; i++) doc.Objects.AddCircle(new Circle(new Point3d(40, i * 3.0, 0), 1 + i * 0.2), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iCurve });
var def = doc.InstanceDefinitions.Add("시험 블록", "", Point3d.Origin, new GeometryBase[] { new Box(new BoundingBox(0, 0, 0, 0.5, 0.5, 2)).ToBrep(), new LineCurve(new Point3d(0, 0, 2), new Point3d(0.5, 0.5, 2)) });
doc.Objects.AddInstanceObject(def, Transform.Translation(50, 0, 0), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iBlock });
doc.Objects.AddInstanceObject(def, Transform.Translation(50, 5, 0), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iBlock });
doc.Objects.AddBox(new Box(new BoundingBox(60, 0, 0, 62, 3, 4)), new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOther });
return doc.Objects.Count;`;

const wait = async (fn, ms = 120000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw Error('Timed out');
};

let worker, host, app;
const result = { dataDir, docDir, steps: {} };
const step = (name, value) => {
  result.steps[name] = value;
  console.log(name, JSON.stringify(value).slice(0, 400));
};
try {
  // 1. The synthetic document, made and saved by a work copy.
  worker = await launchRhinoWorker({ ...options, directory: join(dataDir, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  result.objects = receipt.value;
  await worker.stop();
  worker = undefined;
  const source = join(docDir, 'synthetic.3dm');
  await copyFile(receipt.filename, source);

  // 2. The document open in a VIDE-owned hidden Rhino with the plugin connected, and an action
  //    loop that plays the user's Rhino (Ctrl+Z, counting objects).
  const script = join(docDir, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(docDir.replaceAll('\\', '/'))}
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
    report('ready',dict(ok=True,documentId=int(doc.RuntimeSerialNumber),objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem),path=str(doc.Path)))
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
    JSON.parse(await readFile(join(docDir, 'ready.json'), 'utf8')),
  );
  assert.equal(ready.ok, true, JSON.stringify(ready));
  result.ready = ready;
  result.rhinoPid = host.identity.pid;
  console.log('rhino pid', host.identity.pid);
  let actionId = 0;
  const action = async (code) => {
    actionId++;
    await writeFile(join(docDir, 'action.tmp'), JSON.stringify({ id: actionId, code }));
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(join(docDir, 'action.tmp'), join(docDir, 'action.json'));
        break;
      } catch (error) {
        if (error.code !== 'EPERM' || attempt === 19) throw error;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    const r = await wait(async () =>
      JSON.parse(await readFile(join(docDir, 'action-' + actionId + '.json'), 'utf8')),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.value;
  };
  /** Objects per layer in the Rhino document (the user's view of it). */
  const census = () =>
    action(`counts={}
for o in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectEnumeratorSettings()):
    p=doc.Layers[o.Attributes.LayerIndex].FullPath
    counts[p]=counts.get(p,0)+1
result=dict(total=sum(counts.values()),layers=counts,layerCount=len([l for l in doc.Layers if not l.IsDeleted]))`);
  const initial = await census();
  assert.equal(initial.total, 73, JSON.stringify(initial));
  assert.equal(initial.layers['상자'], 60);

  // 3. The engine with a scripted provider: each turn runs the next script over the agent tools.
  let turnScript;
  const providerFactory = ({ agent }) => ({
    async run(context) {
      const call = async (name, args = {}) => {
        const answer = await app.agentTools.call(agent.token, name, {
          targetRef: agent.targetRef,
          ...args,
        });
        const text = answer.content.find((c) => c.type === 'text')?.text;
        return {
          error: answer.isError === true,
          value: text ? JSON.parse(text) : undefined,
          content: answer.content,
        };
      };
      return turnScript({ agent, context, call });
    },
    async status() {
      return { available: true };
    },
  });
  app = await startServer({
    filename: join(dataDir, 'vide.sqlite'),
    port: Number(process.env.VIDE_TEST_PORT ?? 0),
    providerFactory,
    sdkOptions: { ...options, connectionDirectory },
  });
  result.origin = app.origin;
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: '바로 적용 시험' })).body;
  const docs = (await api('/host/attached-documents')).body;
  const doc = docs.documents.find((d) => d.path?.toLowerCase() === source.toLowerCase());
  assert.ok(doc, JSON.stringify(docs));
  const target = { instance: doc.instance, documentId: doc.id };
  const link = await api(`/projects/${project.id}/links`, 'POST', { ...target, host: 'rhino' });
  assert.equal(link.status, 201, JSON.stringify(link.body));
  const sync = async () => {
    const synced = await api(`/projects/${project.id}/capture`, 'POST', {
      ...target,
      id: randomUUID(),
      linkId: link.body.id,
    });
    assert.equal(synced.status, 200, JSON.stringify(synced.body).slice(0, 400));
    assert.equal(synced.body.result?.hostExecuted, true, JSON.stringify(synced.body).slice(0, 400));
    return synced.body;
  };
  let base = await sync();
  step('sync', { objects: base.result.scene?.length, state: base.state });

  const path = `/projects/${project.id}/requests`;
  const settled = async (id) => {
    for (let i = 0; i < 1200; i++) {
      const { body } = await api(`${path}/${id}`);
      if (body && !['queued', 'running'].includes(body.state)) return body;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('request did not settle: ' + id);
  };
  /** One auto-mode turn running `script`; returns the settled request and the tool answers. */
  const turn = async (body, script, fields = {}) => {
    const answers = [];
    turnScript = async (turnContext) => {
      const call = async (...args) => {
        const answer = await turnContext.call(...args);
        answers.push(answer);
        return answer;
      };
      return script({ ...turnContext, call });
    };
    const id = randomUUID();
    const sent = await api(path, 'POST', {
      id,
      body,
      mode: 'auto',
      provider: 'claude-cli',
      pins: [],
      sketches: [],
      files: [],
      baseRequestId: base.id,
      ...fields,
    });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const request = await settled(id);
    console.log(
      '  turn',
      body,
      request.state,
      JSON.stringify(answers.map((a) => (a.value ? { ...a.value, data: undefined } : a))).slice(
        0,
        700,
      ),
    );
    return { request, answers, id };
  };
  const undo = (id, executionId) => api(`${path}/${id}/undo`, 'POST', { executionId });
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  await sessions.list(true);
  const fingerprint = () => sessions.fingerprint(target);

  // (1) Three boxes in one execute: one undo record with three added objects.
  const addBoxes = `for (var i = 0; i < 3; i++) doc.Objects.AddBox(new Box(new BoundingBox(100 + i * 2, 0, 0, 101 + i * 2, 1, 1)));
output.AppendLine("3 boxes");
return 3;`;
  const t1 = await turn('상자 3개 추가', async ({ call, agent }) => {
    assert.ok(agent.tools.includes('execute'), agent.tools.join(','));
    await call('execute', { code: addBoxes });
    return { text: '상자 3개를 추가했습니다.' };
  });
  const e1 = t1.answers[0].value;
  assert.equal(t1.request.state, 'succeeded', JSON.stringify(t1.request.result).slice(0, 600));
  assert.equal(e1.changes.counts.added, 3, JSON.stringify(e1).slice(0, 400));
  assert.ok(e1.undoId, 'undo id set');
  const afterAdd = await census();
  assert.equal(afterAdd.total, initial.total + 3);
  const [x1] = t1.request.result.executions;
  step('1-add-3-boxes', {
    added: e1.changes.counts.added,
    undoId: e1.undoId,
    execState: x1.state,
    total: afterAdd.total,
    addedIds: e1.changes.added.map((a) => a.nativeId),
  });

  // (2) [되돌리기] of the latest record: the boxes go; again → already.
  const u1 = await undo(t1.id, x1.executionId);
  assert.equal(u1.body.ok, true, JSON.stringify(u1.body).slice(0, 300));
  const afterUndo = await census();
  assert.equal(afterUndo.total, initial.total);
  const u1again = await undo(t1.id, x1.executionId);
  assert.equal(u1again.body.already, true);
  step('2-undo-latest', {
    first: { ok: u1.body.ok, state: u1.body.request.result.executions[0].state },
    total: afterUndo.total,
    again: { ok: u1again.body.ok, already: u1again.body.already },
  });

  // (3) A then B; undo A → not-latest; undo B then A → both undone.
  base = await sync();
  const t3 = await turn('A 다음 B', async ({ call }) => {
    await call('execute', {
      code: 'doc.Objects.AddPoint(new Point3d(200, 0, 0)); output.AppendLine("A");',
    });
    await call('execute', {
      code: 'doc.Objects.AddPoint(new Point3d(201, 0, 0)); output.AppendLine("B");',
    });
    return { text: 'A와 B를 추가했습니다.' };
  });
  assert.equal(t3.request.state, 'succeeded', JSON.stringify(t3.request.result).slice(0, 600));
  const [xa, xb] = t3.request.result.executions;
  const uA = await undo(t3.id, xa.executionId);
  assert.deepEqual([uA.body.ok, uA.body.reason], [false, 'not-latest']);
  const countAB = (await census()).total;
  assert.equal(countAB, initial.total + 2);
  const uB = await undo(t3.id, xb.executionId);
  const uA2 = await undo(t3.id, xa.executionId);
  assert.equal(uB.body.ok, true);
  assert.equal(uA2.body.ok, true);
  const afterAB = (await census()).total;
  assert.equal(afterAB, initial.total);
  step('3-not-latest', {
    undoIds: [xa.undoId, xb.undoId],
    undoA: { ok: uA.body.ok, reason: uA.body.reason, totalAfter: countAB },
    undoB: uB.body.ok,
    undoAThen: uA2.body.ok,
    total: afterAB,
  });

  // (4) Guards. Bulk delete of the 60 boxes: guarded, document unchanged; [진행] deletes them.
  base = await sync();
  const wipe = `var layer = doc.Layers.FindName("상자");
foreach (var o in doc.Objects.FindByLayer(layer)) doc.Objects.Delete(o, true);`;
  const t4 = await turn('상자 모두 삭제', async ({ call }) => {
    await call('execute', { code: wipe });
    return { text: '확인이 필요합니다.' };
  });
  const g4 = t4.answers[0].value;
  const held = await census();
  assert.equal(t4.request.state, 'needs-confirmation', JSON.stringify(t4.request.result));
  assert.equal(g4.guarded.kind, 'bulk-delete');
  assert.equal(held.total, initial.total);
  const [xg] = t4.request.result.executions;
  const confirmed = await api(`${path}/${t4.id}/confirm`, 'POST', {
    executionId: xg.executionId,
  });
  assert.ok([200, 202].includes(confirmed.status), JSON.stringify(confirmed.body).slice(0, 400));
  const t4done = confirmed.body.state === 'succeeded' ? confirmed.body : await settled(t4.id);
  const applied4 = t4done.result.executions.find((e) => e.state === 'applied');
  const afterWipe = await census();
  assert.equal(afterWipe.layers['상자'] ?? 0, 0);
  assert.equal(applied4.changes.removed.length, 60);
  // Put the boxes back through VIDE (the confirmed run is its own record).
  const u4 = await undo(t4.id, applied4.executionId);
  const restored = await census();
  assert.equal(restored.total, initial.total);
  step('4a-bulk-delete', {
    guarded: g4.guarded,
    state: t4.request.state,
    totalWhileHeld: held.total,
    confirmState: t4done.state,
    removed: applied4.changes.removed.length,
    boxesAfterConfirm: afterWipe.layers['상자'] ?? 0,
    undoConfirmed: u4.body.ok,
    totalAfterUndo: restored.total,
  });

  // Layer delete: guarded and reverted.
  base = await sync();
  const t4b = await turn('빈 레이어 삭제', async ({ call }) => {
    await call('execute', {
      code: 'var i = doc.Layers.FindByFullPath("비움", -1); output.AppendLine(doc.Layers.Delete(i, true).ToString());',
    });
    return { text: '확인이 필요합니다.' };
  });
  const g4b = t4b.answers[0].value;
  const layersAfter = await census();
  assert.equal(g4b.guarded?.kind, 'layer-delete', JSON.stringify(g4b));
  assert.equal(layersAfter.layerCount, initial.layerCount);
  step('4b-layer-delete', {
    guarded: g4b.guarded,
    state: t4b.request.state,
    layerCount: layersAfter.layerCount,
  });

  // Purge: found before the run (not undoable), nothing runs.
  base = await sync();
  const t4c = await turn('레이어 정리', async ({ call }) => {
    await call('execute', {
      code: 'var i = doc.Layers.FindByFullPath("비움", -1); doc.Layers.Purge(i, true);',
    });
    return { text: '확인이 필요합니다.' };
  });
  const g4c = t4c.answers[0].value;
  const purgeAfter = await census();
  assert.equal(g4c.guarded?.kind, 'purge', JSON.stringify(g4c));
  assert.equal(purgeAfter.layerCount, initial.layerCount);
  step('4c-purge', {
    guarded: g4c.guarded,
    state: t4c.request.state,
    layerCount: purgeAfter.layerCount,
  });

  // (5) A body that adds a box and throws: EXECUTION_FAILED, reverted, document unchanged.
  base = await sync();
  const before5 = await fingerprint();
  const t5 = await turn('실패하는 실행', async ({ call }) => {
    await call('execute', {
      code: 'doc.Objects.AddBox(new Box(new BoundingBox(300, 0, 0, 301, 1, 1))); throw new InvalidOperationException("의도한 실패");',
    });
    return { text: '실행이 실패했습니다.' };
  });
  const e5 = t5.answers[0].value;
  const after5 = await census();
  assert.equal(e5.code, 'EXECUTION_FAILED', JSON.stringify(e5));
  assert.equal(e5.reverted, true);
  assert.equal(after5.total, initial.total);
  step('5-execution-failed', {
    code: e5.code,
    reverted: e5.reverted,
    message: e5.message,
    requestState: t5.request.state,
    executions: t5.request.result.executions?.length ?? 0,
    total: after5.total,
    fingerprintBefore: before5,
    fingerprintAfter: await fingerprint(),
  });

  // (6) capture_view and measure through the agent tools.
  const ids =
    await action(`on=lambda name: [o for o in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectEnumeratorSettings()) if doc.Layers[o.Attributes.LayerIndex].FullPath==name]
boxes=sorted(on(u'\\uc0c1\\uc790'), key=lambda o: (o.Geometry.GetBoundingBox(True).Min.Y, o.Geometry.GetBoundingBox(True).Min.X))
result=dict(boxes=[str(o.Id) for o in boxes][:2], curve=[str(o.Id) for o in sorted([o for o in on(u'\\uc120') if isinstance(o.Geometry, Rhino.Geometry.LineCurve)], key=lambda o: o.Geometry.GetLength())][:1])`);
  assert.equal(ids.boxes.length, 2, JSON.stringify(ids));
  assert.equal(ids.curve.length, 1, JSON.stringify(ids));
  base = await sync();
  const t6 = await turn('모델 보기와 치수', async ({ call, agent }) => {
    assert.ok(agent.tools.includes('capture_view'), agent.tools.join(','));
    assert.ok(agent.tools.includes('measure'));
    await call('capture_view', { width: 1600, height: 900 });
    await call('capture_view', { width: 2400, height: 900 });
    await call('capture_view', { width: 1200, height: 800, fitIds: [...ids.boxes, ...ids.curve] });
    await call('measure', {
      ids: [...ids.boxes, ...ids.curve],
      distances: [{ a: ids.boxes[0], b: ids.boxes[1] }],
    });
    return { text: '보고 쟀습니다.' };
  });
  const [view, oversize, fitted, measured] = t6.answers;
  const image = view.content.find((c) => c.type === 'image');
  const png = image ? Buffer.from(image.data, 'base64') : null;
  const viewMeta = view.value;
  step('6-view-tools', {
    state: t6.request.state,
    image: image
      ? {
          mimeType: image.mimeType,
          bytes: png.length,
          pngSignature: png.subarray(1, 4).toString(),
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
        }
      : null,
    meta: viewMeta && { ...viewMeta, data: undefined },
    oversize: { error: oversize.error, value: oversize.value },
    measure: measured.value,
  });
  // A blank capture (hidden window, ViewCapture.CaptureToBitmap) was a 6 KB white PNG at 1600x900.
  assert.ok(image && png.length > 15000, 'the capture shows the model');
  assert.ok(png.readUInt32BE(16) <= 1600 && png.readUInt32BE(20) <= 1600);
  const box0 = measured.value.objects.find((o) => o.id === ids.boxes[0]);
  assert.deepEqual(
    box0.size.map((v) => Math.round(v * 1000) / 1000),
    [1, 1, 1],
  );
  assert.ok(Math.abs(measured.value.objects.find((o) => o.id === ids.curve[0]).length - 10) < 1e-6);
  assert.ok(Math.abs(measured.value.distances[0].distance - 2) < 1e-6);
  if (png) await writeFile(join(dataDir, 'capture.png'), png);
  const fittedImage = fitted.content.find((c) => c.type === 'image');
  if (fittedImage)
    await writeFile(join(dataDir, 'capture-fit.png'), Buffer.from(fittedImage.data, 'base64'));

  // (7) Rhino's own Undo (Ctrl+Z) of an AI record, then VIDE [되돌리기] → already.
  base = await sync();
  const t7 = await turn('점 하나 추가', async ({ call }) => {
    await call('execute', { code: 'doc.Objects.AddPoint(new Point3d(400, 0, 0));' });
    return { text: '점을 추가했습니다.' };
  });
  const [x7] = t7.request.result.executions;
  const with7 = (await census()).total;
  // Ctrl+Z in Rhino is the Undo command.
  const hostUndo = await action("result=bool(Rhino.RhinoApp.RunScript('_Undo', False))");
  const after7 = (await census()).total;
  const u7 = await undo(t7.id, x7.executionId);
  const after7undo = (await census()).total;
  step('7-host-undo-then-vide', {
    totalWithPoint: with7,
    rhinoUndo: hostUndo,
    totalAfterRhinoUndo: after7,
    vide: {
      status: u7.status,
      ok: u7.body.ok,
      already: u7.body.already ?? null,
      reason: u7.body.reason ?? null,
    },
    state: u7.body.request?.result?.executions?.[0]?.state,
    totalAfterVideUndo: after7undo,
  });
  assert.equal(with7, initial.total + 1);
  assert.equal(hostUndo, true);
  assert.equal(after7, initial.total);
  assert.equal(u7.body.ok, true);
  assert.equal(after7undo, initial.total, 'VIDE undo did not undo anything else');
  assert.equal(u7.body.already, true, 'the host-side undo is reported as already undone');

  result.passed = true;
} catch (error) {
  result.passed = false;
  result.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  await worker?.stop().catch(() => {});
  await app?.close().catch(() => {});
  await host?.stop?.().catch(() => {});
  await writeFile(join(dataDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, error: result.error, dataDir }));
}
