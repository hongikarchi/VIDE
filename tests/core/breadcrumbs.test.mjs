import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { BIG_JSON, setBreadcrumbSink } from '../../src/core/breadcrumbs.ts';

test('a large stored result notes its write and read before they run; small ones note nothing', () => {
  const steps = [];
  setBreadcrumbSink((step, fields) => steps.push({ step, ...fields }));
  const store = new Store(':memory:');
  try {
    const workspace = new Workspace(store);
    const project = store.createProject('Breadcrumbs');
    const submit = (id) =>
      workspace.submit(project.id, {
        id,
        provider: 'codex-cli',
        permission: 'review',
        body: 'Sync',
        pins: [],
        files: [],
        sketches: [],
      });
    submit('small');
    workspace.update(project.id, 'small', 'succeeded', { hostExecuted: true, objects: [] });
    assert.deepEqual(steps, []);
    submit('big');
    workspace.update(project.id, 'big', 'succeeded', {
      hostExecuted: true,
      objects: [],
      padding: 'x'.repeat(BIG_JSON),
    });
    assert.deepEqual(
      steps.map((entry) => [entry.step, entry.id]),
      [
        ['write-big', 'big'],
        ['write-big-done', 'big'],
        ['parse-big', 'big'],
      ],
    );
    assert.ok(steps[0].bytes >= BIG_JSON);
  } finally {
    setBreadcrumbSink(undefined);
    store.close?.();
  }
});
