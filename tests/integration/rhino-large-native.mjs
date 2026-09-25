import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { queryPage } from '../../src/server/query-page.ts';

const directory = resolve('.vide/rhino-large-native', randomUUID());
await mkdir(directory, { recursive: true });
const evidence = [];
for (const [kind, count] of [
  ['boxes', 1000],
  ['points', 10000],
]) {
  await mkdir(join(directory, kind));
  let worker;
  const times = {};
  let start = performance.now(),
    receipt,
    model;
  try {
    worker = await launchRhinoWorker({
      ...sdkOptions(directory),
      directory: join(directory, kind, 'create'),
    });
    times.startMs = performance.now() - start;
    start = performance.now();
    const code =
      kind === 'boxes'
        ? `for(int i=0;i<${count};i++)doc.Objects.AddBox(new Box(new BoundingBox(i*3,0,0,i*3+2,3,4)));`
        : `for(int i=0;i<${count};i++)doc.Objects.AddPoint(new Point3d(i,0,0));`;
    receipt = await worker.execute(randomUUID(), 0, code);
    assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 300));
    assert.equal(receipt.snapshot.objects.length, count);
    times.executeMs = performance.now() - start;
    start = performance.now();
    model = await worker.exportModel();
    times.exportMs = performance.now() - start;
    assert.equal(model.objects.length, count);
    assert.equal(model.scene.length, count);
    if (kind === 'boxes') assert.ok(model.scene.every((row) => Math.abs(row.volume - 24) < 1e-7));
    const page = queryPage(await worker.query(), { offset: count - 10, expectedRevision: 1 });
    assert.equal(page.objects.length, 10);
    assert.equal(page.page.nextOffset, null);
  } finally {
    if (worker) await worker.stop();
    worker = undefined;
  }
  try {
    start = performance.now();
    worker = await launchRhinoWorker({
      ...sdkOptions(directory),
      directory: join(directory, kind, 'reopen'),
      source: {
        filename: receipt.filename,
        fileHash: receipt.fileHash,
        geometryMeasurements: model.scene.map(({ id, geometryHash, area, volume, length }) => ({
          id,
          geometryHash,
          area,
          volume,
          length,
        })),
      },
    });
    times.reopenMs = performance.now() - start;
    start = performance.now();
    const restored = await worker.exportModel();
    times.cachedExportMs = performance.now() - start;
    assert.deepEqual(
      restored.objects.map((row) => row.nativeId),
      model.objects.map((row) => row.nativeId),
    );
    assert.equal(restored.measurementStats.measuredObjects, 0);
    assert.equal(restored.measurementStats.reusedObjects, count);
    evidence.push({
      kind,
      count,
      times,
      serializedBytes: Buffer.byteLength(JSON.stringify(model)),
      measurementStats: restored.measurementStats,
      filename: receipt.filename,
      fileHash: receipt.fileHash,
    });
    console.log(JSON.stringify({ kind, count, passed: true, times }));
  } finally {
    if (worker) await worker.stop();
  }
}
await writeFile(
  join(directory, 'result.json'),
  JSON.stringify({ passed: true, evidence }, null, 2),
);
console.log(JSON.stringify({ directory, passed: true }));
