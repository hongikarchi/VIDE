// Direct mode end to end (ADR-022): HTTP routes → Execution → SdkExecution → EditorSessions →
// editor channel parsing, over a mocked attached Rhino connection that answers direct-execute,
// direct-undo and fingerprint the way the worker does (DirectExecution.cs). Scripted provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../../src/server/server.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { editorMethods } from '../../hosts/rhino/editor-channel.ts';

const hash = (n) => n.toString(16).padStart(64, '0');
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** The attached document: an undo stack of records, answering the worker's wire shapes. */
function rhinoHost() {
  const calls = [];
  const records = []; // { serial, undone }
  let serial = 40,
    revision = 1,
    made = 0;
  const latest = () => records.filter((r) => !r.undone).at(-1);
  const answer = (method, extra) => {
    if (method === 'fingerprint') return { ok: true, documentHash: hash(revision), revision };
    if (method === 'attachedStatus')
      return {
        ok: true,
        documentId: 7,
        name: 'model.3dm',
        units: 'Millimeters',
        objectCount: made,
        modified: true,
        generation: revision,
        live: true,
        busy: false,
      };
    if (method === 'direct-execute') {
      const { code, guard, label } = extra;
      assert.ok(label && label.length <= 80);
      if (code.startsWith('bad'))
        return { ok: false, code: 'COMPILE_ERROR', diagnostics: ['CS1002: ; expected'] };
      const removes = code.startsWith('wipe') ? 600 : 0;
      // The worker runs inside the record, counts the deletions, and undoes a guarded run.
      if (removes > guard.maxDeletes && !guard.confirmed)
        return {
          ok: false,
          reverted: true,
          guarded: {
            kind: 'bulk-delete',
            detail: `객체 ${removes}개를 지웁니다 (기준 ${guard.maxDeletes}개).`,
            deletes: removes,
          },
          log: '',
        };
      serial++;
      revision++;
      records.push({ serial, undone: false });
      const added = removes
        ? []
        : [{ nativeId: uuid(++made), hash: hash(900 + made), layer: 'Walls' }];
      return {
        ok: true,
        undoId: String(serial),
        changes: {
          added,
          changed: [],
          removed: Array.from({ length: removes }, (_, i) => ({
            nativeId: uuid(500 + i),
            layer: 'Old',
          })),
          counts: { added: added.length, changed: 0, removed: removes },
        },
        log: 'done\n',
        value: { made },
        units: 'Millimeters',
      };
    }
    if (method === 'direct-undo') {
      const record = records.find((r) => String(r.serial) === extra.undoId);
      if (!record) return { ok: false, reason: 'unknown' };
      if (record.undone) return { ok: true, already: true };
      if (latest() !== record) return { ok: false, reason: 'not-latest' };
      record.undone = true;
      revision++;
      return { ok: true };
    }
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  };
  const call = async (method, extra = {}) => {
    calls.push({ method, ...extra });
    return answer(method, extra);
  };
  return { call, calls, records, bump: () => records.push({ serial: ++serial, undone: false }) };
}

/** A provider whose turn is a script over the MCP scope it was given (called in-process). */
function scripted(app, script) {
  const seen = [];
  const providerFactory = ({ agent }) => ({
    async run(context) {
      seen.push({ agent, context });
      const call = async (name, args = {}) => {
        const result = await app().agentTools.call(agent.token, name, {
          targetRef: agent.targetRef,
          ...args,
        });
        return { error: result.isError === true, value: JSON.parse(result.content.at(-1).text) };
      };
      return script({ agent, context, call, turn: seen.length });
    },
    async status() {
      return { available: true };
    },
  });
  return { providerFactory, seen };
}

