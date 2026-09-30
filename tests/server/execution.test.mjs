import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Execution } from '../../src/server/execution.ts';

function fixture() {
  const store = new Store(':memory:'),
    workspace = new Workspace(store),
    project = store.createProject('test');
  const input = {
    id: 'request-1',
    body: '경계 검토',
    provider: 'claude-cli',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
  };
  return { store, workspace, project, input };
}

test('SDK dispatch receives bounded metadata while retaining the full basis and protected pins', async () => {
  const { store, workspace, project, input } = fixture();
  const objects = Array.from({ length: 500 }, (_, i) => ({
    id: `object-${i}`,
    name: `Object ${i}`,
    kind: 'native',
    nativeId: `native-${i}`,
    origin: [i, 0, 0],
  }));
  workspace.submit(project.id, input);
  workspace.update(project.id, input.id, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    objects,
    scene: [],
  });
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
    const pins = [{ id: 'object-499', name: 'Object 499', basis: input.id, role: 'preserve' }];
    const request = workspace.submit(project.id, {
      ...input,
      id: 'sdk-context',
      baseRequestId: input.id,
      pins,
    }).request;
    execution.start(request);
    await Promise.all([...execution.active.values()].map((item) => item.completion));
    assert.equal(workspace.get(project.id, request.id).state, 'succeeded');
    assert.equal(task.previous.result.objects.length, 500);
    assert.deepEqual(task.input.pins, pins);
    assert.equal(task.items.find((item) => item.id === 'working-model').data[0].id, 'object-499');
    assert.equal(task.items.find((item) => item.id === 'model-context-summary').data.omitted, 400);
  } finally {
    store.close();
  }
});

test('explicit empty basis never picks the latest model and refuses writable pins from an unselected basis', async () => {
  const { store, workspace, project, input } = fixture();
  let received;
  workspace.submit(project.id, input);
  workspace.update(project.id, input.id, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    objects: [
      { id: 'existing', kind: 'box', name: 'Existing', origin: [0, 0, 0], size: [1, 1, 1] },
    ],
    scene: [],
  });
  const execution = new Execution(workspace, {
    host: {},
    providerFactory: () => ({
      run: async (packet) => {
        received = packet;
        return { text: JSON.stringify({ message: 'No model selected', operations: [] }) };
      },
    }),
  });
  try {
    assert.throws(
      () =>
        workspace.submit(project.id, {
          ...input,
          id: 'wrong-pin',
          baseRequestId: null,
          pins: [{ id: 'existing', name: 'Existing', basis: input.id, role: 'target' }],
        }),
      { code: 'STALE_REFERENCE' },
    );
    const request = workspace.submit(project.id, {
      ...input,
      id: 'empty-basis',
      baseRequestId: null,
    }).request;
    execution.start(request);
    await Promise.all([...execution.active.values()].map((item) => item.completion));
    assert.deepEqual(received.items.find((item) => item.id === 'working-model').data, []);
    assert.equal(
      received.items.some((item) => item.id === 'measurements'),
      false,
    );
    assert.equal(workspace.get(project.id, request.id).input.baseRequestId, null);
    assert.equal(workspace.get(project.id, request.id).state, 'succeeded');
  } finally {
    store.close();
  }
});

test('AI receives native lengths, world bounds and decoded layers instead of sampled viewport geometry', async () => {
  const { store, workspace, project, input } = fixture();
  let received;
  const source = {
    id: 'curve',
    kind: 'native',
    nativeId: 'guid',
    name: 'Circle',
    origin: [-2, -2, 0],
  };
  workspace.submit(project.id, input);
  workspace.update(project.id, input.id, 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    objects: [source],
    scene: [
      {
        id: 'curve',
        length: 4 * Math.PI,
        boundsSize: [4, 4, 0],
        layer64: Buffer.from('대지').toString('base64'),
        area: 4 * Math.PI,
        volume: null,
        line: [1, 2, 3],
        attributes64: [
          [
            Buffer.from('PrivateKey').toString('base64'),
            Buffer.from('PrivateValue').toString('base64'),
          ],
        ],
        attributesComplete: true,
      },
    ],
  });
  const execution = new Execution(workspace, {
    host: {},
    providerFactory: () => ({
      run: async (packet) => {
        received = packet;
        return { text: JSON.stringify({ message: 'Measured circle', operations: [] }) };
      },
    }),
  });
  try {
    execution.start(
      workspace.submit(project.id, { ...input, id: 'measure-followup', baseRequestId: input.id })
        .request,
    );
    await Promise.all([...execution.active.values()].map((item) => item.completion));
    const measure = received.items.find((item) => item.id === 'measurements').data[0];
    assert.equal(measure.length, 4 * Math.PI);
    assert.equal(JSON.stringify(received).includes('PrivateValue'), false);
    assert.equal(JSON.stringify(received).includes('UHJpdmF0ZVZhbHVl'), false);
    assert.equal(measure.attributes64, undefined);
    assert.deepEqual(measure.boundsSize, [4, 4, 0]);
    assert.equal(measure.layer, '대지');
    assert.equal(measure.line, undefined);
    assert.equal(workspace.get(project.id, 'measure-followup').state, 'succeeded');
  } finally {
    store.close();
  }
});

