// Jig isolation before a persona run (T-280), against a fake engine API (no engine, no UI).
//   node --test tools/persona/isolation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliSessions, isolateJigs, scenarioJigs } from './isolation.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('scenarioJigs reads the jigs field', () => {
  assert.equal(scenarioJigs({ id: 'X' }), null);
  assert.equal(scenarioJigs({ id: 'X', jigs: null }), null);
  assert.deepEqual(scenarioJigs({ id: 'X', jigs: [] }), []);
  assert.deepEqual(
    scenarioJigs({ id: 'X', jigs: [' project/s06-frame ', 'sync', 'project/s06-frame'] }),
    ['project/s06-frame', 'sync'],
  );
  assert.throws(() => scenarioJigs({ id: 'X', jigs: 'sync' }), /array/);
  assert.throws(() => scenarioJigs({ id: 'X', jigs: [''] }), /bad jig id/);
  assert.throws(() => scenarioJigs({ id: 'X', jigs: ['a/b/c'] }), /bad jig id/);
  assert.throws(() => scenarioJigs({ id: 'X', jigs: [3] }), /bad jig id/);
});

test('every scenario in scenarios.json has a valid jigs field', async () => {
  const plan = JSON.parse(await readFile(join(here, 'scenarios.json'), 'utf8'));
  const byId = Object.fromEntries(plan.scenarios.map((s) => [s.id, scenarioJigs(s)]));
  for (const [id, jigs] of Object.entries(byId)) assert.ok(Array.isArray(jigs), id);
  assert.deepEqual(byId['R1-D'], ['project/s06-frame']);
  assert.deepEqual(byId['R1-HIDE'], []);
});

/** A fake of the engine API: one project, instances, conversations; records the writes. */
function fakeEngine({ skills, instances, conversations, failClose = [] }) {
  const writes = [];
  let clock = 100;
  const api = async (path, body) => {
    const p = path.replace('/projects/p1', '');
    if (!path.startsWith('/projects/p1/')) throw new Error('outside the project: ' + path);
    if (body === undefined) {
      if (p === '/skills') return { skills };
      if (p === '/jig-instances') return { instances: [...instances] };
      if (p === '/conversations') return conversations.map((c) => ({ ...c }));
      throw new Error('GET ' + path);
    }
    writes.push([p, body]);
    const close = /^\/conversations\/([^/]+)\/close$/.exec(p);
    if (close) {
      if (failClose.includes(close[1])) throw new Error('INVALID_INPUT');
      conversations.find((c) => (c.id ?? 'default') === close[1]).state = 'closed';
      return {};
    }
    const unbind = /^\/conversations\/([^/]+)\/unbind$/.exec(p);
    if (unbind) return {};
    if (p === '/jig-instances') {
      const row = {
        id: 'new-' + body.jig,
        jigId: body.jig,
        updatedAt: `2026-10-14T00:00:${clock++}`,
      };
      instances.push(row);
      return row;
    }
    throw new Error('POST ' + path);
  };
  return { api, writes };
}

test('isolateJigs closes bound conversations and makes a new latest workbook', async () => {
  const engine = fakeEngine({
    skills: [
      { id: 'project/s06-frame', kind: 'instance', version: '1.2.0', open: { reuse: 'last' } },
      { id: 'sync', kind: 'legacy', open: { reuse: 'last' } },
    ],
    instances: [
      { id: 'w1', jigId: 'project/s06-frame', updatedAt: '2026-10-09T00:00:00Z' },
      { id: 'w2', jigId: 'project/s06-frame', updatedAt: '2026-10-13T00:00:00Z' },
      { id: 'o1', jigId: 'other', updatedAt: '2026-10-13T00:00:00Z' },
    ],
    conversations: [
      { id: 'c1', state: 'open', jigInstanceId: 'w2' },
      { id: 'c2', state: 'closed', jigInstanceId: 'w1' },
      { id: 'c3', state: 'open', jigInstanceId: 'o1' },
      { id: null, state: 'open', jigInstanceId: 'w1' },
    ],
    failClose: ['default'],
  });
  const result = await isolateJigs({
    api: engine.api,
    projectId: 'p1',
    jigs: ['project/s06-frame', 'sync'],
  });
  assert.equal(result.status, 'full');
  const [s06, sync] = result.jigs;
  assert.deepEqual(s06.previousWorkbooks, ['w1', 'w2']);
  assert.deepEqual(s06.closedConversations, ['c1']);
  assert.deepEqual(s06.unboundConversations, ['default']);
  assert.equal(s06.freshWorkbook, 'new-project/s06-frame');
  assert.equal(s06.latestIsFresh, true);
  assert.equal(sync.kind, 'legacy');
  assert.equal(sync.freshWorkbook, null);
  const made = engine.writes.find(([p]) => p === '/jig-instances')[1];
  assert.deepEqual(made, {
    jig: 'project/s06-frame',
    version: '1.2.0',
    title: '작업본 3',
    layerRootLater: true,
  });
  // c3 (another jig) and c2 (closed) are left alone.
  assert.ok(!engine.writes.some(([p]) => p.includes('/c3/') || p.includes('/c2/')));
  assert.ok(result.limits.length >= 1);
});

test('isolateJigs is partial when a jig is not in the catalog; none when no jigs', async () => {
  const engine = fakeEngine({ skills: [], instances: [], conversations: [] });
  const result = await isolateJigs({ api: engine.api, projectId: 'p1', jigs: ['vide/site-model'] });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.jigs[0].errors, ['not in the catalog']);
  assert.equal(engine.writes.length, 0);
  assert.equal((await isolateJigs({ api: engine.api, projectId: 'p1', jigs: [] })).status, 'none');
});

test('cliSessions reads resume per request from cli-start lines', () => {
  const lines = {
    a: [
      { event: 'request-stages' },
      { event: 'cli-start', provider: 'claude-cli', resume: true, model: 'm' },
    ],
    b: [{ event: 'cli-start', provider: 'claude-cli' }],
  };
  assert.deepEqual(
    cliSessions(['a', 'b', 'c'], (id) => lines[id] ?? []),
    [
      { requestId: 'a', cliStarts: 1, resume: true, provider: 'claude-cli', model: 'm' },
      { requestId: 'b', cliStarts: 1, resume: false, provider: 'claude-cli', model: null },
      { requestId: 'c', cliStarts: 0, resume: null, provider: null, model: null },
    ],
  );
});