async function setup(t, script) {
  const root = await mkdtemp(join(tmpdir(), 'vide-direct-e2e-'));
  const connections = join(root, 'rhino-connections');
  await mkdir(connections, { recursive: true });
  const executable = join(root, 'Rhino.exe'),
    plugin = join(root, 'vide.rhp'),
    bootstrap = join(root, 'bootstrap.exe');
  for (const file of [executable, plugin, bootstrap]) await writeFile(file, '');
  const host = rhinoHost();
  const identity = {
    port: 45123,
    pid: 4321,
    startTicks: '99',
    sessionId: randomUUID(),
    documentId: 7,
    revision: 0,
  };
  await writeFile(
    join(connections, identity.sessionId + '.json'),
    JSON.stringify({ identity, token: 'b'.repeat(64), executable }),
  );
  let app;
  const { providerFactory, seen } = scripted(() => app, script);
  app = await startServer({
    filename: join(root, 'vide.db'),
    host: { status: async () => ({ available: true }) },
    providerFactory,
    sdkOptions: {
      directory: join(root, 'sdk-models'),
      executable,
      plugin,
      bootstrap,
      connectionDirectory: connections,
      // The attached connection: the real channel methods over the mocked worker.
      resume: (connection) => ({
        ...editorMethods(host.call),
        identity: connection.identity,
        editorConnection: connection,
      }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const login = await fetch(app.origin + '/api/v1/session', {
    method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: new URL(app.launchUrl).hash.slice(1) }),
  });
  const headers = {
    Origin: app.origin,
    'Content-Type': 'application/json',
    Cookie: login.headers.get('set-cookie').split(';')[0],
  };
  const api = async (path, method = 'GET', data) => {
    const response = await fetch(app.origin + '/api/v1' + path, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const project = (await api('/projects', 'POST', { name: 'direct' })).body;
  // The Sync of the attached document (a display read) is the basis of every turn.
  const instance = `${identity.pid}:${identity.startTicks}:${identity.sessionId}`;
  const workspace = new Workspace(app.store);
  workspace.submit(project.id, {
    id: 'sync-1',
    body: 'Sync',
    mode: 'plan',
    provider: 'claude-cli',
    pins: [],
    sketches: [],
    files: [],
  });
  workspace.update(project.id, 'sync-1', 'succeeded', {
    host: 'rhino',
    hostExecuted: true,
    displayOnly: true,
    objects: [],
    scene: [],
    sourceDocument: {
      instance,
      documentId: identity.documentId,
      documentHash: hash(1),
      revision: 1,
      connection: 'attached-editor',
      name: 'model.3dm',
      capturedAt: '2026-09-30T00:00:00.000Z',
    },
  });
  const path = `/projects/${project.id}/requests`;
  const send = async (id, fields = {}) =>
    api(path, 'POST', {
      id,
      body: '벽 추가',
      provider: 'claude-cli',
      pins: [],
      sketches: [],
      files: [],
      baseRequestId: 'sync-1',
      ...fields,
    });
  const settled = async (id) => {
    for (let i = 0; i < 400; i++) {
      const { body } = await api(`${path}/${id}`);
      if (body && !['queued', 'running'].includes(body.state)) return body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('request did not settle: ' + id);
  };
  return { api, path, send, settled, host, seen, instance };
}

test('Auto over HTTP: two executes are two undo records; [되돌리기] only undoes the latest', async (t) => {
  const answers = [];
  const { api, path, send, settled, host, seen } = await setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'bad body' }));
    answers.push(await call('execute', { code: 'add wall one' }));
    answers.push(await call('execute', { code: 'add wall two' }));
    return { text: '벽 2개를 추가했습니다. Ctrl+Z나 [되돌리기]로 되돌릴 수 있습니다.' };
  });
  assert.equal((await send('auto-1', { mode: 'auto' })).status, 202);
  const done = await settled('auto-1');
  assert.equal(done.state, 'succeeded', JSON.stringify(done.result));
  assert.ok(seen[0].agent.tools.includes('execute'));
  // Compile errors go back to the model through the channel's result parsing.
  assert.equal(answers[0].value.code, 'COMPILE_ERROR');
  assert.deepEqual(
    answers.slice(1).map((a) => a.value.undoId),
    ['41', '42'],
  );
  assert.equal(answers[1].value.changes.counts.added, 1);
  // The wire command carries the direct-mode contract.
  const executes = host.calls.filter((c) => c.method === 'direct-execute');
  assert.equal(executes.length, 3);
  for (const command of executes) {
    assert.equal(typeof command.requestId, 'string');
    assert.deepEqual(command.guard, { confirmed: false, maxDeletes: 500 });
    assert.match(command.label, /^VIDE AI \d: /);
  }
  assert.equal(done.result.mode, 'auto');
  assert.equal(done.result.executionMode, 'direct');
  assert.equal(done.result.appliedDirectly, true);
  const [first, second] = done.result.executions;
  assert.equal(done.result.executions.length, 2);
  assert.deepEqual([first.undoId, second.undoId], ['41', '42']);
  assert.ok(done.result.executions.every((e) => e.state === 'applied' && e.code === undefined));

  // The older record is not the document's latest: not-latest, nothing undone.
  const older = await api(`${path}/auto-1/undo`, 'POST', { executionId: first.executionId });
  assert.equal(older.status, 200);
  assert.deepEqual([older.body.ok, older.body.reason], [false, 'not-latest']);
  // The latest one is undone by the host.
  const latest = await api(`${path}/auto-1/undo?view=summary`, 'POST', {
    executionId: second.executionId,
  });
  assert.equal(latest.body.ok, true);
  assert.equal(latest.body.request.result.scene, undefined);
  assert.equal(latest.body.request.result.definitions, undefined);
  assert.equal(latest.body.request.result.executions[1].state, 'undone');
  assert.deepEqual(
    host.calls.filter((c) => c.method === 'direct-undo').map((c) => c.undoId),
    ['41', '42'],
  );
  // Now the first one is the latest again; a second [되돌리기] on an undone one is a no-op.
  assert.equal(
    (await api(`${path}/auto-1/undo`, 'POST', { executionId: first.executionId })).body.ok,
    true,
  );
  const again = await api(`${path}/auto-1/undo`, 'POST', { executionId: second.executionId });
  assert.equal(again.body.already, true);
  assert.equal(host.calls.filter((c) => c.method === 'direct-undo').length, 3);
  assert.equal((await api(`${path}/auto-1/undo`, 'POST', { executionId: 'missing' })).status, 404);
});

