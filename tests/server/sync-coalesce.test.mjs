import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncCoalescer } from '../../src/server/sync-coalesce.ts';

const later = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};

// PLAN-27 T-087 (2026-10-01): opening one file made three pages each start a full document Sync.
test('automatic Syncs of one document join the running one; other documents run on their own', async () => {
  const sync = new SyncCoalescer();
  const gate = later();
  let runs = 0;
  const task = (value) => async () => {
    runs++;
    await gate.promise;
    return value;
  };
  const first = sync.run('p|rhino|1:2:a|7', task('one'));
  const second = sync.run('p|rhino|1:2:a|7', task('two'));
  const third = sync.run('p|rhino|1:2:a|7', task('three'));
  const other = sync.run('p|rhino|1:2:a|8', task('other'));
  gate.resolve();
  assert.deepEqual(await first, { result: 'one' });
  assert.deepEqual(await second, { result: 'one', shared: 'joined' });
  assert.deepEqual(await third, { result: 'one', shared: 'joined' });
  assert.deepEqual(await other, { result: 'other' });
  assert.equal(runs, 2);
});

test('right after a Sync, the same revision reuses it; a changed one, a late one or ↻ runs fresh', async () => {
  let now = 1000;
  const sync = new SyncCoalescer({ reuseMs: 2000, now: () => now });
  let runs = 0;
  const task = () => async () => `run-${++runs}`;
  await sync.run('doc', task());
  now += 1500;
  assert.deepEqual(await sync.run('doc', task(), { reusable: () => true }), {
    result: 'run-1',
    shared: 'reused',
  });
  // The document changed since: a new read.
  assert.deepEqual(await sync.run('doc', task(), { reusable: () => false }), { result: 'run-2' });
  // A failed revision check also reads again.
  assert.deepEqual(
    await sync.run('doc', task(), {
      reusable: async () => {
        throw Object.assign(new Error('HOST_BUSY'), { code: 'HOST_BUSY' });
      },
    }),
    { result: 'run-3' },
  );
  // The user's own Sync is never shared.
  assert.deepEqual(await sync.run('doc', task(), { fresh: true, reusable: () => true }), {
    result: 'run-4',
  });
  now += 2500;
  assert.deepEqual(await sync.run('doc', task(), { reusable: () => true }), { result: 'run-5' });
  // Without a revision check nothing finished is reused.
  assert.deepEqual(await sync.run('doc', task()), { result: 'run-6' });
});

test('a fresh Sync runs beside a running one and later automatic ones join it', async () => {
  const sync = new SyncCoalescer();
  const slow = later(),
    manual = later();
  const first = sync.run('doc', async () => {
    await slow.promise;
    return 'auto';
  });
  const fresh = sync.run(
    'doc',
    async () => {
      await manual.promise;
      return 'manual';
    },
    { fresh: true },
  );
  const joined = sync.run('doc', async () => 'never');
  slow.resolve();
  assert.deepEqual(await first, { result: 'auto' });
  manual.resolve();
  assert.deepEqual(await fresh, { result: 'manual' });
  assert.deepEqual(await joined, { result: 'manual', shared: 'joined' });
});

test('a failed Sync is shared with those that joined it and never reused', async () => {
  let now = 0;
  const sync = new SyncCoalescer({ now: () => now });
  const gate = later();
  const failing = sync.run('doc', async () => {
    await gate.promise;
    throw new Error('CAPTURE_FAILED');
  });
  const joined = sync.run('doc', async () => 'never');
  gate.resolve();
  await assert.rejects(failing, /CAPTURE_FAILED/);
  await assert.rejects(joined, /CAPTURE_FAILED/);
  now += 100;
  assert.deepEqual(await sync.run('doc', async () => 'again', { reusable: () => true }), {
    result: 'again',
  });
});
