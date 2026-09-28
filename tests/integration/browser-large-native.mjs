import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { sdkOptions } from '../../src/server/sdk-options.ts';

const fixture = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert.equal(fixture.passed, true);
const directory = resolve('.vide/browser-large-native', randomUUID());
await mkdir(directory, { recursive: true });
let app, browser;
try {
  app = await startServer({
    filename: join(directory, 'test.sqlite'),
    sdkOptions: sdkOptions(directory),
  });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(120000);
  const metrics = await page.context().newCDPSession(page);
  await metrics.send('Performance.enable');
  const memory = async () => {
    const result = await metrics.send('Performance.getMetrics');
    return Object.fromEntries(
      result.metrics
        .filter((row) =>
          ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents'].includes(row.name),
        )
        .map((row) => [row.name, row.value]),
    );
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => document.querySelector('#project-picker')?.value);
  const evidence = [];
  for (const sample of fixture.evidence) {
    const beforeMemory = await memory();
    const start = performance.now();
    await page.locator('#model-file').setInputFiles(sample.filename);
    await page.waitForFunction(
      (count) => document.querySelectorAll('#objects .object').length === count,
      sample.count,
      { timeout: 120000 },
    );
    const elapsed = performance.now() - start;
    await page.locator('#document-tree').evaluate((node) => (node.open = true));
    await page.locator('#objects .object').last().click();
    assert.equal(await page.locator('#objects .object[aria-pressed="true"]').count(), 1);
    assert.equal(
      await page.locator('#objects .object').last().getAttribute('aria-pressed'),
      'true',
    );
    const row = app.store.db
      .prepare('SELECT state,result FROM workspace_requests ORDER BY rowid DESC LIMIT 1')
      .get();
    assert.equal(row.state, 'succeeded');
    const result = JSON.parse(row.result);
    assert.equal(result.objects.length, sample.count);
    assert.equal(result.scene.length, sample.count);
    await page.screenshot({ path: join(directory, sample.kind + '.png') });
    evidence.push({
      kind: sample.kind,
      count: sample.count,
      importAndUiMs: elapsed,
      lastObjectSelected: true,
      memoryBefore: beforeMemory,
      memoryAfter: await memory(),
      nodeMemory: process.memoryUsage(),
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({ passed: true, evidence }, null, 2),
  );
  console.log(JSON.stringify({ directory, passed: true, evidence }));
} finally {
  await browser?.close();
  await app?.close();
}
