// Synthetic millimeter/unknown-unit files, imported through the browser without legacy MCP.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { startServer } from '../../src/server/server.ts';
const directory = resolve('.vide/sdk-import', randomUUID());
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
const filename = join(directory, 'millimeters.3dm'),
  unknown = join(directory, 'unknown.3dm'),
  literal = (value) => '@"' + value.replaceAll('"', '""') + '"';
let worker, app, browser;
try {
  worker = await launchRhinoWorker({ ...options, directory: join(directory, 'fixture') });
  const result = await worker.execute(
    randomUUID(),
    0,
    `using(var source=RhinoDoc.CreateHeadless(null)){source.ModelUnitSystem=UnitSystem.Millimeters;var attributes=new Rhino.DocObjects.ObjectAttributes();attributes.Name="Millimeter source";attributes.SetUserString("Use","Study");source.Objects.AddBox(new Box(new BoundingBox(0,0,0,10000,8000,6000)),attributes);if(!source.Write3dmFile(${literal(filename)},new Rhino.FileIO.FileWriteOptions()))throw new Exception("Fixture save failed");source.ModelUnitSystem=UnitSystem.None;if(!source.Write3dmFile(${literal(unknown)},new Rhino.FileIO.FileWriteOptions()))throw new Exception("Fixture save failed");}`,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  await worker.stop();
  worker = undefined;
  const hash = createHash('sha256')
    .update(await readFile(filename))
    .digest('hex');
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    host: {
      directory: join(directory, 'uploads'),
      importFile: () => {
        throw Error('Legacy MCP must not run');
      },
    },
    sdkOptions: { ...options, directory: join(directory, 'workers') },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/models', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  const upload = async (path, count) => {
    await page.locator('#model-file').setInputFiles(path);
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const rows = await page.evaluate(
        async (id) => await (await fetch(`/api/v1/projects/${id}/requests`)).json(),
        projectId,
      );
      if (rows.length === count && !['queued', 'running'].includes(rows.at(-1).state))
        return rows.at(-1);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error('Import timed out: ' + directory);
  };
  const imported = await upload(filename, 1);
  assert.equal(imported.state, 'succeeded', JSON.stringify(imported.result));
  assert.equal(imported.result.executionMode, 'sdk');
  assert.deepEqual(imported.result.scene[0].boundsSize, [10, 8, 6]);
  assert.ok(Math.abs(imported.result.scene[0].volume - 480) < 1e-8);
  assert.equal(
    createHash('sha256')
      .update(await readFile(filename))
      .digest('hex'),
    hash,
  );
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.locator('#document-tree').evaluate((node) => (node.open = true));
  await page.locator('#object-tree').evaluate((node) => (node.open = true));
  await page.locator('#objects button').first().click();
  await page.screenshot({ path: join(directory, 'import.png') });
  const rejected = await upload(unknown, 2);
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.result.code, 'UNKNOWN_UNITS');
  const evidence = {
    passed: true,
    directory,
    millimetersConverted: true,
    sourceUnchanged: true,
    unknownUnitsRejected: true,
    legacyMcpUsed: false,
    browserImported: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  if (worker) await worker.stop();
}
