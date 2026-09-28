// Real browser sketch -> subscription agent -> RhinoCommon -> saved/read-back geometry.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';

const directory = resolve('.vide/sdk-sketch', randomUUID());
await mkdir(directory, { recursive: true });
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: {
      directory: join(directory, 'workers'),
      executable: 'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
      plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
      bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const projectId = await page.locator('#project-picker').inputValue();
  await page.locator('#model').selectOption('claude-opus-4-6');
  await page.locator('#effort').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#effort-label').textContent(), 'low');
  await page.locator('#permission').selectOption('candidate');
  await page.locator('[data-tool="sketch"]').click();
  await page.locator('#sketch-coordinates').evaluate((node) => (node.open = true));
  await page.locator('#line-role').selectOption('boundary');
  const points = [
    [0, 0],
    [6, 0],
    [6, 4],
    [0, 4],
    [0, 0],
  ];
  for (const [u, v] of points) {
    await page.locator('#point-u').fill(String(u));
    await page.locator('#point-v').fill(String(v));
    await page.locator('#add-point').click();
  }
  await page.locator('#finish-sketch').click();
  await page
    .locator('#body')
    .fill(
      '첨부한 XY 경계 스케치 그대로 위로 3 m 돌출해서 닫힌 솔리드 하나를 만들어줘. 이름은 스케치 매스. 다른 객체는 만들지 마.',
    );
  await page.locator('#request').click();
  let saved;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const rows = await page.evaluate(
      async (id) => await (await fetch(`/api/v1/projects/${id}/requests`)).json(),
      projectId,
    );
    if (rows.length && !['queued', 'running'].includes(rows.at(-1).state)) {
      saved = rows.at(-1);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(saved, 'Request did not finish; inspect ' + directory);
  assert.equal(saved.state, 'succeeded', JSON.stringify(saved.result));
  assert.equal(saved.result.executionMode, 'sdk');
  assert.equal(saved.result.hostExecuted, true);
  assert.deepEqual(saved.input.sketches[0].points, points);
  assert.equal(saved.input.sketches[0].role, 'boundary');
  assert.equal(saved.result.objects.length, 1);
  const scene = saved.result.scene[0];
  assert.deepEqual(scene.boundsSize, [6, 4, 3]);
  assert.ok(Math.abs(scene.volume - 72) < 1e-7);
  await page.getByRole('button', { name: '이 후보 보기', exact: true }).click();
  await page.locator('#document-tree').evaluate((node) => (node.open = true));
  await page.locator('#objects .object').first().click();
  await page.screenshot({ path: join(directory, 'viewport.png') });
  const evidence = {
    passed: true,
    directory,
    projectId,
    requestId: saved.id,
    points,
    bounds: scene.boundsSize,
    volume: scene.volume,
    usage: saved.result.usage,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
}
