import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AgentTools, ToolImage, visionHandlers } from '../../src/server/agent-tools.ts';
import { agentConnection, agentToolNames } from '../../src/ai/agent-connection.ts';
import { viewMethods } from '../../hosts/rhino/view-tools.ts';
import { startServer } from '../../src/server/server.ts';

// The AI's eyes (PLAN-24): capture_view returns image content, measure returns numbers; both
// come from a host source (worker working copy or attached editor) through fixed methods.
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
const camera = { location: [10, -10, 10], target: [0, 0, 0], parallel: false };
function source(log = []) {
  return {
    async captureView(options) {
      log.push(['captureView', options]);
      return {
        ok: true,
        mimeType: 'image/png',
        width: options.width ?? 1200,
        height: options.height ?? 800,
        data: png,
        view: 'Perspective',
        units: 'Meters',
        camera,
      };
    },
    async measure(options) {
      log.push(['measure', options]);
      return {
        ok: true,
        units: 'Meters',
        objects: (options.ids ?? []).map((id) => ({
          id,
          type: 'Brep',
          bounds: [
            [0, 0, 0],
            [1, 2, 3],
          ],
          size: [1, 2, 3],
          length: null,
          area: 22,
          volume: 6,
        })),
        distances: [],
      };
    },
  };
}

test('capture_view and measure are registered names the connection allows', () => {
  assert.ok(agentToolNames.includes('capture_view') && agentToolNames.includes('measure'));
  const connection = agentConnection({
    url: 'http://127.0.0.1:4000/mcp',
    token: 'a'.repeat(64),
    tools: ['query', 'capture_view', 'measure'],
  });
  assert.deepEqual([...connection.tools], ['query', 'capture_view', 'measure']);
});

test('capture_view returns image content with the camera as text; measure returns numbers', async () => {
  const tools = new AgentTools();
  const log = [];
  const used = [];
  const scope = tools.issue({
    targetRef: 'rhino:synthetic',
    isCurrent: () => true,
    handlers: visionHandlers(source(log), (tool) => used.push(tool)),
  });
  const image = await tools.call(scope.token, 'capture_view', {
    targetRef: 'rhino:synthetic',
    width: 800,
    height: 600,
    fitIds: ['beam-1'],
    hideLayers: ['참조'],
  });
  assert.equal(image.isError, undefined);
  assert.deepEqual(image.content[0], { type: 'image', data: png, mimeType: 'image/png' });
  const meta = JSON.parse(image.content[1].text);
  assert.deepEqual(meta, {
    ok: true,
    width: 800,
    height: 600,
    view: 'Perspective',
    units: 'Meters',
    camera,
  });
  // targetRef stays with the scope; the host gets only the capture options.
  assert.deepEqual(log[0], [
    'captureView',
    { width: 800, height: 600, fitIds: ['beam-1'], hideLayers: ['참조'] },
  ]);
  const measured = await tools.call(scope.token, 'measure', {
    targetRef: 'rhino:synthetic',
    ids: ['beam-1'],
    distances: [{ a: 'beam-1', b: [0, 0, 5] }],
  });
  const value = JSON.parse(measured.content[0].text);
  assert.equal(value.objects[0].volume, 6);
  assert.deepEqual(log[1][1].distances, [{ a: 'beam-1', b: [0, 0, 5] }]);
  assert.deepEqual(used, ['capture_view', 'measure']);
});

