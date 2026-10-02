import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';

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
    handlers: { status: () => ({ state: 'idle' }) },
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

test('stale basis, exhausted budget and revoked scope prevent executor invocation', async (t) => {
  const { app, connect } = await fixture(t);
  let current = false,
    executions = 0;
  const scope = app.agentTools.issue({
    targetRef: 'synthetic:A',
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
  assert.equal(payload(await client.callTool(request)).code, 'STALE_REFERENCE');
  current = true;
  assert.deepEqual(payload(await client.callTool(request)), { synthetic: true });
  assert.equal(payload(await client.callTool(request)).code, 'AGENT_CALL_LIMIT');
  assert.equal(executions, 1);
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
    handlers: { status: () => ({}) },
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
