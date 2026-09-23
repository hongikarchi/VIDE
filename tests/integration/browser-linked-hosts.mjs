import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { pathToFileURL } from 'node:url';
const appRoot = resolve(process.env.VIDE_TEST_PACKAGE_APP || '.');
const { startServer } = await import(pathToFileURL(join(appRoot, 'src/server/server.ts')).href);
const { sdkOptions } = await import(pathToFileURL(join(appRoot, 'src/server/sdk-options.ts')).href);
const { launchRhinoWorker } = await import(
  pathToFileURL(join(appRoot, 'hosts/rhino/worker-client.ts')).href
);

const directory = resolve('.vide/browser-linked-hosts', randomUUID());
const failRhino = process.argv.includes('--fail-rhino');
const sameHost = process.argv.includes('--same-host');
assert.ok(!(sameHost && failRhino));
await mkdir(join(directory, 'zwcad-sdk-models'), { recursive: true });
const cad = JSON.parse(await readFile(process.argv[2], 'utf8')).result;
const cadFile = join(directory, 'zwcad-sdk-models', 'seed.dwg');
await copyFile(cad.filename, cadFile);
const config = sdkOptions(directory);
await mkdir(config.directory, { recursive: true });
const seed = sameHost
  ? null
  : await launchRhinoWorker({ ...config, directory: join(config.directory, 'seed') });
