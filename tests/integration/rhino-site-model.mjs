// T-207 (PLAN-45) in a VIDE-owned Rhino 8 on a synthetic document: the official jig vide/site-model
// computed from the synthetic public services (tests/fixtures/site-data.mjs, two lots 합필, a road,
// two buildings with recorded heights) and a synthetic 수치지형도 SHP for the terrain, then made in
// the attached document through the jig route (바로 적용): blocked until the target is confirmed;
// afterwards parcels and roads as closed curves, buildings as closed outward solids with the
// expected volumes and their height sources, the terrain mesh and contours, and one site-information
// dot carrying the summary, CRS, survey base point and true north — all readable by Sync. Then the
// same site with survey coordinates kept (EPSG:5186, f64 origin + f32 differences) lands on the
// survey positions within a millimetre, and [되돌리기] removes the whole bake.
// No user document is opened; the test builds its own under .vide/. Without Rhino 8 it is skipped.
// Only the Rhino processes this test launched are closed; the installed VIDE's plugin registration
// is restored afterwards.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Execution } from '../../src/server/execution.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { siteModelRoutes } from '../../src/server/site-model-routes.ts';
import { SiteDataSettings } from '../../src/server/site-data-routes.ts';
import { PublicDataKeyStore } from '../../src/server/public-data-keys.ts';
import { SITE_DATA_NOTICE } from '../../src/contracts/site-data.ts';
import { readObjects } from '../../src/jigs/bake/plan.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';
import { soleDb } from '../fixtures/store.mjs';
import { KEYS, P1, P2, fakeSiteData } from '../fixtures/site-data.mjs';
import { siteShapefiles } from '../fixtures/site-shp.mjs';

const probe = sdkOptions('.');
// A worktree without its own plugin build names the checkout's with VIDE_TEST_RHINO_PLUGIN.
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${plugin}) is not available`,
  );
  process.exit(0);
}

const directory = runDirectory('rhino-site-model');
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
options.plugin = plugin;
const ROOT = 'VIDE::대지';
const BAKES = [
  'targets',
  'outline',
  'parcels',
  'roads',
  'buildings',
  'terrain',
  'contours',
  'siteInfo',
];
const build = `
var iOther = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기타" });
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOther }; doc.Objects.AddBox(new Box(new BoundingBox(-500, -500, 0, -499, -499, 1)), a); }
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
const attrsOf = (row) =>
  Object.fromEntries(row.attributes64.map(([k, v]) => [decode(k), decode(v)]));
const ms = (start) => Math.round(performance.now() - start);

