// SPIKE T-250 (PLAN-49): surface read and panel make paths for 패널링, measured in VIDE-owned hidden
// Rhino 8 processes on synthetic surfaces under .vide/spikes/paneling/ (never a user document,
// never the user's Rhino). See docs/tdd/SPIKE-2026-10-08-paneling.md.
//
//   node tools/spikes/2026-10-08-paneling/run.mjs
//   VIDE_TEST_RHINO_PLUGIN=<built VIDE.Worker.rhp>   plugin to load (default: sdkOptions)
//   SPIKE_SKIP=worker,gh,solids5000                   skip parts
//
// Paths: (a) the attached document runs the official read template through direct-execute,
// (b) a hidden worker opens a work copy of the file and runs the same template, (c) GH lite.
// Writes .vide/spikes/paneling/<run>/result.json and prints it. Only this script's Rhino processes
// are stopped; afterwards the installed engine's connector status is read (and the plugin
// re-installed only when it is not current and no Rhino runs).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { SdkExecution } from '../../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../../src/server/sdk-options.ts';
import { renderChunks } from '../../../src/jigs/bake/templates.ts';
import { splitMesh } from '../../../src/jigs/bake/data-block.ts';
import { surfaceSampleSchema } from '../../../src/contracts/paneling.ts';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../../hosts/rhino/worker-client.ts';
import { installedConnectors } from './connectors.mjs';

const HERE = import.meta.dirname;
const SKIP = new Set((process.env.SPIKE_SKIP ?? '').split(',').filter(Boolean));
const probe = sdkOptions('.');
const plugin = process.env.VIDE_TEST_RHINO_PLUGIN
  ? resolve(process.env.VIDE_TEST_RHINO_PLUGIN)
  : probe.plugin;
if (!existsSync(probe.executable) || !existsSync(plugin)) {
  console.log(`skipped: Rhino 8 (${probe.executable}) or the plugin (${plugin}) is not available`);
  process.exit(0);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve('.vide/spikes/paneling', stamp);
await mkdir(directory, { recursive: true });
const options = { ...sdkOptions(directory), plugin };
const connectionDirectory = join(directory, 'rhino-connections');
const result = { directory, plugin, startedAt: new Date().toISOString() };
const ms = (t) => Math.round(performance.now() - t);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── templates and data blocks ──────────────────────────────────────────────────────────────────
const PLACEHOLDER = '{{DATA_BASE64}}';
const hashText = readFileSync(join(HERE, 'face-hash.cs'), 'utf8').replace(/\r\n/g, '\n');
const templateText = (file) =>
  readFileSync(join(HERE, file), 'utf8')
    .replace(/\r\n/g, '\n')
    .replace('//@include face-hash.cs', hashText);
const READ = templateText('read-surface-grid.cs');
const MAKE = templateText('make-panels-uv.cs');
const render = (template, block) => {
  const at = template.indexOf(PLACEHOLDER);
  const code =
    template.slice(0, at) + block.toString('base64') + template.slice(at + PLACEHOLDER.length);
  if (code.length > 65536) throw Error(`BODY_TOO_LARGE ${code.length}`);
  return code;
};
class Writer {
  parts = [];
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.parts.push(b);
    return this;
  }
  f64(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    this.parts.push(b);
    return this;
  }
  str(s) {
    const b = Buffer.from(s, 'utf8');
    this.i32(b.length);
    this.parts.push(b);
    return this;
  }
  get length() {
    return this.parts.reduce((n, b) => n + b.length, 0);
  }
  done() {
    return Buffer.concat(this.parts);
  }
}
const readBody = ({ mode = 0, id, face = 0, n = 128, enc = 1, probes = [] }) => {
  const w = new Writer().str('vide.read.surface-grid@1').i32(mode).str(id).i32(face);
  w.i32(n)
    .i32(n)
    .i32(enc)
    .i32(probes.length / 2);
  for (const p of probes) w.f64(p);
  return render(READ, w.done());
};
const f64s = (value) =>
  typeof value === 'string'
    ? Array.from(new Float64Array(new Uint8Array(Buffer.from(value, 'base64')).buffer))
    : value;

