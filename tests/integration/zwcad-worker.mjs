import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { launchZwcadWorker } from '../../hosts/zwcad/worker-client.ts';

const directory = resolve('.vide/zwcad-worker', randomUUID());
await mkdir(directory, { recursive: true });
let worker;
try {
  worker = await launchZwcadWorker({ directory });
  assert.equal((await worker.query()).revision, 0);
  for (const code of [
    'System.IO.File.WriteAllText("should-not-exist", "bad");',
    'tr.Commit();',
    'var x = db.GetType();',
  ]) {
    const rejected = await worker.execute(randomUUID(), 0, code);
    assert.equal(rejected.code, 'CODE_POLICY_REJECTED', JSON.stringify(rejected));
  }
  assert.equal((await worker.execute(randomUUID(), 0, 'bad syntax ;')).code, 'COMPILE_ERROR');
  const code = `var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
var line=new Polyline();
line.AddVertexAt(0,new Point2d(0,0),0,0,0);line.AddVertexAt(1,new Point2d(20000,0),0,0,0);
line.AddVertexAt(2,new Point2d(20000,10000),0,0,0);line.AddVertexAt(3,new Point2d(0,10000),0,0,0);
line.Closed=true;space.AppendEntity(line);tr.AddNewlyCreatedDBObject(line,true);return line.Handle.ToString();`;
  const operationId = randomUUID();
  const created = await worker.execute(operationId, 0, code);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.model.scene[0].area, 200);
  assert.deepEqual(await worker.execute(operationId, 0, code), created);
  assert.equal((await worker.execute(randomUUID(), 0, code)).code, 'STALE_REFERENCE');
  const modified = await worker.execute(
    randomUUID(),
    1,
    `var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);
foreach(ObjectId id in space) {var line=(Polyline)tr.GetObject(id,OpenMode.ForWrite);line.SetPointAt(1,new Point2d(24000,0));line.SetPointAt(2,new Point2d(24000,10000));}`,
  );
  assert.equal(modified.ok, true, JSON.stringify(modified));
  assert.equal(modified.model.scene[0].area, 240);
  assert.equal(modified.model.objects[0].nativeId, created.model.objects[0].nativeId);
  const failedId = randomUUID();
  const failed = await worker.execute(
    failedId,
    2,
    'throw new InvalidOperationException("SYNTHETIC_ZWCAD_FAILURE");',
  );
  assert.equal(failed.code, 'HOST_RESULT_UNKNOWN');
  assert.match(
    await readFile(join(directory, failed.diagnosticId + '.diagnostic.txt'), 'utf8'),
    /SYNTHETIC_ZWCAD_FAILURE/,
  );
  assert.deepEqual(
    await worker.execute(
      failedId,
      2,
      'throw new InvalidOperationException("SYNTHETIC_ZWCAD_FAILURE");',
    ),
    failed,
  );
  assert.equal((await worker.execute(randomUUID(), 2, code)).code, 'HOST_RESULT_UNKNOWN');
  await writeFile(
    join(directory, 'passed.json'),
    JSON.stringify({ passed: true, created, modified }, null, 2),
  );
  console.log(JSON.stringify({ passed: true, directory }));
} catch (error) {
  await writeFile(join(directory, 'failure.txt'), String(error.stack));
  console.error(error);
  process.exitCode = 1;
} finally {
  if (worker) await worker.stop();
}
