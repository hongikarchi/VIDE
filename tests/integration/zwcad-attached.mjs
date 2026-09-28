import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { inspectorOptions } from '../../hosts/zwcad/inspector.ts';
import { AttachedZwcadDocuments } from '../../hosts/zwcad/attached-documents.ts';
import { sendHostCommand } from '../../hosts/common/transport.ts';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const directory = resolve('.vide/zwcad-attached', randomUUID());
const registry = join(directory, 'zwcad-connections');
await mkdir(registry, { recursive: true });
const config = inspectorOptions(),
  script = join(directory, 'start.scr');
const quote = (value) => JSON.stringify(value.replaceAll('\\', '/'));
const harness = join(directory, 'AttachedActions.dll');
execFileSync(
  join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
  [
    '/nologo',
    '/target:library',
    '/out:' + harness,
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwManaged.dll',
    '/reference:C:/Program Files/ZWSOFT/ZWCAD 2023/ZwDatabaseMgd.dll',
    resolve('tests/integration/fixtures/ZwcadAttachedActions.cs'),
  ],
  { windowsHide: true },
);
await writeFile(
  script,
  [
    '(setvar "INSUNITS" 4)',
    '(entmake (list (cons 0 "LINE") (cons 10 (list 0.0 0.0 0.0)) (cons 11 (list 3000.0 4000.0 0.0))))',
    '(entmake (list (cons 0 "CIRCLE") (cons 10 (list 10000.0 0.0 0.0)) (cons 40 2000.0)))',
    '(entmake (list (cons 0 "TEXT") (cons 10 (list 0.0 5000.0 0.0)) (cons 40 250.0) (cons 1 "VIDE fixture")))',
    '(entmake (list (cons 0 "BLOCK") (cons 2 "VIDETEST") (cons 70 0) (cons 10 (list 0.0 0.0 0.0))))',
    '(entmake (list (cons 0 "LINE") (cons 10 (list 0.0 0.0 0.0)) (cons 11 (list 1000.0 0.0 0.0))))',
    '(entmake (list (cons 0 "ENDBLK")))',
    '(entmake (list (cons 0 "INSERT") (cons 2 "VIDETEST") (cons 10 (list 20000.0 0.0 0.0))))',
    `(command "_NETLOAD" ${quote(resolve('.vide/build/zwcad-connection/VIDE.Zwcad.Connection.dll'))})`,
    `(command "_NETLOAD" ${quote(harness)})`,
    'VIDETestAttachedActions',
    'VIDECADConnect',
    'VIDECADLiveSync',
    '(command "_ZOOM" "_EXTENTS")',
    `(setq videTestFile (open ${quote(join(directory, 'ready.txt'))} "w"))`,
    '(write-line (itoa (getvar "DBMOD")) videTestFile)',
    '(close videTestFile)',
    '',
  ].join('\n'),
);
const owner = await launchOwnedHost({
  executable: config.executable,
  args: ['/b', script],
  visible: false,
  environment: {
    ...process.env,
    VIDE_ZWCAD_CONNECT_DIR: registry,
    VIDE_ATTACHED_TEST_ACTIONS: directory,
  },
});
try {
  const deadline = Date.now() + 90000;
  while (true) {
    try {
      await readFile(join(directory, 'ready.txt'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT' || Date.now() > deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const adapter = new AttachedZwcadDocuments(registry);
  const [doc] = await adapter.list();
  assert.ok(doc, 'No attached document');
  assert.ok(doc.instance.startsWith(owner.identity.pid + ':'));
  assert.equal(doc.objectCount, 4);
  assert.equal(doc.live, true);
  const target = { instance: doc.instance, documentId: 1 };
  const before = await adapter.inspect(target),
    model = await adapter.capture(target),
    after = await adapter.inspect(target);
  assert.equal(before.documentHash, after.documentHash);
  assert.equal(model.displayOnly, true);
  assert.equal(model.verified, false);
  assert.deepEqual(model.scene.find((s) => s.nativeType === 'Line').segments, [0, 0, 0, 3, 4, 0]);
  assert.deepEqual(
    model.scene.find((s) => s.nativeType === 'BlockReference').segments,
    [20, 0, 0, 21, 0, 0],
  );
  assert.equal(model.displayCoverage.displayed, 3);
  assert.equal(model.displayCoverage.omitted, 1);
  assert.equal((await adapter.list())[0].modified, doc.modified);
  let app, browser;
  const browserErrors = [];
  try {
    app = await startServer({
      filename: join(directory, 'workspace.sqlite'),
      sdkOptions: sdkOptions(directory),
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => browserErrors.push(error.message));
    await page.goto(app.launchUrl);
    await page.waitForFunction(() => !document.querySelector('#body').disabled);
    const attachedResponse = await page.request.get(app.origin + '/api/v1/host/attached-documents');
    const attachedCatalog = await attachedResponse.json();
    console.log(JSON.stringify({ attachedStatus: attachedResponse.status(), attachedCatalog }));
    await page.locator('#host-documents').selectOption(`${target.instance}/1`, { timeout: 20000 });
    await page.locator('#capture-document').click();
    await page.waitForFunction(
      () => document.querySelector('#host-document-info')?.textContent.includes('Sync 완료'),
      { timeout: 30000 },
    );
    await page.getByRole('button', { name: '위 · 직교', exact: true }).click();
    await page.screenshot({ path: join(directory, 'browser-sync.png') });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#body').disabled);
    assert.ok(await page.locator('canvas').count());
    assert.deepEqual(browserErrors, []);
  } finally {
    await browser?.close();
    await app?.close();
  }
  await assert.rejects(adapter.capture({ ...target, documentId: 2 }), {
    code: 'DOCUMENT_MISMATCH',
  });
  const record = JSON.parse(
    await readFile(
      join(
        registry,
        (await readdir(registry)).find((f) => f.endsWith('.json')),
      ),
      'utf8',
    ),
  );
  const call = (extra) =>
    sendHostCommand(
      'vide',
      { ...record.identity, token: record.token, ...extra },
      { port: record.identity.port },
    );
  assert.equal((await call({ method: 'execute', code: 'danger' })).code, 'UNSUPPORTED_METHOD');
  assert.equal(
    (await call({ method: 'attachedStatus', token: '0'.repeat(64) })).code,
    'UNAUTHORIZED',
  );
  assert.equal(
    (await call({ method: 'displayPage', offset: 0, limit: 100, revision: 999999 })).code,
    'SOURCE_CHANGED',
  );
  const until = async (read, accept) => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await read();
      if (accept(result)) return result;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw Error('Timed out waiting for CAD state');
  };
  await writeFile(join(directory, 'action.txt'), 'move');
  await until(
    () => adapter.list(),
    (docs) => docs[0]?.generation > doc.generation,
  );
  const moved = await adapter.capture(target);
  assert.deepEqual(moved.scene.find((s) => s.nativeType === 'Line').segments, [1, 0, 0, 4, 4, 0]);
  assert.notEqual(moved.sourceDocument.documentHash, model.sourceDocument.documentHash);
  await writeFile(join(directory, 'action.txt'), 'large');
  await until(
    () => adapter.list(),
    (docs) => docs[0]?.objectCount === 6,
  );
  const large = await adapter.capture(target);
  assert.equal(large.displayCoverage.omittedTypes.OversizedDisplay, 1);
  assert.equal(large.displayCoverage.displayed, 4);
  assert.equal(large.displayCoverage.total, 6);
  assert.ok(
    large.scene.some((s) => JSON.stringify(s.segments) === JSON.stringify([0, 10, 0, 5, 10, 0])),
    'Geometry after the enormous block is preserved',
  );
  await writeFile(join(directory, 'action.txt'), 'second');
  const both = await until(
    () => adapter.list(),
    (docs) => docs.length === 2,
  );
  assert.notEqual(both[0].instance, both[1].instance);
  assert.equal((await adapter.capture(target)).objects.length, large.objects.length);
  const other = both.find((d) => d.instance !== target.instance);
  assert.equal(
    (await adapter.capture({ instance: other.instance, documentId: 1 })).objects.length,
    0,
  );
  await writeFile(join(directory, 'action.txt'), 'disconnect');
  await until(
    () => adapter.list(),
    (docs) => docs.length === 1 && docs[0].instance === other.instance,
  );
  assert.equal(await adapter.has(target.instance), false);
  await writeFile(join(directory, 'action.txt'), 'close-second');
  await until(
    () => adapter.list(),
    (docs) => docs.length === 0,
  );
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      { directory, doc, model, before, after, largeCoverage: large.displayCoverage },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ directory, passed: true, coverage: model.displayCoverage }));
} finally {
  await owner.stop();
}