// ── engine-side interpolation of a sample (what T-252 would do) ─────────────────────────────────
function interpolator(face) {
  const { nu, nv, domainU, domainV, closedU, closedV } = face;
  const P = f64s(face.points);
  // A closed direction wraps (the last sample equals the first); an open edge gets a quadratic
  // ghost sample (3·P0 − 3·P1 + P2) so the cubic keeps its order at the boundary.
  const raw = (i, j, c) => P[3 * (j * nu + i) + c];
  const atU = (i, j, c) => {
    if (i >= 0 && i < nu) return raw(i, j, c);
    if (closedU) return raw(((i % (nu - 1)) + (nu - 1)) % (nu - 1), j, c);
    if (i < 0) return 3 * raw(0, j, c) - 3 * raw(1, j, c) + raw(2, j, c);
    return 3 * raw(nu - 1, j, c) - 3 * raw(nu - 2, j, c) + raw(nu - 3, j, c);
  };
  const at = (i, j, c) => {
    if (j >= 0 && j < nv) return atU(i, j, c);
    if (closedV) return atU(i, ((j % (nv - 1)) + (nv - 1)) % (nv - 1), c);
    if (j < 0) return 3 * atU(i, 0, c) - 3 * atU(i, 1, c) + atU(i, 2, c);
    return 3 * atU(i, nv - 1, c) - 3 * atU(i, nv - 2, c) + atU(i, nv - 3, c);
  };
  const cell = (u, v) => {
    const period = domainU[1] - domainU[0];
    if (closedU && u > domainU[1]) u -= period;
    if (closedV && v > domainV[1]) v -= domainV[1] - domainV[0];
    const s = ((u - domainU[0]) / (domainU[1] - domainU[0])) * (nu - 1);
    const t = ((v - domainV[0]) / (domainV[1] - domainV[0])) * (nv - 1);
    const i = Math.min(nu - 2, Math.max(0, Math.floor(s)));
    const j = Math.min(nv - 2, Math.max(0, Math.floor(t)));
    return { i, j, a: s - i, b: t - j };
  };
  const bilinear = (u, v) => {
    const { i, j, a, b } = cell(u, v);
    return [0, 1, 2].map(
      (c) =>
        (1 - a) * (1 - b) * at(i, j, c) +
        a * (1 - b) * at(i + 1, j, c) +
        (1 - a) * b * at(i, j + 1, c) +
        a * b * at(i + 1, j + 1, c),
    );
  };
  // Catmull-Rom (cubic through the samples), clamped at the edges.
  const cr = (p0, p1, p2, p3, x) =>
    0.5 *
    (2 * p1 +
      (-p0 + p2) * x +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * x * x +
      (-p0 + 3 * p1 - 3 * p2 + p3) * x * x * x);
  const bicubic = (u, v) => {
    const { i, j, a, b } = cell(u, v);
    return [0, 1, 2].map((c) => {
      const row = (jj) => cr(at(i - 1, jj, c), at(i, jj, c), at(i + 1, jj, c), at(i + 2, jj, c), a);
      return cr(row(j - 1), row(j), row(j + 1), row(j + 2), b);
    });
  };
  return { bilinear, bicubic };
}
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    maxMm: +(s[s.length - 1] * 1000).toFixed(3),
    p95Mm: +(s[Math.floor(0.95 * (s.length - 1))] * 1000).toFixed(3),
  };
};
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

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