test('CLI path changes only affect providers created for subsequent requests', async () => {
  const { store, workspace, project, input } = fixture();
  let path = 'C:/first/codex.exe',
    release;
  input.provider = 'codex-cli';
  const seen = [];
  const execution = new Execution(workspace, {
    settings: { get: () => ({ paths: { 'codex-cli': path } }) },
    providerFactory: (options) => ({
      run: async () => {
        seen.push(options.executable);
        await new Promise((resolve) => (release = resolve));
        return { text: 'Done' };
      },
    }),
  });
  try {
    execution.start(workspace.submit(project.id, input).request);
    path = 'C:/second/codex.exe';
    release();
    await Promise.all([...execution.active.values()].map((item) => item.completion));
    execution.start(workspace.submit(project.id, { ...input, id: 'next-settings' }).request);
    release();
    await Promise.all([...execution.active.values()].map((item) => item.completion));
    assert.deepEqual(seen, ['C:/first/codex.exe', 'C:/second/codex.exe']);
  } finally {
    store.close();
  }
});
test('request retry is idempotent and rejects changed payload or foreign project', () => {
  const { store, workspace, project, input } = fixture();
  try {
    assert.equal(workspace.submit(project.id, input).created, true);
    assert.equal(workspace.submit(project.id, input).created, false);
    assert.throws(() => workspace.submit(project.id, { ...input, body: '다른 요청' }), {
      code: 'REVISION_CONFLICT',
    });
    assert.throws(() => workspace.submit(store.createProject('other').id, input), {
      code: 'REVISION_CONFLICT',
    });
  } finally {
    store.close();
  }
});
test('provider response is persisted without claiming host execution', async () => {
  const { store, workspace, project, input } = fixture();
  const execution = new Execution(workspace, {
    providerFactory: () => ({ run: async () => ({ text: '검토 결과' }) }),
  });
  execution.start(workspace.submit(project.id, input).request);
  await Promise.all([...execution.active.values()].map((x) => x.completion));
  assert.equal(workspace.get(project.id, input.id).result.hostExecuted, false);
  assert.equal(workspace.get(project.id, input.id).state, 'succeeded');
  store.close();
});
test('provider failure and interrupted restart cannot become successful host work', async () => {
  const { store, workspace, project, input } = fixture();
  const execution = new Execution(workspace, {
    providerFactory: () => ({
      run: async () => {
        throw { code: 'SUBSCRIPTION_LOGIN_REQUIRED' };
      },
    }),
  });
  execution.start(workspace.submit(project.id, input).request);
  await Promise.all([...execution.active.values()].map((x) => x.completion));
  assert.equal(workspace.get(project.id, input.id).state, 'failed');
  workspace.update(project.id, input.id, 'running');
  new Workspace(store);
  assert.equal(workspace.get(project.id, input.id).state, 'interrupted');
  store.close();
});
test('cross-host references are read-only input and cannot become the wrong output baseline', () => {
  const { store, workspace, project, input } = fixture();
  try {
    workspace.submit(project.id, { ...input, host: 'zwcad' });
    workspace.update(project.id, input.id, 'succeeded', {
      host: 'zwcad',
      hostExecuted: true,
      objects: [{ id: 'boundary' }],
    });
    const cross = {
      ...input,
      id: 'rhino-request',
      host: 'rhino',
      permission: 'candidate',
      pins: [{ id: 'boundary', basis: input.id, role: 'target' }],
    };
    assert.throws(() => workspace.submit(project.id, { ...cross, baseRequestId: input.id }), {
      code: 'TARGET_MISMATCH',
    });
    assert.equal(workspace.submit(project.id, cross).created, true);
    // SPEC-02.9: a later write of that host waits behind it instead of being refused.
    assert.equal(
      workspace.submit(project.id, { ...cross, id: 'overlap', pins: [] }).request.result.waitingFor
        .after,
      'rhino-request',
    );
  } finally {
    store.close();
  }
});

