import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';

// PLAN-27 (2026-10-02): a request with 8 pins on a large document's display Sync (78 MB JSON)
// decoded that Sync 9 times on submit and 9 more times (with a schema copy each) when it ran: the
// engine stalled for seconds near 2 GB of heap. Pins and checks now read the Sync's geometry-free
// row; only the run's own basis is decoded once.
function largeSync() {
  const objects = Array.from({ length: 400 }, (_, i) => ({
    id: `object-${i}`,
    name: `Object ${i}`,
    kind: 'native',
    nativeId: `native-${i}`,
    origin: [i, 0, 0],
  }));
  const scene = objects.map(({ id }, i) => ({
    id,
    vertices: Array.from({ length: 6000 }, (_, k) => i + k / 7),
    indices: Array.from({ length: 3000 }, (_, k) => k),
    area: i,
  }));
  return { host: 'rhino', hostExecuted: true, objects, scene };
}

/** Counts JSON.parse calls on strings over 1 MB while `run` lasts. */
async function largeDecodes(run) {
  const parse = JSON.parse;
  let count = 0;
  JSON.parse = function (text, ...rest) {
    if (typeof text === 'string' && text.length > 1_000_000) count++;
    return parse.call(this, text, ...rest);
  };
  try {
    await run();
  } finally {
    JSON.parse = parse;
  }
  return count;
}

test('a request pinning 8 objects of a large Sync decodes that Sync at most once per run', async () => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('test');
  const base = { provider: 'claude-cli', permission: 'candidate', sketches: [], files: [] };
  workspace.submit(project.id, { ...base, id: 'sync', body: 'sync', pins: [] });
  const model = largeSync();
  workspace.update(project.id, 'sync', 'succeeded', model);
  assert.ok(JSON.stringify(model).length > 10_000_000, 'the Sync is a large model');
  // Stored per object (PLAN-27 1단계): pins and checks never rebuild the whole model.
  assert.ok(workspace.model(project.id, 'sync'));
  let loads = 0;
  const load = workspace.models.load.bind(workspace.models);
  workspace.models.load = (...args) => (loads++, load(...args));
  let task;
  const execution = new Execution(workspace, {
    sdk: {
      run: async (value) => {
        task = value;
        return { text: 'Read only', hostExecuted: false };
      },
    },
  });
  try {
    const pins = Array.from({ length: 8 }, (_, i) => ({
      id: `object-${i * 7}`,
      basis: 'sync',
      role: 'target',
    }));
    let request;
    const onSubmit = await largeDecodes(() => {
      request = workspace.submit(project.id, {
        ...base,
        id: 'pinned',
        body: '기둥 대안',
        baseRequestId: 'sync',
        pins,
      }).request;
    });
    // The geometry-free row is decoded once and kept; before: once per pin plus the basis (9).
    assert.ok(onSubmit <= 1, `submit decoded the Sync ${onSubmit} times`);
    assert.equal(loads, 0, 'submit rebuilt the stored model');
    const onRun = await largeDecodes(async () => {
      execution.start(request);
      await Promise.all([...execution.active.values()].map((item) => item.completion));
    });
    assert.ok(onRun <= 1, `the run decoded the Sync ${onRun} times`);
    assert.equal(loads, 1, 'the run rebuilds its basis once');
    assert.equal(workspace.get(project.id, 'pinned').state, 'succeeded');
    // The run still gets the whole model and every pinned object.
    assert.equal(task.previous.result.scene.length, 400);
    assert.equal(task.previous.result.scene[7].vertices.length, 6000);
    const referenced = task.items.find((item) => item.id === 'referenced-geometry');
    assert.deepEqual(
      referenced.data.map((entry) => entry.object.id),
      pins.map((pin) => pin.id),
    );
  } finally {
    store.close();
  }
});

// PLAN-28 T-123: an AI turn on a display Sync never assembles its model. The basis is the small
// result and a lazy view; the model summary reads the pinned objects and the first ones only.
test('a turn on a large display Sync rebuilds no model and summarizes from the stored rows', async () => {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('test');
  const base = { provider: 'claude-cli', permission: 'candidate', sketches: [], files: [] };
  workspace.submit(project.id, { ...base, id: 'sync', body: 'sync', pins: [] });
  // A display Sync's object row and scene item share the native id (one manifest key each).
  const model = largeSync();
  model.scene = model.scene.map((item, i) => ({ ...item, nativeId: model.objects[i].nativeId }));
  workspace.update(project.id, 'sync', 'succeeded', {
    ...model,
    displayOnly: true,
    executionMode: 'sdk',
    sourceDocument: {
      instance: '1:2:356ff01d-b586-460c-8e2b-8c9f3c083e96',
      documentId: 7,
      documentHash: 'd'.repeat(64),
      revision: 3,
      name: 'Large',
      capturedAt: '2026-10-06T00:00:00.000Z',
      connection: 'attached-editor',
    },
  });
  let loads = 0;
  const load = workspace.models.load.bind(workspace.models);
  workspace.models.load = (...args) => (loads++, load(...args));
  let task;
  const execution = new Execution(workspace, {
    sdk: {
      run: async (value) => {
        task = value;
        return { text: 'Read only', hostExecuted: false };
      },
    },
  });
  try {
    const request = workspace.submit(project.id, {
      ...base,
      id: 'turn',
      body: '기둥 대안',
      baseRequestId: 'sync',
      pins: [{ id: 'object-321', basis: 'sync', role: 'target' }],
    }).request;
    const decodes = await largeDecodes(async () => {
      execution.start(request);
      await Promise.all([...execution.active.values()].map((item) => item.completion));
    });
    assert.equal(decodes, 0);
    assert.equal(loads, 0, 'the turn rebuilt the display Sync');
    assert.equal(workspace.get(project.id, 'turn').state, 'succeeded');
    assert.equal(task.previous.id, 'sync');
    assert.equal(task.previous.result.scene, undefined);
    assert.equal(task.previous.result.sourceDocument.revision, 3);
    const model = task.items.find((item) => item.id === 'working-model').data;
    assert.equal(model[0].id, 'object-321', 'the pinned object comes first');
    assert.equal(model.length, 100);
    const summary = task.items.find((item) => item.id === 'model-context-summary').data;
    assert.equal(summary.total, 400);
    const measured = task.items.find((item) => item.id === 'measurements').data;
    assert.equal(measured[0].area, 321);
  } finally {
    store.close();
  }
});