test('Auto over HTTP: a tripped guard waits on its card; [진행] re-runs the body released', async (t) => {
  const answers = [];
  const { api, path, send, settled, host } = await setup(t, async ({ call }) => {
    answers.push(await call('execute', { code: 'wipe old layer' }));
    return { text: '객체 600개 삭제는 확인이 필요합니다.' };
  });
  // The old permission value still maps: candidate is Auto.
  await send('guard-1', { permission: 'candidate' });
  const waiting = await settled('guard-1');
  assert.equal(waiting.state, 'needs-confirmation');
  assert.equal(answers[0].value.guarded.kind, 'bulk-delete');
  assert.equal(waiting.result.guarded.kind, 'bulk-delete');
  const [held] = waiting.result.executions;
  assert.equal(held.state, 'guarded');
  assert.equal(held.undoId, null);
  // Nothing stayed applied: the host recorded no undo record.
  assert.equal(host.records.length, 0);

  const confirmed = await api(`${path}/guard-1/confirm`, 'POST', {
    executionId: held.executionId,
  });
  assert.equal(confirmed.status, 202);
  assert.equal(confirmed.body.state, 'succeeded');
  const rerun = host.calls.filter((c) => c.method === 'direct-execute').at(-1);
  assert.equal(rerun.code, 'wipe old layer');
  assert.deepEqual(rerun.guard, { confirmed: true, maxDeletes: 500 });
  const [first, applied] = confirmed.body.result.executions;
  assert.equal(first.state, 'confirmed');
  assert.equal(first.code, undefined);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.confirms, held.executionId);
  assert.equal(applied.changes.removed.length, 600);
  // The confirmed run is its own undo record, undoable from VIDE.
  const undone = await api(`${path}/guard-1/undo`, 'POST', { executionId: applied.executionId });
  assert.equal(undone.body.ok, true);
  // A second [진행] on a settled request is refused.
  assert.equal((await api(`${path}/guard-1/confirm`, 'POST', {})).status, 409);
});

