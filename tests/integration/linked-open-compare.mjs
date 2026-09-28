// Rhino model and CAD drawing of one project, placed with different origins: one linked request
// (both open documents, Plan mode) finds the relation and the mismatches. Synthetic documents in
// agent-launched Rhino and ZWCAD; never user files.
// Env: VIDE_TEST_AI_PROVIDER (default codex-cli), VIDE_TEST_AI_MODEL, VIDE_TEST_RHINO_PLUGIN.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/linked-open-compare', randomUUID());
await mkdir(join(directory, 'zwcad-connections'), { recursive: true });
const slash = (value) => value.split(String.fromCharCode(92)).join('/');
const quote = (value) => JSON.stringify(slash(value));
const options = sdkOptions(directory);
if (process.env.VIDE_TEST_RHINO_PLUGIN)
  options.plugin = resolve(process.env.VIDE_TEST_RHINO_PLUGIN);
// The same four beam centre lines; Rhino is offset by (125000, 48000, 3200) mm, its third beam
// ends 0.8 mm off, and it has a fourth beam the drawing lacks.
const offset = [125000, 48000, 3200];
const beams = [
  [0, 0, 6000, 0],
  [0, 3000, 6000, 3000],
  [0, 6000, 6000, 6000.8],
  [0, 9000, 6000, 9000],
];
const cadBeams = [
  [0, 0, 6000, 0],
  [0, 3000, 6000, 3000],
  [0, 6000, 6000, 6000],
];
const ready = join(directory, 'rhino-ready.json');
const script = join(directory, 'fixture.py');
await writeFile(
  script,
  `import Rhino, json, traceback
try:
    doc=Rhino.RhinoDoc.ActiveDoc
    doc.ModelUnitSystem=Rhino.UnitSystem.Millimeters
    layer=Rhino.DocObjects.Layer();layer.Name='S-BEAM';index=doc.Layers.Add(layer)
    for i,(x0,y0,x1,y1) in enumerate(${JSON.stringify(beams)}):
        a=Rhino.DocObjects.ObjectAttributes();a.LayerIndex=index;a.Name='B%d'%(i+1)
        doc.Objects.AddLine(Rhino.Geometry.Line(x0+${offset[0]},y0+${offset[1]},${offset[2]},x1+${offset[0]},y1+${offset[1]},${offset[2]}),a)
    Rhino.PlugIns.PlugIn.LoadPlugIn(${JSON.stringify(slash(options.plugin))})
    assert Rhino.RhinoApp.RunScript('_VIDEConnect',False)
    with open(${JSON.stringify(slash(ready))},'w') as f:json.dump(dict(ok=True),f)
except Exception as e:
    with open(${JSON.stringify(slash(ready))},'w') as f:json.dump(dict(ok=False,error=str(e),trace=traceback.format_exc()),f)
`,
);
const cadScript = join(directory, 'start.scr');
await writeFile(
  cadScript,
  [
    '(setvar "INSUNITS" 4)',
    '(entmake (list (cons 0 "LAYER") (cons 100 "AcDbSymbolTableRecord") (cons 100 "AcDbLayerTableRecord") (cons 2 "S-BEAM") (cons 70 0) (cons 62 1)))',
    ...cadBeams.map(
      ([x0, y0, x1, y1]) =>
        `(entmake (list (cons 0 "LINE") (cons 8 "S-BEAM") (cons 10 (list ${x0}.0 ${y0}.0 0.0)) (cons 11 (list ${x1}.0 ${y1}.0 0.0))))`,
    ),
    `(command "_NETLOAD" ${quote(resolve('.vide/build/zwcad-connection/VIDE.Zwcad.Connection.dll'))})`,
    'VIDECADConnect',
    `(setq f (open ${quote(join(directory, 'cad-ready.txt'))} "w"))`,
    '(write-line "r" f)',
    '(close f)',
    '',
  ].join('\n'),
);
const waitFor = async (file) => {
  for (const end = Date.now() + 180000; ; ) {
    try {
      return await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > end) throw error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
};
let rhino, cad, app;
const result = { directory };
try {
  rhino = await launchOwnedHost({
    executable: options.executable,
    environment: { ...process.env, VIDE_CONNECT_DIR: join(directory, 'rhino-connections') },
    visible: true,
    spawnProcess: (file, args, opts) =>
      spawn(file, args, { ...opts, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  cad = await launchOwnedHost({
    executable: inspectorOptions().executable,
    args: ['/b', cadScript],
    visible: false,
    environment: { ...process.env, VIDE_ZWCAD_CONNECT_DIR: join(directory, 'zwcad-connections') },
  });
  const status = JSON.parse(await waitFor(ready));
  assert.equal(status.ok, true, JSON.stringify(status));
  await waitFor(join(directory, 'cad-ready.txt'));
  app = await startServer({ filename: join(directory, 'vide.sqlite'), sdkOptions: options });
  const launch = new URL(app.launchUrl);
  const session = await fetch(launch.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: launch.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: launch.hash.slice(1) }),
  });
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const call = async (path, data) => {
    const response = await fetch(launch.origin + '/api/v1' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Origin: launch.origin, 'Content-Type': 'application/json', Cookie: cookie },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const project = (await call('/projects'))[0] ?? (await call('/projects', { name: 'Linked' }));
  const documents = await call('/host/documents');
  const all = [...(documents.documents ?? []), ...(documents.cad ?? [])];
  const rhinoDoc = all.find((d) => d.host === 'rhino' && d.connection === 'attached-editor');
  const [cadDoc] = await new AttachedZwcadDocuments(join(directory, 'zwcad-connections')).list();
  assert.ok(rhinoDoc && cadDoc, JSON.stringify(documents).slice(0, 600));
  const syncRhino = await call(`/projects/${project.id}/capture`, {
    id: randomUUID(),
    instance: rhinoDoc.instance,
    documentId: rhinoDoc.id,
  });
  const syncCad = await call(`/projects/${project.id}/capture`, {
    id: randomUUID(),
    instance: cadDoc.instance,
    documentId: 1,
  });
  assert.equal(syncRhino.state, 'succeeded', JSON.stringify(syncRhino.result).slice(0, 300));
  assert.equal(syncCad.state, 'succeeded', JSON.stringify(syncCad.result).slice(0, 300));
  const id = randomUUID();
  const began = Date.now();
  await call(`/projects/${project.id}/requests`, {
    id,
    body: 'Rhino 모델과 CAD 도면의 S-BEAM 보 중심선을 비교해줘. 두 파일의 원점이 다르니 먼저 위치 관계(이동량 mm)를 구하고, 서로 안 맞는 보(한쪽에만 있음, 1mm 이하 오차 포함)를 보 이름/핸들과 함께 알려줘. 수정하지는 마.',
    pins: [],
    sketches: [],
    files: [],
    linkedTargets: [
      { host: 'rhino', baseRequestId: syncRhino.id },
      { host: 'zwcad', baseRequestId: syncCad.id },
    ],
    coordinateBasis: 'align-by-features',
    provider: process.env.VIDE_TEST_AI_PROVIDER || 'codex-cli',
    ...(process.env.VIDE_TEST_AI_MODEL ? { model: process.env.VIDE_TEST_AI_MODEL } : {}),
    effort: 'default',
    permission: 'review',
  });
  let done;
  for (const end = Date.now() + 900000; Date.now() < end; ) {
    done = await call(`/projects/${project.id}/requests/${id}`);
    if (!['queued', 'running'].includes(done.state)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  result.requestMs = Date.now() - began;
  result.state = done.state;
  result.text = done.result?.text;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(done.state, 'succeeded', JSON.stringify(done.result).slice(0, 1500));
  const text = done.result.text.replace(/[,\s]/g, '');
  assert.match(text, /125000|125m|125\.0/);
  assert.match(text, /48000|48m|48\.0/);
  assert.match(done.result.text, /B4/);
  assert.match(done.result.text, /0\.8/);
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
} finally {
  await app?.close();
  await cad?.stop();
  await rhino?.stop();
}
