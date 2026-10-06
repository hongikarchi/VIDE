import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { runDirectory } from './run-directory.mjs';

import { soleDb } from '../fixtures/store.mjs';
// Use only the owned synthetic result from browser-linked-hosts --intervene.
const sourceDirectory = resolve(process.argv[2]);
const proof = JSON.parse(await readFile(join(sourceDirectory, 'passed.json'), 'utf8'));
assert.equal(proof.nativeIntervention, true);
const source = new DatabaseSync(join(sourceDirectory, 'test.sqlite'), { readOnly: true });
const rows = source.prepare('SELECT * FROM workspace_requests').all();
source.close();
const directory = runDirectory('browser-linked-native-followup');
await mkdir(directory, { recursive: true });
let app,
  browser,
  calls = 0;
const writes = { rhino: 0, zwcad: 0 };
const sourceHashes = [];
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: sdkOptions(directory),
    providerFactory: ({ agent }) => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        calls++;
        assert.match(context.goal, /4.5 m/);
        const cadRef = context.goal.match(/zwcad:[a-f0-9-]+/)?.[0];
        const rhinoRef = context.goal.match(/rhino:[a-f0-9-]+/)?.[0];
        assert.ok(cadRef && rhinoRef);
        const client = new Client({ name: 'linked-native-followup', version: '1.0.0' });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(agent.url), {
            requestInit: { headers: { Authorization: 'Bearer ' + agent.token } },
          }),
        );
        const call = async (name, targetRef, code) => {
          const response = await client.callTool({
            name,
            arguments: { targetRef, ...(code ? { code } : {}) },
          });
          assert.equal(response.isError, undefined, JSON.stringify(response));
          const result = JSON.parse(response.content[0].text);
          assert.notEqual(result.ok, false, JSON.stringify(result));
          if (name === 'execute') writes[targetRef === cadRef ? 'zwcad' : 'rhino']++;
          return result;
        };
        try {
          const cad = await call('query', cadRef);
          assert.equal(cad.model.scene[0].area, 260);
          const before = await call('query', rhinoRef);
          assert.equal(before.objects.length, 1);
          const points = cad.model.objects[0].points
            .map((p) => `new Point3d(${p.join(',')})`)
            .join(',');
          await call(
            'execute',
            rhinoRef,
            `var curve=new PolylineCurve(new[]{${points}});var shape=Extrusion.Create(curve,4.5,true);if(shape==null)throw new Exception("Invalid boundary");foreach(var obj in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject))doc.Objects.Replace(obj.Id,shape);`,
          );
          const after = await call('query', rhinoRef);
          assert.equal(after.objects[0].nativeId, before.objects[0].nativeId);
          return { text: 'CAD 경계를 유지하고 Rhino 높이만 4.5m로 변경했습니다.' };
        } finally {
          await client.close();
        }
      },
    }),
  });
  const project = app.store.createProject('복구 뒤 연계 후속');
  for (const row of rows) {
    const result = row.result ? JSON.parse(row.result) : null;
    if (row.state === 'succeeded' && result?.filename) {
      const folder = join(directory, result.host === 'zwcad' ? 'zwcad-sdk-models' : 'sdk-models');
      await mkdir(folder, { recursive: true });
      const filename = join(folder, row.id + extname(result.filename));
      await copyFile(result.filename, filename);
      sourceHashes.push({ filename: result.filename, fileHash: result.fileHash });
      result.filename = filename;
    }
    soleDb(app.store)
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(row.id, project.id, row.input, row.state, JSON.stringify(result), row.createdAt);
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(app.launchUrl);
  await page.locator('#project-picker').selectOption(project.id);
  await page
    .locator(`[data-request-id="${proof.heldRequestId}"]`)
    .getByRole('button', { name: '확인된 후보에서 이어가기', exact: true })
    .click();
  assert.equal(calls, 0);
  assert.match(await page.locator('#body').inputValue(), /4.5 m/);
  const submitted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith(`/projects/${project.id}/requests`),
  );
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  const response = await submitted;
  assert.equal(response.status(), 202);
  const parent = await response.json();
  let saved;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    saved = soleDb(app.store).prepare('SELECT * FROM workspace_requests WHERE id=?').get(parent.id);
    if (!['queued', 'running'].includes(saved.state)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(saved.state, 'succeeded', JSON.stringify(saved));
  const results = JSON.parse(saved.result).targetResults.map((r) => {
    const row = soleDb(app.store)
      .prepare('SELECT * FROM workspace_requests WHERE id=?')
      .get(r.requestId);
    return { ...row, input: JSON.parse(row.input), result: JSON.parse(row.result) };
  });
  const cad = results.find((r) => r.result.host === 'zwcad');
  const rhino = results.find((r) => r.result.host === 'rhino');
  assert.equal(cad.result.unchanged, true);
  assert.equal(cad.result.scene[0].area, 260);
  const basis = JSON.parse(
    soleDb(app.store)
      .prepare('SELECT result FROM workspace_requests WHERE id=?')
      .get(cad.input.baseRequestId).result,
  );
  assert.equal(cad.result.filename, basis.filename);
  assert.equal(cad.result.fileHash, basis.fileHash);
  assert.equal(cad.result.progress.attempts, 0);
  assert.ok(Math.abs(rhino.result.scene[0].volume - 1170) < 1e-7);
  assert.equal(rhino.result.progress.attempts, 1);
  assert.deepEqual(writes, { rhino: 1, zwcad: 0 });
  assert.equal(calls, 1);
  for (const original of sourceHashes) {
    assert.equal(
      createHash('sha256')
        .update(await readFile(original.filename))
        .digest('hex'),
      original.fileHash,
    );
  }
  await page.reload();
  await page
    .locator(`[data-request-id="${parent.id}"]`)
    .getByRole('button', { name: '확인된 후보에서 이어가기', exact: true })
    .click();
  assert.equal(calls, 1);
  await page.screenshot({ path: join(directory, 'followup.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    directory,
    parentId: parent.id,
    providerCalls: calls,
    writes,
    area: 260,
    volume: 1170,
    unchangedCadFile: true,
    originalsUnchanged: true,
    deterministicAgent: true,
    furtherDraftWithoutExecution: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await app?.close();
}
