import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

const directory = runDirectory('native-sdk-interruption');
await mkdir(directory, { recursive: true });
const controller = new AbortController();
let handlers,
  latest,
  finished = false,
  attempts = 0;
const sdk = new SdkExecution({
  ...sdkOptions(directory),
  origin: () => '',
  tools: {
    issue: (scope) => {
      handlers = scope.handlers;
      return { token: 'test', revoke: () => {} };
    },
  },
});
const running = sdk
  .run({
    input: { body: 'bounded synthetic cancellation', permission: 'candidate', pins: [] },
    items: [],
    signal: controller.signal,
    update: (value) => {
      latest = value;
    },
    provider: () => ({
      run: async () => {
        attempts++;
        const operation = handlers.execute({
          code: 'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4))); var until=DateTime.UtcNow.AddSeconds(4); while(DateTime.UtcNow<until) { var value=Math.Sqrt(12345.0); }',
        });
        return Promise.race([
          operation.then(() => ({ text: 'finished' })),
          new Promise((_, reject) =>
            controller.signal.addEventListener(
              'abort',
              () => reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })),
              { once: true },
            ),
          ),
        ]);
      },
    }),
  })
  .then(
    (result) => ({ result }),
    (error) => ({ error }),
  )
  .finally(() => {
    finished = true;
  });
const deadline = Date.now() + 90000;
let started = false;
while (Date.now() < deadline && !finished) {
  if (latest?.operationId) {
    try {
      const receipt = JSON.parse(
        await readFile(join(latest.workerDirectory, latest.operationId + '.json'), 'utf8'),
      );
      if (receipt.result.code === 'HOST_RESULT_UNKNOWN') {
        started = true;
        break;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
try {
  assert.equal(started, true, 'Native write intent must exist before cancelling');
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(finished, false, 'Must wait for in-flight native operation');
  const outcome = await running;
  assert.equal(outcome.error?.code, 'HOST_RESULT_UNKNOWN');
  const recovered = await sdk.recover(outcome.error.intent);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.scene.length, 1);
  assert.ok(Math.abs(recovered.scene[0].volume - 24) < 1e-8);
  assert.equal(attempts, 1);
  const evidence = {
    passed: true,
    directory,
    cancelledDuringNativeWrite: true,
    waitedForNativeCompletion: true,
    automaticCandidate: false,
    recoveredVolume: 24,
    executeCount: attempts,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  controller.abort();
  await running;
}
