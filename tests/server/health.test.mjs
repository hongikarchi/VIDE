import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHealthLog } from '../../src/server/health.ts';

// Health samples (PLAN-27 step 0): memory and the event loop's worst delay, read after a death.
test('health samples carry memory and the worst event-loop delay of the period', async () => {
  const lines = [];
  const stop = startHealthLog({ write: (event, fields) => lines.push({ event, ...fields }) }, 40);
  // Let the delay monitor's own timer start first, then block the loop well past its resolution;
  // under a fully loaded test run a short block was sometimes read before it was recorded.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const end = performance.now() + 150;
  while (performance.now() < end) {
    /* Block the loop for about 150 ms. */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  stop();
  assert.ok(lines.length >= 1);
  const [first] = lines;
  assert.equal(first.event, 'health');
  for (const key of ['rssMB', 'heapMB', 'externalMB', 'arrayBuffersMB', 'loopMaxMs', 'loopP99Ms'])
    assert.equal(typeof first[key], 'number', key);
  assert.ok(Math.max(...lines.map((line) => line.loopMaxMs)) >= 20);
});
