import { installBrowserSupport } from './browser-support.mjs';
// Render/hit-test a surveyed point at large coordinates; no host writes or AI calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [playwright, launch] = process.argv.slice(2),
  { chromium } = await import(pathToFileURL(playwright).href),
  { url } = JSON.parse(await readFile(launch, 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installBrowserSupport(page, { fixtures: true });
  await page.goto(url);
  await page.waitForFunction(() =>
    document.querySelector('#connection-status').textContent.includes('연결됨'),
  );
  await page.evaluate(async () => {
    const { createViewport } = await import('/__test__/fixture.mjs');
    const container = document.createElement('div');
    container.id = 'point-fixture';
    Object.assign(container.style, { position: 'fixed', inset: '100px', zIndex: '10000' });
    document.body.append(container);
    window.pointPicks = [];
    window.pointView = createViewport(
      container,
      [],
      (id, pin) => window.pointPicks.push({ id, pin }),
      () => {},
    );
    window.pointView.replace([
      { id: 'survey-point', nativeType: 'Point', origin: [10000, 20000, 30] },
    ]);
    window.pointView.plane('XY');
  });
  const canvas = page.locator('#point-fixture canvas');
  await canvas.click();
  assert.deepEqual(await page.evaluate(() => window.pointPicks), [
    { id: 'survey-point', pin: false },
  ]);
  await page.evaluate(() => window.pointView.mode('pin'));
  await canvas.click();
  assert.deepEqual((await page.evaluate(() => window.pointPicks)).at(-1), {
    id: 'survey-point',
    pin: true,
  });
  await page.evaluate(() => {
    window.pointView.projection('perspective');
    window.pointView.fit();
  });
  await canvas.click();
  assert.equal((await page.evaluate(() => window.pointPicks)).length, 3);
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2);
  assert.equal((await page.evaluate(() => window.pointPicks)).length, 3);
  assert.deepEqual(errors, []);
  await page.evaluate(() => {
    window.pointView.dispose();
    document.getElementById('point-fixture').remove();
  });
  console.log(
    JSON.stringify({
      orthographicPick: true,
      perspectivePick: true,
      pin: true,
      offPointMiss: true,
      largeCoordinates: true,
    }),
  );
} finally {
  await browser.close();
}
