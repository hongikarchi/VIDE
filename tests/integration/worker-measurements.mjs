import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { runDirectory } from './run-directory.mjs';
const directory = runDirectory('worker-measurements');
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
let worker;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'baseline') });
  const initial = await worker.execute(
    randomUUID(),
    0,
    `foreach(var name in new[]{"keep","resize","rename","mesh"}){var a=new Rhino.DocObjects.ObjectAttributes();a.Name=name;a.SetUserString("vide-id",name);var box=new Box(new BoundingBox(0,0,0,2,3,4));if(name=="mesh")doc.Objects.AddMesh(Mesh.CreateFromBox(box,1,1,1),a);else doc.Objects.AddBox(box,a);}`,
  );
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const model = await worker.exportModel();
  assert.equal(model.measurementVersion, 1);
  assert.deepEqual(model.measurementStats, { measuredObjects: 4, reusedObjects: 0 });
  for (const row of model.scene) {
    assert.ok(Math.abs(row.volume - 24) < 1e-8);
    assert.ok(Math.abs(row.area - 52) < 1e-8);
  }
  const measurements = model.scene.map(({ id, area, volume, length }) => ({
    id,
    area,
    volume,
    length,
  }));
  await worker.stop();
  worker = undefined;
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'edit'),
    source: { filename: initial.filename, fileHash: initial.fileHash, measurements },
  });
  const unchanged = await worker.exportModel();
  assert.deepEqual(unchanged.measurementStats, { measuredObjects: 0, reusedObjects: 4 });
  const changed = await worker.execute(
    randomUUID(),
    0,
    `
 var objects=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();
 var renamed=objects.Single(o=>o.Name=="rename");var a=renamed.Attributes.Duplicate();a.Name="New name";doc.Objects.ModifyAttributes(renamed.Id,a,true);
 var resized=objects.Single(o=>o.Name=="resize");using(var replacement=new Box(new BoundingBox(0,0,0,2,3,8)).ToBrep())doc.Objects.Replace(resized.Id,replacement);
 `,
  );
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const edited = await worker.exportModel();
  assert.deepEqual(edited.measurementStats, { measuredObjects: 1, reusedObjects: 3 });
  assert.ok(Math.abs(edited.scene.find((row) => row.id === 'resize').volume - 48) < 1e-8);
  const editedAgain = await worker.exportModel();
  assert.deepEqual(editedAgain.measurementStats, { measuredObjects: 0, reusedObjects: 4 });
  assert.deepEqual(editedAgain.scene, edited.scene);
  const moved = await worker.execute(
    randomUUID(),
    1,
    `
 var objects=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();
 doc.Objects.Transform(objects.Single(o=>o.Name=="keep").Id,Transform.Translation(10,20,30),true);
 doc.Objects.Transform(objects.Single(o=>o.Name=="mesh").Id,Transform.Rotation(Math.PI/3,Vector3d.ZAxis,Point3d.Origin),true);
 `,
  );
  assert.equal(moved.ok, true, JSON.stringify(moved));
  const rigid = await worker.exportModel();
  assert.deepEqual(rigid.measurementStats, { measuredObjects: 1, reusedObjects: 3 });
  assert.equal(moved.changes.modified.find((row) => row.id === 'keep').geometry, true);
  assert.equal(moved.changes.modified.find((row) => row.id === 'mesh').geometry, true);
  assert.ok(Math.abs(rigid.scene.find((row) => row.id === 'keep').volume - 24) < 1e-8);
  const scaled = await worker.execute(
    randomUUID(),
    2,
    `
 var obj=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="keep");
 doc.Objects.Transform(obj.Id,Transform.Scale(Point3d.Origin,2),true);
 `,
  );
  assert.equal(scaled.ok, true, JSON.stringify(scaled));
  const resized = await worker.exportModel();
  assert.deepEqual(resized.measurementStats, { measuredObjects: 1, reusedObjects: 3 });
  assert.ok(Math.abs(resized.scene.find((row) => row.id === 'keep').volume - 192) < 1e-7);
  const deleted = await worker.execute(
    randomUUID(),
    3,
    `
 var obj=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="mesh");
 doc.Objects.Delete(obj.Id,true);
 `,
  );
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  const removed = await worker.exportModel();
  assert.equal(
    removed.scene.some((row) => row.id === 'mesh'),
    false,
  );
  assert.deepEqual(removed.measurementStats, { measuredObjects: 0, reusedObjects: 3 });
  const changedTolerance = await worker.execute(
    randomUUID(),
    4,
    'doc.ModelAbsoluteTolerance = doc.ModelAbsoluteTolerance * 2;',
  );
  assert.equal(changedTolerance.ok, true, JSON.stringify(changedTolerance));
  const toleranceModel = await worker.exportModel();
  assert.deepEqual(toleranceModel.measurementStats, { measuredObjects: 3, reusedObjects: 0 });
  const toleranceAgain = await worker.exportModel();
  assert.deepEqual(toleranceAgain.measurementStats, { measuredObjects: 0, reusedObjects: 3 });
  assert.deepEqual(toleranceAgain.scene, toleranceModel.scene);
  await worker.stop();
  worker = undefined;
  const sdk = new SdkExecution({
    ...options,
    directory: join(directory, 'sync'),
    tools: {},
    origin: () => '',
  });
  const geometryMeasurements = model.scene.map(({ id, geometryHash, area, volume, length }) => ({
    id,
    geometryHash,
    area,
    volume,
    length,
  }));
  const imported = await sdk.importFile(deleted.filename, () => {}, geometryMeasurements);
  assert.deepEqual(imported.measurementStats, { measuredObjects: 2, reusedObjects: 1 });
  assert.equal(
    imported.scene.some((row) => row.id === 'mesh'),
    false,
  );
  assert.ok(Math.abs(imported.scene.find((row) => row.id === 'keep').volume - 192) < 1e-7);
  assert.ok(Math.abs(imported.scene.find((row) => row.id === 'resize').volume - 48) < 1e-8);
  const repeated = await sdk.importFile(
    imported.filename,
    () => {},
    imported.scene.map(({ id, geometryHash, area, volume, length }) => ({
      id,
      geometryHash,
      area,
      volume,
      length,
    })),
  );
  assert.deepEqual(repeated.measurementStats, { measuredObjects: 0, reusedObjects: 3 });
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'added'),
    source: { filename: repeated.filename, fileHash: repeated.fileHash },
  });
  const added = await worker.execute(
    randomUUID(),
    0,
    `
    var a=new Rhino.DocObjects.ObjectAttributes();a.Name="fresh";a.SetUserString("vide-id","fresh");
    doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,1,2,3)),a);
    var old=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name=="New name");
    var attributes=old.Attributes.Duplicate();attributes.SetUserString("Level","L03");
    doc.Objects.ModifyAttributes(old.Id,attributes,true);
  `,
  );
  assert.equal(added.ok, true, JSON.stringify(added));
  await worker.stop();
  worker = undefined;
  const addedImport = await sdk.importFile(
    added.filename,
    () => {},
    repeated.scene.map(({ id, geometryHash, area, volume, length }) => ({
      id,
      geometryHash,
      area,
      volume,
      length,
    })),
  );
  assert.deepEqual(addedImport.measurementStats, { measuredObjects: 1, reusedObjects: 3 });
  assert.ok(Math.abs(addedImport.scene.find((row) => row.id === 'fresh').volume - 6) < 1e-8);
  assert.ok(
    addedImport.scene
      .find((row) => row.id === 'rename')
      .attributes64.some(
        ([key, value]) =>
          Buffer.from(key, 'base64').toString() === 'Level' &&
          Buffer.from(value, 'base64').toString() === 'L03',
      ),
  );
  const evidence = {
    passed: true,
    directory,
    unchangedCalculated: 0,
    changedCalculated: 1,
    repeatedChangedCalculated: 0,
    toleranceInvalidated: true,
    repeatedToleranceCalculated: 0,
    renamedReused: true,
    closedMeshVolume: 24,
    translationReused: true,
    rotationRecomputed: true,
    rigidStillMarkedChanged: true,
    scaleInvalidated: true,
    deletedExcluded: true,
    importedGeometryCacheVerified: true,
    repeatedImportCalculated: 0,
    addedImportCalculated: 1,
    attributeOnlyImportReused: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (worker) await worker.stop();
}
