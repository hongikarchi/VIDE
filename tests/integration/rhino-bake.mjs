// T-055 (PLAN-22) on a synthetic document in VIDE-owned Rhino processes: Rhino에 만들기 with the
// four fixed templates (lines, H members under their top line — one on an arc rail —, H columns,
// text dots) made directly in the attached document (바로 적용, user decision 2026-09-30: one host
// undo record per body, baseline read right after) → a second bake that replaces only the
// recorded, unchanged objects and leaves human work alone (an edited column, a copied line, a line
// moved to a hidden layer, a deleted mark) → [되돌리기] of that bake through the host's undo → a
// hidden output layer that blocks the bake.
// No user document is opened; the test builds its own. Afterwards the Rhino it launched is closed
// and the installed VIDE's plugin registration is restored.
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { JigStore } from '../../src/core/jig-store.ts';
import { DocumentLinks } from '../../src/core/document-links.ts';
import { Execution } from '../../src/server/execution.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { closeJigRuntime, jigRoutes } from '../../src/server/jig-routes.ts';
import { importPack, packJig } from '../../src/jigs/runtime/pack.ts';
import { readObjects } from '../../src/jigs/bake/plan.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';

const directory = resolve('.vide/rhino-bake', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
const ROOT = 'VIDE::격자';
const LAYERS = {
  columns: `${ROOT}::jig 기둥`,
  beams: `${ROOT}::jig 부재`,
  lines: `${ROOT}::jig 상단선`,
  marks: `${ROOT}::jig 부호`,
};
const HIDDEN = '기존::숨김';
/** A Python unicode literal with ASCII escapes only: the action file is read without an encoding. */
const py = (value) =>
  'u' +
  JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );

// The synthetic document (metres): the slab outline, the fixed parent layer with nothing under
// it yet, a hidden layer, and an unrelated box that must never change.
const build = `
var iOutline = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "슬래브 외곽" });
var iVide = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "VIDE" });
doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "격자", ParentLayerId = doc.Layers[iVide].Id });
var iOld = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기존" });
doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "숨김", ParentLayerId = doc.Layers[iOld].Id, IsVisible = false });
var iOther = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기타" });
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOutline }; doc.Objects.AddPolyline(new[] { new Point3d(0, 0, 0), new Point3d(30, 0, 0), new Point3d(30, 20, 0), new Point3d(0, 20, 0), new Point3d(0, 0, 0) }, a); }
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOther }; doc.Objects.AddBox(new Box(new BoundingBox(40, 40, 0, 41, 41, 1)), a); }
return doc.Objects.Count;`;

