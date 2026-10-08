// T-208 (PLAN-45) on a synthetic document in VIDE-owned Rhino processes: the site templates made
// directly in the attached document (바로 적용) through the jig route — 300 extruded buildings
// (rectangles, concave L shapes, courtyards with holes, pentagons on a sloping ground),
// a terrain mesh in pieces and envelopes as planar faces (`vide.bake.brep-faces@1`, SPIKE-2026-10-07
// -envelope) — then: closed outward solids with the expected volumes, attributes readable by Sync
// (the display read's user strings), bad envelopes (reversed, open, wrong engine volume) reported in
// failed[] instead of made, one [되돌리기] removing the whole bake, and a later bake that keeps the
// building a person moved. Timings and chunk sizes go to result.json and the console.
// No user document is opened; the test builds its own under .vide/. Without Rhino 8 it is skipped.
// Afterwards only the Rhino processes this test launched are closed and the installed VIDE's plugin
// registration is restored.
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { extractItems, readObjects } from '../../src/jigs/bake/plan.ts';
import { renderChunks } from '../../src/jigs/bake/templates.ts';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';
import { soleDb } from '../fixtures/store.mjs';
import {
  reportRestore,
  restoreInstalledPlugin,
  warnIfRhinoRunning,
} from './installed-connector.mjs';

const probe = sdkOptions('.');
if (!existsSync(probe.executable) || !existsSync(probe.plugin)) {
  console.log(
    `skipped: Rhino 8 (${probe.executable}) or the worker plugin (${probe.plugin}) is not available`,
  );
  process.exit(0);
}

const directory = runDirectory('rhino-site-bake');
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
const ROOT = 'VIDE::대지';
const LAYERS = {
  buildings: `${ROOT}::jig 건물`,
  terrain: `${ROOT}::jig 지형`,
  envelopes: `${ROOT}::jig 외피`,
};
const BAKES = Object.keys(LAYERS);
const BAD_ENVELOPES = ['env:reversed', 'env:open', 'env:volume-off'];

// The synthetic document (metres): the slab outline the example grid reads and an unrelated box.
const build = `
var iOutline = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "슬래브 외곽" });
var iOther = doc.Layers.Add(new Rhino.DocObjects.Layer { Name = "기타" });
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOutline }; doc.Objects.AddPolyline(new[] { new Point3d(0, 0, 0), new Point3d(30, 0, 0), new Point3d(30, 20, 0), new Point3d(0, 20, 0), new Point3d(0, 0, 0) }, a); }
{ var a = new Rhino.DocObjects.ObjectAttributes { LayerIndex = iOther }; doc.Objects.AddBox(new Box(new BoundingBox(-50, -50, 0, -49, -49, 1)), a); }
return doc.Objects.Count;`;

