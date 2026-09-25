import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/rhino-layer-preservation', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
let worker, editor;
const evidence = [];
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'seed') });
  const initial = await worker.execute(
    randomUUID(),
    0,
    'var layer=new Rhino.DocObjects.Layer();layer.Name="Unused";layer.SetUserString("Purpose","Preserve");doc.Layers.Add(layer);var a=new Rhino.DocObjects.ObjectAttributes();a.Name="point";doc.Objects.AddPoint(new Point3d(1,2,3),a);',
  );
  assert.equal(initial.ok, true);
  await worker.stop();
  worker = undefined;
  editor = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'editor'),
    mode: 'editor',
    visible: false,
    source: initial,
  });
  const basis = await editor.captureEditor(randomUUID());
  for (const [name, code] of [
    [
      'add-empty',
      'var layer=new Rhino.DocObjects.Layer();layer.Name="New empty layer";doc.Layers.Add(layer);',
    ],
    ['remove-empty', 'doc.Layers.Delete(doc.Layers.First(l=>l.Name=="Unused").Index,true);'],
    [
      'rename-empty',
      'var l=doc.Layers.First(l=>l.Name=="Unused");l.Name="Renamed";l.CommitChanges();',
    ],
    [
      'data-empty',
      'var l=doc.Layers.First(l=>l.Name=="Unused");l.SetUserString("Purpose","Changed");l.CommitChanges();',
    ],
  ]) {
    worker = await launchRhinoWorker({
      ...options,
      directory: join(directory, name),
      source: basis,
    });
    const candidate = await worker.execute(randomUUID(), 0, code);
    assert.equal(candidate.ok, true, JSON.stringify(candidate).slice(0, 300));
    await assert.rejects(
      () =>
        editor.previewEditorApplication(candidate.filename, candidate.fileHash, basis.documentHash),
      { code: 'UNSUPPORTED_APPLICATION' },
    );
    const application = await editor.applyEditorCandidate(
      randomUUID(),
      candidate.filename,
      candidate.fileHash,
      basis.documentHash,
    );
    assert.equal(application.state, 'failed');
    assert.equal(application.result.code, 'UNSUPPORTED_APPLICATION');
    assert.equal((await editor.captureEditor(randomUUID())).documentHash, basis.documentHash);
    evidence.push({ name, rejectedBeforeWrite: true });
    await worker.stop();
    worker = undefined;
  }
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'move'),
    source: basis,
  });
  const candidate = await worker.execute(
    randomUUID(),
    0,
    'doc.Objects.Transform(doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single().Id,Transform.Translation(0,0,5),true);',
  );
  assert.equal(candidate.ok, true);
  const preview = await editor.previewEditorApplication(
    candidate.filename,
    candidate.fileHash,
    basis.documentHash,
  );
  assert.equal(preview.updated, 1);
  assert.equal(
    (
      await editor.applyEditorCandidate(
        randomUUID(),
        candidate.filename,
        candidate.fileHash,
        basis.documentHash,
      )
    ).state,
    'succeeded',
  );
  const captured = await editor.captureEditor(randomUUID());
  await worker.stop();
  worker = undefined;
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'reopen'),
    source: captured,
  });
  const model = await worker.query();
  assert.equal(model.objects[0].nativeId, initial.snapshot.objects[0].nativeId);
  assert.deepEqual(model.objects[0].bounds, [
    [1, 2, 8],
    [1, 2, 8],
  ]);
  const inspected = await worker.execute(
    randomUUID(),
    0,
    'return new { names=doc.Layers.Where(l=>!l.IsDeleted).Select(l=>l.Name).ToArray(), purpose=doc.Layers.First(l=>l.Name=="Unused").GetUserString("Purpose") };',
  );
  assert.equal(inspected.ok, true);
  assert.ok(inspected.value.names.includes('Unused'));
  assert.equal(inspected.value.purpose, 'Preserve');
  evidence.push({
    name: 'object-only-move',
    applied: true,
    nativeIdPreserved: true,
    unusedLayerPreserved: true,
  });
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({ passed: true, evidence }, null, 2),
  );
  console.log(JSON.stringify({ directory, passed: true, evidence }));
} finally {
  if (worker) await worker.stop();
  if (editor) await editor.stop();
}
