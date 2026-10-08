// 법규 체크 실호스트 시험 (PLAN-48 T-241 시나리오 2) in a VIDE-owned hidden Rhino 8: a synthetic
// document under .vide/ (metres; the `rect` lot of the buildable-mass fixture — 20 × 30 m, road on
// the south, three neighbouring lots — and a building drawn on it: a mass, its top floor pushed
// north over the 일조 사선, floor outlines with `vide-floor`, ten parking stalls, landscape, public
// open space and one closed solid on an unnamed layer). The engine computes `vide/buildable-mass`
// from the layers read back from Rhino (its output '한계'), reads the document for the role check,
// sets one role directly, and runs [법규 체크] by name; each row is checked against what the model
// holds. Nothing is written to the document; no user document is opened; only the Rhino this test
// launched is closed; the installed VIDE's plugin registration is restored afterwards (a running
// Rhino makes that pending and the run fails).
// Usage: node tests/integration/rhino-compliance.mjs
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { complianceRoutes } from '../../src/server/compliance-routes.ts';
import { ComplianceRoles } from '../../src/services/compliance-roles.ts';
import { officialJigRoot } from '../../src/jigs/runtime/loader.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';
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
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${plugin}) is not available`,
  );
  process.exit(0);
}
const directory = runDirectory('rhino-compliance');
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
options.plugin = plugin;

// The synthetic document (metres). Site and neighbours as the `rect` fixture draws them.
const build = `
doc.ModelUnitSystem = Rhino.UnitSystem.Meters;
int L(string name) { return doc.Layers.Add(new Rhino.DocObjects.Layer { Name = name }); }
Rhino.DocObjects.ObjectAttributes A(int layer) { return new Rhino.DocObjects.ObjectAttributes { LayerIndex = layer }; }
void Ring(int layer, double x0, double y0, double x1, double y1, double z, string floor) {
  var a = A(layer); if (floor != null) a.SetUserString("vide-floor", floor);
  doc.Objects.AddPolyline(new[] { new Point3d(x0, y0, z), new Point3d(x1, y0, z), new Point3d(x1, y1, z), new Point3d(x0, y1, z), new Point3d(x0, y0, z) }, a);
}
var site = L("대지 경계"); var road = L("도로"); var lots = L("인접 대지");
var mass = L("건물"); var floors = L("층"); var parking = L("주차"); var green = L("조경"); var open = L("공개공지"); var other = L("기타");
Ring(site, 0, 0, 20, 30, 0, null);
Ring(road, -10, -8, 30, 0, 0, null);
Ring(lots, 20, 0, 40, 30, 0, null); Ring(lots, 0, 30, 20, 50, 0, null); Ring(lots, -20, 0, 0, 30, 0, null);
doc.Objects.AddBox(new Box(new BoundingBox(4, 6, 0, 16, 22, 14.4)), A(mass));
doc.Objects.AddBox(new Box(new BoundingBox(4, 22, 11.1, 16, 27, 14.4)), A(mass));
for (int i = 0; i < 4; i++) Ring(floors, 4, 6, 16, i == 3 ? 27 : 22, i == 0 ? 0 : 4.5 + (i - 1) * 3.3, (i + 1) + "F");
for (int i = 0; i < 10; i++) Ring(parking, 1 + i * 1.5, 1.5, 2.2 + i * 1.5, 4.5, 0, null);
Ring(green, 0, 6, 3, 30, 0, null);
Ring(open, 17, 1, 20, 6, 0, null);
doc.Objects.AddBox(new Box(new BoundingBox(17, 20, 0, 19, 22, 2)), A(other));
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
const timed = async (timings, name, fn) => {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - started);
  }
};