let rhino;
try {
  if (sameHost) {
    const secondFile = join(directory, 'zwcad-sdk-models', 'second.dwg');
    await copyFile(cadFile, secondFile);
    rhino = { ...cad, filename: secondFile };
  } else {
    const receipt = await seed.execute(
      randomUUID(),
      0,
      'doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,24,10,6)));',
    );
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    rhino = {
      ...(await seed.exportModel()),
      filename: receipt.filename,
      fileHash: receipt.fileHash,
      host: 'rhino',
      hostExecuted: true,
      verified: true,
      executionMode: 'sdk',
    };
  }
} finally {
  await seed?.stop();
}
let app,
  browser,
  providerCalls = 0;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: config,
    providerFactory: ({ agent }) => ({
      status: async () => ({ available: true }),
      run: async (context) => {
        providerCalls++;
        const cadRef = context.goal.match(/zwcad:[a-f0-9-]+/)?.[0],
          rhinoRef = sameHost
            ? [...context.goal.matchAll(/zwcad:[a-f0-9-]+/g)]
                .map((match) => match[0])
                .filter((ref) => ref !== cadRef)[0]
            : context.goal.match(/rhino:[a-f0-9-]+/)?.[0];
        assert.ok(cadRef && rhinoRef);
        const client = new Client({ name: 'linked-host-test', version: '1.0.0' });
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
          const value = JSON.parse(response.content[0].text);
          assert.notEqual(value.ok, false, JSON.stringify(value));
          return value;
        };
        try {
          const invalid = await client.callTool({
            name: 'query',
            arguments: { targetRef: 'zwcad-wrong-target' },
          });
          assert.equal(invalid.isError, true);
          assert.equal(JSON.parse(invalid.content[0].text).code, 'TARGET_MISMATCH');
          await call('query', cadRef);
          await call(
            'execute',
            cadRef,
            'var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForRead);foreach(ObjectId id in ms){var p=(Polyline)tr.GetObject(id,OpenMode.ForWrite);p.SetPointAt(1,new Point2d(26000,0));p.SetPointAt(2,new Point2d(26000,10000));}',
          );
          const changed = await call('query', cadRef);
          assert.equal(changed.model.scene[0].area, 260);
          if (sameHost) {
            const before = await call('query', rhinoRef);
            assert.equal(before.model.scene[0].area, 240);
            const points = changed.model.objects[0].points;
            const vertices = points
              .slice(0, -1)
              .map(
                (point, index) =>
                  `p.AddVertexAt(${index},new Point2d(${point[0] * 1000},${point[1] * 1000}),0,0,0);`,
              )
              .join('');
            await call(
              'execute',
              rhinoRef,
              `var bt=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var ms=(BlockTableRecord)tr.GetObject(bt[BlockTableRecord.ModelSpace],OpenMode.ForWrite);var p=new Polyline();${vertices}p.Closed=true;ms.AppendEntity(p);tr.AddNewlyCreatedDBObject(p,true);`,
            );
            const after = await call('query', rhinoRef);
            assert.equal(after.model.objects.length, 2);
            assert.deepEqual(
              after.model.scene.map((row) => row.area).sort((a, b) => a - b),
              [240, 260],
            );
            return { text: '첫 CAD 수정 경계를 두 번째 CAD에 새 객체로 복사했습니다.' };
          }
          const points = changed.model.objects[0].points
            .map((point) => `new Point3d(${point.join(',')})`)
            .join(',');
          await call('query', rhinoRef);
          if (failRhino) {
            const failed = await client.callTool({
              name: 'execute',
              arguments: {
                targetRef: rhinoRef,
                code: 'doc.Objects.AddPoint(0,0,0);throw new InvalidOperationException("Synthetic interrupted write");',
              },
            });
            assert.equal(failed.isError, true);
            assert.equal(JSON.parse(failed.content[0].text).code, 'HOST_RESULT_UNKNOWN');
            return { text: 'CAD 후보는 준비됐고 Rhino 쓰기는 결과 확인이 필요합니다.' };
          }
          await call(
            'execute',
            rhinoRef,
            `var curve=new PolylineCurve(new[]{${points}});var shape=Extrusion.Create(curve,6,true);if(shape==null)throw new Exception("Invalid boundary");foreach(var obj in doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject))doc.Objects.Replace(obj.Id,shape);`,
          );
          await call('query', rhinoRef);
          return { text: 'CAD 수정 경계로 Rhino 높이 6 m 후보를 만들었습니다.' };
        } finally {
          await client.close();
        }
      },
    }),
  });
  const project = app.store.createProject('연계 검수');
  const input = {
    body: '기준 후보',
    permission: 'candidate',
    provider: 'codex-cli',
    pins: [],
    sketches: [],
    files: [],
  };
  const save = (id, host, result) =>
    app.store.db
      .prepare('INSERT INTO workspace_requests VALUES(?,?,?,?,?,?)')
      .run(
        id,
        project.id,
        JSON.stringify({ ...input, id, host, body: host + ' 기준 후보' }),
        'succeeded',
        JSON.stringify(result),
        new Date().toISOString(),
      );
  save('cad-basis', 'zwcad', { ...cad, filename: cadFile });
  save('rhino-basis', sameHost ? 'zwcad' : 'rhino', rhino);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => console.error('pageerror:', error.message));
  await page.goto(app.launchUrl);
  console.log('linked: loaded');
  await page.locator('#project-picker').selectOption(project.id);
  await page.getByLabel('참조 추가', { exact: true }).click();
  await page.getByRole('button', { name: '연계 대상', exact: true }).click();
  await page.getByLabel('연계 대상 1', { exact: true }).selectOption('cad-basis');
  await page.getByLabel('연계 대상 2', { exact: true }).selectOption('rhino-basis');
  assert.equal(
    await page.getByRole('button', { name: '요청에 첨부', exact: true }).isEnabled(),
    false,
  );
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '요청에 첨부', exact: true }).click();
  console.log('linked: targets attached');
  await page.reload();
  await page
    .getByLabel('메시지', { exact: true })
    .fill(
      sameHost
        ? '첫 도면 경계 폭을 26 m로 바꾸고 두 번째 도면에 새 객체로 복사해 주세요.'
        : '경계 폭을 26 m로 늘리고 그 수정 경계로 Rhino 높이 6 m 모델도 변경해 주세요.',
    );
  await page.getByLabel('Permission', { exact: true }).selectOption('candidate');
  await page.screenshot({ path: join(directory, 'before-submit.png'), fullPage: true });
  assert.equal(
    await page.getByRole('button', { name: '메시지 보내기', exact: true }).isEnabled(),
    true,
    await page.locator('#validation').innerText(),
  );
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith(`/projects/${project.id}/requests`),
  );
  await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
  const response = await submitted;
  assert.equal(response.status(), 202);
  const parent = await response.json();
  let done;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    done = app.store.db.prepare('SELECT * FROM workspace_requests WHERE id=?').get(parent.id);
    if (!['queued', 'running'].includes(done.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  assert.equal(done.state, failRhino ? 'failed' : 'succeeded', JSON.stringify(done));
  assert.equal(providerCalls, 1);
  const outcomes = JSON.parse(done.result).targetResults;
  const results = outcomes.map((row) =>
    JSON.parse(
      app.store.db.prepare('SELECT result FROM workspace_requests WHERE id=?').get(row.requestId)
        .result,
    ),
  );
  assert.equal(results[0].scene[0].area, 260);
  if (failRhino) assert.equal(outcomes[1].state, 'unknown');
  else if (sameHost) {
    assert.deepEqual(
      results[1].scene.map((row) => row.area).sort((a, b) => a - b),
      [240, 260],
    );
    assert.notEqual(results[1].objects[1].nativeId, results[1].objects[0].nativeId);
  } else assert.ok(Math.abs(results[1].scene[0].volume - 1560) < 1e-7);
  assert.equal(results[0].objects[0].nativeId, cad.objects[0].nativeId);
  if (!failRhino) assert.equal(results[1].objects[0].nativeId, rhino.objects[0].nativeId);
  assert.equal(
    createHash('sha256')
      .update(await readFile(cadFile))
      .digest('hex'),
    cad.fileHash,
  );
  assert.equal(
    createHash('sha256')
      .update(await readFile(rhino.filename))
      .digest('hex'),
    rhino.fileHash,
  );
  await page
    .locator(`[data-request-id="${parent.id}"]`)
    .getByRole('button', { name: '대상 후보 보기', exact: true })
    .last()
    .click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(directory, 'linked-result.png'), fullPage: true });
  await writeFile(
    join(directory, 'passed.json'),
    JSON.stringify(
      {
        passed: true,
        parentId: parent.id,
        outcomes,
        area: 260,
        volume: failRhino || sameHost ? null : 1560,
        sameHost,
        partialUnknownPreserved: failRhino,
        providerCalls,
        deterministicAgent: true,
        packagedApp: Boolean(process.env.VIDE_TEST_PACKAGE_APP),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, directory }));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
}
