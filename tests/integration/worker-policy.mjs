// Owned synthetic Rhino only. No subscription calls and no existing document attachment.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
const root = resolve('.vide/worker-policy', randomUUID());
await mkdir(root, { recursive: true });
let worker;
try {
  worker = await launchRhinoWorker({
    directory: join(root, 'worker'),
    executable: 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
    plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
    bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
  });
  const blocked = [
    'System.IO.File.WriteAllText("vide-policy-must-not-exist.txt","synthetic");',
    'global::System.IO.File.ReadAllText("missing");',
    'System.Diagnostics.Process.Start("cmd.exe");',
    'new System.Net.WebClient();',
    'System.Environment.GetEnvironmentVariable("PATH");',
    'var type=doc.GetType();',
    'var type=typeof(RhinoDoc);',
    'dynamic value=doc; value.Dispose();',
    'Rhino.RhinoApp.RunScript("_New",false);',
    'var other=RhinoDoc.ActiveDoc;',
    'doc.Write3dmFile("forbidden.3dm",new Rhino.FileIO.FileWriteOptions());',
    'return null; } static TaskCode() {} public static object Other() {',
  ];
  for (const code of blocked) {
    const result = await worker.execute(randomUUID(), 0, code);
    assert.equal(result.code, 'CODE_POLICY_REJECTED', JSON.stringify(result));
    assert.equal((await worker.query()).objects.length, 0);
  }
  await assert.rejects(access('vide-policy-must-not-exist.txt'));
  const compiled = await worker.execute(randomUUID(), 0, 'this is not valid C#;');
  assert.equal(compiled.code, 'COMPILE_ERROR');
  const safe = await worker.execute(
    randomUUID(),
    0,
    'var note="System.IO.File is harmless text"; doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4))); return new { count=doc.Objects.Count, note };',
  );
  assert.equal(safe.ok, true, JSON.stringify(safe));
  assert.equal((await worker.exportModel()).scene[0].volume, 24);
  const operationId = randomUUID(),
    code =
      'doc.Objects.AddPoint(new Point3d(10,0,0)); throw new InvalidOperationException("SYNTHETIC_RUNTIME_CAUSE");';
  const failed = await worker.execute(operationId, 1, code);
  assert.equal(failed.code, 'HOST_RESULT_UNKNOWN');
  assert.equal(failed.exceptionType, 'System.InvalidOperationException');
  assert.ok(failed.diagnosticId);
  assert.ok(
    (
      await readFile(join(root, 'worker', failed.diagnosticId + '.diagnostic.txt'), 'utf8')
    ).includes('SYNTHETIC_RUNTIME_CAUSE'),
  );
  const again = await worker.execute(operationId, 1, code);
  assert.deepEqual(again, failed);
  const snapshot = await worker.query();
  assert.equal(snapshot.uncertain, true);
  assert.equal(snapshot.objects.length, 2);
  const refused = await worker.execute(
    randomUUID(),
    1,
    'doc.Objects.AddPoint(new Point3d(20,0,0));',
  );
  assert.equal(refused.code, 'HOST_RESULT_UNKNOWN');
  assert.equal((await worker.query()).objects.length, 2);
  console.log(
    JSON.stringify({
      passed: true,
      blocked: blocked.length,
      normalSdk: true,
      compileCorrection: true,
      localDiagnostic: true,
      noReplay: true,
      directory: root,
    }),
  );
} catch (error) {
  await writeFile(
    join(root, 'failure.json'),
    JSON.stringify({ message: error.message, stack: error.stack }),
  );
  throw error;
} finally {
  if (worker) await worker.stop();
}
