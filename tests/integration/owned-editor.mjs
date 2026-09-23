import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
const directory = resolve('.vide/owned-editor', randomUUID());
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
let worker, editor;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'model') });
  const model = await worker.execute(
    randomUUID(),
    0,
    'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)));',
  );
  assert.equal(model.ok, true, JSON.stringify(model));
  await worker.stop();
  worker = undefined;
  editor = await launchRhinoWorker({
    ...options,
    mode: 'editor',
    visible: true,
    directory: join(directory, 'editor'),
    source: { filename: model.filename, fileHash: model.fileHash },
  });
  const before = await editor.inspectEditor();
  assert.equal(before.objectCount, 1);
  assert.equal(before.units, 'Meters');
  const rejected = await editor.execute(randomUUID(), 0, 'doc.Objects.Clear();');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'UNKNOWN_METHOD');
  const captured = await editor.captureEditor(randomUUID());
  assert.equal(captured.documentHash, before.documentHash);
  const after = await editor.inspectEditor();
  assert.equal(after.documentHash, before.documentHash);
  assert.equal(after.modified, before.modified);
  assert.equal(
    createHash('sha256')
      .update(await readFile(model.filename))
      .digest('hex'),
    model.fileHash,
  );
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'recapture'),
    source: { filename: captured.filename, fileHash: captured.fileHash },
  });
  const restored = await worker.exportModel();
  assert.equal(restored.scene[0].volume, 24);
  const evidence = {
    passed: true,
    directory,
    visibleEditor: true,
    readOnlyChannel: true,
    captureVerified: true,
    sourceUnchanged: true,
    volume: 24,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (worker) await worker.stop();
  if (editor) await editor.stop();
}
