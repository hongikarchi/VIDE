// Real host concurrency through the browser API; deterministic provider, no subscription calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { installBrowserSupport } from './browser-support.mjs';
import { runDirectory } from './run-directory.mjs';

import { soleDb } from '../fixtures/store.mjs';
const directory = runDirectory('native-concurrent-work');
const config = sdkOptions(directory);
const cancelRhino = process.argv.includes('--cancel-rhino');
await mkdir(config.directory, { recursive: true });
let app, browser, release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const targets = new Set();
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: config,
    providerFactory: ({ agent }) => ({
      status: async () => ({ available: true }),
      run: async (_context, { signal }) => {
        const client = new Client({ name: 'native-concurrent-test', version: '1.0.0' });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(agent.url), {
              requestInit: { headers: { Authorization: 'Bearer ' + agent.token } },
            }),
          );
          const call = async (name, code) => {
            const reply = await client.callTool({
              name,
              arguments: { targetRef: agent.targetRef, ...(code ? { code } : {}) },
            });
            assert.equal(reply.isError, undefined, JSON.stringify(reply));
            const value = JSON.parse(reply.content[0].text);
            assert.notEqual(value.ok, false, JSON.stringify(value));
            return value;
          };
          await call('query');
          targets.add(agent.targetRef);
          await Promise.race([
            gate,
            new Promise((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Parallel native startup timed out')),
                90000,
              );
              timer.unref();
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(Object.assign(new Error('Cancelled'), { code: 'CANCELLED' }));
                },
                { once: true },
              );
              gate.then(() => clearTimeout(timer));
            }),
          ]);
          await call(
            'execute',
            agent.targetRef.startsWith('rhino:')
              ? 'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)));'
              : 'var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);var p=new Polyline();p.AddVertexAt(0,new Point2d(0,0),0,0,0);p.AddVertexAt(1,new Point2d(2000,0),0,0,0);p.AddVertexAt(2,new Point2d(2000,3000),0,0,0);p.AddVertexAt(3,new Point2d(0,3000),0,0,0);p.Closed=true;ms.AppendEntity(p);tr.AddNewlyCreatedDBObject(p,true);',
          );
          await call('query');
          return { text: '독립 대상 생성 완료' };
        } finally {
          await client.close();
        }
      },
    }),
  });
  const project = app.store.createProject('복수 호스트 병렬 검수');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await installBrowserSupport(page);
  await page.goto(app.launchUrl);
  const requests = ['rhino', 'zwcad'].map((host) => ({
    id: randomUUID(),
    host,
    baseRequestId: null,
    body: 'Create the specified test geometry',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
  }));
  await page.evaluate(
    async ({ project, requests }) => {
      await Promise.all(
        requests.map((input) => window.testApi(`/projects/${project}/requests`, 'POST', input)),
      );
    },
    { project: project.id, requests },
  );
  const deadline = Date.now() + 180000;
  while (targets.size < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(targets.size, 2, 'Both actual hosts must be available before either may finish');
  const rows = () =>
    requests.map(({ id }) =>
      soleDb(app.store).prepare('SELECT * FROM workspace_requests WHERE id=?').get(id),
    );
  assert.deepEqual(
    rows().map((row) => row.state),
    ['running', 'running'],
  );
  if (cancelRhino)
    await page.evaluate(
      async ({ project, id }) =>
        window.testApi(`/projects/${project}/requests/${id}/cancel`, 'POST', {}),
      { project: project.id, id: requests[0].id },
    );
  release();
  while (rows().some((row) => ['queued', 'running'].includes(row.state)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    rows().map((row) => row.state),
    [cancelRhino ? 'cancelled' : 'succeeded', 'succeeded'],
    JSON.stringify(rows()),
  );
  const results = rows().map((row) => JSON.parse(row.result));
  assert.equal(results[1].host, 'zwcad');
  if (!cancelRhino) {
    assert.equal(results[0].host, 'rhino');
    assert.ok(Math.abs(results[0].scene[0].volume - 24) < 1e-8);
    assert.notEqual(results[0].filename, results[1].filename);
  }
  assert.ok(Math.abs(results[1].scene[0].area - 6) < 1e-8);
  const evidence = {
    passed: true,
    directory,
    overlappingActualHosts: [...targets],
    rhinoCancelled: cancelRhino,
    rhinoVolume: cancelRhino ? null : 24,
    zwcadArea: 6,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  release();
  await browser?.close();
  await app?.close();
}
