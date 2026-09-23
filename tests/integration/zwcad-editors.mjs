import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchZwcadWorker } from '../../hosts/zwcad/worker-client.ts';
import { ZwcadEditors } from '../../hosts/zwcad/editor-sessions.ts';

const sourceResult = JSON.parse(await readFile(process.argv[2], 'utf8'));
const source = {
  filename: sourceResult.result?.filename || sourceResult.modified?.filename,
  fileHash: sourceResult.result?.fileHash || sourceResult.modified?.fileHash,
};
assert.ok(source.filename);
const directory = resolve('.vide/zwcad-editors', randomUUID());
await mkdir(directory, { recursive: true });
const workers = [];
try {
  for (let i = 0; i < 2; i++)
    workers.push(
      await launchZwcadWorker({
        directory: join(directory, 'editor-' + i),
        source,
        editor: true,
        visible: false,
      }),
    );
  await writeFile(
    directory + '.editors.json',
    JSON.stringify(workers.map((worker) => worker.connection)),
  );
  const editors = new ZwcadEditors(directory);
  const docs = await editors.list();
  assert.equal(docs.length, 2);
  assert.notEqual(docs[0].instance, docs[1].instance);
  assert.equal(docs[0].name, docs[1].name);
  const target = { instance: docs[0].instance, documentId: 1 };
  const capture = await editors.capture(target);
  assert.equal(capture.scene[0].area, 240);
  assert.equal(capture.scene[0].length, 68);
  const original = sourceResult.result || sourceResult.modified.model;
  assert.equal(capture.objects[0].nativeId, original.objects[0].nativeId);
  assert.equal(
    createHash('sha256')
      .update(await readFile(source.filename))
      .digest('hex'),
    source.fileHash,
  );
  assert.equal(
    (await workers[0].execute(randomUUID(), 0, 'throw new Exception();')).code,
    'UNSUPPORTED_METHOD',
  );
  await assert.rejects(editors.capture({ ...target, documentId: 2 }), {
    code: 'DOCUMENT_MISMATCH',
  });
  const restored = new ZwcadEditors(directory);
  assert.equal((await restored.list()).length, 2);
  const after = await restored.capture(target);
  assert.equal(after.sourceDocument.documentHash, capture.sourceDocument.documentHash);
  const candidateWorker = await launchZwcadWorker({
    directory: join(directory, 'candidate'),
    source: { filename: capture.filename, fileHash: capture.fileHash },
  });
  workers.push(candidateWorker);
  const changed = await candidateWorker.execute(
    randomUUID(),
    0,
    `var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForWrite);
var ids=space.Cast<ObjectId>().ToArray();
foreach(var id in ids){var line=(Polyline)tr.GetObject(id,OpenMode.ForWrite);line.SetPointAt(1,new Point2d(26000,0));line.SetPointAt(2,new Point2d(26000,10000));
var copy=(Polyline)line.Clone();copy.TransformBy(Matrix3d.Displacement(new Vector3d(30000,0,0)));space.AppendEntity(copy);tr.AddNewlyCreatedDBObject(copy,true);}`,
  );
  assert.equal(changed.ok, true, JSON.stringify(changed));
  const candidate = { ...changed, sourceDocument: capture.sourceDocument };
  const effect = await editors.preview(target, candidate);
  assert.equal(effect.added, 1);
  assert.equal(effect.updated, 1);
  const applyId = randomUUID(),
    applyTarget = {
      ...target,
      documentHash: capture.sourceDocument.documentHash,
      candidateHash: changed.fileHash,
    };
  const applied = await editors.apply(applyId, candidate, applyTarget);
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
  assert.deepEqual(await editors.apply(applyId, candidate, applyTarget), applied);
  const edited = await editors.capture(target);
  assert.equal(edited.objects.length, 2);
  assert.equal(edited.scene[0].area, 260);
  const other = await editors.capture({ instance: docs[1].instance, documentId: 1 });
  assert.equal(other.objects.length, 1);
  assert.equal(other.scene[0].area, 240);
  await assert.rejects(editors.preview(target, candidate), { code: 'STALE_REFERENCE' });
  const deletionWorker = await launchZwcadWorker({
    directory: join(directory, 'deletion'),
    source: { filename: edited.filename, fileHash: edited.fileHash },
  });
  workers.push(deletionWorker);
  const deletion = await deletionWorker.execute(
    randomUUID(),
    0,
    `
var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);
var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);
var ids=ms.Cast<ObjectId>().ToArray();
tr.GetObject(ids[1],OpenMode.ForWrite).Erase();`,
  );
  assert.equal(deletion.ok, true, JSON.stringify(deletion));
  assert.equal(deletion.model.objects.length, 1);
  assert.equal(deletion.model.objects[0].nativeId, edited.objects[0].nativeId);
  const deletionCandidate = { ...deletion, sourceDocument: edited.sourceDocument };
  const deletionEffect = await editors.preview(target, deletionCandidate);
  assert.equal(deletionEffect.removed, 1);
  assert.equal(deletionEffect.updated, 0);
  const deletionId = randomUUID();
  const deletionTarget = {
    ...target,
    documentHash: edited.sourceDocument.documentHash,
    candidateHash: deletion.fileHash,
  };
  const deletionApplied = await editors.apply(deletionId, deletionCandidate, deletionTarget);
  assert.equal(deletionApplied.state, 'succeeded', JSON.stringify(deletionApplied));
  assert.deepEqual(
    await editors.apply(deletionId, deletionCandidate, deletionTarget),
    deletionApplied,
  );
  const final = await editors.capture(target);
  assert.equal(final.objects.length, 1);
  assert.equal(final.objects[0].nativeId, edited.objects[0].nativeId);
  assert.equal(final.scene[0].area, 260);
  const reopened = await launchZwcadWorker({
    directory: join(directory, 'reopened'),
    source: { filename: final.filename, fileHash: final.fileHash },
  });
  workers.push(reopened);
  const readback = await reopened.exportModel();
  assert.equal(readback.objects.length, 1);
  assert.equal(readback.objects[0].nativeId, final.objects[0].nativeId);

  await writeFile(
    join(directory, 'passed.json'),
    JSON.stringify(
      {
        passed: true,
        docs,
        capture,
        deletionEffect,
        deletionApplied,
        deletionReadback: readback,
        sourceUnchanged: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, directory }));
} catch (error) {
  console.error(error);
  await writeFile(join(directory, 'failure.txt'), String(error.stack));
  process.exitCode = 1;
} finally {
  for (const worker of workers) await worker.stop();
}
