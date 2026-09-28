// AI edits the drawing open in ZWCAD (connection plugin), as a user would: Sync the open drawing,
// then a subscription AI request in Accept edits mode writes into that drawing directly.
// A synthetic drawing in an agent-launched ZWCAD; never a user drawing.
// Env: VIDE_TEST_AI_PROVIDER (claude-cli|codex-cli, default codex-cli), VIDE_TEST_AI_MODEL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/zwcad-open-ai', randomUUID());
const registry = join(directory, 'zwcad-connections');
await mkdir(registry, { recursive: true });
const config = inspectorOptions(),
  script = join(directory, 'start.scr');
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));
// Test-only actions in the synthetic process (here: the user's UNDO).
const harness = join(directory, 'AttachedActions.dll');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/target:library',
    '/out:' + harness,
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwManaged.dll',
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwDatabaseMgd.dll',
    resolve('tests/integration/fixtures/ZwcadAttachedActions.cs'),
  ],
  { windowsHide: true },
);
await writeFile(
  script,
  [
    '(setvar "INSUNITS" 4)',
    '(entmake (list (cons 0 "LAYER") (cons 100 "AcDbSymbolTableRecord") (cons 100 "AcDbLayerTableRecord") (cons 2 "S-BEAM") (cons 70 0) (cons 62 1)))',
    '(entmake (list (cons 0 "LINE") (cons 8 "S-BEAM") (cons 10 (list 0.0 0.0 0.0)) (cons 11 (list 6000.0 0.0 0.0))))',
    '(entmake (list (cons 0 "LINE") (cons 8 "S-BEAM") (cons 10 (list 0.0 3000.0 0.0)) (cons 11 (list 6000.0 3000.0 0.0))))',
    '(entmake (list (cons 0 "TEXT") (cons 10 (list 0.0 -1500.0 0.0)) (cons 40 250.0) (cons 1 "PLAN")))',
    `(command "_NETLOAD" ${quote(resolve('.vide/build/zwcad-connection/VIDE.Zwcad.Connection.dll'))})`,
    `(command "_NETLOAD" ${quote(harness)})`,
    'VIDETestAttachedActions',
    'VIDECADConnect',
    `(setq videTestFile (open ${quote(join(directory, 'ready.txt'))} "w"))`,
    '(write-line "ready" videTestFile)',
    '(close videTestFile)',
    '',
  ].join('\n'),
);
const owner = await launchOwnedHost({
  executable: config.executable,
  args: ['/b', script],
  visible: false,
  environment: {
    ...process.env,
    VIDE_ZWCAD_CONNECT_DIR: registry,
    VIDE_ATTACHED_TEST_ACTIONS: directory,
  },
});
let app;
const result = { directory };
try {
  for (const end = Date.now() + 120000; ; ) {
    try {
      await readFile(join(directory, 'ready.txt'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > end) throw error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  const adapter = new AttachedZwcadDocuments(registry);
  const [doc] = await adapter.list();
  assert.ok(doc, 'No attached document');
  const target = { instance: doc.instance, documentId: 1 };
  // 1. Plugin contract: paged query, read-only code (discarded), rejected code, a committed write.
  const listed = await adapter.query(target, { offset: 0, limit: 10 });
  assert.equal(listed.total, 3);
  assert.deepEqual(
    listed.layers.map((l) => l.name),
    ['0', 'S-BEAM'],
  );
  const beam = listed.objects.find((o) => o.type === 'Line');
  assert.deepEqual(beam.start, [0, 0, 0]);
  const read = await adapter.run(
    target,
    'var space=(BlockTableRecord)tr.GetObject(((BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead))[BlockTableRecord.ModelSpace],OpenMode.ForWrite); var l=new Line(new Point3d(0,0,0),new Point3d(1,1,0)); space.AppendEntity(l); tr.AddNewlyCreatedDBObject(l,true); return new { count = space.Cast<ObjectId>().Count() };',
    false,
  );
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.count, 4);
  assert.equal(
    (await adapter.query(target, {})).total,
    3,
    'read-only run must not change the drawing',
  );
  const rejected = await adapter.run(target, 'System.IO.File.WriteAllText("x.txt","no");', true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CODE_POLICY_REJECTED');
  result.pluginContract = true;
  // 2. The product path: Sync the open drawing, then a real AI request edits it.
  const options = sdkOptions(directory);
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
  const project = (await call('/projects'))[0] ?? (await call('/projects', { name: 'CAD AI' }));
  const sync = await call(`/projects/${project.id}/capture`, { id: randomUUID(), ...target });
  assert.equal(sync.state, 'succeeded', JSON.stringify(sync.result).slice(0, 400));
  const id = randomUUID();
  const began = Date.now();
  await call(`/projects/${project.id}/requests`, {
    id,
    host: 'zwcad',
    baseRequestId: sync.id,
    body: 'S-BEAM 레이어의 선 두 개 각각의 중점 위 200mm 위치에 "SG1" 텍스트(높이 200)를 새 레이어 S-LABEL에 추가해줘. 기존 선은 건드리지 마.',
    pins: [],
    sketches: [],
    files: [],
    provider: process.env.VIDE_TEST_AI_PROVIDER || 'codex-cli',
    ...(process.env.VIDE_TEST_AI_MODEL ? { model: process.env.VIDE_TEST_AI_MODEL } : {}),
    effort: 'default',
    permission: 'candidate',
  });
  let done;
  for (const end = Date.now() + 600000; Date.now() < end; ) {
    done = await call(`/projects/${project.id}/requests/${id}`);
    if (!['queued', 'running'].includes(done.state)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  result.requestMs = Date.now() - began;
  result.state = done.state;
  result.text = done.result?.text;
  result.changes = done.result?.changes;
  assert.equal(done.state, 'succeeded', JSON.stringify(done.result).slice(0, 1500));
  assert.equal(done.result.appliedDirectly, true);
  const after = await adapter.query(target, { limit: 50 });
  const labels = after.objects.filter((o) => o.layer === 'S-LABEL');
  result.labels = labels.map((o) => ({ text: o.text, position: o.position }));
  assert.equal(labels.length, 2, JSON.stringify(after.objects));
  assert.ok(labels.every((o) => o.text === 'SG1'));
  assert.equal(after.objects.filter((o) => o.layer === 'S-BEAM').length, 2);
  // The request's model is a fresh read of the drawing, shown in the viewport.
  assert.equal(done.result.displayOnly, true);
  assert.equal(done.result.objects.length, 5);
  // Writes run as the VIDEAIRUN command (one UNDO step). UNDO sent to this background (/b) test
  // process does not revert even a LINE command, so UNDO is checked in the real ZWCAD window.
  result.passed = true;
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await app?.close();
  await owner.stop();
}