let worker, host, store, workspace;
const result = { directory, timings: {} };
const T = result.timings;
try {
  await warnIfRhinoRunning();
  // 1. The synthetic document, saved by a work copy, then open in a VIDE-owned hidden Rhino.
  await timed(T, 'rhinoStartMs', async () => {
    worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
    const receipt = await worker.execute(randomUUID(), 0, build);
    assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
    await worker.stop();
    worker = undefined;
    result.documentSource = receipt.filename;
  });
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic-compliance.3dm');
  await copyFile(result.documentSource, source);
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
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem),rhino=str(Rhino.RhinoApp.Version)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
  );
  const ready = await timed(T, 'rhinoOpenMs', async () => {
    host = await launchOwnedHost({
      executable: options.executable,
      environment: { ...process.env, VIDE_CONNECT_DIR: connectionDirectory },
      visible: false,
      spawnProcess: (file, args, o) => spawn(file, args, { ...o, windowsVerbatimArguments: true }),
      args: [
        '/nosplash',
        '/notemplate',
        '/scheme=VIDE-Worker-Test',
        `/runscript="_-RunPythonScript (${script})"`,
      ],
    });
    return wait(async () =>
      JSON.parse(await readFile(join(attachedDirectory, 'ready.json'), 'utf8')),
    );
  });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.units, 'Meters');
  result.rhino = ready.rhino;
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 2. The engine: project, link, the routes as the server wires them.
  store = new Store(join(directory, 'workspace.sqlite'));
  workspace = new Workspace(store);
  const links = new DocumentLinks(store);
  const roles = new ComplianceRoles(store);
  const project = store.createProject('법규 체크 실호스트 시험');
  const dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic-compliance.3dm',
    path: source,
    instance: target.instance,
    documentId: target.documentId,
  });
  const call = async (method, path, payload) => {
    let last;
    const url = new URL(path, 'http://127.0.0.1');
    const send = (status, data) => (last = { status, data });
    try {
      const handled =
        (await complianceRoutes(url, method, {
          workspace,
          dataDirectory: dataDir,
          body: async () => payload ?? {},
          send,
          remote: false,
          roles,
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
        }));
      return handled ? last : { status: 0 };
    } catch (error) {
      return { status: 'error', code: error.code ?? error.message };
    }
  };
  const base = `/api/v1/projects/${project.id}`;

  // 3. 건축 가능 영역·매스 from the layers read back from Rhino → its output '한계'.
  const rect = join(officialJigRoot(), 'buildable-mass', 'fixtures', 'rect');
  const params = JSON.parse(readFileSync(join(rect, 'params.json'), 'utf8'));
  const mass = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/buildable-mass',
    title: '매스 검토 1',
    layerRoot: 'VIDE::매스',
    params: Object.entries(params).map(([key, value]) => ({ key, value })),
  });
  assert.equal(mass.status, 200, JSON.stringify(mass));
  const massId = mass.data.id;
  const layers = { boundary: '대지 경계', roads: '도로', neighbors: '인접 대지' };
  const read = await timed(T, 'massReadMs', () =>
    call('POST', `${base}/jig-instances/${massId}/reads`, {
      linkId: link.id,
      layers: Object.values(layers),
      purpose: 'assembly',
    }),
  );
  assert.equal(read.status, 200, JSON.stringify(read));
  for (const [role, name] of Object.entries(layers)) {
    const set = await call('PUT', `${base}/jig-instances/${massId}/assembly/site.${role}`, {
      sources: [{ readId: read.data.readId, layers: [name] }],
      confirm: true,
    });
    assert.equal(set.status, 200, JSON.stringify(set));
  }
  const massRun = await timed(T, 'massComputeMs', () =>
    call('POST', `${base}/jig-instances/${massId}/run`, { mode: 'confirmed' }),
  );
  const handoff = massRun.data.steps.find((s) => s.id === 'limitsHandoff');
  assert.equal(handoff?.status, 'done', JSON.stringify(handoff?.error));
  assert.equal(massRun.data.outputs.limitsHandoff.frame.linkId, link.id);

  // 4. 법규 체크: open (the role-check read), one role set by a person, [법규 체크] by name.
  const check = await call('POST', `${base}/jig-instances`, {
    jig: 'vide/compliance-check',
    title: '법규 체크 1',
    layerRootLater: true,
  });
  assert.equal(check.status, 200, JSON.stringify(check));
  const checkId = check.data.id;
  const ground = await call('PUT', `${base}/jig-instances/${checkId}/params`, {
    values: [
      { key: 'groundState', value: 'set' },
      { key: 'groundLevel', value: 0 },
      { key: 'groundBasis', value: 'design' },
      { key: 'exclusionsComplete', value: true },
    ],
    by: 'user',
  });
  assert.equal(ground.status, 200, JSON.stringify(ground));
  const opened = await call('POST', `${base}/jig-instances/${checkId}/run`, { mode: 'geometry' });
  assert.equal(opened.data.steps.find((s) => s.id === 'check').status, 'skipped');
  const first = await timed(T, 'checkReadMs', () =>
    call('POST', `${base}/compliance/read`, { instanceId: checkId }),
  );
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.toMeters, 1);
  assert.deepEqual(
    [first.data.byRole.mass, first.data.byRole.floor, first.data.byRole.parking],
    [2, 4, 10],
  );
  const loose = first.data.rows.find((r) => r.layer === '기타');
  assert.equal(loose?.reason, '역할 없음', JSON.stringify(first.data.rows.slice(0, 5)));
  const set = await call('PUT', `${base}/compliance/roles`, {
    documentKey: first.data.documentKey,
    // The site lines are closed regions without a role: a person leaves them out (SPEC-15.9 7).
    set: ['기타', '대지 경계', '도로', '인접 대지'].map((key) => ({
      scope: 'layer',
      key,
      role: 'ignore',
    })),
    instanceId: checkId,
  });
  assert.equal(set.status, 200, JSON.stringify(set));
  const again = await call('POST', `${base}/compliance/read`, { instanceId: checkId });
  assert.equal(again.data.byRole.ignore, 6);
  assert.equal(again.data.unusedByReason['역할 없음'], 0);
  const ran = await timed(T, 'checkMs', () =>
    call('POST', `${base}/jig-instances/${checkId}/run`, { mode: 'confirmed', until: 'check' }),
  );
  const step = ran.data.steps.find((s) => s.id === 'check');
  assert.equal(step.status, 'done', JSON.stringify(step.error));
  const out = ran.data.outputs.check;
  const row = (id) => out.items.find((i) => i.id === id);
  result.rows = Object.fromEntries(out.items.map((i) => [i.id, `${i.state} ${i.reason}`.trim()]));
  // Hand checks on the synthetic model (values of the `rect` fixture: 일조 기준 높이 10 m,
  // 이격 1.5 m, 사선 0.5 from the north lot line y = 30; height 30 m; coverage 0.6; road setback 1 m).
  assert.equal(row('sun').state, '위반');
  assert.ok(row('sun').exceedances.every((e) => e.max[1] > 22.8));
  assert.equal(row('height:heightMax').state, '적합');
  assert.ok(Math.abs(row('height:heightMax').planned.value - 14.4) < 1e-6);
  // 층수 상한 is 미적용 in the fixture: listed, not a row. 연면적: 3 × 192 + 252 ㎡ over 600 ㎡.
  assert.ok(out.notApplicable.some((n) => n.check === 'floors'));
  assert.ok(Math.abs(row('far').planned.value - (3 * 192 + 252) / 600) < 1e-9);
  assert.equal(row('far').state, '적합');
  assert.equal(row('zone:roadSetback').state, '적합');
  assert.equal(row('outside-site').state, '적합');
  assert.ok(out.inputs.model.revisionKey.startsWith(`${target.instance}|`));
  assert.deepEqual(out.display.origin, [0, 0, 0]);
  // The document's revision now matches the check; nothing was written to Rhino.
  const revision = await call(
    'GET',
    `${base}/compliance/revision?linkId=${encodeURIComponent(link.id)}`,
  );
  assert.equal(revision.data.revisionKey, out.inputs.model.revisionKey);
  result.counts = out.counts;
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  try {
    if (workspace) await closeJigRuntime(workspace);
    store?.close();
  } catch (error) {
    console.error('engine close: ' + String(error));
  }
  await worker?.stop();
  await host?.stop();
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1')
    reportRestore(await restoreInstalledPlugin());
}
