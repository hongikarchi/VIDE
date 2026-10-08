// Viewport display settings: Rhino colours by source, shading modes, crease edges and the popover.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-display-'));
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
    document.body.append(container);
    const view = createViewport(
      container,
      [],
      () => {},
      () => {},
    );
    // A cube with Rhino display colours next to a plain line without colour metadata.
    const cube = {
      id: 'wall',
      displayColor: '#aa3322',
      layerColor: '#22aa33',
      materialColor: '#2233aa',
      vertices: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
      indices: [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
        0, 4, 3, 4, 7,
      ],
    };
    // CAD entities: raw ACI `color` (legacy export), resolved ACI + lineweight, and ByLayer.
    view.replace([
      cube,
      { id: 'plain', line: [0, 0, 0, 2, 0, 0] },
      { id: 'cad-red', line: [0, 1, 0, 2, 1, 0], color: 1 },
      { id: 'cad-hue', segments: [0, 2, 0, 2, 2, 0], colorIndex: 30, lineWeight: 0.5 },
      { id: 'cad-bylayer', line: [0, 3, 0, 2, 3, 0], color: 256, layerColor: '#123456' },
    ]);
    const base = { mode: 'shaded', edges: true, background: 'light', plot: false };
    const colors = {};
    for (const source of ['default', 'layer', 'object', 'material']) {
      view.display({ ...base, colorSource: source });
      colors[source] = [view.colorOf('wall'), view.colorOf('plain')];
    }
    view.display({ ...base, colorSource: 'object' });
    const cad = ['cad-red', 'cad-hue', 'cad-bylayer'].map((id) => view.colorOf(id));
    view.display({ ...base, colorSource: 'layer' });
    const byLayer = view.colorOf('cad-bylayer');
    view.display({ ...base, colorSource: 'object', plot: true });
    const plot = {
      ink: ['cad-red', 'cad-hue', 'plain', 'wall'].map((id) => view.colorOf(id)),
      widths: [view.plotWidthOf('cad-red'), view.plotWidthOf('cad-hue')],
      background: container.querySelector('canvas').dataset.background,
    };
    // A plugged-in table (e.g. a parsed .ctb) can remap one ACI pen.
    view.plotStyle({
      name: 'test.ctb',
      pens: { 1: { color: '#ff00ff', lineWeight: 1 } },
      fallback: { color: '#000000', lineWeight: 'object' },
      defaultLineWeight: 0.25,
    });
    plot.custom = [view.colorOf('cad-red'), view.plotWidthOf('cad-red')];
    view.plotStyle();
    view.display({ ...base, colorSource: 'object' });
    const unplotted = view.colorOf('cad-red');
    view.select(['wall']);
    const selected = view.colorOf('wall');
    view.select([]);
    const restored = view.colorOf('wall');
    view.display({ ...base, colorSource: 'layer', mode: 'wireframe' });
    const wire = container.querySelector('canvas').dataset.display;
    view.display({ ...base, colorSource: 'layer', background: 'dark' });
    const background = container.querySelector('canvas').dataset.background;
    // A Rhino object larger than one host reply comes as its bounding box (`oversized`): drawn as
    // an outline, not as a solid that reads like real geometry. A nested block arrives expanded.
    view.replace(
      [
        { ...cube, id: 'standin', oversized: true },
        {
          id: 'nested',
          vertices: [],
          indices: [],
          block: {
            definition: 'outer',
            transform: [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
        },
      ],
      {
        outer: {
          hash: 'f'.repeat(64),
          vertices: [...cube.vertices, ...cube.vertices.map((v, i) => (i % 3 === 0 ? v + 2 : v))],
          indices: [...cube.indices, ...cube.indices.map((v) => v + 8)],
          segments: [],
          texts: [],
        },
      },
    );
    const shapes = { standin: view.shapeOf('standin'), nested: view.shapeOf('nested') };
    view.dispose();
    container.remove();
    return { colors, selected, restored, wire, background, cad, byLayer, plot, unplotted, shapes };
  });
  assert.deepEqual(result.shapes.standin, { kind: 'segments', standIn: true, points: 24 });
  assert.deepEqual(result.shapes.nested, { kind: 'mesh', standIn: false, points: 16 });
  assert.deepEqual(result.colors.default, ['#d6d9d3', '#4c5650']);
  assert.equal(result.colors.layer[0], '#22aa33');
  assert.equal(result.colors.object[0], '#aa3322');
  assert.equal(result.colors.material[0], '#2233aa');
  // Objects without Rhino colours keep the neutral fallback for every source.
  assert.equal(result.colors.layer[1], '#4c5650');
  assert.equal(result.selected, '#e3a392');
  assert.equal(result.restored, '#aa3322');
  assert.equal(result.wire, 'wireframe');
  assert.equal(result.background, 'dark');
  // CAD colours: ACI 1 = red, ACI 30 = orange; ByLayer falls back until a layer colour is shown.
  assert.deepEqual(result.cad, ['#ff0000', '#ff7f00', '#4c5650']);
  assert.equal(result.byLayer, '#123456');
  // monochrome.ctb: black ink, lineweight 0.5 mm wider than the 0.25 mm default.
  assert.deepEqual(result.plot.ink, ['#000000', '#000000', '#000000', '#000000']);
  assert.ok(result.plot.widths[1] > result.plot.widths[0], JSON.stringify(result.plot.widths));
  assert.equal(result.plot.background, 'light');
  assert.equal(result.plot.custom[0], '#ff00ff');
  assert.ok(result.plot.custom[1] > result.plot.widths[1]);
  assert.equal(result.unplotted, '#ff0000');
  // Popover: choosing a colour source updates the app viewport and persists.
  await page.locator('#display-settings').click();
  const popover = page.getByRole('dialog', { name: '뷰포트 표시', exact: true });
  await popover.getByRole('button', { name: '레이어 색', exact: true }).click();
  assert.equal(await page.locator('#canvas canvas').getAttribute('data-color-source'), 'layer');
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem('vide:viewport-display')).colorSource,
    ),
    'layer',
  );
  await page.keyboard.press('Escape');
  assert.equal(await popover.isHidden(), true);
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#body').disabled);
  assert.equal(await page.locator('#canvas canvas').getAttribute('data-color-source'), 'layer');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, ...result }));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