/** The bake jig: the example grid plus a step that turns its columns and beams into members. */
function bakeJig(root) {
  const dir = join(root, 'jigs', 'bake-test');
  cpSync(resolve('extensions/jigs/example-grid'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSyncUtf8(join(dir, 'jig.json')));
  manifest.id = 'project/bake-test';
  manifest.capabilities.push({
    name: 'host.bake',
    reason: '기둥·부재·상단선·부호를 Rhino에 만듭니다',
  });
  manifest.steps.push({
    id: 'members',
    title: '부재',
    kind: 'code',
    entry: 'steps/members.ts#members',
    needs: ['grid', 'beams'],
    reads: ['step.grid', 'step.beams'],
    writes: 'members',
    speed: 'release',
    gates: [{ use: 'non-empty' }, { use: 'no-nan' }],
  });
  const decl = (id, template, items, layer, map, attrs) => ({
    id,
    template,
    host: 'rhino',
    items,
    layer,
    key: 'key',
    map,
    ...(attrs ? { attrs } : {}),
    mode: 'replace-own',
  });
  manifest.bake = [
    decl(
      'columns',
      'vide.bake.extrude-column@1',
      'step.members.columns',
      'jig 기둥',
      { H_mm: 'H', B_mm: 'B', tw_mm: 'tw', tf_mm: 'tf' },
      { 'vide-mark': 'mark' },
    ),
    decl(
      'beams',
      'vide.bake.sweep-h@1',
      'step.members.beams',
      'jig 부재',
      { H_mm: 'H', B_mm: 'B', tw_mm: 'tw', tf_mm: 'tf' },
      { 'vide-mark': 'mark' },
    ),
    decl('lines', 'vide.bake.curves@1', 'step.members.lines', 'jig 상단선', { curve: 'line' }),
    decl('marks', 'vide.bake.textdot@1', 'step.members.marks', 'jig 부호', {}),
  ];
  writeFileSyncUtf8(join(dir, 'jig.json'), JSON.stringify(manifest, null, 2));
  writeFileSyncUtf8(
    join(dir, 'steps', 'members.ts'),
    `// Synthetic members for the bake test: H columns 4 m high, H members under their top lines at
// +4 m (plus one on an arc rail), the top lines themselves and a mark per column.
export function members(inputs: { steps: { grid: { columns: { key: string; mark: string; at: [number, number] }[] }; beams: { beams: { key: string; line: [[number, number], [number, number]] }[] } } }) {
  const grid = inputs.steps.grid;
  const beams = inputs.steps.beams;
  const columns = grid.columns.map((c) => ({
    key: c.key, mark: c.mark, base: [c.at[0], c.at[1], 0], top: [c.at[0], c.at[1], 4], strongAxis: [1, 0, 0],
    section: 'H-400x400x13x21', H: 400, B: 400, tw: 13, tf: 21,
  }));
  const rails = beams.beams.map((b) => ({ key: b.key, rail: [[b.line[0][0], b.line[0][1], 4], [b.line[1][0], b.line[1][1], 4]] }));
  const members = [
    ...rails.map((r) => ({ ...r, mark: r.key.replace('G:', 'B'), section: 'H-500x200x10x16', H: 500, B: 200, tw: 10, tf: 16 })),
    { key: 'ARC:1', mark: 'BA1', rail: { kind: 'arc', points: [[0, -5, 4], [15, -9, 4], [30, -5, 4]] }, section: 'H-500x200x10x16', H: 500, B: 200, tw: 10, tf: 16 },
  ];
  const lines = rails.map((r) => ({ key: 'L:' + r.key, line: r.rail }));
  const marks = grid.columns.map((c) => ({ key: 'M:' + c.key, text: c.mark, point: [c.at[0], c.at[1], 4.5] }));
  return { columns, beams: members, lines, marks };
}
`,
  );
  return dir;
}
import { readFileSync, writeFileSync } from 'node:fs';
const readFileSyncUtf8 = (path) => readFileSync(path, 'utf8');
const writeFileSyncUtf8 = (path, text) => writeFileSync(path, text);

const wait = async (fn, ms = 120000) => {
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
    return {
      restored: install.ok,
      status: install.status,
      body: (await install.text()).slice(0, 300),
    };
  } catch (error) {
    return { restored: false, error: String(error) };
  }
}