// The site step: synthetic buildings, terrain pieces and envelopes, the same on every run.
const SITE_STEP = `// Synthetic site for the T-208 bake test (no project data): 300 buildings on a 20 × 15 lot grid
// with ground rising 0.5 m per row, a 600 × 600 m terrain in six mesh pieces, and envelopes as
// planar faces wound counter-clockwise seen from outside, plus three that must not be made.
type P = [number, number, number];
const ring2 = (points: [number, number][], dx: number, dy: number, z: number): P[] =>
  points.map(([x, y]) => [x + dx, y + dy, z]);
function prismFaces(outer: P[], holes: P[][], top: (x: number, y: number) => number): P[][][] {
  // outer counter-clockwise and holes clockwise seen from above; walls face outward for both.
  const up = (r: P[]): P[] => r.map(([x, y]) => [x, y, top(x, y)]);
  const faces: P[][][] = [[up(outer), ...holes.map(up)], [[...outer].reverse(), ...holes.map((h) => [...h].reverse())]];
  for (const r of [outer, ...holes])
    r.forEach((p, i) => {
      const q = r[(i + 1) % r.length];
      faces.push([[p, q, [q[0], q[1], top(q[0], q[1])], [p[0], p[1], top(p[0], p[1])]]]);
    });
  return faces;
}
/** Signed volume of closed faces (fans from each ring's first point). */
function volumeOf(faces: P[][][]) {
  let v = 0;
  for (const face of faces)
    for (const r of face)
      for (let i = 1; i + 1 < r.length; i++) {
        const [a, b, c] = [r[0], r[i], r[i + 1]];
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      }
  return v;
}
export function site() {
  const shapes: { outline: [number, number][]; hole?: [number, number][] }[] = [
    { outline: [[0, 0], [14, 0], [14, 10], [0, 10]] },
    { outline: [[0, 0], [16, 0], [16, 8], [8, 8], [8, 14], [0, 14]] },
    { outline: [[0, 0], [18, 0], [18, 18], [0, 18]], hole: [[6, 6], [12, 6], [12, 12], [6, 12]] },
    { outline: [[0, 0], [12, 0], [12, 9], [6, 14], [0, 9]] },
  ];
  const uses = ['제2종 근린생활시설', '공동주택 (다세대)', '업무시설'];
  const buildings = Array.from({ length: 300 }, (_, i) => {
    const col = i % 20, row = Math.floor(i / 20), shape = shapes[i % 4];
    const floors = 1 + (i % 15);
    const height = Math.round(floors * 3.3 * 100) / 100;
    const ground = row * 0.5;
    const at = (r: [number, number][]) => r.map(([x, y]) => [x + col * 30, y + row * 30]);
    return {
      key: 'bldg:' + i,
      floors,
      height,
      ground,
      heightSource: i % 3 ? '대장' : '추정',
      use: uses[i % 3],
      source: '합성 자료 (시험용, 2026-10-08)',
      outline: shape.hole ? [at(shape.outline), at(shape.hole)] : at(shape.outline),
    };
  });
  const n = 61, spacing = 10;
  const z = (i: number, j: number) => Math.sin(i / 9) * 4 + j * 0.25;
  const terrain = [];
  for (let t = 0; t < 6; t++) {
    const vertices: P[] = [];
    for (let j = t * 10; j <= t * 10 + 10; j++)
      for (let i = 0; i < n; i++) vertices.push([i * spacing - 20, j * spacing - 20, z(i, j) - 2]);
    const faces: number[][] = [];
    for (let j = 0; j < 10; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        faces.push([a, a + 1, a + n + 1], [a, a + n + 1, a + n]);
      }
    terrain.push({ key: 'terrain:' + (t + 1), vertices, faces, source: '합성 등고선' });
  }
  const lOuter = ring2([[0, 0], [30, 0], [30, 15], [15, 15], [15, 30], [0, 30]], 700, 0, 0);
  const lHole = ring2([[4, 4], [4, 10], [10, 10], [10, 4]], 700, 0, 0);
  const sloped = prismFaces(lOuter, [lHole], (_x, y) => 40 - 0.5 * y);
  const box = prismFaces(ring2([[0, 0], [10, 0], [10, 20], [0, 20]], 750, 0, 0), [], () => 30);
  const envelope = (key: string, kind: string, faces: P[][][], volume: number) => ({
    key, kind, faces, volume, volumeText: volume.toFixed(3), unconfirmed: '0',
  });
  const envelopes = [
    envelope('env:sloped', '최대 외피 (시험)', sloped, volumeOf(sloped)),
    envelope('env:box', '돌출 외피 (시험)', box, volumeOf(box)),
    envelope('env:reversed', '뒤집힌 외피', box.map((f) => f.map((r) => [...r].reverse())), volumeOf(box)),
    envelope('env:open', '열린 외피', box.slice(0, 5), volumeOf(box)),
    envelope('env:volume-off', '부피가 다른 외피', box, volumeOf(box) * 1.001),
  ];
  return { buildings, terrain, envelopes };
}
`;

