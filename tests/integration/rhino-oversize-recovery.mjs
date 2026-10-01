import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('rhino-oversize-recovery');
await mkdir(directory, { recursive: true });
let handlers,
  executions = 0,
  stopped = 0;
const sdk = new SdkExecution({
  ...sdkOptions(directory),
  origin: () => '',
  tools: {
    issue(scope) {
      handlers = scope.handlers;
      return { token: 'test', revoke() {} };
    },
  },
  launch: async (options) => {
    const worker = await launchRhinoWorker(options);
    return {
      ...worker,
      execute: async (...args) => {
        executions++;
        return worker.execute(...args);
      },
      stop: async () => {
        await worker.stop();
        stopped++;
      },
    };
  },
});
let failure;
try {
  await sdk.run({
    input: { body: 'Oversize synthetic mesh', permission: 'candidate', pins: [] },
    items: [],
    signal: new AbortController().signal,
    update() {},
    provider: () => ({
      run: async () => {
        const receipt = await handlers.execute({
          code: `var mesh=new Mesh();
        for(int y=0;y<=640;y++)for(int x=0;x<=640;x++)mesh.Vertices.Add(x,y,0);
        for(int y=0;y<640;y++)for(int x=0;x<640;x++){
          int a=y*641+x;mesh.Faces.AddFace(a,a+1,a+642);mesh.Faces.AddFace(a,a+642,a+641);
        }
        mesh.Normals.ComputeNormals();mesh.Compact();doc.Objects.AddMesh(mesh);`,
        });
        assert.equal(receipt.ok, true);
        return { text: 'Saved synthetic mesh' };
      },
    }),
  });
} catch (error) {
  failure = error;
}
assert.equal(failure?.code, 'HOST_RESULT_UNKNOWN');
assert.equal(failure.cause?.code, 'HOST_RESULT_TOO_LARGE');
assert.equal(executions, 1);
assert.equal(stopped, 1);
const intent = failure.intent;
const receiptFile = join(intent.workerDirectory, intent.operationId + '.json');
const receiptBefore = await readFile(receiptFile);
const receipt = JSON.parse(receiptBefore).result;
assert.equal(receipt.ok, true);
assert.equal(receipt.snapshot.objects.length, 1);
const digest = async () =>
  createHash('sha256')
    .update(await readFile(receipt.filename))
    .digest('hex');
assert.equal(await digest(), receipt.fileHash);
await assert.rejects(() => sdk.recover(intent), { code: 'HOST_RESULT_TOO_LARGE' });
assert.equal(executions, 1, 'Recovery must not execute the write again');
assert.equal(stopped, 2);
assert.deepEqual(await readFile(receiptFile), receiptBefore);
assert.equal(await digest(), receipt.fileHash);
const evidence = {
  passed: true,
  executions,
  stopped,
  triangles: 819200,
  responseLimitBytes: 16 * 1024 * 1024,
  receiptPreserved: true,
  candidateHashPreserved: true,
  recoveryReplayed: false,
  filename: receipt.filename,
  fileHash: receipt.fileHash,
};
await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ directory, ...evidence }));
