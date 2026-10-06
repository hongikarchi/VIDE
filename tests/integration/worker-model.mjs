// Live Rhino SDK export/seed + browser display. Fixed code, not an AI capability test.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { startServer } from '../../src/server/server.ts';
import { SdkExecution } from '../../src/server/sdk-execution.ts';
import { runDirectory } from './run-directory.mjs';

import { soleDb } from '../fixtures/store.mjs';
const directory = runDirectory('worker-ui-check');
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
const fingerprint = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
let worker, app, browser;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'first') });
  const first = await worker.execute(
    randomUUID(),
    0,
    'var attributes=new Rhino.DocObjects.ObjectAttributes(); attributes.Name="SDK box"; attributes.SetUserString("Use","Study"); doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,10,8,6)),attributes);',
  );
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.snapshot.uncertain, false);
  const original = await worker.exportModel();
  assert.equal(original.objects.length, 1);
  const originalId = original.objects[0].id;
  assert.ok(original.scene[0].vertices.length > 0);
  assert.equal(original.scene[0].volume, 480);
  assert.equal(original.scene[0].area, 376);
  await worker.stop();
  worker = undefined;
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'second'),
    source: { filename: first.filename, fileHash: first.fileHash },
  });
  assert.equal((await worker.query()).objects.length, 1);
  const second = await worker.execute(
    randomUUID(),
    0,
    'var item=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(); doc.Objects.Transform(item.Id,Transform.Translation(2,0,0),true);',
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.snapshot.uncertain, false);
  const model = await worker.exportModel();
  assert.equal(model.objects[0].id, originalId);
  assert.deepEqual(model.scene[0].origin, [2, 0, 0]);
  assert.deepEqual(model.scene[0].boundsSize, [10, 8, 6]);
  assert.equal(model.scene[0].volume, 480);
  assert.equal(model.scene[0].area, 376);
  assert.ok(
    model.scene[0].attributes64.some(
      ([key, value]) =>
        Buffer.from(key, 'base64').toString() === 'Use' &&
        Buffer.from(value, 'base64').toString() === 'Study',
    ),
  );
  assert.equal(await fingerprint(first.filename), first.fileHash);
  assert.equal(await fingerprint(second.filename), second.fileHash);
  await worker.stop();
  worker = undefined;
  const recovered = await new SdkExecution({
    ...options,
    directory,
    tools: {},
    origin: () => '',
  }).recover({ workerDirectory: join(directory, 'second'), operationId: second.operationId });
  assert.equal(recovered.objects[0].id, originalId);
  assert.equal(recovered.fileHash, second.fileHash);
  assert.equal(recovered.scene[0].volume, 480);
  worker = await launchRhinoWorker({
    ...options,
    directory: join(directory, 'protected'),
    source: { filename: first.filename, fileHash: first.fileHash },
  });
  const unchanged = await worker.execute(randomUUID(), 0, 'var count=doc.Objects.Count;', [
    originalId,
  ]);
  assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
  const rejected = await worker.execute(
    randomUUID(),
    1,
    'var item=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single(); doc.Objects.Transform(item.Id,Transform.Translation(1,0,0),true);',
    [originalId],
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'HOST_RESULT_UNKNOWN');
  assert.equal((await worker.query()).uncertain, true);
  await worker.stop();
  worker = undefined;
  app = await startServer({ filename: join(directory, 'test.sqlite') });
  const project = app.store.createProject('SDK export test');
  const input = {
    id: randomUUID(),
    body: 'SDK model export verification',
    pins: [],
    sketches: [],
    files: [],
    provider: 'codex-cli',
    model: 'codex-cli',
    effort: 'default',
    permission: 'candidate',
    host: 'rhino',
  };
  const result = {
    ...model,
    filename: second.filename,
    fileHash: second.fileHash,
    hostExecuted: true,
    host: 'rhino',
    verified: true,
    text: 'Fixed SDK test',
  };
  soleDb(app.store)
    .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
    .run(
      input.id,
      project.id,
      JSON.stringify(input),
      'succeeded',
      JSON.stringify(result),
      new Date().toISOString(),
    );
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  await page.locator('#project-picker').selectOption(project.id);
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.locator('#document-tree').evaluate((node) => {
    node.open = true;
    for (const row of node.querySelectorAll('.layer-row[aria-expanded="false"]')) row.click();
  });
  await page.locator('#objects .object').first().click();
  await page.locator('#inspector-toggle').click();
  assert.match(await page.locator('#inspector-content').textContent(), /Study/);
  await page.locator('[data-inspect="geometry"]').click();
  assert.match(await page.locator('#inspector-content').textContent(), /376 m²/);
  assert.match(await page.locator('#inspector-content').textContent(), /480 m³/);
  await page.screenshot({ path: join(directory, 'viewport.png') });
  await page.locator('[data-inspect="properties"]').click();
  await page.getByRole('button', { name: '이 객체 수량표', exact: true }).click();
  const quantities = page.getByRole('dialog', { name: '후보 수량표', exact: true });
  await quantities.getByRole('status').filter({ hasText: '1 / 1개 객체' }).waitFor();
  assert.match(await quantities.textContent(), /480/);
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    directory,
    stableId: originalId,
    sourceUnchanged: true,
    seedCopied: true,
    receiptRecovered: true,
    protectedChangeRejected: true,
    area: 376,
    volume: 480,
    browserInspector: true,
    browserQuantities: true,
    first: first.filename,
    second: second.filename,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (worker) await worker.stop();
}