/** The test jig: the example grid plus the synthetic site step and its three bakes. */
function siteJig(root) {
  const dir = join(root, 'jigs', 'site-bake-test');
  cpSync(resolve('extensions/jigs/example-grid'), dir, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(dir, 'jig.json'), 'utf8'));
  manifest.id = 'project/site-bake-test';
  manifest.capabilities.push({ name: 'host.bake', reason: '건물·지형·외피를 Rhino에 만듭니다' });
  manifest.steps.push({
    id: 'site',
    title: '합성 대지',
    kind: 'code',
    entry: 'steps/site.ts#site',
    needs: ['grid'],
    reads: ['step.grid'],
    writes: 'site',
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
    attrs,
    mode: 'replace-own',
  });
  manifest.bake = [
    decl(
      'buildings',
      'vide.bake.extrude-polygon@1',
      'step.site.buildings',
      'jig 건물',
      { rings: 'outline', bottom: 'ground' },
      {
        'vide-floors': 'floors',
        'vide-height': 'height',
        'vide-height-source': 'heightSource',
        'vide-use': 'use',
        'vide-source': 'source',
      },
    ),
    decl(
      'terrain',
      'vide.bake.mesh@1',
      'step.site.terrain',
      'jig 지형',
      {},
      {
        'vide-source': 'source',
      },
    ),
    decl(
      'envelopes',
      'vide.bake.brep-faces@1',
      'step.site.envelopes',
      'jig 외피',
      {},
      {
        'vide-envelope': 'kind',
        'vide-volume-m3': 'volumeText',
        'vide-unconfirmed': 'unconfirmed',
      },
    ),
  ];
  writeFileSync(join(dir, 'jig.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'steps', 'site.ts'), SITE_STEP);
  return { dir, manifest };
}

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

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i],
      [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
};
const decode = (value) => Buffer.from(value, 'base64').toString('utf8');
const attrsOf = (row) =>
  Object.fromEntries(row.attributes64.map(([k, v]) => [decode(k), decode(v)]));
const ms = (start) => Math.round(performance.now() - start);

