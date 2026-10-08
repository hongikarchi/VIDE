// SPIKE 2026-10-08: 중첩 블록(블록 안의 블록)이 Sync에서 박스로 넘어오는지 재현한다.
// 합성 문서만 쓴다(.vide/nested-blocks/<uuid>/). 사용자 문서를 열지 않고, 이 스크립트가 띄운
// 숨은 Rhino 8만 종료한다. 앱과 같은 경로: 연결된 문서(AttachedConnection)의 표시 Sync
// (SdkExecution.syncEditor → displayPage, VGT1)와 Live Sync 변경 페이지(displayChanges).
//
// 실행: node tools/spikes/2026-10-08-nested-blocks/repro.mjs
//   VIDE_TEST_RHINO_PLUGIN=<.rhp>  다른 플러그인 빌드로 실행
//   HEAVY=<n>                      무거운 중첩 사례의 가지 수(기본 8 → 8×8=64 사본)
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';
import { EditorSessions } from '../../../hosts/rhino/editor-sessions.ts';
import { launchRhinoWorker } from '../../../hosts/rhino/worker-client.ts';
import { SdkExecution } from '../../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../../src/server/sdk-options.ts';

const HEAVY = Number(process.env.HEAVY ?? 8);
const directory = resolve('.vide/nested-blocks', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory),
  connectionDirectory = join(directory, 'rhino-connections');
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);

// 합성 문서(미터). 최상위 인스턴스마다 이름이 사례 이름이다.
const build = `
doc.ModelUnitSystem = Rhino.UnitSystem.Meters;
var style = doc.DimStyles.Current;
System.Func<string, GeometryBase[], int> def = (name, geometry) => {
  var attrs = new System.Collections.Generic.List<Rhino.DocObjects.ObjectAttributes>();
  foreach (var g in geometry) attrs.Add(new Rhino.DocObjects.ObjectAttributes());
  var index = doc.InstanceDefinitions.Add(name, "", Point3d.Origin, geometry, attrs);
  if (index < 0) throw new Exception("definition " + name);
  return index;
};
System.Func<int, Transform, GeometryBase> nest = (index, x) => new InstanceReferenceGeometry(doc.InstanceDefinitions[index].Id, x);
System.Action<string, int, Transform> place = (name, index, x) => {
  var a = new Rhino.DocObjects.ObjectAttributes { Name = name };
  if (doc.Objects.AddInstanceObject(index, x, a) == Guid.Empty) throw new Exception("instance " + name);
};
// 정의 안의 여러 형상: Brep, Extrusion, mesh, 곡선, 문자.
System.Func<double, GeometryBase[]> mixed = (s) => new GeometryBase[] {
  new Box(new BoundingBox(0, 0, 0, s, s * 0.5, s * 0.3)).ToBrep(),
  Extrusion.Create(new Circle(new Point3d(s * 1.5, 0, 0), s * 0.2).ToNurbsCurve(), s * 0.8, true),
  Mesh.CreateFromSphere(new Sphere(new Point3d(0, s * 1.5, 0), s * 0.3), 12, 12),
  new LineCurve(new Point3d(0, 0, 0), new Point3d(0, 0, s)),
  new ArcCurve(new Arc(new Point3d(-s, 0, 0), new Point3d(-s, s, 0), new Point3d(-2 * s, s * 0.5, 0))),
  TextEntity.Create("A", new Plane(new Point3d(0, -s, 0), Vector3d.ZAxis), style, false, 0, 0),
};
var turn = Transform.Rotation(30 * Math.PI / 180, Vector3d.ZAxis, Point3d.Origin);
var tilt = Transform.Rotation(15 * Math.PI / 180, Vector3d.XAxis, Point3d.Origin);
var mirror = Transform.Mirror(Plane.WorldYZ);
var scale2 = Transform.Scale(Point3d.Origin, 2);
var stretch = Transform.Scale(Plane.WorldXY, 1, 1.5, 0.5);

// 1. 단순 블록.
var plain = def("plain", mixed(1));
place("case1-plain", plain, Transform.Translation(0, 0, 0));
// 2. 2단 중첩: outer2 = inner2 인스턴스 + 상자 1개.
var inner2 = def("inner2", mixed(1));
var outer2 = def("outer2", new GeometryBase[] {
  nest(inner2, Transform.Translation(0, 0, 0)), nest(inner2, Transform.Translation(4, 0, 0) * turn),
  new Box(new BoundingBox(-1, -1, -0.2, 6, 3, 0)).ToBrep() });
place("case2-nested2", outer2, Transform.Translation(20, 0, 0));
// 3. 3단 중첩, 내부 인스턴스 회전·확대·대칭·비균일 축척, outer3은 중첩 인스턴스만 가진다.
var inner3 = def("inner3", mixed(0.5));
var mid3 = def("mid3", new GeometryBase[] {
  nest(inner3, Transform.Translation(0, 0, 0) * turn), nest(inner3, Transform.Translation(3, 0, 0) * scale2),
  nest(inner3, Transform.Translation(0, 4, 0) * mirror), nest(inner3, Transform.Translation(3, 4, 0) * stretch * tilt) });
var outer3 = def("outer3-only-nested", new GeometryBase[] {
  nest(mid3, Transform.Identity), nest(mid3, Transform.Translation(10, 0, 0) * mirror * turn),
  nest(mid3, Transform.Translation(0, 10, 0) * scale2) });
place("case3-nested3-xforms", outer3, Transform.Translation(40, 0, 0));
place("case3b-nested3-mirrored-instance", outer3, Transform.Translation(80, 0, 0) * mirror * turn);
// 4. 2단 중첩, 바깥 정의가 중첩 인스턴스만 가진다.
var only2 = def("outer2-only-nested", new GeometryBase[] { nest(inner2, Transform.Identity), nest(inner2, Transform.Translation(0, 4, 0) * tilt) });
place("case4-only-nested2", only2, Transform.Translation(0, 40, 0));
// 5. 첫 Sync 뒤 안쪽 정의를 고치는 중첩 블록.
var editInner = def("edit-inner", new GeometryBase[] { new Box(new BoundingBox(0, 0, 0, 1, 1, 1)).ToBrep() });
var editOuter = def("edit-outer", new GeometryBase[] { nest(editInner, Transform.Identity), nest(editInner, Transform.Translation(2, 0, 0)) });
place("case5-edit-inner-after-sync", editOuter, Transform.Translation(20, 40, 0));
// 6. 무거운 중첩: 조밀한 메시(~10k 정점) ${HEAVY}×${HEAVY} 사본을 2단으로 담는다.
var heavyInner = def("heavy-inner", new GeometryBase[] { Mesh.CreateFromSphere(new Sphere(Point3d.Origin, 0.5), 100, 100) });
var heavyRow = new GeometryBase[${HEAVY}];
for (int i = 0; i < ${HEAVY}; i++) heavyRow[i] = nest(heavyInner, Transform.Translation(i * 1.2, 0, 0));
var heavyMid = def("heavy-mid", heavyRow);
var heavyCol = new GeometryBase[${HEAVY}];
for (int j = 0; j < ${HEAVY}; j++) heavyCol[j] = nest(heavyMid, Transform.Translation(0, j * 1.2, 0));
var heavyOuter = def("heavy-outer", heavyCol);
place("case6-heavy-nested", heavyOuter, Transform.Translation(0, 80, 0));
// 6b. 같은 형상량을 중첩 없이: heavy-inner 인스턴스 ${HEAVY}×${HEAVY}개를 최상위에 둔다(대조군).
for (int i = 0; i < ${HEAVY}; i++) for (int j = 0; j < ${HEAVY}; j++)
  place("case6b-flat-" + i + "-" + j, heavyInner, Transform.Translation(40 + i * 1.2, 80 + j * 1.2, 0));
// 7. 가벼운 중첩(2×2 사본, 대조군).
var lightCol = new GeometryBase[] { nest(heavyInner, Transform.Identity), nest(heavyInner, Transform.Translation(1.2, 0, 0)) };
var lightMid = def("light-mid", lightCol);
var lightOuter = def("light-outer", new GeometryBase[] { nest(lightMid, Transform.Identity), nest(lightMid, Transform.Translation(0, 1.2, 0)) });
place("case7-light-nested", lightOuter, Transform.Translation(80, 80, 0));
return doc.Objects.Count;`;

