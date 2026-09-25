import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { queryPage } from '../../src/server/query-page.ts';

const run = promisify(execFile);
async function memory(worker) {
  const pid = worker.identity.pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `$p=Get-Process -Id ${pid}; @{ workingSet=$p.WorkingSet64; peakWorkingSet=$p.PeakWorkingSet64; privateBytes=$p.PrivateMemorySize64 } | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true },
  );
  return { node: process.memoryUsage(), rhino: JSON.parse(stdout) };
}

const directory = resolve('.vide/rhino-dense-mesh', randomUUID());
await mkdir(directory, { recursive: true });
const evidence = [];
for (const [kind, count] of [['dense-mesh', 1]]) {
  await mkdir(join(directory, kind));
  let worker;
  const times = {};
  const memories = {};
  let start = performance.now(),
    receipt,
    model;
  try {
    worker = await launchRhinoWorker({
      ...sdkOptions(directory),
      directory: join(directory, kind, 'create'),
    });
    times.startMs = performance.now() - start;
    memories.started = await memory(worker);
    start = performance.now();
    const code = `var mesh=new Mesh();
      for(int y=0;y<=256;y++)for(int x=0;x<=256;x++)mesh.Vertices.Add(x,y,0);
      for(int y=0;y<256;y++)for(int x=0;x<256;x++){
        int a=y*257+x;mesh.Faces.AddFace(a,a+1,a+258);mesh.Faces.AddFace(a,a+258,a+257);
      }
      mesh.Normals.ComputeNormals();mesh.Compact();doc.Objects.AddMesh(mesh);`;
    receipt = await worker.execute(randomUUID(), 0, code);
    assert.equal(receipt.ok, true, JSON.stringify(receipt).slice(0, 300));
    assert.equal(receipt.snapshot.objects.length, count);
    times.executeMs = performance.now() - start;
    start = performance.now();
    model = await worker.exportModel();
    times.exportMs = performance.now() - start;
    assert.equal(model.objects.length, count);
    assert.equal(model.scene.length, count);
    assert.equal(model.scene[0].vertices.length, 257 * 257 * 3);
    assert.equal(model.scene[0].indices.length, 131072 * 3);
    assert.ok(Math.abs(model.scene[0].area - 65536) < 1e-6);
    memories.exported = await memory(worker);
    const page = queryPage(await worker.query(), { offset: 0, expectedRevision: 1 });
    assert.equal(page.objects.length, 1);
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
    assert.deepEqual(restored.scene[0].vertices, model.scene[0].vertices);
    assert.deepEqual(restored.scene[0].indices, model.scene[0].indices);
    memories.reopened = await memory(worker);
    evidence.push({
      memories,
      triangles: 131072,
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