let worker, host, engine;
const result = { directory };
try {
  // 1. The synthetic document, saved by a work copy.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  await worker.stop();
  worker = undefined;

  // 2. The document open in a VIDE-owned attached Rhino with an action loop for measurements.
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic-site-model.3dm');
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
    assert doc.Path and doc.Path.lower().replace('\\\\','/')==source.lower(), doc.Path
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    Rhino.RhinoApp.Idle+=idle
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem),tolerance=doc.ModelAbsoluteTolerance,rhino=str(Rhino.RhinoApp.Version),plugin=assembly.Location))
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
  Object.assign(result, { rhino: ready.rhino, units: ready.units, tolerance: ready.tolerance });
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
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. The engine: project, link, a Sync, the official jig's instance and its site data.
  const store = new Store(join(directory, 'workspace.sqlite')),
    workspace = new Workspace(store),
    links = new DocumentLinks(store),
    project = store.createProject('사이트 모델링 시험'),
    dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic-site-model.3dm',
    path: source,
    instance: target.instance,
    documentId: target.documentId,
  });
  const display = await sdk.syncEditor(target, () => {});
  soleDb(workspace.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      'sync-1',
      project.id,
      JSON.stringify({
        id: 'sync-1',
        body: 'Sync',
        permission: 'review',
        provider: 'claude-cli',
        pins: [],
        sketches: [],
        files: [],
        host: 'rhino',
        source: 'document',
        linkId: link.id,
        sourceDocument: target,
      }),
      'succeeded',
      JSON.stringify({ ...display, hostExecuted: true }),
      new Date().toISOString(),
    );
  const execution = new Execution(workspace, { sdk });
  engine = { execution, workspace, store };
  let last;
  const call = async (method, path, payload) => {
    last = undefined;
    const request = Object.assign(Readable.from([]), { method, headers: {} });
    const handled = await jigRoutes(new URL(path, 'http://127.0.0.1'), request, {
      workspace,
      body: async () => payload ?? {},
      send: (status, data) => (last = { status, data }),
      dataDirectory: dataDir,
      links,
      sdk,
      execution,
    });
    return handled ? last : { status: 0, data: undefined };
  };
  const settings = new SiteDataSettings(join(dataDir, 'site-data-settings.json'));
  await settings.update(project.id, () => ({
    confirmed: { version: SITE_DATA_NOTICE.version, at: new Date().toISOString() },
  }));
  const fake = fakeSiteData();
  const site = async (method, path, payload) => {
    let out;
    await siteModelRoutes(new URL(path, 'http://127.0.0.1'), method, {
      workspace,
      dataDirectory: dataDir,
      keys: new PublicDataKeyStore(undefined, KEYS),
      settings,
      body: async () => payload ?? {},
      send: (status, data) => (out = { status, data }),
      context: { fetch: fake.fetch },
    });
    return out.data;
  };
  const base = `/api/v1/projects/${project.id}/jig-instances`;
  const created = await call('POST', base, {
    jig: 'vide/site-model',
    title: '대지 모델 시험',
    layerRoot: ROOT,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const iid = created.data.id;
  const siteBase = `${base}/${iid}/site-data/site`;
  await site('PUT', `${siteBase}/targets`, { pnus: [P1, P2] });
  const collected = await site('POST', `${siteBase}/collect`);
  assert.equal(collected.blocked, false);
  // Terrain from a synthetic 수치지형도 SHP over the same place (public parcels and buildings win).
  await site('POST', `${siteBase}/shp`, {
    files: siteShapefiles({ x: 200000, y: 550000 }).map((f) => ({
      name: f.name,
      data: Buffer.from(f.bytes).toString('base64'),
    })),
  });
  await call('PUT', `${base}/${iid}/params`, {
    values: [{ key: 'terrain', value: true }],
    by: 'user',
  });
  const run = async () => (await call('POST', `${base}/${iid}/run`, { mode: 'confirmed' })).data;
  let report = await run();
  const status = (id) => report.steps.find((s) => s.id === id)?.status;
  for (const id of ['collect', 'frame', 'roads', 'terrain', 'buildings', 'summary'])
    assert.equal(
      status(id),
      'done',
      `${id}: ${JSON.stringify(report.steps.find((s) => s.id === id))}`,
    );
  assert.equal(status('confirmTarget'), 'waiting');
  const outputs = report.outputs;
  result.counts = {
    targets: outputs.frame.targets.length,
    parcels: outputs.frame.parcels.length,
    roads: outputs.roads.curves.length,
    buildings: outputs.buildings.buildings.length,
    terrainPieces: outputs.terrain.mesh.length,
    contours: outputs.terrain.contours.length,
  };
  assert.equal(outputs.terrain.included, true);
  assert.ok(outputs.terrain.mesh.length >= 1);

  // 4. Not confirmed: Rhino에 만들기 is refused before anything is sent.
  const refused = await call('POST', `${base}/${iid}/bake`, { bake: BAKES, linkId: link.id });
  assert.equal(refused.status, 422, JSON.stringify(refused.data).slice(0, 400));
  assert.equal(refused.data.code, 'GATE_BLOCKED');
  assert.ok(refused.data.blocked.includes('target-confirmed'));

  // 5. Confirmed: made in the open document.
  await call('POST', `${base}/${iid}/steps/confirmTarget/confirm`, {
    inputHash: report.steps.find((s) => s.id === 'confirmTarget').inputHash,
  });
  report = await run();
  assert.equal(status('confirmTarget'), 'confirmed');
  let started = performance.now();
  const made = await call('POST', `${base}/${iid}/bake`, { bake: BAKES, linkId: link.id });
  result.bakeMs = ms(started);
  assert.equal(made.status, 200, JSON.stringify(made.data).slice(0, 800));
  assert.equal(made.data.status, 'applied');
  assert.deepEqual(
    made.data.bake.bakes.flatMap((b) => b.failed),
    [],
    'nothing failed',
  );
  result.totals = made.data.bake.totals;

  // 6. The document as Sync reads it: layers, attributes, the site information.
  const rows = (await sdk.readLayers(target, { includeHidden: true })).scene.filter(
    (row) => attrsOf(row)['vide-instance'] === iid,
  );
  const layerOf = (row) => decode(row.layer64);
  const on = (name) => rows.filter((row) => layerOf(row) === `${ROOT}::${name}`);
  result.layers = Object.fromEntries(
    ['대상 필지', '대지 경계', '주변 필지', '도로', '건물', '지형', '등고선', '대지 정보'].map(
      (name) => [name, on(name).length],
    ),
  );
  assert.equal(on('대상 필지').length, 2);
  assert.equal(on('대지 경계').length, 1, '합필 outline');
  assert.equal(on('건물').length, 2);
  assert.equal(on('도로').length, 1);
  assert.equal(on('지형').length, outputs.terrain.mesh.length);
  assert.ok(on('지형').every((row) => row.nativeType === 'Mesh'));
  assert.equal(on('대지 정보').length, 1);
  const byKey = new Map(rows.map((row) => [attrsOf(row)['vide-key'], row]));
  const parcel = attrsOf(byKey.get(`parcel:${P1}`));
  assert.equal(parcel['vide-pnu'], P1);
  assert.equal(parcel['vide-jimok'], '대');
  assert.equal(parcel['vide-area-m2'], '600');
  assert.equal(parcel['vide-fetched-at'], outputs.collect.fetchedAt);
  const tower = attrsOf(byKey.get('bldg:1199910100100010000000001'));
  assert.equal(tower['vide-height-source'], '건물 정보');
  assert.equal(tower['vide-height'], '17.50');
  const shop = attrsOf(byKey.get('bldg:1199910100100010001000001'));
  assert.equal(shop['vide-height-source'], '대장');
  const road = attrsOf(on('도로')[0]);
  assert.equal(road['vide-width-min'], '10.00');
  const info = attrsOf(on('대지 정보')[0]);
  assert.match(info['vide-crs'], /EPSG:5186/);
  assert.equal(info['vide-origin-survey'], outputs.frame.originText);
  assert.match(info['vide-true-north'], /수렴각/);
  const summary = JSON.parse(info['vide-site-summary']);
  assert.deepEqual(summary.pnu, [P1, P2]);
  assert.equal(summary.area.computed, 1200);
  result.siteInfo = { crs: info['vide-crs'], origin: info['vide-origin-survey'] };

  // 7. Solids, orientation, volumes and positions measured in Rhino (site base point at 0, 0).
  const masses = on('건물');
  const measured = await action(
    `out={}
for i in ${JSON.stringify(masses.map((row) => row.nativeId))}:
    b=doc.Objects.FindId(System.Guid(i)).Geometry
    if isinstance(b, Rhino.Geometry.Extrusion): b=b.ToBrep()
    m=Rhino.Geometry.VolumeMassProperties.Compute(b,True,False,False,False)
    bb=b.GetBoundingBox(True)
    out[i]=[b.IsSolid,b.IsValid,str(b.SolidOrientation),m.Volume if m else None,[bb.Min.X,bb.Min.Y,bb.Min.Z,bb.Max.Z]]
result=out`,
  );
  const expected = new Map(
    outputs.buildings.buildings.map((b) => [b.key, { volume: b.footprint_m2 * b.height, b }]),
  );
  let worst = 0;
  for (const row of masses) {
    const key = attrsOf(row)['vide-key'];
    const [solid, valid, orientation, volume, box] = measured[row.nativeId];
    assert.ok(solid && valid && orientation === 'Outward', `${key}: ${measured[row.nativeId]}`);
    const want = expected.get(key);
    const relative = Math.abs(volume - want.volume) / want.volume;
    worst = Math.max(worst, relative);
    assert.ok(relative <= 1e-4, `${key}: volume ${volume} vs ${want.volume}`);
    const minX = Math.min(...want.b.polygon.map((p) => p[0]));
    assert.ok(Math.abs(box[0] - minX) < 1e-3, `${key}: x ${box[0]} vs ${minX}`);
    assert.ok(Math.abs(box[2] - want.b.ground) < 1e-3, `${key}: ground ${box[2]}`);
  }
  result.worstRelativeVolume = worst;

  // 8. Survey coordinates kept: the same site lands at EPSG:5186 positions (f64 + f32 offsets).
  await call('PUT', `${base}/${iid}/params`, {
    values: [{ key: 'originMode', value: 'survey' }],
    by: 'user',
  });
  report = await run();
  assert.equal(report.outputs.frame.mode, 'survey');
  started = performance.now();
  const survey = await call('POST', `${base}/${iid}/bake`, { bake: BAKES, linkId: link.id });
  result.surveyBakeMs = ms(started);
  assert.equal(survey.status, 200, JSON.stringify(survey.data).slice(0, 800));
  const surveyRows = (await sdk.readLayers(target, { includeHidden: true })).scene.filter(
    (row) => attrsOf(row)['vide-run'] === survey.data.bake.runId,
  );
  const towerRow = surveyRows.find(
    (row) => attrsOf(row)['vide-key'] === 'bldg:1199910100100010000000001',
  );
  const far = await action(
    `b=doc.Objects.FindId(System.Guid(${JSON.stringify(towerRow.nativeId)})).Geometry
bb=b.GetBoundingBox(True)
result=[bb.Min.X,bb.Min.Y,bb.Max.X,bb.Max.Y]`,
  );
  // The fake tower outline is 200005..200015 × 550005..550025 in EPSG:5186.
  const error = Math.max(
    Math.abs(far[0] - 200005),
    Math.abs(far[1] - 550005),
    Math.abs(far[2] - 200015),
    Math.abs(far[3] - 550025),
  );
  result.surveyError_m = error;
  assert.ok(error < 1e-3, `survey placement error ${error} m`);

  // 9. [되돌리기] of the last bake removes it in one action; the earlier objects were replaced.
  const records = (await call('GET', `${base}/${iid}/bakes`)).data.bakes.filter(
    (r) => r.runId === survey.data.bake.runId,
  );
  const undone = await call('POST', `${base}/${iid}/bakes/${records[0].id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const after = readObjects(await sdk.readLayers(target, { includeHidden: true }));
  const left = [...after.values()].filter(
    (o) => o.tags['vide-instance'] === iid && o.tags['vide-run'] === survey.data.bake.runId,
  );
  assert.equal(left.length, 0, 'the survey bake is gone');

  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  try {
    await engine?.execution.close();
    if (engine) await closeJigRuntime(engine.workspace);
    engine?.store.close();
  } catch (error) {
    console.error('engine close: ' + String(error));
  }
  await worker?.stop();
  await host?.stop();
  if (process.env.VIDE_TEST_KEEP_REGISTRATION !== '1') {
    const restored = await restoreInstalledPlugin();
    console.log('installed plugin registration: ' + JSON.stringify(restored));
  }
}
