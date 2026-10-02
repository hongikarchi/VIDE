import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import {
  ZwcadSdkExecution,
  directMode,
  DIRECT_MAX_DELETES,
} from '../../src/server/zwcad-sdk-execution.ts';

const sessionId = '356ff01d-b586-460c-8e2b-8c9f3c083e96';
const token = 'a'.repeat(64);
const hash = 'b'.repeat(64);

/** A stand-in for the ZWCAD connection plugin: framed JSON over loopback, one drawing. */
async function fakeHost(t, respond) {
  const calls = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32BE(0)) return;
      const envelope = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32BE(0)).toString('utf8'));
      calls.push(envelope.params);
      const body = Buffer.from(
        JSON.stringify({ status: 'success', result: respond(envelope.params) }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(join(tmpdir(), 'vide-zwcad-direct-'));
  const directory = join(root, 'zwcad-connections');
  await mkdir(directory);
  const identity = {
    pid: 4242,
    startTicks: '1234',
    sessionId,
    documentId: sessionId,
    port: server.address().port,
  };
  await writeFile(
    join(directory, sessionId + '.json'),
    JSON.stringify({ attached: true, identity, token, executable: 'C:/ZWCAD/ZWCAD.exe' }),
  );
  t.after(async () => {
    server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { calls, root, directory, target: { instance: `4242:1234:${sessionId}`, documentId: 1 } };
}

const applied = (params) => ({
  ok: true,
  requestId: params.requestId,
  undoId: 'undo-1',
  label: params.label,
  changes: {
    added: [{ nativeId: '2A1', hash, layer: 'A-WALL', type: 'Line' }],
    changed: [{ nativeId: '1F', hash, layer: '0', type: 'Circle' }],
    removed: [{ nativeId: '1E', layer: '0' }],
    layersRemoved: [],
    purged: [],
  },
  log: ['VIDEAIRUN · ' + params.label, '추가 1 · 수정 1 · 삭제 1'],
  documentHash: hash,
  revision: 7,
});

test('directMode maps the old permission values and reads the guard confirmation', () => {
  assert.deepEqual(directMode({ permission: 'review' }), { mode: 'plan', confirmed: false });
  assert.deepEqual(directMode({ permission: 'candidate' }), { mode: 'auto', confirmed: false });
  assert.deepEqual(directMode({ permission: 'apply' }), { mode: 'auto', confirmed: false });
  assert.deepEqual(directMode({ mode: 'plan', permission: 'candidate' }).mode, 'plan');
  assert.equal(directMode({ mode: 'auto', guard: { confirmed: true } }).confirmed, true);
  assert.equal(directMode({ guardConfirmed: true }).confirmed, true);
  assert.equal(directMode({}).mode, 'auto');
  assert.equal(DIRECT_MAX_DELETES, 500);
});

test('direct-execute sends the contract fields and parses changes, guard and undo answers', async (t) => {
  const host = await fakeHost(t, (params) => {
    if (params.method === 'direct-execute')
      return params.code.includes('EraseAll') && !params.guard.confirmed
        ? {
            ok: false,
            code: 'GUARD_CONFIRMATION_REQUIRED',
            guarded: { kind: 'bulk-delete', detail: '객체 800개 삭제 (기준 500개)', count: 800 },
            log: ['VIDEAIRUN · x'],
            pending: { added: 0, changed: 0, removed: 80 },
          }
        : applied(params);
    if (params.method === 'direct-undo')
      return params.undoId === 'undo-1'
        ? { ok: true, documentHash: hash, revision: 8 }
        : { ok: false, reason: 'not-latest' };
    if (params.method === 'fingerprint') return { ok: true, documentHash: hash, revision: 7 };
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  });
  const attached = new AttachedZwcadDocuments(host.directory);

  const done = await attached.directExecute(host.target, {
    requestId: 'r1',
    code: 'return 1;',
    label: '벽 추가',
  });
  assert.equal(done.ok, true);
  assert.equal(done.undoId, 'undo-1');
  assert.deepEqual(
    done.changes.added.map((row) => row.nativeId),
    ['2A1'],
  );
  const sent = host.calls.at(-1);
  assert.equal(sent.method, 'direct-execute');
  assert.equal(sent.token, token);
  assert.deepEqual(sent.guard, { confirmed: false, maxDeletes: 500 });
  assert.equal(sent.label, '벽 추가');

  const held = await attached.directExecute(host.target, {
    requestId: 'r1',
    code: 'EraseAll();',
    label: 'x',
  });
  assert.equal(held.ok, false);
  assert.equal(held.code, 'GUARD_CONFIRMATION_REQUIRED');
  assert.equal(held.guarded.kind, 'bulk-delete');

  const confirmed = await attached.directExecute(host.target, {
    requestId: 'r1',
    code: 'EraseAll();',
    label: 'x',
    guard: { confirmed: true, maxDeletes: 10 },
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(host.calls.at(-1).guard, { confirmed: true, maxDeletes: 10 });

  assert.deepEqual(await attached.directUndo(host.target, 'old'), {
    ok: false,
    reason: 'not-latest',
  });
  assert.equal((await attached.directUndo(host.target, 'undo-1')).ok, true);
  assert.equal(host.calls.at(-1).method, 'direct-undo');
  assert.deepEqual(await attached.fingerprint(host.target), {
    ok: true,
    documentHash: hash,
    revision: 7,
  });
});

function task(host, input, script) {
  const updates = [];
  return {
    updates,
    task: {
      input: { id: 'req-1', body: '벽을 추가', pins: [], ...input },
      previous: {
        id: 'base-1',
        result: {
          displayOnly: true,
          sourceDocument: { ...host.target, connection: 'attached-editor' },
        },
      },
      items: [],
      signal: new AbortController().signal,
      update: (value) => updates.push(value),
      provider: () => ({ run: script }),
    },
  };
}

function execution(host) {
  let handlers;
  const sdk = new ZwcadSdkExecution({
    directory: join(host.root, 'work'),
    origin: () => 'http://127.0.0.1:1',
    tools: {
      issue(scope) {
        handlers = scope.handlers;
        return { token: 't', revoke() {} };
      },
    },
  });
  return { sdk, handlers: () => handlers };
}

test('auto mode routes execute to direct-execute and records undoable executions', async (t) => {
  const host = await fakeHost(t, (params) => {
    if (params.method === 'direct-execute')
      return params.code.includes('EraseAll') && !params.guard.confirmed
        ? {
            ok: false,
            code: 'GUARD_CONFIRMATION_REQUIRED',
            guarded: { kind: 'layer-delete', detail: '레이어 1개 삭제 (A-OLD)' },
          }
        : applied(params);
    if (params.method === 'direct-undo') return { ok: true };
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  });
  const { sdk, handlers } = execution(host);
  const { task: auto } = task(host, { mode: 'auto' }, async () => {
    const first = await handlers().execute({ code: 'return 1;' });
    assert.equal(first.ok, true);
    const held = await handlers().execute({ code: 'EraseAll();' });
    assert.equal(held.guarded.kind, 'layer-delete');
    return { summary: '완료' };
  });
  const result = await sdk.run(auto);
  assert.equal(host.calls.filter((call) => call.method === 'direct-execute').length, 2);
  // Each execute is its own host request (never the turn's id).
  const sent = host.calls.filter((call) => call.method === 'direct-execute');
  assert.notEqual(sent[0].requestId, 'req-1');
  assert.notEqual(sent[0].requestId, sent[1].requestId);
  assert.equal(result.mode, 'auto');
  // The applied record and the held one, in the Rhino record shape (the card re-runs the body).
  assert.deepEqual(
    result.executions.map((entry) => [entry.state, entry.host, entry.undoId]),
    [
      ['applied', 'zwcad', 'undo-1'],
      ['guarded', 'zwcad', null],
    ],
  );
  assert.equal(result.executions[0].executionId, sent[0].requestId);
  assert.deepEqual(result.executions[0].target, host.target);
  assert.equal(result.executions[0].document.revision, 7);
  assert.equal(result.executions[1].code, 'EraseAll();');
  assert.equal(result.guarded.executionId, result.executions[1].executionId);
  assert.deepEqual(result.changes, { added: ['2A1'], modified: ['1F'], removed: ['1E'] });
  assert.equal(result.guarded.kind, 'layer-delete');
  assert.equal(result.appliedDirectly, true);

  assert.deepEqual(await sdk.undo(auto.previous.result.sourceDocument, 'undo-1'), { ok: true });
  assert.equal(host.calls.at(-1).undoId, 'undo-1');
});

test('a confirmed re-run releases the guard; plan mode never writes', async (t) => {
  const host = await fakeHost(t, (params) => {
    if (params.method === 'direct-execute') return applied(params);
    if (params.method === 'runCode') return { ok: true, write: false, value: 3 };
    return { ok: false, code: 'UNSUPPORTED_METHOD' };
  });
  const { sdk, handlers } = execution(host);
  const { task: confirmed } = task(
    host,
    { permission: 'candidate', guard: { confirmed: true } },
    async () => {
      await handlers().execute({ code: 'EraseAll();' });
      return {};
    },
  );
  await sdk.run(confirmed);
  assert.deepEqual(host.calls.at(-1).guard, { confirmed: true, maxDeletes: 500 });

  const { task: plan } = task(host, { mode: 'plan' }, async () => {
    const read = await handlers().execute({ code: 'return 3;' });
    assert.equal(read.value, 3);
    return { plan: { steps: [{ title: '벽 추가' }] } };
  });
  const before = host.calls.length;
  const result = await sdk.run(plan);
  const sent = host.calls.slice(before);
  assert.deepEqual(
    sent.map((call) => [call.method, call.write]),
    [['runCode', false]],
  );
  assert.equal(result.mode, 'plan');
  assert.equal(result.executions.length, 0);
  assert.equal(result.appliedDirectly, false);
});

// User decision 2026-10-01: a refusal before execution is "실행하지 않음" with its reason; an answer
// that may have reached the drawing (HOST_READ_FAILED) stays unknown.
test('a refused execute is not run: a closed drawing stops later executes, busy lets them run', async (t) => {
  let answer = { ok: false, code: 'STALE_CONNECTION', exceptionType: 'InvalidOperationException' };
  const host = await fakeHost(t, (params) =>
    params.method === 'direct-execute' ? (answer ?? applied(params)) : { ok: false, code: 'X' },
  );
  const { sdk, handlers } = execution(host);
  const { task: closed } = task(host, { mode: 'auto' }, async () => {
    const first = await handlers().execute({ code: 'return 1;' });
    const second = await handlers().execute({ code: 'return 1;' });
    assert.equal(first.executed, false);
    assert.equal(first.code, 'STALE_CONNECTION');
    assert.match(first.next, /No execute can succeed/);
    assert.deepEqual(second, first);
    return { summary: '실행하지 않음' };
  });
  const result = await sdk.run(closed);
  assert.equal(host.calls.filter((call) => call.method === 'direct-execute').length, 1);
  assert.equal(result.refused.code, 'STALE_CONNECTION');
  assert.match(result.refused.reason, /다시 연결/);
  assert.equal(result.appliedDirectly, false);

  answer = { ok: false, code: 'HOST_BUSY', exceptionType: 'InvalidOperationException' };
  const { task: busy } = task(host, { mode: 'auto' }, async () => {
    const first = await handlers().execute({ code: 'return 1;' });
    assert.equal(first.executed, false);
    assert.match(first.reason, /명령이 진행 중/);
    answer = undefined;
    assert.equal((await handlers().execute({ code: 'return 1;' })).ok, true);
    return {};
  });
  const after = await sdk.run(busy);
  assert.equal(after.refused, undefined);
  assert.equal(after.appliedDirectly, true);
});

test('a failure that may have reached the drawing stays unknown', async (t) => {
  const host = await fakeHost(t, () => ({
    ok: false,
    code: 'HOST_READ_FAILED',
    exceptionType: 'System.NullReferenceException',
  }));
  const { sdk, handlers } = execution(host);
  const { task: auto } = task(host, { mode: 'auto' }, async () => {
    await assert.rejects(handlers().execute({ code: 'return 1;' }), {
      code: 'HOST_RESULT_UNKNOWN',
    });
    return {};
  });
  await assert.rejects(sdk.run(auto), { code: 'HOST_RESULT_UNKNOWN' });
});
