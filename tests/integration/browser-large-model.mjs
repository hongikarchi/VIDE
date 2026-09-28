import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';

const baseline = process.argv.includes('--baseline');
const directory = await mkdtemp(join(tmpdir(), 'vide-large-model-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.glClears = 0;
    window.glBuffers = new Set();
    for (const type of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const clear = type.prototype.clear,
        create = type.prototype.createBuffer,
        remove = type.prototype.deleteBuffer;
      type.prototype.clear = function (...args) {
        window.glClears++;
        return clear.apply(this, args);
      };
      type.prototype.createBuffer = function () {
        const buffer = create.call(this);
        window.glBuffers.add(buffer);
        return buffer;
      };
      type.prototype.deleteBuffer = function (buffer) {
        window.glBuffers.delete(buffer);
        return remove.call(this, buffer);
      };
    }
  });
  await installBrowserSupport(page, { fixtures: true });
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/host', (route) => route.fulfill({ json: { available: false } }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  await page.evaluate(async () => {
    const { createViewport } = await import('/__test__/fixture.mjs');
    const container = document.createElement('div');
    container.id = 'large-fixture';
    Object.assign(container.style, { position: 'fixed', inset: '100px', zIndex: '10000' });
    document.body.append(container);
    window.largePicks = [];
    window.largeView = createViewport(
      container,
      [],
      (ids) => ids.length && window.largePicks.push(ids[0]),
      () => {},
    );
  });
  const results = [];
  for (const count of [1000, 10000]) {
    const elapsed = await page.evaluate(async (count) => {
      const data = Array.from({ length: count }, (_, i) => ({
        id: `point-${i}`,
        nativeType: 'Point',
        origin: [10000 + (i % 100), 20000 + Math.floor(i / 100), 0],
      }));
      const start = performance.now();
      window.largeView.replace(data);
      window.largeView.plane('XY');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    }, count);
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => window.glClears);
    await page.waitForTimeout(300);
    const idleFrames = await page.evaluate((before) => window.glClears - before, before);
    await page.evaluate(() => window.largeView.fit('point-0'));
    const startPick = performance.now();
    await page.locator('#large-fixture canvas').click();
    assert.equal((await page.evaluate(() => window.largePicks)).at(-1), 'point-0');
    if (!baseline) assert.equal(idleFrames, 0, 'Unchanged scene must not redraw');
    results.push({
      count,
      replaceAndFirstFramesMs: elapsed,
      idleFramesIn300ms: idleFrames,
      pickRoundtripMs: performance.now() - startPick,
    });
  }
  const dense = await page.evaluate(async () => {
    const vertices = [],
      indices = [],
      width = 256;
    for (let y = 0; y <= width; y++)
      for (let x = 0; x <= width; x++) vertices.push(x / 10, y / 10, Math.sin(x / 20));
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width; x++) {
        const a = y * (width + 1) + x,
          b = a + width + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    const start = performance.now();
    window.largeView.replace([{ id: 'dense', vertices, indices }]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { triangles: indices.length / 3, replaceAndFirstFramesMs: performance.now() - start };
  });
  if (!baseline) {
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => window.glClears);
    await page.evaluate(() => {
      window.largeView.select(['dense']);
      window.largeView.lines(
        [],
        [
          [0, 0],
          [20, 20],
        ],
        'XY',
      );
    });
    await page.waitForTimeout(100);
    const changed = await page.evaluate(() => window.glClears);
    assert.ok(changed > before, 'Selection and sketch changes must redraw');
    await page.evaluate(() => {
      window.largeView.select(['dense']);
      window.largeView.lines(
        [],
        [
          [0, 0],
          [20, 20],
        ],
        'XY',
      );
    });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.glClears), changed);
    await page.evaluate(() => window.largeView.lines([], [], 'XY'));
  }
  await page.locator('#large-fixture canvas').click();
  assert.equal((await page.evaluate(() => window.largePicks)).at(-1), 'dense');
  const buffersBefore = await page.evaluate(() => window.glBuffers.size);
  await page.evaluate(() => window.largeView.replace([]));
  await page.waitForTimeout(100);
  const buffersAfter = await page.evaluate(() => window.glBuffers.size);
  assert.ok(buffersAfter < buffersBefore, 'Old model GPU buffers must be released');
  await page.evaluate(() => window.largeView.dispose());
  assert.deepEqual(errors, []);
  const evidence = {
    baseline,
    results,
    dense,
    buffersBefore,
    buffersAfter,
    browser: 'Chromium headless, unsafe-swiftshader enabled',
    scaleScope: 'viewport fixtures; not native import support',
  };
  const path = resolve(
    '.vide/viewport-spike',
    `large-model-${baseline ? 'before' : 'after'}-${randomUUID()}.json`,
  );
  await mkdir(resolve('.vide/viewport-spike'), { recursive: true });
  await writeFile(path, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ path, ...evidence }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
