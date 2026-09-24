import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';

const directory = resolve('.vide/editor-types', randomUUID());
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
let worker, editor;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'initial') });
  const initial = await worker.execute(
    randomUUID(),
    0,
    `
    foreach(var id in new[]{"curve","extrusion","mesh","point"}) {
      var a=new Rhino.DocObjects.ObjectAttributes();a.Name=id;a.SetUserString("vide-id",id);
      a.SetUserString("Level","L01");
      if(id=="curve")doc.Objects.AddCurve(new LineCurve(new Point3d(0,0,0),new Point3d(3,4,0)),a);
      if(id=="extrusion")doc.Objects.AddExtrusion(Extrusion.Create(new Rectangle3d(Plane.WorldXY,2,3).ToNurbsCurve(),4,true),a);
      if(id=="mesh")doc.Objects.AddMesh(Mesh.CreateFromBox(new Box(new BoundingBox(0,0,0,2,3,4)),1,1,1),a);
      if(id=="point")doc.Objects.AddPoint(new Point3d(1,2,3),a);
    }
  `,
  );
  assert.equal(initial.ok, true, JSON.stringify(initial));
  const baseline = await worker.exportModel();
  await worker.stop();
  worker = undefined;
  editor = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'editor'),
    mode: 'editor',
    visible: true,
    source: { filename: initial.filename, fileHash: initial.fileHash },
  });
  const captured = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'candidate'),
    source: { filename: captured.filename, fileHash: captured.fileHash },
  });
  const candidate = await worker.execute(
    randomUUID(),
    0,
    `
    foreach(var obj in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray()) {
      var a=obj.Attributes.Duplicate();a.SetUserString("Level","L02");
      if(!doc.Objects.ModifyAttributes(obj.Id,a,true))throw new Exception("Attributes failed");
      if(doc.Objects.Transform(obj.Id,Transform.Translation(10,20,30),true)==Guid.Empty)throw new Exception("Move failed");
    }
  `,
  );
  assert.equal(candidate.ok, true, JSON.stringify(candidate));
  await worker.stop();
  worker = undefined;
  const preview = await editor.previewEditorApplication(
    candidate.filename,
    candidate.fileHash,
    captured.documentHash,
  );
  assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 4, 0]);
  const applied = await editor.applyEditorCandidate(
    randomUUID(),
    candidate.filename,
    candidate.fileHash,
    captured.documentHash,
  );
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
  const final = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'verify'),
    source: { filename: final.filename, fileHash: final.fileHash },
  });
  const actual = await worker.exportModel();
  assert.equal(actual.scene.length, 4);
  for (const before of baseline.scene) {
    const after = actual.scene.find((row) => row.id === before.id);
    assert.equal(after.nativeId, before.nativeId);
    assert.equal(after.nativeType, before.nativeType);
    for (const key of ['area', 'volume', 'length']) {
      if (before[key] === null) assert.equal(after[key], null);
      else assert.ok(Math.abs(after[key] - before[key]) < 1e-7, `${before.id} ${key}`);
    }
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(after.origin[i] - before.origin[i] - [10, 20, 30][i]) < 1e-7);
    assert.ok(
      after.attributes64.some(
        ([key, value]) =>
          Buffer.from(key, 'base64').toString() === 'Level' &&
          Buffer.from(value, 'base64').toString() === 'L02',
      ),
    );
  }
  const evidence = {
    passed: true,
    directory,
    types: actual.scene.map((row) => row.nativeType),
    identityPreserved: true,
    attributesPreserved: true,
    quantitiesPreserved: true,
    translationVerified: true,
    independentReadback: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (worker) await worker.stop();
  if (editor) await editor.stop();
}
