import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('rhino-complex-brep');
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
let worker, editor;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'seed') });
  const makeSlabs = (width, replace) => `
    var faces = new int[3];
    for(var level=0;level<3;level++) {
      double z=level*3.0;
      using var outer=new Box(new BoundingBox(0,0,z,20,12,z+0.3)).ToBrep();
      using var opening=new Box(new BoundingBox(8,4,z-1,8+${width},8,z+1)).ToBrep();
      var result=Brep.CreateBooleanDifference(outer,opening,doc.ModelAbsoluteTolerance);
      if(result==null||result.Length!=1||!result[0].IsSolid)throw new Exception("Invalid slab");
      using var slab=result[0]; faces[level]=slab.Faces.Count;
      var name="Slab-"+level;
      ${
        replace
          ? `var obj=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(o=>o.Name==name);
      var id=obj.Id;var attributes=obj.Attributes.Duplicate();attributes.SetUserString("OpeningWidth","${width}");
      if(!doc.Objects.ModifyAttributes(id,attributes,true))throw new Exception("Metadata failed");
      if(!doc.Objects.Replace(id,slab))throw new Exception("Replace failed");
      if(doc.Objects.FindId(id).Attributes.GetUserString("OpeningWidth")!="${width}")throw new Exception("Metadata readback failed");`
          : `var attributes=new Rhino.DocObjects.ObjectAttributes();attributes.Name=name;
      attributes.SetUserString("Level",level.ToString());attributes.SetUserString("Role","Slab");attributes.SetUserString("OpeningWidth","${width}");
      if(doc.Objects.AddBrep(slab,attributes)==Guid.Empty)throw new Exception("Add failed");`
      }
    }
    ${replace ? '' : 'doc.Objects.AddPoint(new Point3d(30,20,0));'}
    return new { faces };`;
  const seed = await worker.execute(randomUUID(), 0, makeSlabs(4, false));
  assert.equal(seed.ok, true, JSON.stringify(seed));
  assert.ok(seed.value.faces.every((n) => n >= 10));
  const initial = await worker.exportModel();
  const slabs = initial.objects.filter((o) => o.name.startsWith('Slab-'));
  assert.equal(slabs.length, 3);
  const unrelated = initial.scene.find((o) => !slabs.some((s) => s.id === o.id));
  for (const slab of slabs)
    assert.ok(Math.abs(initial.scene.find((o) => o.id === slab.id).volume - 67.2) < 1e-7);
  await worker.stop();
  worker = undefined;
  editor = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'editor'),
    mode: 'editor',
    visible: false,
    source: seed,
  });
  const basis = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'candidate'),
    source: basis,
  });
  const receipt = await worker.execute(randomUUID(), 0, makeSlabs(6, true));
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.ok(receipt.value.faces.every((n) => n >= 10));
  assert.equal(receipt.changes.modified.length, 3);
  const candidate = await worker.exportModel();
  for (const slab of slabs) {
    const row = candidate.scene.find((o) => o.id === slab.id);
    assert.equal(row.nativeId, slab.nativeId);
    assert.ok(Math.abs(row.volume - 64.8) < 1e-7);
    const attributes = Object.fromEntries(
      row.attributes64.map(([k, v]) => [
        Buffer.from(k, 'base64').toString(),
        Buffer.from(v, 'base64').toString(),
      ]),
    );
    assert.equal(attributes.Role, 'Slab');
    assert.equal(attributes.OpeningWidth, '6');
    assert.equal(attributes.Level, slab.name.slice(-1));
  }
  assert.deepEqual(
    candidate.scene.find((o) => o.id === unrelated.id),
    unrelated,
  );
  await worker.stop();
  worker = undefined;
  const preview = await editor.previewEditorApplication(
    receipt.filename,
    receipt.fileHash,
    basis.documentHash,
  );
  assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 3, 0]);
  const applied = await editor.applyEditorCandidate(
    randomUUID(),
    receipt.filename,
    receipt.fileHash,
    basis.documentHash,
  );
  assert.equal(applied.state, 'succeeded');
  const captured = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'reopen'),
    source: captured,
  });
  const restored = await worker.exportModel();
  assert.deepEqual(restored.scene, candidate.scene);
  assert.equal(
    createHash('sha256')
      .update(await readFile(seed.filename))
      .digest('hex'),
    seed.fileHash,
  );
  const evidence = {
    passed: true,
    directory,
    slabs: 3,
    volumeBefore: 201.6,
    volumeAfter: 194.4,
    solidBooleanOpenings: true,
    nativeIdsAndAttributesPreserved: true,
    unrelatedObjectUnchanged: true,
    fixedApplyAndReopen: true,
    sourceUnchanged: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await worker?.stop();
  await editor?.stop();
}
