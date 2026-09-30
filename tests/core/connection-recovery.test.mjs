// The page's way back after losing the work engine (src/ui/connection-recovery.ts).
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionRecovery, probeEngine } from '../../src/ui/connection-recovery.ts';

function harness(results) {
  const states = [],
    timers = [];
  let recovered = 0;
  const recovery = connectionRecovery({
    probe: async () => results.shift(),
    onState: (state) => states.push(state),
    onRecovered: () => void recovered++,
    delays: [10, 20],
    schedule: (run, ms) => timers.push({ run, ms }) - 1,
    cancel: () => {},
  });
  const tick = async () => {
    const next = timers.shift();
    next.run();
    await new Promise((resolve) => setImmediate(resolve));
    return next.ms;
  };
  return { recovery, states, timers, tick, recovered: () => recovered };
}

test('retries with backoff while the engine is away, then unlocks once', async () => {
  const h = harness(['unreachable', 'unreachable', 'ok']);
  h.recovery.lost();
  h.recovery.lost(); // repeated reports are one loss
  assert.equal(h.timers.length, 1);
  assert.equal(await h.tick(), 10);
  assert.equal(await h.tick(), 20);
  assert.equal(await h.tick(), 20);
  assert.equal(h.recovered(), 1);
  assert.equal(h.recovery.active, false);
  assert.deepEqual(h.states.slice(-2), ['checking', 'ok']);
});

test('a refused session waits for [다시 연결] instead of retrying by itself', async () => {
  const h = harness(['unauthorized', 'ok']);
  h.recovery.lost();
  await h.tick();
  assert.equal(h.timers.length, 0);
  assert.equal(h.states.at(-1), 'unauthorized');
  h.recovery.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.recovered(), 1);
});

test('retry does nothing while connected', async () => {
  const h = harness(['ok']);
  h.recovery.retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.recovered(), 0);
  assert.deepEqual(h.states, []);
});

test('probe reads 200 / 401 / other / network failure', async () => {
  const reply = (status) => async () => ({ ok: status < 300, status });
  assert.equal(await probeEngine(reply(200)), 'ok');
  assert.equal(await probeEngine(reply(401)), 'unauthorized');
  assert.equal(await probeEngine(reply(503)), 'unreachable');
  assert.equal(
    await probeEngine(async () => {
      throw new TypeError('fetch failed');
    }),
    'unreachable',
  );
});