test('restart during host execution preserves unknown intent and blocks new writes on that host', () => {
  const { store, workspace, project, input } = fixture();
  try {
    workspace.submit(project.id, { ...input, permission: 'candidate' });
    workspace.update(project.id, input.id, 'running', {
      phase: 'host',
      objects: [{ id: 'planned' }],
      host: 'rhino',
      hostExecuted: false,
    });
    const resumed = new Workspace(store);
    const saved = resumed.get(project.id, input.id);
    assert.equal(saved.state, 'unknown');
    assert.equal(saved.result.objects[0].id, 'planned');
    assert.throws(
      () => resumed.submit(project.id, { ...input, id: 'new-write', permission: 'candidate' }),
      { code: 'HOST_RESULT_UNRESOLVED' },
    );
    assert.equal(resumed.submit(project.id, { ...input, id: 'read-only' }).created, true);
  } finally {
    store.close();
  }
});
test('host transport uncertainty retains intended geometry and cannot be reported as ordinary failure', async () => {
  const { store, workspace, project, input } = fixture();
  const object = { id: 'box', kind: 'box', name: 'Box', origin: [0, 0, 0], size: [1, 1, 1] };
  const execution = new Execution(workspace, {
    host: {
      build: async () => {
        throw { code: 'HOST_RESULT_UNKNOWN' };
      },
    },
    providerFactory: () => ({
      run: async () => ({ text: JSON.stringify({ message: 'create', operations: [object] }) }),
    }),
  });
  try {
    execution.start(workspace.submit(project.id, { ...input, permission: 'candidate' }).request);
    await Promise.all([...execution.active.values()].map((x) => x.completion));
    const saved = workspace.get(project.id, input.id);
    assert.equal(saved.state, 'unknown');
    assert.deepEqual(saved.result.objects, [object]);
    assert.equal(saved.result.hostExecuted, false);
  } finally {
    store.close();
  }
});

test('malformed host response after execution preserves uncertainty instead of allowing a blind retry', async () => {
  const { store, workspace, project, input } = fixture();
  const object = { id: 'box', kind: 'box', name: 'Box', origin: [0, 0, 0], size: [1, 1, 1] };
  const execution = new Execution(workspace, {
    host: { build: async () => ({ scene: 'invalid' }) },
    providerFactory: () => ({
      run: async () => ({ text: JSON.stringify({ message: 'create', operations: [object] }) }),
    }),
  });
  try {
    execution.start(workspace.submit(project.id, { ...input, permission: 'candidate' }).request);
    await Promise.all([...execution.active.values()].map((x) => x.completion));
    const saved = workspace.get(project.id, input.id);
    assert.equal(saved.state, 'unknown');
    assert.equal(saved.result.code, 'HOST_RESULT_UNKNOWN');
    assert.deepEqual(saved.result.objects, [object]);
    assert.throws(
      () => workspace.submit(project.id, { ...input, id: 'retry', permission: 'candidate' }),
      { code: 'HOST_RESULT_UNRESOLVED' },
    );
  } finally {
    store.close();
  }
});

for (const available of [true, false]) {
  test(`mixed LINE candidates use the SDK without falling back to legacy templates; sdk=${available}`, async () => {
    const { store, workspace, project, input } = fixture();
    let calls = 0;
    workspace.submit(project.id, { ...input, host: 'zwcad' });
    workspace.update(project.id, input.id, 'succeeded', {
      host: 'zwcad',
      hostExecuted: true,
      verified: true,
      referenceOnly: true,
      dwgEditMode: 'linear-entities-v1',
      objects: [],
      scene: [],
    });
    const execution = new Execution(workspace, {
      zwcadSdk: available
        ? {
            run: async () => {
              calls++;
              return { text: 'SDK result', hostExecuted: true };
            },
          }
        : undefined,
      providerFactory: () => {
        throw Error('Legacy provider must not run');
      },
    });
    try {
      const request = workspace.submit(project.id, {
        ...input,
        host: 'zwcad',
        id: 'followup',
        permission: 'candidate',
        baseRequestId: input.id,
      }).request;
      execution.start(request);
      await Promise.all([...execution.active.values()].map((item) => item.completion));
      const saved = workspace.get(project.id, request.id);
      assert.equal(calls, available ? 1 : 0);
      assert.equal(saved.state, available ? 'succeeded' : 'failed');
      if (!available) assert.equal(saved.result.code, 'ZWCAD_REFERENCE_ONLY');
    } finally {
      store.close();
    }
  });
}

test('host modeling turns get the project read tools of SPEC-02.6 beside their host tools', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { HOST_TURN_PROJECT_TOOLS, hostTurnProjectHandlers } =
    await import('../../src/server/execution.ts');
  const root = mkdtempSync(join(tmpdir(), 'vide-host-tools-'));
  const store = new Store(join(root, 'vide.sqlite'));
  try {
    const workspace = new Workspace(store);
    const project = store.createProject('호스트 도구');
    const handlers = hostTurnProjectHandlers(workspace, {
      id: 'c-host',
      projectId: project.id,
      jigInstanceId: null,
    });
    // project_* come with the project's facts DB; this project has none, so only the link tools.
    assert.ok(Object.keys(handlers).every((name) => HOST_TURN_PROJECT_TOOLS.includes(name)));
    assert.deepEqual(Object.keys(handlers).sort(), ['links_layers', 'sync_sample']);
    // Nothing that writes a document, a jig setting or a draft.
    for (const name of ['execute', 'query', 'jig_set', 'jig_run', 'jig_delete_file'])
      assert.equal(handlers[name], undefined, name);
    const layers = await handlers.links_layers({}, { signal: new AbortController().signal });
    assert.ok(layers && typeof layers === 'object');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
