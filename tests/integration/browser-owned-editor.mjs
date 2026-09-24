import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';
import { startServer } from '../../src/server/server.ts';
const directory = resolve('.vide/browser-owned-editor', randomUUID());
await mkdir(directory, { recursive: true });
const options = {
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
};
const ai = process.argv.includes('--ai'),
  provider = process.argv.includes('--codex') ? 'codex-cli' : 'claude-cli';
const workers = [];
let app, browser;
const launch = async (options) => {
  const worker = await launchRhinoWorker(options);
  workers.push(worker);
  return worker;
};
try {
  const worker = await launch({ ...options, directory: join(directory, 'source') });
  const receipt = await worker.execute(
    randomUUID(),
    0,
    'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)));',
  );
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  const model = await worker.exportModel();
  await worker.stop();
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: { ...options, directory, launch },
  });
  const project = app.store.createProject('Own editor'),
    id = randomUUID();
  const input = {
    id,
    body: 'Synthetic editor test',
    provider: 'codex-cli',
    permission: 'candidate',
    host: 'rhino',
    pins: [],
    sketches: [],
    files: [],
  };
  app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
    id,
    project.id,
    JSON.stringify(input),
    'succeeded',
    JSON.stringify({
      ...model,
      hostExecuted: true,
      executionMode: 'sdk',
      host: 'rhino',
      verified: true,
      filename: receipt.filename,
      fileHash: receipt.fileHash,
    }),
    new Date().toISOString(),
  );
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(90000);
  if (!ai) {
    await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/v1/models', (route) => route.fulfill({ json: [] }));
  }
  await page.goto(app.launchUrl);
  await page.locator('#project-picker').selectOption(project.id);
  const opened = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/requests/${id}/open`) && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Rhino에서 열기', exact: true }).click();
  const response = await opened;
  assert.equal(response.status(), 200);
  const target = await response.json();
  await page.getByText('열린 호스트 문서', { exact: true }).click();
  await page.locator('#refresh-documents').click();
  await page.locator('#host-documents').selectOption(target.instance + '/' + target.documentId);
  const capturing = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${project.id}/capture`) &&
      response.request().method() === 'POST',
  );
  await page.locator('#capture-document').click();
  const result = await (await capturing).json();
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  assert.equal(result.result.executionMode, 'sdk');
  assert.equal(result.result.sourceDocument.instance, target.instance);
  assert.equal(result.result.scene[0].volume, 24);
  await page
    .locator(`[data-request-id="${result.id}"]`)
    .getByRole('button', { name: '이 후보 보기', exact: true })
    .click();
  await page.screenshot({ path: join(directory, 'recaptured.png') });
  let nextId, usage;
  if (ai) {
    await page
      .locator('#model')
      .selectOption(provider === 'claude-cli' ? 'claude-opus-4-6' : provider);
    if (provider === 'claude-cli') {
      await page.locator('#effort').focus();
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
    }
    assert.equal(
      await page.locator('#effort-label').textContent(),
      provider === 'claude-cli' ? 'low' : '기본값',
    );
    await page.locator('#permission').selectOption('candidate');
    await page
      .locator('#body')
      .fill(
        '현재 작업 사본의 박스 한 개 높이만 4 m에서 8 m로 수정해줘. 원점과 폭 2 m, 깊이 3 m, 객체 ID와 기존 속성을 유지하고 Level 사용자 문자열은 L02로 넣어줘. 결과 체적도 확인해줘.',
      );
    await page.locator('#request').click();
    let saved;
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) {
      const rows = await page.evaluate(
        async (id) => await (await fetch(`/api/v1/projects/${id}/requests`)).json(),
        project.id,
      );
      if (rows.length === 3 && !['queued', 'running'].includes(rows.at(-1).state)) {
        saved = rows.at(-1);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(saved, 'AI did not finish');
    assert.equal(saved.state, 'succeeded', JSON.stringify(saved.result));
    assert.equal(saved.result.hostExecuted, true);
    assert.equal(saved.result.baseRequestId, result.id);
    nextId = saved.id;
    usage = saved.result.usage;
  } else {
    const changing = await launch({
      ...options,
      directory: join(directory, 'edited'),
      source: { filename: result.result.filename, fileHash: result.result.fileHash },
    });
    const nextReceipt = await changing.execute(
      randomUUID(),
      0,
      'var item=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).Single();using(var geometry=new Box(new BoundingBox(0,0,0,2,3,8)).ToBrep())doc.Objects.Replace(item.Id,geometry);',
    );
    assert.equal(nextReceipt.ok, true, JSON.stringify(nextReceipt));
    const nextModel = await changing.exportModel();
    await changing.stop();
    nextId = randomUUID();
    app.store.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)').run(
      nextId,
      project.id,
      JSON.stringify({
        ...input,
        id: nextId,
        body: 'Synthetic height edit',
        baseRequestId: result.id,
      }),
      'succeeded',
      JSON.stringify({
        ...nextModel,
        hostExecuted: true,
        executionMode: 'sdk',
        host: 'rhino',
        verified: true,
        filename: nextReceipt.filename,
        fileHash: nextReceipt.fileHash,
        baseRequestId: result.id,
        sourceDocument: result.result.sourceDocument,
      }),
      new Date().toISOString(),
    );
  }
  await app.close();
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: { ...options, directory, launch },
  });
  await page.goto(app.launchUrl);
  await page.locator('#project-picker').selectOption(project.id);
  await page.getByRole('button', { name: '문서에 적용', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '호스트 원본 적용' });
  await dialog.getByRole('button', { name: '영향 검토', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '수정 1' }).waitFor();
  await dialog.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await dialog.getByRole('status').filter({ hasText: '문서 반영 완료' }).waitFor();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await page.getByText('열린 호스트 문서', { exact: true }).click();
  await page.locator('#refresh-documents').click();
  await page.locator('#host-documents').selectOption(target.instance + '/' + target.documentId);
  const finalCapture = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/projects/${project.id}/capture`) &&
      response.request().method() === 'POST',
  );
  await page.locator('#capture-document').click();
  const final = await (await finalCapture).json();
  assert.equal(final.state, 'succeeded', JSON.stringify(final));
  assert.ok(Math.abs(final.result.scene[0].volume - 48) < 1e-8);
  assert.equal(final.result.objects[0].nativeId, result.result.objects[0].nativeId);
  if (ai)
    assert.ok(
      final.result.scene[0].attributes64.some(
        ([key, value]) =>
          Buffer.from(key, 'base64').toString() === 'Level' &&
          Buffer.from(value, 'base64').toString() === 'L02',
      ),
    );
  await page
    .locator(`[data-request-id="${final.id}"]`)
    .getByRole('button', { name: '이 후보 보기', exact: true })
    .click();
  await page.screenshot({ path: join(directory, 'applied.png') });
  const evidence = {
    passed: true,
    directory,
    actualAi: ai,
    provider: ai ? provider : undefined,
    usage,
    browserOpened: true,
    ownDocumentSelected: true,
    browserRecaptured: true,
    browserPreviewApplied: true,
    controllerRestartReconnected: true,
    nativeIdentityPreserved: true,
    volumeBefore: 24,
    volumeAfter: 48,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  for (const worker of workers.reverse()) await worker.stop();
  await rm(directory + '.editors.json', { force: true });
}
