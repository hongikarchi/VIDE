// T-191: the open project removed elsewhere (site clean-up) — the first project-scoped NOT_FOUND
// re-reads the project list; when the project is gone the window leaves it and no call for it
// reaches the engine again (2026-10-06: 40 minutes of polling, ~1,500 NOT_FOUND).
import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../src/ui/gateway.ts';
import {
  PROJECT_GONE_TEXT,
  isProjectGone,
  projectOfPath,
  watchProjectGone,
} from '../../src/ui/project-gone.ts';

const notFound = () =>
  new Response('{"code":"NOT_FOUND"}', {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });

test('project paths name their project; other paths none', () => {
  assert.equal(projectOfPath('/projects/p1/links?hold=a'), 'p1');
  assert.equal(projectOfPath('/projects/a%20b/offline-view'), 'a b');
  assert.equal(projectOfPath('/projects'), undefined);
  assert.equal(projectOfPath('/telemetry'), undefined);
});

test('a NOT_FOUND for the open, removed project leaves it once and stops its polling', async (t) => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return notFound();
  };
  t.after(() => (globalThis.fetch = original));
  let lists = 0;
  const left = [];
  const stop = watchProjectGone({
    current: () => 'gone-1',
    listProjects: async () => {
      lists++;
      return [{ id: 'other' }];
    },
    leave: (id) => left.push(id),
  });
  t.after(stop);
  // The links poll answers NOT_FOUND: the list is read and the project is not in it.
  await assert.rejects(api('/projects/gone-1/links'), { code: 'NOT_FOUND' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lists, 1);
  assert.deepEqual(left, ['gone-1']);
  assert.equal(isProjectGone('/projects/gone-1/offline-view'), true);
  // Every later poll is answered without the engine, quietly, and does not leave again.
  const before = calls.length;
  for (const path of ['/projects/gone-1/links', '/projects/gone-1/offline-view'])
    await assert.rejects(api(path), { code: 'PROJECT_GONE', message: PROJECT_GONE_TEXT });
  assert.equal(calls.length, before);
  assert.deepEqual(left, ['gone-1']);
  // Other projects are still asked.
  await assert.rejects(api('/projects/other/links'), { code: 'NOT_FOUND' });
  assert.equal(calls.length, before + 1);
});

test('a NOT_FOUND inside a project that still exists (a missing request) keeps the project', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => notFound();
  t.after(() => (globalThis.fetch = original));
  let lists = 0;
  let clock = 0;
  const left = [];
  const stop = watchProjectGone({
    current: () => 'kept-1',
    listProjects: async () => {
      lists++;
      return [{ id: 'kept-1' }];
    },
    leave: (id) => left.push(id),
    recheckMs: 30_000,
    now: () => clock,
  });
  t.after(stop);
  await assert.rejects(api('/projects/kept-1/requests/r1'), { code: 'NOT_FOUND' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Repeats within the wait do not read the list again.
  await assert.rejects(api('/projects/kept-1/requests/r1'), { code: 'NOT_FOUND' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lists, 1);
  clock = 31_000;
  await assert.rejects(api('/projects/kept-1/requests/r1'), { code: 'NOT_FOUND' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lists, 2);
  assert.deepEqual(left, []);
  assert.equal(isProjectGone('/projects/kept-1/links'), false);
  // A NOT_FOUND for a project that is not the open one is not checked.
  await assert.rejects(api('/projects/elsewhere/links'), { code: 'NOT_FOUND' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lists, 2);
});
