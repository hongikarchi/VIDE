import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
const source = fixture.evidence.find((row) => row.kind === 'points' && row.count === 10000);
assert.ok(source);
const directory = resolve('.vide/rhino-large-apply', randomUUID());
await mkdir(directory, { recursive: true });
let editor, worker;
try {
  const options = sdkOptions(directory);
  editor = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'editor'),
    mode: 'editor',
    visible: false,
    source,
  });
  const captured = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'candidate'),
    source: { filename: captured.filename, fileHash: captured.fileHash },
  });
  const initial = await worker.query();
  const first = initial.objects[0];
  const receipt = await worker.execute(
    randomUUID(),
    0,
    `var target=doc.Objects.FindId(new Guid("${first.nativeId}"));if(!doc.Objects.Transform(target.Id,Transform.Translation(0,0,5),true).Equals(target.Id))throw new Exception("Identity changed");`,
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 300));
  await worker.stop();
  worker = undefined;
  const start = performance.now();
  const preview = await editor.previewEditorApplication(
    receipt.filename,
    receipt.fileHash,
    captured.documentHash,
  );
  assert.deepEqual([preview.added, preview.updated, preview.removed], [0, 1, 0]);
  const applied = await editor.applyEditorCandidate(
    randomUUID(),
    receipt.filename,
    receipt.fileHash,
    captured.documentHash,
  );
  assert.equal(applied.state, 'succeeded', JSON.stringify(applied));
  const elapsed = performance.now() - start;
  const after = await editor.captureEditor(randomUUID());
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'readback'),
    source: { filename: after.filename, fileHash: after.fileHash },
  });
  const restored = await worker.query();
  assert.equal(restored.objects.length, 10000);
  assert.deepEqual(
    restored.objects.map((o) => o.nativeId),
    initial.objects.map((o) => o.nativeId),
  );
  const modified = restored.objects.find((o) => o.nativeId === first.nativeId);
  assert.equal(modified.bounds[0][2], first.bounds[0][2] + 5);
  const evidence = {
    passed: true,
    count: 10000,
    updated: 1,
    identityPreserved: true,
    previewAndApplyMs: elapsed,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }));
} finally {
  await worker?.stop();
  await editor?.stop();
}