test('vision tools refuse bad input, other targets and oversize images', async () => {
  const tools = new AgentTools();
  const big = {
    ...source(),
    async captureView() {
      return { mimeType: 'image/png', data: Buffer.alloc(1_000_001).toString('base64') };
    },
  };
  const scope = tools.issue({
    targetRef: 'rhino:synthetic',
    isCurrent: () => true,
    handlers: visionHandlers(big),
  });
  const code = (result) => JSON.parse(result.content[0].text).code;
  assert.equal(
    code(
      await tools.call(scope.token, 'capture_view', { targetRef: 'rhino:synthetic', width: 4000 }),
    ),
    'INVALID_INPUT',
  );
  assert.equal(
    code(await tools.call(scope.token, 'capture_view', { targetRef: 'rhino:other' })),
    'TARGET_MISMATCH',
  );
  assert.equal(
    code(await tools.call(scope.token, 'capture_view', { targetRef: 'rhino:synthetic' })),
    'QUERY_RESULT_TOO_LARGE',
  );
  assert.equal(
    code(await tools.call(scope.token, 'measure', { targetRef: 'rhino:synthetic' })),
    'INVALID_INPUT',
  );
  assert.equal(
    code(
      await tools.call(scope.token, 'measure', {
        targetRef: 'rhino:synthetic',
        distances: Array.from({ length: 21 }, () => ({ a: 'x', b: 'y' })),
      }),
    ),
    'INVALID_INPUT',
  );
  assert.throws(() => new ToolImage('not base64!', 'image/png'), {
    code: 'QUERY_RESULT_TOO_LARGE',
  });
});

test('capture_view is one-at-a-time and checks the basis like query and execute', async () => {
  const tools = new AgentTools();
  let current = true;
  const scope = tools.issue({
    targetRef: 'rhino:synthetic',
    isCurrent: () => current,
    handlers: visionHandlers(source()),
  });
  current = false;
  const stale = await tools.call(scope.token, 'capture_view', { targetRef: 'rhino:synthetic' });
  assert.equal(JSON.parse(stale.content[0].text).code, 'STALE_REFERENCE');
});

test('the host channel validates options and replies (worker and attached editor)', async () => {
  const calls = [];
  const reply = {
    ok: true,
    mimeType: 'image/png',
    width: 640,
    height: 480,
    data: png,
    view: 'Top',
    units: 'Meters',
    camera: { ...camera, parallel: true },
  };
  const methods = viewMethods(async (method, extra) => {
    calls.push([method, extra]);
    if (method === 'captureView')
      return extra.namedView === 'missing' ? { ok: false, code: 'NOT_FOUND' } : reply;
    return { ok: true, units: 'Meters', objects: [], distances: [] };
  });
  assert.equal((await methods.captureView({ width: 640, height: 480 })).view, 'Top');
  await assert.rejects(methods.captureView({ namedView: 'missing' }), { code: 'NOT_FOUND' });
  await assert.rejects(methods.captureView({ width: 2000 }), { code: 'INVALID_INPUT' });
  await assert.rejects(methods.measure({}), { code: 'INVALID_INPUT' });
  assert.deepEqual(await methods.measure({ ids: ['a'] }), {
    ok: true,
    units: 'Meters',
    objects: [],
    distances: [],
  });
  assert.deepEqual(
    calls.map(([method]) => method),
    ['captureView', 'captureView', 'measure'],
  );
  const broken = viewMethods(async () => ({ ok: true, data: 'x' }));
  await assert.rejects(broken.captureView(), { code: 'HOST_INVALID_RESPONSE' });
});

test('over MCP the model receives capture_view as image content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vide-vision-test-'));
  const app = await startServer({ filename: join(directory, 'store.sqlite') });
  const client = new Client({ name: 'synthetic-agent', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope = app.agentTools.issue({
    targetRef: 'rhino:synthetic',
    isCurrent: () => true,
    handlers: visionHandlers(source()),
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', app.origin), {
      requestInit: { headers: { Authorization: `Bearer ${scope.token}` } },
    }),
  );
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['capture_view', 'measure']);
  const result = await client.callTool({
    name: 'capture_view',
    arguments: { targetRef: 'rhino:synthetic' },
  });
  assert.equal(result.content[0].type, 'image');
  assert.equal(result.content[0].data, png);
  assert.equal(JSON.parse(result.content[1].text).view, 'Perspective');
});
