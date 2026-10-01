import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
import { launchZwcadWorker } from '../../hosts/zwcad/worker-client.ts';
import { inspectWindowsProcess } from '../../hosts/common/owned-process.ts';
import { runDirectory } from './run-directory.mjs';
const directory = runDirectory('browser-zwcad-editor');
await mkdir(join(directory, 'zwcad-sdk-models'), { recursive: true });
const original = JSON.parse(await readFile(process.argv[2], 'utf8')).result;
const filename = join(directory, 'zwcad-sdk-models', 'seed.dwg');
await copyFile(original.filename, filename);
let app, browser, changing;
const owned = [];
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: sdkOptions(directory),
  });
  const project = app.store.createProject('ZWCAD editor test'),
    id = randomUUID();
  const input = {
    id,
    body: 'Synthetic SDK candidate',
    permission: 'candidate',
    provider: 'codex-cli',
    host: 'zwcad',
    pins: [],
    sketches: [],
    files: [],
  };
  const save = (id, input, result) =>
    app.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify(input),
        'succeeded',
        JSON.stringify(result),
        new Date().toISOString(),
      );
  save(id, input, { ...original, filename });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90000);
  await page.goto(app.launchUrl);
  await page.locator('#project-picker').selectOption(project.id);
  const opening = page.waitForResponse((r) => r.url().endsWith(`/requests/${id}/open`));
  await page.getByRole('button', { name: 'ZWCAD에서 열기', exact: true }).click();
  const opened = await opening;
  assert.equal(opened.status(), 200);
  const target = await opened.json();
  owned.push(target.instance);
  // The opened work copy is a linked file of the project; its first Sync starts by itself.
  const capturing = page.waitForResponse((r) =>
    r.url().endsWith(`/projects/${project.id}/capture`),
  );
  const captured = await (await capturing).json();
  assert.equal(captured.state, 'succeeded', JSON.stringify(captured));
  assert.equal(captured.result.host, 'zwcad');
  assert.equal(captured.input.host, 'zwcad');
  assert.equal(captured.result.scene[0].area, 240);
  changing = await launchZwcadWorker({
    directory: join(directory, 'zwcad-sdk-models', 'candidate'),
    source: { filename: captured.result.filename, fileHash: captured.result.fileHash },
  });
  const receipt = await changing.execute(
    randomUUID(),
    0,
    `var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);foreach(ObjectId id in space){var p=(Polyline)tr.GetObject(id,OpenMode.ForWrite);p.SetPointAt(1,new Point2d(26000,0));p.SetPointAt(2,new Point2d(26000,10000));}`,
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  await changing.stop();
  changing = undefined;
  const nextId = randomUUID();
  save(
    nextId,
    { ...input, id: nextId, body: 'Synthetic width change', baseRequestId: captured.id },
    {
      ...receipt.model,
      host: 'zwcad',
      hostExecuted: true,
      executionMode: 'sdk',
      verified: true,
      filename: receipt.filename,
      fileHash: receipt.fileHash,
      sourceDocument: captured.result.sourceDocument,
      baseRequestId: captured.id,
    },
  );
  await page.reload();
  await page.getByRole('button', { name: '문서에 적용', exact: true }).last().click();
  await page.getByRole('button', { name: '영향 검토', exact: true }).click();
  await page.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await page
    .getByText('문서 반영 완료 · 파일은 아직 저장하지 않았습니다.', { exact: true })
    .waitFor();
  const connection = app.store.db.prepare('SELECT host FROM connections').get();
  assert.equal(connection.host, 'zwcad');
  await page.screenshot({ path: join(directory, 'applied.png') });
  await writeFile(
    join(directory, 'passed.json'),
    JSON.stringify(
      { passed: true, target, capturedRequest: captured.id, appliedRequest: nextId },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, directory }));
} catch (error) {
  console.error(error);
  await writeFile(join(directory, 'failure.txt'), String(error.stack));
  process.exitCode = 1;
} finally {
  await changing?.stop();
  await browser?.close();
  await app?.close();
  for (const instance of owned) {
    const [pid, ticks] = instance.split(':');
    const actual = await inspectWindowsProcess(Number(pid));
    if (actual.startTicks === ticks && /ZWCAD\.exe$/i.test(actual.executable))
      process.kill(Number(pid));
  }
}