// 첫 Sync 뒤 안쪽 정의(edit-inner)를 구(Brep)로 바꾼다. 연결된 문서에서 Direct 실행으로.
const editInner = `
var index = doc.InstanceDefinitions.Find("edit-inner").Index;
var g = new GeometryBase[] { new Sphere(new Point3d(0.5, 0.5, 0.5), 0.8).ToBrep(), new LineCurve(new Point3d(0, 0, 0), new Point3d(0, 0, 3)) };
var a = new Rhino.DocObjects.ObjectAttributes[] { new Rhino.DocObjects.ObjectAttributes(), new Rhino.DocObjects.ObjectAttributes() };
if (!doc.InstanceDefinitions.ModifyGeometry(index, g, a)) throw new Exception("modify");
output.Append("ok");`;

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
const len = (a) => (a ? a.length : 0);
const nameOf = (row) => Buffer.from(row.name64 ?? '', 'base64').toString('utf8');

/** 사례별 요약: 종류, 블록 여부, 정의 크기, 박스 대체 여부. */
function summarize(model, filter = () => true) {
  const out = {};
  for (const row of model.scene) {
    const name = nameOf(row);
    if (!filter(name)) continue;
    const definition = row.block ? model.definitions?.[row.block.definition] : undefined;
    out[name] = {
      nativeType: row.nativeType,
      valid: row.valid,
      oversized: row.oversized === true,
      block: !!row.block,
      definitionHash: definition?.hash?.slice(0, 12),
      definitionVertices: definition ? len(definition.vertices) / 3 : undefined,
      definitionTriangles: definition ? len(definition.indices) / 3 : undefined,
      definitionSegments: definition ? len(definition.segments) / 6 : undefined,
      definitionTexts: definition ? len(definition.texts) : undefined,
      rowVertices: len(row.vertices) / 3,
      rowTriangles: len(row.indices) / 3,
      // 박스 대체: 블록 없이 정점 8개·삼각형 12개.
      verdict: row.block && definition && (len(definition.vertices) || len(definition.segments))
        ? 'block (correct)'
        : !row.block && len(row.vertices) === 24 && len(row.indices) === 36
          ? 'BOX'
          : 'other',
    };
  }
  return out;
}

