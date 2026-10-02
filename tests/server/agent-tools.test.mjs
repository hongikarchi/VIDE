import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { AgentTools, RESULT_BYTES, bounded } from '../../src/server/agent-tools.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vide-mcp-test-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map((client) => client.close()));
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const connect = async (token) => {
    const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', app.origin), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  return { app, connect };
}
const payload = (result) => JSON.parse(result.content[0].text);

test('official MCP query transports page and object filter arguments', async (t) => {
  const { app, connect } = await fixture(t);
  let received;
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:page',
    isCurrent: () => true,
    handlers: {
      query: (args) => {
        received = args;
        return { revision: 3, objects: [], page: { offset: 50, total: 50, nextOffset: null } };
      },
    },
  });
  const client = await connect(scope.token);
  const args = {
    targetRef: 'synthetic:page',
    offset: 50,
    limit: 20,
    expectedRevision: 3,
    objectIds: ['a'],
  };
  assert.equal(payload(await client.callTool({ name: 'query', arguments: args })).revision, 3);
  assert.deepEqual(received, args);
});

test('official MCP client lists only granted tools and cannot access another target or browser API', async (t) => {
  const { app, connect } = await fixture(t);
  let calls = 0;
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => true,
    handlers: {
      query: async () => {
        calls++;
        return { objects: 3 };
      },
    },
  });
  const client = await connect(scope.token);
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['query'],
  );
  assert.deepEqual(
    payload(await client.callTool({ name: 'query', arguments: { targetRef: 'synthetic:A' } })),
    { objects: 3 },
  );
  assert.equal(
    payload(await client.callTool({ name: 'query', arguments: { targetRef: 'synthetic:B' } })).code,
    'TARGET_MISMATCH',
  );
  assert.equal(
    (
      await client.callTool({
        name: 'execute',
        arguments: { targetRef: 'synthetic:A', code: 'untrusted' },
      })
    ).isError,
    true,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await fetch(app.origin + '/api/v1/projects', {
        headers: { Authorization: `Bearer ${scope.token}` },
      })
    ).status,
    401,
  );
  scope.revoke();
  await assert.rejects(client.listTools());
});