test('Plan over HTTP: no execute, a plan card, and [진행] continues in Auto', async (t) => {
  const { api, path, send, settled, host, seen } = await setup(t, async ({ call, agent }) => {
    if (!agent.tools.includes('execute')) {
      const tried = await call('execute', { code: 'add wall' });
      assert.equal(tried.error, true);
      return {
        text:
          '벽을 넣겠습니다.\n```json\n' +
          JSON.stringify({
            plan: {
              steps: [{ title: '벽 레이어 확인' }, { title: '벽 1개 추가', risk: '창과 겹침' }],
              questions: ['두께 200mm로 할까요?'],
            },
          }) +
          '\n```',
      };
    }
    await call('execute', { code: 'add wall' });
    return { text: '계획대로 추가했습니다.' };
  });
  await send('plan-1', { mode: 'plan' });
  const planned = await settled('plan-1');
  assert.equal(planned.state, 'succeeded', JSON.stringify(planned.result));
  assert.equal(planned.result.mode, 'plan');
  assert.equal(planned.result.plan.steps.length, 2);
  assert.equal(planned.result.text, '벽을 넣겠습니다.');
  assert.equal(host.calls.filter((c) => c.method === 'direct-execute').length, 0);

  const next = await api(`${path}/plan-1/continue`, 'POST', {});
  assert.equal(next.status, 202);
  assert.equal(next.body.id, 'plan-1-go');
  assert.equal(next.body.input.mode, 'auto');
  assert.match(next.body.input.body, /\[계획\]\n1\. 벽 레이어 확인/);
  const went = await settled('plan-1-go');
  assert.equal(went.state, 'succeeded', JSON.stringify(went.result));
  assert.equal(went.result.executions.length, 1);
  assert.equal(went.result.executions[0].undoId, '41');
  assert.equal(seen.length, 2);
  // [진행] is idempotent, and an Auto turn cannot be continued.
  assert.equal((await api(`${path}/plan-1/continue`, 'POST', {})).body.id, 'plan-1-go');
  assert.equal(seen.length, 2);
  assert.equal((await api(`${path}/plan-1-go/continue`, 'POST', {})).status, 409);
});

test('[되돌리기] of the whole request over HTTP ({all: true}) undoes every record, last first', async (t) => {
  const { api, path, send, settled, host } = await setup(t, async ({ call }) => {
    await call('execute', { code: 'add wall one' });
    await call('execute', { code: 'add wall two' });
    return { text: '벽 2개를 추가했습니다.' };
  });
  await send('all-1', { mode: 'auto' });
  assert.equal((await settled('all-1')).state, 'succeeded');
  const undone = await api(`${path}/all-1/undo`, 'POST', { all: true });
  assert.equal(undone.status, 200);
  assert.equal(undone.body.ok, true);
  assert.deepEqual(
    host.calls.filter((c) => c.method === 'direct-undo').map((c) => c.undoId),
    ['42', '41'],
  );
  assert.ok(undone.body.request.result.executions.every((e) => e.state === 'undone'));
  assert.deepEqual(
    undone.body.files.map((file) => [file.state, file.undone]),
    [['undone', 2]],
  );
  const again = await api(`${path}/all-1/undo`, 'POST', { all: true });
  assert.equal(again.body.already, true);
});