let worker, host;
const result = { directory, heavy: HEAVY };
try {
  // 1. 합성 문서를 숨은 작업용 Rhino에서 만든다.
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'create') });
  const receipt = await worker.execute(randomUUID(), 0, build);
  if (!receipt.ok) throw Error('build failed: ' + JSON.stringify(receipt).slice(0, 800));
  await worker.stop();
  worker = undefined;

  // 2. 사본을 숨은 Rhino에서 열고 연결(AttachedConnection) — 앱의 연결 문서와 같은 경로.
  const attached = join(directory, 'attached');
  await mkdir(attached);
  const source = join(attached, 'nested.3dm');
  await copyFile(receipt.filename, source);
  const script = join(attached, 'fixture.py');
  await writeFile(
    script,
    `import Rhino, System, json, os, traceback
folder=${JSON.stringify(attached.replaceAll('\\', '/'))}
plugin=${JSON.stringify(options.plugin.replaceAll('\\', '/'))}
source=${JSON.stringify(source.replaceAll('\\', '/'))}
def report(name,value):
    with open(os.path.join(folder,name+'.tmp'),'w') as f: json.dump(value,f)
    os.rename(os.path.join(folder,name+'.tmp'),os.path.join(folder,name+'.json'))
try:
    opened,already=Rhino.RhinoDoc.Open(source)
    doc=Rhino.RhinoDoc.ActiveDoc
    loaded,pid=Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    assembly=[a for a in System.AppDomain.CurrentDomain.GetAssemblies() if a.GetName().Name=='VIDE.Worker'][0]
    connect=assembly.GetType('Vide.Worker.AttachedConnection').GetMethod('Connect',System.Reflection.BindingFlags.Static|System.Reflection.BindingFlags.NonPublic)
    connect.Invoke(None,System.Array[System.Object]([doc]))
    report('ready',dict(ok=True,pid=System.Diagnostics.Process.GetCurrentProcess().Id,objects=int(doc.Objects.Count)))
except Exception as e: report('ready',dict(ok=False,error=str(e),trace=traceback.format_exc()))
`,
  );
  host = await launchOwnedHost({
    executable: options.executable,
    environment: { ...process.env, VIDE_CONNECT_DIR: connectionDirectory },
    visible: false,
    spawnProcess: (f, a, o) => spawn(f, a, { ...o, windowsVerbatimArguments: true }),
    args: ['/nosplash', '/notemplate', '/scheme=VIDE-Worker-Test', `/runscript="_-RunPythonScript (${script})"`],
  });
  const ready = await wait(async () => JSON.parse(await readFile(join(attached, 'ready.json'), 'utf8')));
  if (!ready.ok) throw Error(JSON.stringify(ready));
  result.rhinoPid = ready.pid;
  const sessions = new EditorSessions({ ...options, connectionDirectory });
  const sdk = new SdkExecution({ ...options, connectionDirectory, tools: {}, origin: () => '' });
  const catalog = await sessions.list(true);
  const target = { instance: catalog.documents[0].instance, documentId: catalog.documents[0].id };

  // 3. 첫 표시 Sync.
  const first = await sdk.syncEditor(target, () => {});
  const notFlat = (name) => !name.startsWith('case6b-flat-') || name === 'case6b-flat-0-0';
  result.firstSync = summarize(first, notFlat);
  const flat = first.scene.filter((row) => nameOf(row).startsWith('case6b-flat-'));
  result.flatControl = {
    count: flat.length,
    boxes: flat.filter((row) => !row.block).length,
    blocks: flat.filter((row) => row.block).length,
  };
  result.coverage = first.displayCoverage;

  // 4. 안쪽 정의를 고친 뒤 Live Sync 변경 페이지와 다시 한 번 전체 Sync.
  const before = await sessions.inspect(target);
  const edit = await sessions.directExecute(target, { requestId: randomUUID(), code: editInner, label: 'nested edit' });
  result.edit = { ok: edit.ok, output: edit.output ?? edit.code };
  const changes = await sessions.changes(target, before.revision ?? 0);
  result.liveChanges = summarize(changes, (name) => name.startsWith('case5'));
  const second = await sdk.syncEditor(target, () => {});
  result.secondSync = summarize(second, (name) => name.startsWith('case5'));
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await worker?.stop();
  await host?.stop();
}
