// Product browser -> subscription CLI -> attached Rhino -> refreshed viewport.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { launchOwnedHost } from '../../hosts/common/owned-process.ts';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';
const directory = resolve('.vide/rhino-attached-ai', randomUUID());
await mkdir(directory, { recursive: true });
const options = sdkOptions(directory);
options.plugin = resolve(
  process.env.VIDE_TEST_RHINO_PLUGIN || '.vide/build/rhino-panel/bin/VIDE.Worker.rhp',
);
const connections = join(directory, 'rhino-connections');
const script = join(directory, 'fixture.py');
await writeFile(
  script,
  `import Rhino, json, traceback
try:
    doc=Rhino.RhinoDoc.ActiveDoc
    assert doc.Objects.Count==0
    doc.ModelUnitSystem=Rhino.UnitSystem.Millimeters
    attributes=Rhino.DocObjects.ObjectAttributes();attributes.Name='VIDE AI roundtrip';attributes.SetUserString('Role','Mass')
    native=doc.Objects.AddBox(Rhino.Geometry.Box(Rhino.Geometry.BoundingBox(0,0,0,2000,3000,4000)),attributes)
    Rhino.PlugIns.PlugIn.LoadPlugIn(${JSON.stringify(options.plugin.replaceAll('\\', '/'))})
    assert Rhino.RhinoApp.RunScript('_VIDEConnect',False)
    assert Rhino.RhinoApp.RunScript('_VIDEPanel',False)
    with open(${JSON.stringify(join(directory, 'ready.json').replaceAll('\\', '/'))},'w') as f:json.dump(dict(ok=True,nativeId=str(native)),f)
except Exception as e:
    with open(${JSON.stringify(join(directory, 'ready.json').replaceAll('\\', '/'))},'w') as f:json.dump(dict(ok=False,error=str(e),trace=traceback.format_exc()),f)
`,
);
let host, app, browser;
try {
  host = await launchOwnedHost({
    executable: options.executable,
    environment: { ...process.env, VIDE_CONNECT_DIR: connections },
    visible: true,
    spawnProcess: (file, args, opts) =>
      spawn(file, args, { ...opts, windowsVerbatimArguments: true }),
    args: [
      '/nosplash',
      '/notemplate',
      '/scheme=VIDE-Worker-Test',
      `/runscript="_-RunPythonScript (${script})"`,
    ],
  });
  let ready;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      ready = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(ready?.ok, true, JSON.stringify(ready));
  app = await startServer({ filename: join(directory, 'vide.sqlite'), sdkOptions: options });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.getByText('열린 호스트 문서', { exact: true }).click();
  await page.locator('#refresh-documents').click();
  await page.locator('#capture-document').click();
  await page.waitForFunction(
    () => document.querySelector('#host-document-info').textContent === 'Sync 완료',
    {},
    { timeout: 90000 },
  );
  const project = app.store.listProjects()[0];
  const rows = () =>
    app.store.db
      .prepare('SELECT * FROM workspace_requests WHERE projectId=? ORDER BY rowid')
      .all(project.id)
      .map((row) => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
  const basis = rows().at(-1);
  assert.equal(basis.result.displayOnly, true);
  assert.deepEqual(basis.result.scene[0].boundsSize, [2, 3, 4]);
  await page.locator('#model').selectOption(process.env.VIDE_TEST_AI_MODEL || 'codex-cli');
  await page.locator('#permission').selectOption('apply');
  await page
    .locator('#body')
    .fill(
      '현재 문서의 유일한 박스 높이를 4 m에서 5 m로 바꿔줘. 폭 2 m, 깊이 3 m, 원점, 객체 ID, 이름과 Role 속성은 유지해. 다른 객체는 만들지 마.',
    );
  await page.locator('#request').click();
  console.log('Actual subscription AI request submitted to the product browser.');
  let edited;
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    const latest = rows().at(-1);
    if (latest.id !== basis.id && !['queued', 'running'].includes(latest.state)) {
      edited = latest;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await page.screenshot({ path: join(directory, 'ai-roundtrip.png') });
  await writeFile(
    join(directory, 'outcome.json'),
    JSON.stringify({ state: edited?.state, result: edited?.result, errors }, null, 2),
  );
  assert.equal(edited?.state, 'succeeded', JSON.stringify(edited?.result));
  assert.equal(edited.result.applicationState, 'succeeded');
  assert.equal(edited.result.syncState, 'succeeded');
  assert.equal(edited.result.scene[0].nativeId, ready.nativeId);
  assert.deepEqual(edited.result.scene[0].boundsSize, [2, 3, 5]);
  assert.ok(Math.abs(edited.result.scene[0].volume - 30) < 1e-7);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  assert.equal(await page.locator('#viewport-empty').isVisible(), false);
  await page.screenshot({ path: join(directory, 'ai-roundtrip-reloaded.png') });
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    directory,
    nativeIdPreserved: true,
    sourceUnits: edited.result.sourceDocument.units,
    heightBefore: 4,
    heightAfter: 5,
    volumeAfter: 30,
    application: edited.result.applicationState,
    refreshed: edited.result.syncState,
    reloaded: true,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close();
  await app?.close();
  await host?.stop();
}