let worker, host, reader;
try {
  // 1. The synthetic document, made and saved by a hidden worker.
  let t = performance.now();
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  result.workerLaunchMs = ms(t);
  const built = await worker.execute(
    randomUUID(),
    0,
    readFileSync(join(HERE, 'surfaces.cs'), 'utf8'),
  );
  assert.equal(built.ok, true, JSON.stringify(built).slice(0, 1500));
  const ids = built.value;
  await worker.stop();
  worker = undefined;
  const attachedDirectory = join(directory, 'attached');
  await mkdir(attachedDirectory);
  const source = join(attachedDirectory, 'paneling-surfaces.3dm');
  await copyFile(built.filename, source);
  result.document = { file: source, ids };
  log('document', JSON.stringify(ids));

  // 2. The document in a VIDE-owned attached Rhino (hidden), with an action loop for checks.
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
    report('ready',dict(ok=True,objects=int(doc.Objects.Count),units=str(doc.ModelUnitSystem),tolerance=doc.ModelAbsoluteTolerance,rhino=str(Rhino.RhinoApp.Version)))
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
  Object.assign(result, {
    rhino: ready.rhino,
    units: ready.units,
    tolerance: ready.tolerance,
    attachedLaunchMs: ms(t),
  });
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
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  assert.equal(catalog.documents.length, 1);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };
  const direct = async (code, label = 'VIDE 패널링 시험') => {
    const started = performance.now();
    const r = await sdk.runDirect(
      target,
      code,
      { confirmed: false, maxDeletes: 50 },
      { requestId: randomUUID(), label },
    );
    return { r, ms: ms(started), chars: JSON.stringify(r).length };
  };
  // Live objects only (doc.Objects.Count still counts objects an undo deleted).
  const objectCount = async () =>
    action(
      'result=len(list(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectEnumeratorSettings())))',
    );
  const undoSerial = async () =>
    action('result=[int(doc.NextUndoRecordSerialNumber), bool(doc.UndoRecordingIsActive)]');

  // 3. (a) attached read template: sizes × encodings × surfaces, schema check at 128².
  const SURFACES = ['hypar', 'strip', 'cylinder', 'sphere', 'plane'];
  const samples = {};
  result.readAttached = [];
  for (const name of SURFACES)
    for (const n of SKIP.has('reads') ? [128] : [64, 128, 256])
      for (const enc of SKIP.has('reads') ? [1] : [0, 1]) {
        const { r, ms: took, chars } = await direct(readBody({ id: ids[name], n, enc }));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 800));
        assert.equal(r.undoId, null, 'a read leaves no undo record of VIDE');
        const v = r.value;
        result.readAttached.push({
          surface: name,
          n,
          enc: enc ? 'base64-f64' : 'json',
          ms: took,
          hostMs: Math.round(v.ms),
          chars,
        });
        if (enc === 1) samples[`${name}:${n}`] = v;
        log('read', name, n, enc, took, 'ms', chars, 'chars');
      }
  // Contract check: the 128² base64 read decoded into `SurfaceSample`.
  result.schema = {};
  for (const name of SURFACES) {
    const v = samples[`${name}:128`];
    const sample = {
      schema: 'vide.paneling.surface@1',
      source: {
        linkId: 'spike-link',
        documentKey: 'spike-doc',
        objectId: ids[name],
        revisionKey: 'r1',
        readAt: new Date().toISOString(),
        toMeters: v.toMeters,
        absTol: v.absTol,
        path: 'attached-template',
      },
      faces: v.faces.map((f) => ({
        ...f,
        points: f64s(f.points),
        normals: f64s(f.normals),
        curvatures: f64s(f.curvatures),
      })),
    };
    const parsed = surfaceSampleSchema.safeParse(sample);
    const face = v.faces[0];
    result.schema[name] = {
      ok: parsed.success,
      issues: parsed.success ? undefined : parsed.error.issues.slice(0, 3),
      closedU: face.closedU,
      closedV: face.closedV,
      singular: face.singular,
      domainU: face.domainU,
      domainV: face.domainV,
      trimLoops: face.trimLoops.length,
      inside: face.inside.reduce((a, b) => a + b, 0) / face.inside.length,
      nonFinite: v.nonFinite,
      hash: face.geometryHash.slice(0, 12),
    };
  }
  // Curvature sign (contract: + = centre on the normal side): sphere centre (110, 0, 0).
  {
    const f = samples['sphere:128'].faces[0];
    const P = f64s(f.points),
      N = f64s(f.normals),
      K = f64s(f.curvatures);
    const k = 64 * f.nu + 64;
    const outward =
      (P[3 * k] - 110) * N[3 * k] + P[3 * k + 1] * N[3 * k + 1] + P[3 * k + 2] * N[3 * k + 2] > 0;
    result.curvatureSign = {
      sphereNormalOutward: outward,
      k1: K[2 * k],
      k2: K[2 * k + 1],
      expected: outward ? -0.2 : 0.2,
    };
  }

  // 4. Interpolation error: random parameter points, actual PointAt vs bilinear / bicubic.
  result.interpolation = {};
  for (const name of SKIP.has('interp') ? [] : SURFACES) {
    const f128 = samples[`${name}:128`].faces[0];
    const [u0, u1] = f128.domainU,
      [v0, v1] = f128.domainV;
    const probes = [];
    for (let k = 0; k < 1500; k++) probes.push(u0 + rnd() * (u1 - u0), v0 + rnd() * (v1 - v0));
    const { r } = await direct(readBody({ mode: 1, id: ids[name], probes }));
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
    const actual = f64s(r.value.points);
    result.interpolation[name] = {};
    for (const n of [64, 128, 256]) {
      const ip = interpolator(samples[`${name}:${n}`].faces[0]);
      const lin = [],
        cub = [];
      for (let k = 0; k < probes.length / 2; k++) {
        const q = [actual[3 * k], actual[3 * k + 1], actual[3 * k + 2]];
        lin.push(dist(ip.bilinear(probes[2 * k], probes[2 * k + 1]), q));
        cub.push(dist(ip.bicubic(probes[2 * k], probes[2 * k + 1]), q));
      }
      result.interpolation[name][n] = { bilinear: stats(lin), bicubic: stats(cub) };
    }
    log('interp', name, JSON.stringify(result.interpolation[name]));
  }

  // 5. Undo: does a read leave a record? A person's edit, then a read, then one Undo.
  if (!SKIP.has('undo')) {
    const before = await undoSerial();
    const point = await action(
      `sn=doc.BeginUndoRecord('사람 편집')\npid=doc.Objects.AddPoint(Rhino.Geometry.Point3d(0,0,-10))\ndoc.EndUndoRecord(sn)\nresult=str(pid)`,
    );
    const afterEdit = await undoSerial();
    const { r } = await direct(readBody({ id: ids.hypar, n: 128 }));
    const afterRead = await undoSerial();
    const undone = await action(
      `ok=doc.Undo()\nif doc.UndoRecordingIsActive: doc.EndUndoRecord(doc.CurrentUndoRecordSerialNumber)\nresult=[bool(ok), doc.Objects.FindId(System.Guid(${JSON.stringify(point)})) is None]`,
    );
    // Redo after a read: a person undid an edit, VIDE reads, the person redoes.
    const point2 = await action(
      `sn=doc.BeginUndoRecord('사람 편집 2')
pid=doc.Objects.AddPoint(Rhino.Geometry.Point3d(0,0,-11))
doc.EndUndoRecord(sn)
ok=doc.Undo()
if doc.UndoRecordingIsActive: doc.EndUndoRecord(doc.CurrentUndoRecordSerialNumber)
result=str(pid)`,
    );
    await direct(readBody({ id: ids.hypar, n: 64 }));
    const redone = await action(
      `ok=doc.Redo()
if doc.UndoRecordingIsActive: doc.EndUndoRecord(doc.CurrentUndoRecordSerialNumber)
result=[bool(ok), doc.Objects.FindId(System.Guid(${JSON.stringify('PID')})) is not None]`.replace(
        'PID',
        point2,
      ),
    );
    result.undo = {
      before,
      afterEdit,
      afterRead,
      readUndoId: r.undoId,
      undoRemovedTheEdit: undone,
      redoAfterRead: redone,
    };
    log('undo', JSON.stringify(result.undo));
  }

  // 6. Fingerprint: same twice, 1 mm move changes it, undo restores it; the make refuses a changed face.
  const hashOf = async (id) => (await direct(readBody({ mode: 2, id }))).r.value.hashes[0];
  if (!SKIP.has('fingerprint')) {
    const h1 = await hashOf(ids.hypar),
      h2 = await hashOf(ids.hypar);
    await action(
      `sn=doc.BeginUndoRecord('1 mm 옮김')\nnid=doc.Objects.Transform(System.Guid(${JSON.stringify(ids.hypar)}), Rhino.Geometry.Transform.Translation(0,0,0.001), True)\ndoc.EndUndoRecord(sn)\nresult=str(nid)`,
    );
    const h3 = await hashOf(ids.hypar);
    const count = await objectCount();
    const refused = await direct(
      makeBody({
        id: ids.hypar,
        hash: h1,
        kind: 0,
        panels: gridPanels(samples['hypar:128'].faces[0], 4, 4),
      }),
    );
    const countAfter = await objectCount();
    await action(
      `ok=doc.Undo()\nif doc.UndoRecordingIsActive: doc.EndUndoRecord(doc.CurrentUndoRecordSerialNumber)\nresult=bool(ok)`,
    );
    const h4 = await hashOf(ids.hypar);
    result.fingerprint = {
      sameTwice: h1 === h2,
      changedBy1mm: h1 !== h3,
      restoredByUndo: h1 === h4,
      refusedMake: refused.r.value,
      refusedUndoId: refused.r.undoId,
      objectsUnchanged: count === countAfter,
      hashMs: (await direct(readBody({ mode: 2, id: ids.hypar }))).ms,
    };
    log('fingerprint', JSON.stringify(result.fingerprint));
  }

  // 7. Read failures, each with its reason; the document is not touched.
  if (!SKIP.has('failures')) {
    const reason = (r) => (r.ok ? 'ok' : `${r.code}: ${r.message ?? ''}`);
    result.readFailures = {
      mesh: reason((await direct(readBody({ id: ids.mesh }))).r),
      missing: reason((await direct(readBody({ id: randomUUID() }))).r),
      notAnId: reason((await direct(readBody({ id: 'abc' }))).r),
      smallTrimAt8: reason((await direct(readBody({ id: ids.smalltrim, n: 8 }))).r),
      smallTrimAt128: reason((await direct(readBody({ id: ids.smalltrim, n: 128 }))).r),
      tooManyAllFaces: reason((await direct(readBody({ id: ids.hypar, face: -1, n: 257 }))).r),
    };
    await action(
      `doc.ModelUnitSystem=getattr(Rhino.UnitSystem,'None')\nresult=str(doc.ModelUnitSystem)`,
    );
    result.readFailures.noUnits = reason((await direct(readBody({ id: ids.hypar }))).r);
    await action(`doc.ModelUnitSystem=Rhino.UnitSystem.Meters\nresult=str(doc.ModelUnitSystem)`);
    log('failures', JSON.stringify(result.readFailures));
  }

  // 8. Make from parameter coordinates: 1천·5천 panels, open faces and offset solids, then undo.
  const hyparFace = samples['hypar:128'].faces[0];
  const hyparHash = hyparFace.geometryHash;
  result.make = [];
  const makeRun = async (
    label,
    panels,
    kind,
    { thickness = 0.05, budgetMs = 1e9, id = ids.hypar, hash = hyparHash, face = hyparFace } = {},
  ) => {
    const countBefore = await objectCount();
    const bodies = chunkPanels(panels, { id, hash, kind, thickness, budgetMs });
    const started = performance.now();
    const records = [],
      failed = [],
      made = [];
    const corners = [];
    let hostMs = 0;
    for (const body of bodies) {
      const { r } = await direct(body.code, '패널링 시험 만들기');
      if (!r.ok) {
        records.push({ failed: r.code, reverted: r.reverted, message: r.message });
        break;
      }
      if (r.undoId) records.push(r.undoId);
      failed.push(...r.value.failed);
      made.push(...r.value.ids);
      hostMs += r.value.ms;
      const byKey = new Map(body.panels.map((p) => [p.key, p]));
      // corners come in key order, n per panel
      let at = 0;
      for (const key of r.value.keys) {
        const p = byKey.get(key);
        for (const q of p.uv) {
          corners.push({ uv: q, actual: r.value.corners.slice(at, at + 3) });
          at += 3;
        }
      }
      if (r.value.seams?.length) result.seams = r.value.seams;
    }
    const makeMs = ms(started);
    const countMade = await objectCount();
    // Deviation of the engine's interpolation (128² sample) from the real corner points.
    const ip = interpolator(face);
    const real = corners.filter((c) => c.actual.length === 3);
    const dev = real.map((c) => dist(ip.bicubic(c.uv[0], c.uv[1]), c.actual));
    const devLin = real.map((c) => dist(ip.bilinear(c.uv[0], c.uv[1]), c.actual));
    // Undo every record, newest first (VIDE [되돌리기] of a multi-body make).
    const undoStart = performance.now();
    const undoResults = [];
    for (const undoId of records.filter((x) => typeof x === 'string').reverse())
      undoResults.push((await sdk.undoDirect(target, undoId)).ok);
    const undoMs = ms(undoStart);
    const countAfter = await objectCount();
    const row = {
      label,
      kind: kind ? 'solid' : 'face',
      panels: panels.length,
      bodies: bodies.length,
      maxBodyChars: Math.max(...bodies.map((b) => b.code.length)),
      undoRecords: records.filter((x) => typeof x === 'string').length,
      made: made.length,
      failed: failed.length,
      failedReasons: [...new Set(failed.map((f) => f.split(':').slice(-1)[0]))],
      failedSample: failed.slice(0, 3),
      makeMs,
      hostMs: Math.round(hostMs),
      added: countMade - countBefore,
      deviation: real.length ? { bicubic: stats(dev), bilinear: stats(devLin) } : undefined,
      undoMs,
      undoAllOk: undoResults.every(Boolean),
      restored: countAfter === countBefore,
      abort: records.find((x) => typeof x !== 'string'),
      ids: made,
    };
    log('make', JSON.stringify({ ...row, ids: undefined }));
    return row;
  };
  function gridPanels(face, cols, rows, { shiftU = 0, onlyInside = true } = {}) {
    const [u0, u1] = face.domainU,
      [v0, v1] = face.domainV;
    const du = (u1 - u0) / cols,
      dv = (v1 - v0) / rows;
    const inside = face.inside;
    const isIn = (u, v) => {
      const i = Math.round(((u - u0) / (u1 - u0)) * (face.nu - 1));
      const j = Math.round(((v - v0) / (v1 - v0)) * (face.nv - 1));
      return (
        inside[
          Math.min(face.nv - 1, Math.max(0, j)) * face.nu + Math.min(face.nu - 1, Math.max(0, i))
        ] === 1
      );
    };
    const panels = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = u0 + c * du + shiftU,
          b = a + du,
          lo = v0 + r * dv,
          hi = lo + dv;
        const uv = [
          [a, lo],
          [b, lo],
          [b, hi],
          [a, hi],
        ];
        if (onlyInside && !uv.every(([u, v]) => isIn(u > u1 ? u - (u1 - u0) : u, v))) continue;
        panels.push({ key: `P-${r + 1}-${c + 1}`, uv });
      }
    return panels;
  }
  function makeBody({ id, hash, kind, panels, thickness = 0.05, budgetMs = 1e9 }) {
    return chunkPanels(panels, { id, hash, kind, thickness, budgetMs })[0].code;
  }
  function chunkPanels(panels, { id, hash, kind, thickness, budgetMs }) {
    const head = () =>
      new Writer()
        .str('vide.bake.panels-uv@1')
        .str(id)
        .i32(0)
        .str(hash)
        .i32(kind)
        .f64(thickness)
        .f64(budgetMs)
        .str(kind ? '패널링 시험::부재' : '패널링 시험::미리보기');
    const fixed = MAKE.length - PLACEHOLDER.length;
    const bodies = [];
    let pending = [],
      size = head().length + 4;
    const flush = () => {
      const w = head().i32(pending.length);
      for (const p of pending) {
        w.str(p.key).i32(p.uv.length);
        for (const [u, v] of p.uv) w.f64(u).f64(v);
      }
      bodies.push({ code: render(MAKE, w.done()), panels: pending });
      pending = [];
      size = head().length + 4;
    };
    for (const p of panels) {
      const bytes = 4 + Buffer.byteLength(p.key) + 4 + 16 * p.uv.length;
      if (fixed + Math.ceil((size + bytes) / 3) * 4 > 65536) flush();
      pending.push(p);
      size += bytes;
    }
    if (pending.length) flush();
    return bodies;
  }

  const p1000 = gridPanels(hyparFace, 40, 26);
  const p5000 = gridPanels(hyparFace, 100, 51);
  // One deliberately broken panel (outside the face domain) must come back in failed[].
  const broken = {
    key: 'P-999-999',
    uv: [
      [hyparFace.domainU[1] + 5, 0],
      [hyparFace.domainU[1] + 6, 0],
      [hyparFace.domainU[1] + 6, 1],
      [hyparFace.domainU[1] + 5, 1],
    ],
  };
  if (!SKIP.has('make')) {
    result.make.push(await makeRun('faces 1k', [...p1000, broken], 0));
    result.make.push(await makeRun('faces 5k', p5000, 0));
    result.make.push(await makeRun('solids 1k', p1000, 1));
    if (!SKIP.has('solids5000')) result.make.push(await makeRun('solids 5k', p5000, 1));
    // Time budget exceeded in the first body: the attached run undoes what it made.
    result.make.push(await makeRun('budget 15 ms', p5000.slice(0, 600), 1, { budgetMs: 15 }));
  }

  // 9. Seam: a closed cylinder ring shifted half a panel (the last panel runs past the domain end).
  {
    const cyl = samples['cylinder:128'].faces[0];
    const closedDir = cyl.closedU ? 'u' : 'v';
    let ring = gridPanels(cyl, 24, 2, {
      shiftU: (cyl.domainU[1] - cyl.domainU[0]) / 48,
      onlyInside: false,
    });
    if (closedDir === 'v') ring = [];
    const row = await makeRun('cylinder seam', ring, 0, {
      id: ids.cylinder,
      hash: cyl.geometryHash,
      face: cyl,
    });
    // Areas of the made faces must all be equal (the wrapped one too) — measured before undo? (ids)
    result.seam = { closedDir, ...row, ids: undefined };
    const rowSolid = await makeRun('cylinder seam solids', ring, 1, {
      id: ids.cylinder,
      hash: cyl.geometryHash,
      face: cyl,
    });
    result.seamSolids = { ...rowSolid, ids: undefined };
  }
  // Seam areas: make again, measure areas, undo.
  {
    const cyl = samples['cylinder:128'].faces[0];
    const ring = gridPanels(cyl, 24, 1, {
      shiftU: (cyl.domainU[1] - cyl.domainU[0]) / 48,
      onlyInside: false,
    });
    const body = chunkPanels(ring, {
      id: ids.cylinder,
      hash: cyl.geometryHash,
      kind: 0,
      thickness: 0,
      budgetMs: 1e9,
    })[0];
    const { r } = await direct(body.code);
    const areas = await action(
      `out=[]\nfor i in ${JSON.stringify(r.value.ids)}:\n    b=doc.Objects.FindId(System.Guid(i)).Geometry\n    out.append(Rhino.Geometry.AreaMassProperties.Compute(b).Area)\nresult=out`,
    );
    await sdk.undoDirect(target, r.undoId);
    const expected = (2 * Math.PI * 4 * 6) / 24;
    result.seamAreas = {
      min: Math.min(...areas),
      max: Math.max(...areas),
      expected,
      off: r.value.keys
        .map((key, k) => [key, areas[k], ring.find((p) => p.key === key).uv])
        .filter(([, area]) => Math.abs(area - expected) > 1e-3 * expected),
      seams: r.value.seams,
      invalidLog: r.value.invalidLog,
      failed: r.value.failed,
    };
    log('seam areas', JSON.stringify(result.seamAreas));
  }

  // 10. Stage-1 mesh through the existing mesh@1 (vertices from the engine's interpolation).
  if (!SKIP.has('mesh')) {
    const ip = interpolator(hyparFace);
    result.mesh = [];
    for (const [label, panels] of [
      ['mesh 1k', p1000],
      ['mesh 5k', p5000],
    ]) {
      for (const joined of [false, true]) {
        const meshItems = joined
          ? splitMesh(
              {
                key: 'preview',
                attrs: [],
                vertices: panels.flatMap((p) => p.uv.map(([u, v]) => ip.bicubic(u, v))),
                faces: panels.map((_, k) => [4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 3]),
              },
              600,
            )
          : panels.map((p) => ({
              key: p.key,
              attrs: [],
              vertices: p.uv.map(([u, v]) => ip.bicubic(u, v)),
              faces: [[0, 1, 2, 3]],
            }));
        const chunks = renderChunks(
          {
            template: 'vide.bake.mesh@1',
            jigId: 'spike/paneling',
            instanceId: 'spike',
            bakeId: 'preview',
            runId: randomUUID(),
            layerPath: '패널링 시험::메쉬',
            deleteIds: [],
          },
          meshItems,
        );
        const before = await objectCount();
        const started = performance.now();
        const undoIds = [];
        for (const chunk of chunks) {
          const { r } = await direct(chunk.code);
          assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
          undoIds.push(r.undoId);
        }
        const makeMs = ms(started);
        const added = (await objectCount()) - before;
        const u = performance.now();
        for (const id of undoIds.reverse()) await sdk.undoDirect(target, id);
        const row = {
          label: label + (joined ? ' (joined, splitMesh)' : ' (per panel)'),
          items: meshItems.length,
          bodies: chunks.length,
          makeMs,
          added,
          undoMs: ms(u),
          restored: (await objectCount()) === before,
        };
        result.mesh.push(row);
        log('mesh', JSON.stringify(row));
      }
    }
  }

  // 11. (c) GH lite: whether Grasshopper answers in this hidden Rhino and what its outputs carry.
  if (!SKIP.has('gh')) {
    const gh = {};
    const timed = async (name, fn) => {
      const s = performance.now();
      try {
        const v = await fn();
        gh[name] = {
          ms: ms(s),
          ok: v?.ok ?? true,
          chars: JSON.stringify(v).length,
          sample: JSON.stringify(v).slice(0, 300),
        };
        return v;
      } catch (error) {
        gh[name] = { ms: ms(s), error: String(error).slice(0, 300) };
      }
    };
    await timed('stateBefore', () => sdk.grasshopper(target, 'gh-state', {}));
    await timed('open', () => sdk.grasshopper(target, 'gh-open', {}));
    await timed('state', () => sdk.grasshopper(target, 'gh-state', {}));
    await timed('components', () =>
      sdk.grasshopper(target, 'gh-components', { query: 'Divide Surface', limit: 3 }),
    );
    const applied = await timed('apply', () =>
      sdk.grasshopper(target, 'gh-apply', {
        ops: [
          { op: 'add', script: 'python', x: 0, y: 0, ref: 's', nickname: 'grid' },
          {
            op: 'script',
            id: '$s',
            inputs: [{ name: 'oid' }, { name: 'n' }],
            outputs: [{ name: 'pts' }],
            source: `import Rhino, System\nb = Rhino.RhinoDoc.ActiveDoc.Objects.FindId(System.Guid(str(oid))).Geometry\nf = b.Faces[0]\ns = f.UnderlyingSurface()\ndu, dv = f.Domain(0), f.Domain(1)\nk = int(n)\npts = [s.PointAt(du.ParameterAt(i/(k-1.0)), dv.ParameterAt(j/(k-1.0))) for j in range(k) for i in range(k)]\n`,
          },
          { op: 'set', id: '$s', param: 'oid', data: [ids.hypar] },
          { op: 'set', id: '$s', param: 'n', data: [128] },
        ],
      }),
    );
    const scriptId = applied?.refs?.s ?? applied?.created?.s;
    if (scriptId) {
      const out = await timed('outputs', () =>
        sdk.grasshopper(target, 'gh-outputs', {
          params: [{ id: scriptId, param: 'pts' }],
          items: 500,
        }),
      );
      const first = out?.outputs?.[0];
      gh.outputsShape = {
        count: first?.count,
        type: first?.type,
        items: first?.items?.length,
        firstItems: first?.items?.slice(0, 2),
        nextOffset: first?.nextOffset,
      };
    }
    result.gh = gh;
    log('gh', JSON.stringify(gh).slice(0, 1500));
  }

  // 12. (b) hidden worker: launch on a work copy, run the same read template.
  if (!SKIP.has('worker')) {
    const fileHash = createHash('sha256').update(readFileSync(source)).digest('hex');
    t = performance.now();
    reader = await launchRhinoWorker({
      ...options,
      directory: join(directory, 'reader'),
      source: { filename: source, fileHash },
    });
    result.workerReader = { launchMs: ms(t), reads: [] };
    let revision = 0;
    for (const n of [64, 128, 256])
      for (const enc of [0, 1]) {
        const s = performance.now();
        const r = await reader.execute(randomUUID(), revision, readBody({ id: ids.hypar, n, enc }));
        assert.equal(r.ok, true, JSON.stringify(r).slice(0, 600));
        revision = r.revision;
        result.workerReader.reads.push({
          n,
          enc: enc ? 'base64-f64' : 'json',
          ms: ms(s),
          hostMs: Math.round(r.value.ms),
          chars: JSON.stringify(r).length,
          valueChars: JSON.stringify(r.value).length,
        });
        if (n === 128 && enc === 1)
          result.workerReader.sameHash = r.value.faces[0].geometryHash === hyparHash;
      }
    log('worker', JSON.stringify(result.workerReader));
    await reader.stop();
    reader = undefined;
  }

  result.finishedAt = new Date().toISOString();
  result.passed = true;
} finally {
  await worker?.stop().catch(() => {});
  await reader?.stop().catch(() => {});
  await host?.stop().catch(() => {});
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(result, (k, v) => (k === 'ids' && Array.isArray(v) ? v.length : v), 2),
  );
  // Installed engine connectors: read; re-install only when not current and no Rhino runs.
  try {
    let status = await installedConnectors();
    const rhino = status.connectors?.find((c) => c.id === 'rhino8');
    let running = false;
    try {
      running = /Rhino\.exe/i.test(
        execSync('tasklist /FI "IMAGENAME eq Rhino.exe" /NH', { encoding: 'utf8' }),
      );
    } catch {}
    if (rhino && rhino.plugin !== 'current' && !running)
      status = await installedConnectors({ install: true });
    result.connectors = { ...status, rhinoRunning: running };
    console.log('installed connectors: ' + JSON.stringify(result.connectors));
  } catch (error) {
    console.log('installed connectors: ' + String(error));
  }
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(result, (k, v) => (k === 'ids' && Array.isArray(v) ? v.length : v), 2),
  );
  console.log('result: ' + join(directory, 'result.json'));
}
