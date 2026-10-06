import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';

import { soleDb } from '../fixtures/store.mjs';
// The request list leaves out display geometry and reuses decoded rows (the linked-file list polls
// it every 1.5 s; parsing every stored model each time stalled the engine).
test('request list omits display geometry, reuses rows and follows every change', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'vide-list-test-'));
  const store = new Store(join(root, 'test.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const project = store.createProject('P');
  const workspace = new Workspace(store);
  const input = {
    provider: 'codex-cli',
    host: 'rhino',
    permission: 'candidate',
    body: 'sync',
    pins: [],
    sketches: [],
    files: [],
  };
  const sync = {
    host: 'rhino',
    hostExecuted: true,
    text: '끝',
    objects: [{ id: 'a' }],
    scene: [{ id: 'a', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }],
    definitions: {},
  };
  const insert = (id, result) =>
    soleDb(store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({ ...input, id }),
        'succeeded',
        JSON.stringify(result),
        '2026-09-29T00:00:00.000Z',
      );
  insert('s1', sync);
  insert('t1', { text: '답' });
  const [first, text] = workspace.list(project.id);
  assert.equal(first.result.scene, undefined);
  assert.equal(first.result.definitions, undefined);
  assert.equal(first.result.sceneOmitted, true);
  assert.deepEqual(first.result.objects, [{ id: 'a' }]);
  assert.equal(text.result.sceneOmitted, undefined);
  // The same rows are reused while nothing changed.
  assert.equal(workspace.list(project.id)[0], first);
  // One request, or the full list, still carries the model.
  assert.equal(workspace.get(project.id, 's1').result.scene.length, 1);
  assert.equal(workspace.list(project.id, { full: true })[0].result.scene.length, 1);
  // The basis of new work is the full model.
  assert.equal(workspace.basis(project.id, { id: 'x', host: 'rhino' }).result.scene.length, 1);
  // A change through the workspace is seen at once, even with the same stored size.
  workspace.update(project.id, 's1', 'succeeded', { ...sync, text: '끗' });
  assert.equal(workspace.list(project.id)[0].result.text, '끗');
  // A change written elsewhere is seen through the state or size.
  soleDb(store)
    .prepare("UPDATE workspace_requests SET result=? WHERE id='t1'")
    .run(JSON.stringify({ text: '다른 답' }));
  assert.equal(workspace.list(project.id)[1].result.text, '다른 답');
});
