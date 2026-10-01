// CAD display fidelity: per-segment styles in blocks, solid fills with holes and text annotations.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';
import { runDirectory } from './run-directory.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-cad-display-'));
const evidence = runDirectory('browser-cad-display');
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installBrowserSupport(page, { fixtures: true });
  await page.route('**/api/v1/providers', (route) => route.fulfill({ json: [] }));
  await page.goto(app.launchUrl);
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  const result = await page.evaluate(async () => {
    const { createViewport } = await import('/__test__/fixture.mjs');
    const container = document.createElement('div');
    Object.assign(container.style, { position: 'fixed', inset: '100px', zIndex: '10000' });
    container.id = 'cad-fixture';
    document.body.append(container);
    const picks = [];
    const view = createViewport(
      container,
      [],
      (ids) => picks.push(ids),
      () => {},
    );
    window.cadView = view;
    window.cadPicks = picks;
    view.replace([
      // A block reference: two child runs with different ACI and lineweight.
      {
        id: 'block',
        segments: [0, 0, 0, 4, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0, 4, 3, 0],
        segmentStyles: [
          { n: 2, ci: 1, lw: 0.5, layer: '#ff0000' },
          { n: 1, ci: 5, rgb: '#00a0ff', lw: 0.13, layer: '#0000ff' },
        ],
        colorIndex: 1,
      },
      // Solid hatch with a square hole, on a layer coloured green.
      {
        id: 'hatch',
        segments: [6, 0, 0, 10, 0, 0],
        fills: [
          {
            loops: [
              [6, 0, 0, 10, 0, 0, 10, 4, 0, 6, 4, 0],
              [7, 1, 0, 9, 1, 0, 9, 3, 0, 7, 3, 0],
            ],
            ci: 3,
            layer: '#00ff00',
          },
        ],
        colorIndex: 3,
      },
      // Text-only entities: Korean single line, and a rotated multi-line MText.
      {
        id: 'label',
        texts: [{ s: '회의실 A-101', p: [0, 6, 0], h: 0.5, r: 0, ax: 0, ay: 0, ci: 2 }],
      },
      {
        id: 'note',
        texts: [
          {
            s: '비고\nNOTE line 2',
            p: [6, 8, 0],
            h: 0.4,
            r: Math.PI / 12,
            wf: 0.8,
            ax: 1,
            ay: 3,
            ci: 7,
          },
        ],
      },
    ]);
    view.plane('XY');
    const base = { mode: 'shaded', edges: true, background: 'light', plot: false };
    view.display({ ...base, colorSource: 'object' });
    const object = {
      block: view.cadInfo('block'),
      hatch: view.cadInfo('hatch'),
      label: view.cadInfo('label'),
      note: view.cadInfo('note'),
    };
    view.display({ ...base, colorSource: 'layer' });
    const layer = view.cadInfo('block').lineColors;
    view.display({ ...base, colorSource: 'default' });
    const neutral = view.cadInfo('block').lineColors;
    view.display({ ...base, colorSource: 'object', mode: 'wireframe' });
    const wireFill = view.cadInfo('hatch').fills[0].visible;
    view.display({ ...base, colorSource: 'object', plot: true });
    const plot = {
      block: view.cadInfo('block').plot,
      hatch: view.cadInfo('hatch').fills[0].colors,
      text: view.cadInfo('label').texts[0].colors,
    };
    view.display({ ...base, colorSource: 'object' });
    view.select(['label']);
    const selectedText = view.cadInfo('label').texts[0].colors;
    view.select([]);
    return {
      object,
      layer,
      neutral,
      wireFill,
      plot,
      selectedText,
      labelPoint: view.screenOf([1.2, 6.2, 0]),
    };
  });
  // Per-run screen colours by source.
  assert.deepEqual(result.object.block.lineColors, ['#00a0ff', '#ff0000']);
  assert.equal(result.object.block.vertexColors, true);
  assert.deepEqual(result.layer, ['#0000ff', '#ff0000']);
  assert.deepEqual(result.neutral, ['#4c5650']);
  // Fill with a hole: an outer square minus an inner square triangulates to 8 triangles.
  assert.equal(result.object.hatch.fills.length, 1);
  assert.equal(result.object.hatch.fills[0].triangles, 8);
  assert.deepEqual(result.object.hatch.fills[0].colors, ['#00ff00']);
  assert.equal(result.wireFill, false);
  // Texts: one quad per line, ACI 2 yellow; ACI 7 is dark foreground on a light background.
  assert.equal(result.object.label.texts[0].quads, 1);
  assert.deepEqual(result.object.label.texts[0].colors, ['#ffff00']);
  assert.equal(result.object.note.texts[0].quads, 2);
  assert.deepEqual(result.object.note.texts[0].colors, ['#1f2421']);
  // monochrome.ctb: two weight batches (0.5 / 0.13 mm), black ink; fills and texts print black.
  assert.equal(result.plot.block.length, 2, JSON.stringify(result.plot.block));
  assert.ok(result.plot.block.every((batch) => batch.colors.join() === '#000000'));
  assert.notEqual(result.plot.block[0].width, result.plot.block[1].width);
  assert.deepEqual(result.plot.hatch, ['#000000']);
  assert.deepEqual(result.plot.text, ['#000000']);
  assert.deepEqual(result.selectedText, ['#d0664a']);
  // Clicking a text quad selects the owning object.
  await page.mouse.click(result.labelPoint.x, result.labelPoint.y);
  assert.deepEqual(await page.evaluate(() => window.cadPicks.at(-1)), ['label']);
  // Crossing window around the note selects it although it has no line geometry.
  const box = await page.evaluate(() => [
    window.cadView.screenOf([7.5, 7.5, 0]),
    window.cadView.screenOf([5.5, 8.6, 0]),
  ]);
  await page.mouse.move(box[0].x, box[0].y);
  await page.mouse.down();
  await page.mouse.move(box[1].x, box[1].y, { steps: 5 });
  await page.mouse.up();
  assert.ok(
    (await page.evaluate(() => window.cadPicks.at(-1))).includes('note'),
    JSON.stringify(await page.evaluate(() => window.cadPicks)),
  );
  await page.evaluate(() =>
    window.cadView.display({
      mode: 'shaded',
      edges: true,
      background: 'light',
      plot: false,
      colorSource: 'object',
    }),
  );
  await page.locator('#cad-fixture').screenshot({ path: join(evidence, 'cad-display.png') });
  await page.evaluate(() =>
    window.cadView.display({
      mode: 'shaded',
      edges: true,
      background: 'light',
      plot: true,
      colorSource: 'object',
    }),
  );
  await page.locator('#cad-fixture').screenshot({ path: join(evidence, 'cad-plot.png') });
  await page.evaluate(() => window.cadView.dispose());
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