test('MCP rejects missing credentials, cross-origin calls, malformed inputs and unsupported methods', async (t) => {
  const { app } = await fixture(t);
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => true,
    handlers: { measure: () => ({ state: 'idle' }) },
  });
  const headers = { Authorization: `Bearer ${scope.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(app.origin + '/mcp')).status, 401);
  assert.equal((await fetch(app.origin + '/mcp', { headers })).status, 405);
  assert.equal(
    (
      await fetch(app.origin + '/mcp', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(app.origin + '/mcp', { method: 'POST', headers, body: 'broken' })).status,
    400,
  );
});

test('a stale basis prevents executor invocation; tool calls are not counted (ADR-031 7)', async (t) => {
  const { app, connect } = await fixture(t);
  let current = false,
    executions = 0;
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
    // Accepted for old callers; no longer a cap.
    maxCalls: 2,
    isCurrent: () => current,
    handlers: {
      execute: () => {
        executions++;
        return { synthetic: true };
      },
    },
  });
  const client = await connect(scope.token);
  const request = {
    name: 'execute',
    arguments: { targetRef: 'synthetic:A', code: 'synthetic code' },
  };
  const stale = payload(await client.callTool(request));
  assert.equal(stale.code, 'STALE_REFERENCE');
  assert.match(stale.next, /Read the current state again/);
  current = true;
  for (let i = 0; i < 5; i++)
    assert.deepEqual(payload(await client.callTool(request)), { synthetic: true });
  assert.equal(executions, 5);
});

test('reads run side by side; only a second write is AGENT_BUSY; schema errors name the field', async () => {
  const tools = new AgentTools();
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  let running = 0,
    most = 0;
  const scope = tools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => true,
    handlers: {
      query: async () => {
        running++;
        most = Math.max(most, running);
        await gate;
        running--;
        return { ok: true };
      },
      execute: async () => {
        await gate;
        return { ran: true };
      },
    },
  });
  const read = () => tools.call(scope.token, 'query', { targetRef: 'synthetic:A' });
  const reads = [read(), read(), read()];
  const write = tools.call(scope.token, 'execute', { targetRef: 'synthetic:A', code: 'x' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const busy = JSON.parse(
    (await tools.call(scope.token, 'execute', { targetRef: 'synthetic:A', code: 'y' })).content[0]
      .text,
  );
  assert.equal(busy.code, 'AGENT_BUSY');
  assert.match(busy.next, /reads may run side by side/);
  open();
  await Promise.all([...reads, write]);
  assert.equal(most, 3);
  const invalid = JSON.parse(
    (await tools.call(scope.token, 'query', { targetRef: 'synthetic:A', limit: 'ten' })).content[0]
      .text,
  );
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.deepEqual(
    invalid.fields.map((entry) => entry.field),
    ['limit'],
  );
});

test('a large tool result is cut with truncated and where to read on, not refused (ADR-031 3)', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, text: 'x'.repeat(500) }));
  const page = bounded({ total: 400, offset: 0, items: rows, nextOffset: null });
  assert.equal(page.truncated, true);
  assert.ok(page.items.length > 0 && page.items.length < 400);
  assert.equal(page.nextOffset, page.items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RESULT_BYTES);
  const blob = bounded({ text: 'y'.repeat(RESULT_BYTES * 2) });
  assert.equal(blob.truncated, true);
  assert.ok(blob.partial.length < RESULT_BYTES);
  assert.match(blob.next, /Ask for less/);
  const small = { a: 1 };
  assert.equal(bounded(small), small);
});

test('a scope keeps its tools while the turn keeps calling (the lifetime runs between calls)', async () => {
  let now = 0;
  const tools = new AgentTools({ now: () => now });
  const scope = tools.issue({
    targetRef: 'synthetic:A',
    ttlMs: 100,
    isCurrent: () => true,
    handlers: { measure: () => ({ ok: true }) },
  });
  const call = () => tools.call(scope.token, 'measure', { targetRef: 'synthetic:A', ids: ['a'] });
  for (let i = 0; i < 5; i++) {
    now += 90;
    assert.equal(JSON.parse((await call()).content[0].text).ok, true);
  }
  now += 101;
  assert.equal(JSON.parse((await call()).content[0].text).code, 'AGENT_SCOPE_EXPIRED');
});

test('concurrent execution is rejected; revocation during basis check blocks late execution', async (t) => {
  const { app, connect } = await fixture(t);
  let release, entered;
  const checking = new Promise((resolve) => {
    entered = resolve;
  });
  let executions = 0;
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    handlers: {
      execute: () => {
        executions++;
        return {};
      },
    },
  });
  const client = await connect(scope.token);
  const request = {
    name: 'execute',
    arguments: { targetRef: 'synthetic:A', code: 'synthetic code' },
  };
  const pending = client.callTool(request);
  await checking;
  assert.equal(payload(await client.callTool(request)).code, 'AGENT_BUSY');
  scope.revoke();
  release(true);
  assert.equal(payload(await pending).code, 'AGENT_SCOPE_EXPIRED');
  assert.equal(executions, 0);
});

test('expired tokens cannot initialize MCP and backend exceptions do not leak local details', async (t) => {
  const { app, connect } = await fixture(t);
  const expired = app.agentTools.issue({
    targetRef: 'synthetic:A',
    ttlMs: 1,
    isCurrent: () => true,
    handlers: { measure: () => ({}) },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    (await fetch(app.origin + '/mcp', { headers: { Authorization: `Bearer ${expired.token}` } }))
      .status,
    401,
  );
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => true,
    handlers: {
      query: () => {
        throw new Error('private path and credential');
      },
    },
  });
  const client = await connect(scope.token);
  assert.deepEqual(
    payload(await client.callTool({ name: 'query', arguments: { targetRef: 'synthetic:A' } })),
    { code: 'AGENT_TOOL_FAILED' },
  );
  // A coded failure reaches the model as its own code (ADR-031), with its hint when there is one.
  const sized = app.agentTools.issue({
    targetRef: 'synthetic:A',
    isCurrent: () => true,
    handlers: {
      query: () => {
        throw Object.assign(new Error('private path'), { code: 'HOST_RESULT_TOO_LARGE' });
      },
    },
  });
  const sizedClient = await connect(sized.token);
  const told = payload(
    await sizedClient.callTool({ name: 'query', arguments: { targetRef: 'synthetic:A' } }),
  );
  assert.equal(told.code, 'HOST_RESULT_TOO_LARGE');
  assert.match(told.next, /nextOffset/);
});