let worker, host, engine;
const result = { directory };
try {
  // 1. The synthetic document, saved by a work copy.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  assert.equal(receipt.value, 2);
  await worker.stop();
  worker = undefined;

  // 2. The document open in a VIDE-owned attached Rhino, with an action loop for "human" edits.
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
    report('ready',dict(ok=True,documentId=int(doc.RuntimeSerialNumber),objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem)))
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
  result.units = ready.units;
  let step = 0;
  /** Run Python in the attached Rhino; `result` in its scope comes back. */
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

  // 3. The engine side: project, link, Sync, the bake jig and its instance computed to the end.
  const store = new Store(join(directory, 'workspace.sqlite')),
    workspace = new Workspace(store),
    jigStore = new JigStore(store.db),
    links = new DocumentLinks(store.db),
    project = store.createProject('만들기 시험'),
    dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic.3dm',
    path: source,
    instance: target.instance,
    documentId: target.documentId,
  });
  const display = await sdk.syncEditor(target, () => {});
  assert.equal(display.displayOnly, true);
  workspace.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
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
  const packed = await packJig(bakeJig(directory), { dataDir, bundle: false, skipTests: true });
  await importPack(packed.bytes, { store: jigStore, dataDir });
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
  const base = `/api/v1/projects/${project.id}/jig-instances`;
  const created = await call('POST', base, {
    jig: 'project/bake-test',
    version: '0.1.0',
    title: '만들기 시험 작업본',
    layerRoot: ROOT,
    params: [
      { key: 'spacingX', value: 10 },
      { key: 'spacingY', value: 10 },
    ],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const iid = created.data.id;
  const read = await call('POST', `${base}/${iid}/reads`, {
    linkId: link.id,
    layers: ['슬래브 외곽'],
    purpose: 'assembly',
  });
  assert.equal(read.data.objectCount, 1, JSON.stringify(read.data));
  await call('PUT', `${base}/${iid}/assembly/${encodeURIComponent('site.outline')}`, {
    sources: [{ readId: read.data.readId, layers: ['슬래브 외곽'] }],
    confirm: true,
  });
  const first = await call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  assert.equal(first.data.steps[0].status, 'done', JSON.stringify(first.data.steps));
  await call('POST', `${base}/${iid}/steps/confirmInputs/confirm`, {
    inputHash: first.data.steps[1].inputHash,
  });
  const computed = await call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  assert.ok(
    computed.data.steps.every((s) => ['done', 'confirmed'].includes(s.status)),
    JSON.stringify(computed.data.steps.map((s) => [s.id, s.status, s.error])),
  );
  const members = computed.data.outputs.members;
  const counts = {
    columns: members.columns.length,
    beams: members.beams.length,
    lines: members.lines.length,
    marks: members.marks.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  result.counts = counts;
  assert.ok(counts.columns >= 4 && counts.beams >= 4);

  const readAll = async () => readObjects(await sdk.readLayers(target, { includeHidden: true }));
  const tagged = (objects, run) =>
    [...objects.values()].filter(
      (o) => o.tags['vide-instance'] === iid && (!run || o.tags['vide-run'] === run),
    );
  const records = async () => (await call('GET', `${base}/${iid}/bakes`)).data.bakes;
  const before = await readAll();
  const outline = [...before.values()].find((o) => o.layer === '슬래브 외곽');
  const box = [...before.values()].find((o) => o.layer === '기타');

  // 4. First bake: all four templates made directly in the attached document (바로 적용), one host
  //    undo record per body, and the baseline read right after — no work copy, no apply step.
  const started = performance.now();
  const bake1 = await call('POST', `${base}/${iid}/bake`, {
    bake: ['columns', 'beams', 'lines', 'marks'],
  });
  assert.equal(bake1.status, 200, JSON.stringify(bake1.data).slice(0, 600));
  assert.equal(
    bake1.data.status,
    'applied',
    'the engine has direct-execute (SdkExecution.directExecute / directUndo)',
  );
  assert.equal(bake1.data.baseline, 'recorded');
  assert.equal(
    bake1.data.plans.reduce((n, p) => n + p.added.length, 0),
    total,
  );
  assert.equal(bake1.data.undoIds.length, bake1.data.chunks);
  result.firstBakeMs = Math.round(performance.now() - started);
  result.chunks = bake1.data.chunks;
  const summary1 = bake1.data.bake;
  assert.equal(summary1.direct, true);
  assert.equal(summary1.totals.added, total, JSON.stringify(summary1.totals));
  assert.equal(summary1.totals.failed, 0, JSON.stringify(summary1.bakes.map((b) => b.failed)));
  assert.equal(bake1.data.removed, 0);
  // The document's rows: every object tagged and on its one-level output layer; members are solids.
  const rows1 = (await sdk.readLayers(target, { includeHidden: true })).scene.filter((row) =>
    row.attributes64.some(
      ([k, v]) =>
        Buffer.from(k, 'base64').toString() === 'vide-run' &&
        Buffer.from(v, 'base64').toString() === summary1.runId,
    ),
  );
  assert.equal(rows1.length, total);
  const layerOf = (row) => Buffer.from(row.layer64, 'base64').toString();
  assert.deepEqual(new Set(rows1.map(layerOf)), new Set(Object.values(LAYERS)));
  const solids = rows1.filter((row) => [LAYERS.columns, LAYERS.beams].includes(layerOf(row)));
  assert.ok(
    solids.every((row) => row.nativeType === 'Brep' && row.volume > 0),
    'members and columns are closed solids',
  );
  const arc = solids.find((row) =>
    row.attributes64.some(
      ([k, v]) =>
        Buffer.from(k, 'base64').toString() === 'vide-key' &&
        Buffer.from(v, 'base64').toString() === 'ARC:1',
    ),
  );
  assert.ok(arc && arc.volume > 0, 'the H member swept along the arc rail is a solid');
  result.arcVolume = arc.volume;

  // 5. The records: fingerprints and appliedAt at once, naming the objects in the document.
  const applied1 = await readAll();
  const run1 = tagged(applied1, summary1.runId);
  assert.equal(run1.length, total, 'every object of the run is in the document');
  const records1 = (await records()).filter((r) => r.runId === summary1.runId);
  assert.equal(records1.length, 4);
  assert.ok(records1.every((r) => r.appliedAt && !r.pendingBaseline && r.undoable));
  assert.ok(
    records1.every((record) =>
      Object.values(record.items).every(
        (item) => applied1.get(item.nativeId)?.hash === item.hash && item.hash.length === 64,
      ),
    ),
    'the record names objects that exist, with their fingerprints',
  );
  assert.equal(applied1.get(outline.nativeId).hash, outline.hash, 'other objects are untouched');
  assert.equal(applied1.get(box.nativeId).hash, box.hash);
  const layerTable = (await sdk.readLayers(target, {})).layers;
  for (const path of Object.values(LAYERS)) {
    const layer = layerTable.find((l) => l.fullPath === path);
    assert.ok(layer && layer.visible && !layer.locked, path);
    assert.equal(
      layer.parentId,
      layerTable.find((l) => l.fullPath === ROOT).id,
      'one level under the parent',
    );
  }

  // 6. Human work in Rhino: an edited column, a copied line, a line moved to the hidden layer, a
  //    deleted mark. The fingerprints of everything else stay the same.
  const byKey = (record, key) => record.items[key].nativeId;
  const columnsRecord = records1.find((r) => r.bakeId === 'columns');
  const linesRecord = records1.find((r) => r.bakeId === 'lines');
  const marksRecord = records1.find((r) => r.bakeId === 'marks');
  const editedKey = members.columns[0].key,
    editedId = byKey(columnsRecord, editedKey);
  const copiedKey = members.lines[0].key,
    copiedId = byKey(linesRecord, copiedKey);
  const movedKey = members.lines[1].key,
    movedId = byKey(linesRecord, movedKey);
  const deletedKey = members.marks[0].key,
    deletedId = byKey(marksRecord, deletedKey);
  await action(
    `obj=doc.Objects.FindId(System.Guid(${JSON.stringify(editedId)}))
doc.Objects.Transform(obj, Rhino.Geometry.Transform.Translation(0,0,0.5), True)`,
  );
  const copyId = await action(
    `obj=doc.Objects.FindId(System.Guid(${JSON.stringify(copiedId)}))
copy=doc.Objects.Transform(obj, Rhino.Geometry.Transform.Translation(0,1,0), False)
# A Rhino copy keeps every user string, vide-id included; two objects with one vide-id break the
# display read (scene-pages identity set) — a separate defect, so the copy drops that one tag here.
attr=doc.Objects.FindId(copy).Attributes.Duplicate()
attr.DeleteUserString('vide-id')
assert doc.Objects.ModifyAttributes(copy, attr, True)
result=str(copy)`,
  );
  await action(
    `obj=doc.Objects.FindId(System.Guid(${JSON.stringify(movedId)}))
attr=obj.Attributes.Duplicate()
paths=[(l.FullPath,l.Index) for l in doc.Layers if not l.IsDeleted]
found=[i for p,i in paths if p==${py(HIDDEN)}]
assert found, str(paths)
attr.LayerIndex=found[0]
assert doc.Objects.ModifyAttributes(obj,attr,True)`,
  );
  await action(`assert doc.Objects.Delete(System.Guid(${JSON.stringify(deletedId)}),True)`);
  const edited = await readAll();
  assert.notEqual(
    edited.get(editedId).hash,
    applied1.get(editedId).hash,
    'the moved column has a new fingerprint',
  );
  assert.ok(edited.has(copyId) && edited.get(copyId).tags['vide-key'] === copiedKey);
  assert.equal(edited.get(movedId).layer, HIDDEN);
  assert.ok(!edited.has(deletedId));

  // 7. Second bake: only the recorded, unchanged objects are replaced, in the document directly.
  const bake2 = await call('POST', `${base}/${iid}/bake`, {
    bake: ['columns', 'beams', 'lines', 'marks'],
  });
  assert.equal(bake2.status, 200, JSON.stringify(bake2.data).slice(0, 800));
  assert.equal(bake2.data.status, 'applied');
  const plan = Object.fromEntries(bake2.data.plans.map((p) => [p.bakeId, p]));
  assert.deepEqual(plan.columns.preserved, [
    { key: editedKey, nativeId: editedId, reason: 'edited' },
  ]);
  assert.equal(plan.columns.replaced.length, counts.columns - 1);
  assert.deepEqual(plan.lines.preserved, [{ key: movedKey, nativeId: movedId, reason: 'moved' }]);
  assert.equal(plan.lines.replaced.length, counts.lines - 1);
  assert.equal(plan.lines.copies, 1);
  assert.deepEqual(plan.marks.deleted, [deletedKey]);
  assert.equal(plan.marks.replaced.length, counts.marks - 1);
  assert.equal(plan.beams.replaced.length, counts.beams);
  const summary2 = bake2.data.bake;
  assert.deepEqual(
    [
      summary2.totals.added,
      summary2.totals.replaced,
      summary2.totals.preserved,
      summary2.totals.copies,
      summary2.totals.deleted,
    ],
    [0, total - 3, 2, 1, 1],
  );
  assert.equal(bake2.data.removed, total - 3, 'exactly the replaced objects were deleted');
  const applied2 = await readAll();
  assert.equal(
    applied2.get(editedId).hash,
    edited.get(editedId).hash,
    'the edited column is kept as edited',
  );
  assert.ok(applied2.has(copyId), 'the copy is kept');
  assert.equal(applied2.get(movedId).layer, HIDDEN, 'the line on the hidden layer is kept');
  assert.ok(
    ![...applied2.values()].some((o) => o.tags['vide-key'] === deletedKey),
    'the deleted mark is not made again',
  );
  const mine = tagged(applied2);
  assert.equal(
    mine.length,
    total - 1 + 1,
    'no duplicates: every key once, plus the copy, minus the deleted mark',
  );
  const perKey = new Map();
  for (const o of mine) perKey.set(o.tags['vide-key'], (perKey.get(o.tags['vide-key']) ?? 0) + 1);
  assert.deepEqual(
    [...perKey].filter(([, n]) => n > 1).map(([key]) => key),
    [copiedKey],
    'only the copied key appears twice',
  );
  assert.equal(
    tagged(applied2, summary1.runId).length,
    3,
    'edited, copy and moved keep the first run tag',
  );
  assert.equal(applied2.get(outline.nativeId).hash, outline.hash);
  assert.equal(applied2.get(box.nativeId).hash, box.hash);
  result.secondBake = summary2.totals;

  // 8. [되돌리기] of the second bake: the host undoes its records; the document is as before it.
  const record2 = (await records()).find((r) => r.runId === summary2.runId && r.undoable);
  assert.ok(record2, 'the last bake can be undone');
  const undone = await call('POST', `${base}/${iid}/bakes/${record2.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const afterUndo = await readAll();
  assert.equal(tagged(afterUndo, summary2.runId).length, 0);
  assert.deepEqual(
    tagged(afterUndo)
      .map((o) => `${o.nativeId}:${o.hash}`)
      .sort(),
    tagged(edited)
      .map((o) => `${o.nativeId}:${o.hash}`)
      .sort(),
    'the objects of the first bake are back with the same GUIDs and fingerprints',
  );
  assert.equal(afterUndo.get(box.nativeId).hash, box.hash);
  assert.ok((await records()).filter((r) => r.runId === summary2.runId).every((r) => r.undone));
  await assert.rejects(call('POST', `${base}/${iid}/bakes/${record2.id}/undo`), {
    code: 'BAKE_UNDO_UNAVAILABLE',
  });
  result.undone = true;

  // 9. A hidden output layer blocks before anything runs.
  const setVisible = (path, visible) =>
    action(
      `found=[l for l in doc.Layers if not l.IsDeleted and l.FullPath==${py(path)}]
assert found, str([l.FullPath for l in doc.Layers])
found[0].IsVisible=${visible ? 'True' : 'False'}
result=bool(found[0].IsVisible)`,
    );
  assert.equal(await setVisible(LAYERS.lines, false), false);
  const blocked = await call('POST', `${base}/${iid}/bake`, { bake: ['lines'] });
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data).slice(0, 400));
  assert.deepEqual(blocked.data.blocked, ['hidden-target']);
  assert.deepEqual(blocked.data.hints, ['Rhino에서 레이어를 켠 뒤 다시 누르세요']);
  assert.equal(await setVisible(LAYERS.lines, true), true);
  assert.equal(tagged(await readAll()).length, tagged(afterUndo).length, 'nothing was written');

  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  // The engine first (child runners, the request executor, the database), then the Rhino this
  // test launched; the user's own Rhino windows are never touched.
  try {
    await engine?.execution.close();
    if (engine) await closeJigRuntime(engine.workspace);
    engine?.store.close();
  } catch (error) {
    console.error('engine close: ' + String(error));
  }
  await worker?.stop();
  await host?.stop();
  const restored = await restoreInstalledPlugin();
  console.log('installed plugin registration: ' + JSON.stringify(restored));
}
