import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchZwcadWorker } from '../../hosts/zwcad/worker-client.ts';
import { ZwcadEditors } from '../../hosts/zwcad/editor-sessions.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('zwcad-linear-entities');
await mkdir(directory, { recursive: true });
const workers = [];
const launch = async (name, source, editor = false) => {
  const worker = await launchZwcadWorker({
    directory: join(directory, name),
    source,
    editor,
    visible: false,
  });
  workers.push(worker);
  return worker;
};
const setup =
  'var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);';
try {
  const seed = await launch('seed');
  const initial = await seed.execute(
    randomUUID(),
    0,
    setup +
      `
    var line=new Line(new Point3d(0,0,0),new Point3d(3000,4000,0));line.ColorIndex=1;ms.AppendEntity(line);tr.AddNewlyCreatedDBObject(line,true);
    var second=new Line(new Point3d(10000,0,0),new Point3d(10000,10000,0));ms.AppendEntity(second);tr.AddNewlyCreatedDBObject(second,true);
    var poly=new Polyline();poly.AddVertexAt(0,new Point2d(20000,0),0,0,0);poly.AddVertexAt(1,new Point2d(22000,0),0,0,0);poly.AddVertexAt(2,new Point2d(22000,3000),0,0,0);poly.AddVertexAt(3,new Point2d(20000,3000),0,0,0);poly.Closed=true;ms.AppendEntity(poly);tr.AddNewlyCreatedDBObject(poly,true);`,
  );
  assert.equal(initial.ok, true, JSON.stringify(initial).slice(0, 400));
  assert.equal(initial.model.dwgEditMode, 'linear-entities-v1');
  assert.equal(initial.model.objects.length, 3);
  const originalLine = initial.model.scene.find(
    (row) => row.nativeType === 'Line' && row.length === 5,
  );
  const originalPolyline = initial.model.scene.find((row) => row.nativeType === 'LWPolyline');
  assert.ok(originalLine);
  assert.equal(originalLine.area, null);
  assert.equal(originalPolyline.area, 6);
  await seed.stop();
  const editor = await launch('editor', initial, true);
  await writeFile(directory + '.editors.json', JSON.stringify([editor.connection]));
  const editors = new ZwcadEditors(directory);
  const [document] = await editors.list();
  const target = { instance: document.instance, documentId: 1 };
  const capture = await editors.capture(target);
  const candidateWorker = await launch('candidate', capture);
  const modified = await candidateWorker.execute(
    randomUUID(),
    0,
    setup +
      `
    foreach(var id in ms.Cast<ObjectId>().ToArray()) {
      var e=tr.GetObject(id,OpenMode.ForWrite);
      if(e is Line){var l=(Line)e;if(l.Length==5000){l.EndPoint=new Point3d(6000,8000,0);l.ColorIndex=2;}else l.Erase();}
    }
    var added=new Line(new Point3d(0,0,0),new Point3d(1000,0,0));ms.AppendEntity(added);tr.AddNewlyCreatedDBObject(added,true);`,
  );
  assert.equal(modified.ok, true, JSON.stringify(modified).slice(0, 400));
  const candidate = { ...modified, sourceDocument: capture.sourceDocument };
  const effect = await editors.preview(target, candidate);
  assert.deepEqual([effect.added, effect.updated, effect.removed], [1, 1, 1]);
  const operation = randomUUID();
  const applyTarget = {
    ...target,
    documentHash: capture.sourceDocument.documentHash,
    candidateHash: modified.fileHash,
  };
  const applied = await editors.apply(operation, candidate, applyTarget);
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
  assert.deepEqual(await editors.apply(operation, candidate, applyTarget), applied);
  const captured = await editors.capture(target);
  assert.equal(captured.objects.length, 3);
  const line = captured.scene.find((row) => row.nativeId === originalLine.nativeId);
  assert.equal(line.nativeType, 'Line');
  assert.equal(line.length, 10);
  assert.equal(line.color, 2);
  assert.deepEqual(
    captured.scene.find((row) => row.nativeId === originalPolyline.nativeId),
    originalPolyline,
  );
  await assert.rejects(() => editors.preview(target, candidate), { code: 'STALE_REFERENCE' });
  const reopened = await launch('reopen', captured);
  const query = await reopened.query();
  assert.deepEqual(query.model.objects, captured.objects);
  assert.deepEqual(query.model.scene, captured.scene);
  const rejectedWorker = await launch('unsupported', initial);
  const rejected = await rejectedWorker.execute(
    randomUUID(),
    0,
    setup +
      'var l=ms.Cast<ObjectId>().Select(id=>tr.GetObject(id,OpenMode.ForWrite)).OfType<Line>().First();l.EndPoint=new Point3d(1,2,3);',
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'HOST_RESULT_UNKNOWN');
  assert.equal(
    createHash('sha256')
      .update(await readFile(initial.filename))
      .digest('hex'),
    initial.fileHash,
  );
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        effect,
        originalHandle: originalLine.nativeId,
        handlePreserved: true,
        polylinePreserved: true,
        nonPlanarRejected: true,
        captured,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      directory,
      passed: true,
      handlePreserved: true,
      polylinePreserved: true,
      nonPlanarRejected: true,
    }),
  );
} finally {
  for (const worker of workers.reverse()) await worker.stop();
}
