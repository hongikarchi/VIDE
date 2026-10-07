// Section view (SPEC-01.15, PLAN-43 T-197): a plane or a box cuts only VIDE's drawing. The cut side
// is empty in the captured pixels and cannot be picked, flip keeps the other side, the section
// stays while walking, turning it off draws everything again, and the work screen's 단면 panel
// drives the same viewer: a plane drawn with two clicks in the top view (Escape, right click and
// a repeated click on the first point), the axis plane, box sliders, off. Synthetic scene.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vide-section-'));
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
  // Shared page helpers: two boxes left (x -6..-2) and right (x 2..6), and a pixel probe that
  // tells whether a world point's pixel shows the model or the background.
  await page.evaluate(() => {
    // The work screen's viewer; the fixture's viewer below takes over window.videViewport.
    window.appViewport = window.videViewport;
    const box = (id, [x0, y0, z0], [x1, y1, z1]) => ({
      id,
      vertices: [
        x0,
        y0,
        z0,
        x1,
        y0,
        z0,
        x1,
        y1,
        z0,
        x0,
        y1,
        z0,
        x0,
        y0,
        z1,
        x1,
        y0,
        z1,
        x1,
        y1,
        z1,
        x0,
        y1,
        z1,
      ],
      indices: [
        0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3,
        0, 4, 3, 4, 7,
      ],
    });
    window.sectionScene = () => [
      box('left', [-6, -2, 0], [-2, 2, 4]),
      box('right', [2, -2, 0], [6, 2, 4]),
    ];
    /** 'model' or 'empty' for each world point, from the viewer's own capture. */
    window.probe = async (view, points) => {
      const canvas = view.canvasElement ?? document.querySelector('#canvas canvas');
      const url = view.capture();
      const image = new Image();
      image.src = url;
      await image.decode();
      const off = document.createElement('canvas');
      off.width = image.width;
      off.height = image.height;
      const context = off.getContext('2d');
      context.drawImage(image, 0, 0);
      const r = canvas.getBoundingClientRect();
      return points.map((point) => {
        const at = view.screenOf(point);
        const x = Math.round(((at.x - r.left) / r.width) * image.width),
          y = Math.round(((at.y - r.top) / r.height) * image.height);
        const [red, green, blue] = context.getImageData(x, y, 1, 1).data;
        // The light background is #f2f1ee (242, 241, 238).
        const background =
          Math.abs(red - 242) <= 3 && Math.abs(green - 241) <= 3 && Math.abs(blue - 238) <= 3;
        return background ? 'empty' : 'model';
      });
    };
  });

  // 1. The viewer alone (fixture): plane, flip, picking, walking, box, off.
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
    view.canvasElement = container.querySelector('canvas');
    view.replace(window.sectionScene());
    const tops = [
      [-4, 0, 4],
      [4, 0, 4],
    ];
    const out = {};
    out.bounds = view.modelBounds();
    out.before = await window.probe(view, tops);
    // Plane on x at 0 keeps x ≤ 0: the right box is cut away and cannot be picked.
    view.setSection({ mode: 'plane', axis: 'x', offset: 0, flip: false });
    out.plane = await window.probe(view, tops);
    const right = view.screenOf([4, 0, 4]);
    out.pickCut = view.pickAt(right.x, right.y).ids;
    const left = view.screenOf([-4, 0, 4]);
    out.pickKept = view.pickAt(left.x, left.y).ids;
    out.dataset = view.canvasElement.dataset.section;
    // Flip keeps the other side.
    view.setSection({ mode: 'plane', axis: 'x', offset: 0, flip: true });
    out.flip = await window.probe(view, tops);
    // A z plane at 2 m keeps the lower half: the tops (z = 4) are gone, the boxes' middles stay.
    view.setSection({ mode: 'plane', axis: 'z', offset: 2, flip: false });
    out.zTops = await window.probe(view, [...tops, [-4, -2, 1], [4, -2, 1]]);
    // The section stays while walking.
    view.setSection({ mode: 'plane', axis: 'x', offset: 0, flip: false });
    view.walk(true);
    view.walkTeleport([0, -12, 0], Math.PI / 2);
    out.walking = await window.probe(view, [
      [-4, 0, 1.5],
      [4, 0, 1.5],
    ]);
    out.walkSection = view.section()?.mode;
    view.walk(false);
    // A box around the left box only.
    view.setSection({ mode: 'box', min: [-7, -3, -1], max: [0, 3, 5] });
    out.box = await window.probe(view, tops);
    // Off draws everything again.
    view.setSection(null);
    out.off = await window.probe(view, tops);
    out.offDataset = view.canvasElement.dataset.section;
    view.dispose();
    container.remove();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(result.bounds, { min: [-6, -2, 0], max: [6, 2, 4] });
  assert.deepEqual(result.before, ['model', 'model']);
  assert.deepEqual(result.plane, ['model', 'empty']);
  assert.deepEqual(result.pickCut, []);
  assert.deepEqual(result.pickKept, ['left']);
  assert.equal(result.dataset, 'plane');
  assert.deepEqual(result.flip, ['empty', 'model']);
  assert.deepEqual(result.zTops, ['empty', 'empty', 'model', 'model']);
  assert.deepEqual(result.walking, ['model', 'empty']);
  assert.equal(result.walkSection, 'plane');
  assert.deepEqual(result.box, ['model', 'empty']);
  assert.deepEqual(result.off, ['model', 'model']);
  assert.equal(result.offDataset, 'off');

  // 2. The work screen's 단면 panel.
  const pressed = () => page.locator('#section-toggle').getAttribute('aria-pressed');
  const section = () => page.evaluate(() => window.appViewport.section());
  await page.click('#section-toggle');
  await page.locator('#section-panel').waitFor();
  // With nothing shown there is nothing to cut: the section stays off.
  await page.click('#section-panel [data-section="plane"]');
  assert.equal(await section(), null);
  assert.equal(await pressed(), 'false');
  const slide = (label, value) =>
    page.evaluate(
      ([label, value]) => {
        const input = document.querySelector(`#section-panel input[aria-label="${label}"]`);
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          input,
          String(value),
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
      [label, value],
    );
  await page.evaluate(() => window.appViewport.replace(window.sectionScene()));
  // Two-point plane (the default for 평면), drawn in the top view like Rhino's clipping plane.
  const placing = () => page.evaluate(() => window.appViewport.sectionPlacing());
  const at = (point) => page.evaluate((point) => window.appViewport.screenOf(point), point);
  const click = async (point, options) => {
    const { x, y } = await at(point);
    await page.mouse.click(x, y, options);
  };
  const probeAt = (points) =>
    page.evaluate((points) => window.probe(window.appViewport, points), points);
  await page.evaluate(() => window.appViewport.plane('XY'));
  const leftColour = await page.evaluate(() => window.appViewport.colorOf('left'));
  await page.click('#section-panel [data-section="plane"]');
  assert.equal(await placing(), 'first');
  assert.equal(await section(), null);
  assert.equal(await pressed(), 'true');
  await page.locator('#section-panel .section-hint').waitFor();
  // Escape before any line: the drawing stops, the plane turns off, the panel stays open.
  await page.keyboard.press('Escape');
  assert.equal(await placing(), null);
  assert.equal(await pressed(), 'false');
  assert.equal(await page.locator('#section-panel').isVisible(), true);
  // First point on the left box's top (x = -4), then a click on the same spot is ignored.
  await page.click('#section-panel [data-section="plane"]');
  await click([-4, -1, 4]);
  assert.equal(await placing(), 'second');
  await click([-4, -1, 4]);
  assert.equal(await placing(), 'second');
  await page.mouse.move((await at([-4, 1, 4])).x, (await at([-4, 1, 4])).y);
  await click([-4, 1, 4]);
  assert.equal(await placing(), null);
  const line = await section();
  assert.equal(line.mode, 'line');
  assert.ok(
    Math.abs(line.point[0] + 4) < 0.05 && Math.abs(line.point[2] - 4) < 0.05,
    `snapped: ${JSON.stringify(line)}`,
  );
  assert.ok(
    Math.abs(line.normal[0] + 1) < 1e-6 && Math.abs(line.normal[1]) < 1e-6,
    `kept side: ${JSON.stringify(line)}`,
  );
  // Placing points picks nothing, and the panel stayed open.
  assert.equal(await page.evaluate(() => window.appViewport.colorOf('left')), leftColour);
  assert.equal(await page.locator('#section-panel').isVisible(), true);
  await page.locator('#section-panel .section-line').waitFor();
  // Keeps x ≤ -4: the far left of the left box stays, its right part and the right box are cut.
  const across = [
    [-4.9, 0.9, 4],
    [-2.5, 0.9, 4],
    [4.9, 0.9, 4],
  ];
  assert.deepEqual(await probeAt(across), ['model', 'empty', 'empty']);
  await page.getByLabel('반대쪽 남기기').check();
  assert.deepEqual(await probeAt(across), ['empty', 'model', 'model']);
  await page.getByLabel('반대쪽 남기기').uncheck();
  // 위치 moves the plane along its normal: -3 puts it at x = -1.
  await slide('단면선 위치', -3);
  assert.ok(Math.abs((await section()).offset + 3) < 0.05);
  assert.deepEqual(await probeAt(across), ['model', 'model', 'empty']);
  // Redrawing, then Escape or a right click: the drawn line stays.
  await page.click('#section-panel .section-draw');
  assert.equal(await placing(), 'first');
  await page.keyboard.press('Escape');
  assert.equal(await placing(), null);
  assert.equal((await section()).mode, 'line');
  await page.click('#section-panel .section-draw');
  await click([3, 0, 0], { button: 'right' });
  assert.equal(await placing(), null);
  assert.equal((await section()).mode, 'line');
  assert.equal(await page.locator('#section-panel').isVisible(), true);
  // 축 기준: Z by default, at the middle of the model; X puts it at x = 0 and cuts the right box.
  await page.evaluate(() => window.appViewport.home());
  await page.click('#section-panel [data-section="axis"]');
  assert.equal(await pressed(), 'true');
  assert.equal((await section()).axis, 'z');
  await page.click('#section-panel [data-section="x"]');
  const plane = await section();
  assert.equal(plane.axis, 'x');
  assert.ok(Math.abs(plane.offset) < 1e-9, `plane at ${plane.offset}`);
  const tops = [
    [-4, 0, 4],
    [4, 0, 4],
  ];
  const probe = () => page.evaluate((points) => window.probe(window.appViewport, points), tops);
  assert.deepEqual(await probe(), ['model', 'empty']);
  await page.getByLabel('반대쪽 남기기').check();
  assert.deepEqual(await probe(), ['empty', 'model']);
  // Box: starts around the whole model, then its X 최대 slider pulls the +x face to x = 0.
  await page.click('#section-panel [data-section="box"]');
  const box = await section();
  assert.ok(box.min[0] < -6 && box.max[0] > 6, `box starts at the bounds: ${JSON.stringify(box)}`);
  assert.deepEqual(await probe(), ['model', 'model']);
  await slide('X 최대', 0);
  const slid = await section();
  assert.ok(Math.abs(slid.max[0]) < 0.05, `X 최대 moved: ${slid.max[0]}`);
  assert.deepEqual(await probe(), ['model', 'empty']);
  // The min face never passes the max face: dragging X 최소 past it moves both.
  await slide('X 최소', 3);
  const pushed = await section();
  assert.ok(
    pushed.min[0] <= pushed.max[0] + 1e-9,
    `faces kept in order: ${JSON.stringify(pushed)}`,
  );
  await page.click('#section-panel .section-reset');
  assert.deepEqual(await probe(), ['model', 'model']);
  // Escape closes the panel; the section stays until it is turned off.
  await page.keyboard.press('Escape');
  await page.locator('#section-panel').waitFor({ state: 'hidden' });
  assert.equal(await pressed(), 'true');
  await page.click('#section-toggle');
  await page.click('#section-panel [data-section="off"]');
  assert.equal(await section(), null);
  assert.equal(await pressed(), 'false');
  assert.deepEqual(await probe(), ['model', 'model']);

  assert.deepEqual(errors, []);
  console.log('browser-section: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
