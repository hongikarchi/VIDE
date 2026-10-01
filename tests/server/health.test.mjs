import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHealthLog } from '../../src/server/health.ts';

// Health samples (PLAN-27 step 0): memory and the event loop's worst delay, read after a death.
test('health samples carry memory and the worst event-loop delay of the period', async () => {
  const lines = [];
  const stop = startHealthLog({ write: (event, fields) => lines.push({ event, ...fields }) }, 40);
  const end = performance.now() + 60;
  while (performance.now() < end) {
    /* Block the loop for about 60 ms. */
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  stop();
  assert.ok(lines.length >= 1);
  const [first] = lines;
  assert.equal(first.event, 'health');
  for (const key of ['rssMB', 'heapMB', 'externalMB', 'arrayBuffersMB', 'loopMaxMs', 'loopP99Ms'])
    assert.equal(typeof first[key], 'number', key);
  assert.ok(Math.max(...lines.map((line) => line.loopMaxMs)) >= 20);
});
