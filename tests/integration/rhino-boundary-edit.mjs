import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/rhino-boundary-edit', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
let worker, editor;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'seed') });
  const seed = await worker.execute(
    randomUUID(),
    0,
    'var attrs=new Rhino.DocObjects.ObjectAttributes();attrs.Name="Boundary";attrs.SetUserString("Role","Site");doc.Objects.AddCurve(new PolylineCurve(new[]{new Point3d(0,0,0),new Point3d(12,0,0),new Point3d(12,8,0),new Point3d(0,8,0),new Point3d(0,0,0)}),attrs);doc.Objects.AddPoint(new Point3d(30,20,0));',
  );
  assert.equal(seed.ok, true, JSON.stringify(seed));
  const initial = await worker.exportModel();
  const curve = initial.objects.find((o) => o.name === 'Boundary');
  const originalScene = initial.scene.find((o) => o.id === curve.id);
  assert.ok(Math.abs(originalScene.area - 96) < 1e-8);
  const other = initial.scene.find((o) => o.id !== curve.id);
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
  const receipt = await worker.execute(
    randomUUID(),
    0,
    `var obj=doc.Objects.FindId(new Guid("${curve.nativeId}"));var c=obj.Geometry as PolylineCurve;if(c==null)throw new Exception("Wrong type");Polyline p;if(!c.TryGetPolyline(out p))throw new Exception("Not a polyline");p[2]=new Point3d(p[2].X,10,p[2].Z);p[3]=new Point3d(p[3].X,10,p[3].Z);if(!doc.Objects.Replace(obj.Id,new PolylineCurve(p)))throw new Exception("Replace failed");return new { role=doc.Objects.FindId(obj.Id).Attributes.GetUserString("Role"), layer=doc.Objects.FindId(obj.Id).Attributes.LayerIndex };`,
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.value.role, 'Site');
  const candidate = await worker.exportModel();
  const changed = candidate.scene.find((o) => o.id === curve.id);
  assert.ok(Math.abs(changed.area - 120) < 1e-8);
  assert.equal(changed.length, 44);
  assert.deepEqual(
    candidate.scene.find((o) => o.id === other.id),
    other,
  );
  await worker.stop();
  worker = undefined;
  const preview = await editor.previewEditorApplication(
    receipt.filename,
    receipt.fileHash,
    basis.documentHash,
  );
  assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 1, 0]);
  const applied = await editor.applyEditorCandidate(
    randomUUID(),
    receipt.filename,
    receipt.fileHash,
    basis.documentHash,
  );
  assert.equal(applied.state, 'succeeded');
  const stale = await editor.applyEditorCandidate(
    randomUUID(),
    receipt.filename,
    receipt.fileHash,
    basis.documentHash,
  );
  assert.equal(stale.state, 'failed');
  const captured = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'reopen'),
    source: captured,
  });
  const restored = await worker.exportModel();
  assert.equal(restored.objects.find((o) => o.id === curve.id).nativeId, curve.nativeId);
  assert.deepEqual(
    restored.scene.find((o) => o.id === curve.id),
    changed,
  );
  assert.deepEqual(
    restored.scene.find((o) => o.id === other.id),
    other,
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(seed.filename))
      .digest('hex'),
    seed.fileHash,
  );
  const evidence = {
    passed: true,
    directory,
    areaBefore: 96,
    areaAfter: 120,
    length: 44,
    nativeIdPreserved: true,
    attributesAndLayerPreserved: true,
    unrelatedObjectUnchanged: true,
    sourceFileUnchanged: true,
    staleApplyRejected: true,
    captured,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, directory }));
} finally {
  await worker?.stop();
  await editor?.stop();
}