let worker, host, engine;
const result = { directory };
try {
  await warnIfRhinoRunning();
  // 1. The synthetic document, saved by a work copy.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 400));
  await worker.stop();
  worker = undefined;

  // 2. The document open in a VIDE-owned attached Rhino, with an action loop for "human" edits.
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'synthetic-site.3dm');
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

  // 3. The engine side: project, link, Sync, the site jig and its instance computed to the end.
  const store = new Store(join(directory, 'workspace.sqlite')),
    workspace = new Workspace(store),
    jigStore = new JigStore(store),
    links = new DocumentLinks(store),
    project = store.createProject('대지 만들기 시험'),
    dataDir = join(directory, 'data');
  await mkdir(dataDir, { recursive: true });
  const link = links.link(project.id, {
    host: 'rhino',
    name: 'synthetic-site.3dm',
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
  const jig = siteJig(directory);
  const packed = await packJig(jig.dir, { dataDir, bundle: false, skipTests: true });
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
    jig: 'project/site-bake-test',
    version: '0.1.0',
    title: '대지 만들기 시험 작업본',
    layerRoot: ROOT,
    params: [],
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
  await call('POST', `${base}/${iid}/steps/confirmInputs/confirm`, {
    inputHash: first.data.steps[1].inputHash,
  });
  const computed = await call('POST', `${base}/${iid}/run`, { mode: 'geometry' });
  assert.ok(
    computed.data.steps.every((s) => ['done', 'confirmed'].includes(s.status)),
    JSON.stringify(computed.data.steps.map((s) => [s.id, s.status, s.error])),
  );
  const site = computed.data.outputs.site;
  const counts = {
    buildings: site.buildings.length,
    terrain: site.terrain.length,
    envelopes: site.envelopes.length,
  };
  const good = counts.buildings + counts.terrain + counts.envelopes - BAD_ENVELOPES.length;
  result.counts = counts;
  assert.equal(counts.buildings, 300);

  // The bodies the route will send, measured with the same functions (worker limit 65,536).
  result.chunkSizes = Object.fromEntries(
    jig.manifest.bake.map((decl) => {
      const { items, problems } = extractItems(decl, site);
      assert.deepEqual(problems, [], decl.id);
      const chunks = renderChunks(
        {
          template: decl.template,
          jigId: 'x',
          instanceId: iid,
          bakeId: decl.id,
          runId: randomUUID(),
          layerPath: `${ROOT}::${decl.layer}`,
          deleteIds: [],
        },
        items,
      );
      return [
        decl.id,
        chunks.map((c) => ({ items: c.keys.length, chars: c.code.length, bytes: c.bytes })),
      ];
    }),
  );

  const readAll = async () => readObjects(await sdk.readLayers(target, { includeHidden: true }));
  const tagged = (objects, run) =>
    [...objects.values()].filter(
      (o) => o.tags['vide-instance'] === iid && (!run || o.tags['vide-run'] === run),
    );
  const records = async () => (await call('GET', `${base}/${iid}/bakes`)).data.bakes;
  const before = await readAll();
  const box = [...before.values()].find((o) => o.layer === '기타');
  const bake = async (label) => {
    const started = performance.now();
    const made = await call('POST', `${base}/${iid}/bake`, { bake: BAKES });
    assert.equal(made.status, 200, JSON.stringify(made.data).slice(0, 800));
    assert.equal(made.data.status, 'applied');
    result[`${label}Ms`] = ms(started);
    return made.data;
  };

  // 4. First bake: everything good is made, the three bad envelopes come back in failed[].
  const bake1 = await bake('firstBake');
  result.chunks = bake1.chunks;
  const summary1 = bake1.bake;
  assert.deepEqual(
    summary1.bakes.flatMap((b) => b.failed).sort(),
    [...BAD_ENVELOPES].sort(),
    'only the bad envelopes failed',
  );
  assert.equal(summary1.totals.added, good, JSON.stringify(summary1.totals));
  assert.equal(summary1.totals.failed, BAD_ENVELOPES.length);
  assert.equal(bake1.baseline, 'recorded');
  assert.equal(bake1.undoIds.length, bake1.chunks, 'one host undo record per body');

  // 5. The document: Sync's display read carries every object with its attributes.
  let started = performance.now();
  const rows = (await sdk.readLayers(target, { includeHidden: true })).scene.filter(
    (row) => attrsOf(row)['vide-run'] === summary1.runId,
  );
  result.readAfterBakeMs = ms(started);
  assert.equal(rows.length, good);
  const layerOf = (row) => decode(row.layer64);
  const byKey = new Map(rows.map((row) => [attrsOf(row)['vide-key'], row]));
  const sample = attrsOf(byKey.get('bldg:2'));
  assert.equal(sample['vide-use'], site.buildings[2].use, 'Korean text with spaces survives');
  assert.equal(sample['vide-height-source'], '대장');
  assert.equal(sample['vide-floors'], '3');
  assert.equal(sample['vide-source'], '합성 자료 (시험용, 2026-10-08)');
  assert.equal(sample['vide-jig'], 'project/site-bake-test');
  assert.equal(attrsOf(byKey.get('env:sloped'))['vide-envelope'], '최대 외피 (시험)');
  assert.equal(attrsOf(byKey.get('terrain:1'))['vide-source'], '합성 등고선');
  for (const key of BAD_ENVELOPES) assert.equal(byKey.has(key), false, `${key} was not made`);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(LAYERS).map(([id, path]) => [
        id,
        rows.filter((row) => layerOf(row) === path).length,
      ]),
    ),
    { buildings: 300, terrain: counts.terrain, envelopes: counts.envelopes - BAD_ENVELOPES.length },
  );
  assert.ok(
    rows.filter((row) => layerOf(row) === LAYERS.terrain).every((row) => row.nativeType === 'Mesh'),
  );

  // 6. Solids, orientation and volumes measured in the attached Rhino.
  const solids = rows.filter((row) => layerOf(row) !== LAYERS.terrain);
  started = performance.now();
  const measured = await action(
    `out={}
for i in ${JSON.stringify(solids.map((row) => row.nativeId))}:
    b=doc.Objects.FindId(System.Guid(i)).Geometry
    m=Rhino.Geometry.VolumeMassProperties.Compute(b,True,False,False,False)
    out[i]=[b.IsSolid,b.IsValid,str(b.SolidOrientation),m.Volume if m else None,b.Faces.Count]
result=out`,
  );
  result.measureMs = ms(started);
  const expected = new Map([
    ...site.buildings.map((b) => {
      const rings = Array.isArray(b.outline[0][0]) ? b.outline : [b.outline];
      const area = ringArea(rings[0]) - rings.slice(1).reduce((s, r) => s + ringArea(r), 0);
      return [b.key, area * Math.fround(b.height)];
    }),
    ...site.envelopes.map((e) => [e.key, e.volume]),
  ]);
  let worst = 0;
  for (const row of solids) {
    const key = attrsOf(row)['vide-key'];
    const [solid, valid, orientation, volume] = measured[row.nativeId];
    assert.ok(solid && valid && orientation === 'Outward', `${key}: ${measured[row.nativeId]}`);
    const relative = Math.abs(volume - expected.get(key)) / expected.get(key);
    worst = Math.max(worst, relative);
    assert.ok(relative <= 1e-5, `${key}: volume ${volume} vs ${expected.get(key)}`);
  }
  result.worstRelativeVolume = worst;
  result.envelopeFaces = measured[byKey.get('env:sloped').nativeId][4];
  assert.equal(
    result.envelopeFaces,
    site.envelopes[0].faces.length,
    'no coplanar merge: one Brep face per engine face',
  );

  // 7. Records name every made object; [되돌리기] removes the whole bake in one action.
  const records1 = (await records()).filter((r) => r.runId === summary1.runId);
  assert.equal(records1.length, BAKES.length);
  assert.ok(records1.every((r) => r.appliedAt && r.undoable));
  started = performance.now();
  const undone = await call('POST', `${base}/${iid}/bakes/${records1[0].id}/undo`);
  result.undoMs = ms(started);
  assert.equal(undone.status, 200, JSON.stringify(undone.data));
  const afterUndo = await readAll();
  assert.equal(tagged(afterUndo).length, 0, 'every object of the bake is gone');
  assert.equal(afterUndo.get(box.nativeId).hash, box.hash, 'other objects are untouched');

  // 8. Bake again, a person moves one building, and the next bake keeps it.
  const bake2 = await bake('secondBake');
  assert.equal(bake2.bake.totals.added, good);
  const records2 = (await records()).filter((r) => r.runId === bake2.bake.runId);
  const buildingsRecord = records2.find((r) => r.bakeId === 'buildings');
  const movedKey = 'bldg:7',
    movedId = buildingsRecord.items[movedKey].nativeId;
  await action(
    `obj=doc.Objects.FindId(System.Guid(${JSON.stringify(movedId)}))
assert doc.Objects.Transform(obj, Rhino.Geometry.Transform.Translation(0,0,1.0), True)`,
  );
  const moved = await readAll();
  const bake3 = await bake('thirdBake');
  const plans = Object.fromEntries(bake3.plans.map((p) => [p.bakeId, p]));
  assert.deepEqual(plans.buildings.preserved, [
    { key: movedKey, nativeId: movedId, reason: 'edited' },
  ]);
  assert.equal(plans.buildings.replaced.length, 299);
  assert.equal(plans.terrain.replaced.length, counts.terrain);
  const after3 = await readAll();
  assert.equal(after3.get(movedId).hash, moved.get(movedId).hash, 'the moved building is kept');
  const perKey = new Map();
  for (const o of tagged(after3))
    perKey.set(o.tags['vide-key'], (perKey.get(o.tags['vide-key']) ?? 0) + 1);
  assert.equal(perKey.size, good, 'every key once');
  assert.ok(
    [...perKey.values()].every((n) => n === 1),
    'no duplicates',
  );
  assert.equal(after3.get(box.nativeId).hash, box.hash);
  result.thirdBake = bake3.bake.totals;

  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  // The engine first, then the Rhino processes this test launched; other Rhino windows are never
  // touched.
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
    reportRestore(await restoreInstalledPlugin());
  }
}
