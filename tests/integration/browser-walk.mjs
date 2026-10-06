// Walk mode (PLAN-37 T-170~T-173): eye-level walking, floors, steps, walls, floor change,
// selection while walking, the work screen's toggle, keys and Escape, and 18,000 objects.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-walk-'));
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
    const notices = [];
    const view = createViewport(
      container,
      [],
      () => {},
      () => {},
      undefined,
      (text) => notices.push(text),
    );
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
    // Ground slab, a wall at x = 8, a stair of ten 0.18 m steps along +y at x 10–12 up to a
    // landing (top 1.8), and an upper floor slab (top 3.6) over x -10–4.
    const stairs = Array.from({ length: 10 }, (_, i) =>
      box(`step-${i}`, [10, i * 0.3, -0.2], [12, (i + 1) * 0.3, (i + 1) * 0.18]),
    );
    view.replace([
      box('ground', [-10, -10, -0.2], [20, 10, 0]),
      box('wall', [8, -10, 0], [8.2, 10, 3]),
      box('upper', [-10, -10, 3.4], [4, 10, 3.6]),
      box('landing', [10, 3, 1.6], [12, 6, 1.8]),
      ...stairs,
    ]);
    const out = {};
    const button = (label) =>
      [...container.querySelectorAll('.walk-bar button')].find((b) => b.textContent === label);
    view.walk(true);
    out.started = view.walkState();
    out.canvas = container.querySelector('canvas').dataset.walk;
    out.bar = !container.querySelector('.walk-bar').hidden;
    // Walk +x for 7 s at 1.4 m/s from x = 0: the wall at x = 8 stops the walker 0.3 m before it.
    view.walkTeleport([0, 0, 0], 0);
    out.atStart = view.walkState().feet;
    out.blocked = view.walkSimulate(['w'], 7000).feet;
    // Selection keeps working while walking: a click on the wall picks it.
    const at = view.screenOf([8, 0, 1.5]);
    out.pick = view.pickAt(at.x, at.y).ids;
    // Collision off: the same walk passes through the wall.
    button('벽 충돌').click();
    view.walkTeleport([0, 0, 0], 0);
    out.through = view.walkSimulate(['w'], 7000).feet;
    button('벽 충돌').click();
    // Diagonal into the wall slides along it.
    view.walkTeleport([6, 0, 0], Math.PI / 4);
    out.slide = view.walkSimulate(['w'], 3000).feet;
    // Stairs: from y = -2 facing +y up ten steps to the landing at 1.8.
    view.walkTeleport([11, -2, 0], Math.PI / 2);
    out.stairs = view.walkSimulate(['w'], 4000).feet;
    // Off the landing's far edge the walker drops to the ground.
    out.fallen = view.walkSimulate(['w'], 4000).feet;
    // Floor change at x = 0: up to the upper slab, nothing above it, down again.
    view.walkTeleport([0, 0, 0], 0);
    out.upOk = view.walkFloor(1);
    out.up = view.walkState().feet;
    out.upAgain = view.walkFloor(1);
    view.walkFloor(-1);
    out.down = view.walkState().feet;
    // The bar's floor buttons do the same.
    button('위층').click();
    out.upButton = view.walkState().feet;
    button('아래층').click();
    out.notices = notices;
    // A double click on the ground ahead walks there (batched objects are on the pick layer).
    view.walkTeleport([0, 0, 0], 0);
    const spot = view.screenOf([3, 0.5, 0]);
    out.jumped = view.walkJump(spot.x, spot.y);
    out.jumpedTo = view.walkState().feet;
    // Turning and running.
    view.walkTeleport([0, 0, 0], 0);
    out.turned = view.walkSimulate(['q'], 1000).yaw;
    view.walkTeleport([-9, 0, 0], 0);
    out.run = view.walkSimulate(['w', 'shift'], 1000).feet;
    // Leaving restores the orbit camera and hides the bar.
    view.walk(false);
    out.left = view.walking();
    out.barAfter = container.querySelector('.walk-bar').hidden;
    // 18,000 small objects: the cost of one walk step among them (moving and turning).
    const many = [box('floor', [-50, -50, -0.2], [250, 250, 0])];
    for (let i = 0; i < 18000; i++) {
      const x = (i % 150) * 1.5,
        y = Math.floor(i / 150) * 1.5;
      many.push(box(`b${i}`, [x, y, 0], [x + 0.4, y + 0.4, 2.5]));
    }
    view.replace(many);
    view.walk(true);
    view.walkTeleport([0.95, 0.95, 0], Math.PI / 2);
    const began = performance.now();
    view.walkSimulate(['w'], 4000);
    out.largeMs = (performance.now() - began) / (4000 / 16);
    out.large = view.walkState();
    view.walk(false);
    view.dispose();
    container.remove();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.equal(result.started.active, true);
  assert.equal(result.canvas, 'true');
  assert.equal(result.bar, true);
  assert.ok(Math.abs(result.atStart[2]) < 0.01, `stands on the ground: ${result.atStart}`);
  assert.ok(
    result.blocked[0] > 7.4 && result.blocked[0] < 7.75,
    `wall stops at ${result.blocked[0]}`,
  );
  assert.deepEqual(result.pick, ['wall']);
  assert.ok(result.through[0] > 8.5, `collision off passes: ${result.through}`);
  assert.ok(
    result.slide[0] < 7.75 && result.slide[1] > 1,
    `slides along the wall: ${result.slide}`,
  );
  assert.ok(
    Math.abs(result.stairs[2] - 1.8) < 0.05 && result.stairs[1] > 3,
    `stairs: ${result.stairs}`,
  );
  assert.ok(Math.abs(result.fallen[2]) < 0.05 && result.fallen[1] > 6, `fell: ${result.fallen}`);
  assert.equal(result.upOk, true);
  assert.ok(Math.abs(result.up[2] - 3.6) < 0.01, `upper floor: ${result.up}`);
  assert.equal(result.upAgain, false);
  assert.ok(Math.abs(result.down[2]) < 0.01, `back down: ${result.down}`);
  assert.ok(Math.abs(result.upButton[2] - 3.6) < 0.01, `bar 위층: ${result.upButton}`);
  assert.ok(result.notices.includes('위층이 없습니다.'));
  assert.equal(result.jumped, true);
  assert.ok(
    Math.abs(result.jumpedTo[0] - 3) < 0.1 && Math.abs(result.jumpedTo[1] - 0.5) < 0.1,
    `jump: ${result.jumpedTo}`,
  );
  assert.ok(result.turned > 1.4 && result.turned < 1.8, `turn ${result.turned}`);
  assert.ok(result.run[0] > -9 + 3.5, `run ${result.run}`);
  assert.equal(result.left, false);
  assert.equal(result.barAfter, true);
  // Among the posts the walker is blocked or slides; it never stands inside one.
  assert.ok(result.large.candidates > 0);
  assert.ok(result.largeMs < 8, `a walk step among 18,000 objects took ${result.largeMs} ms`);

  // The work screen: the 걷기 button, Escape, and the sketch tool ending the walk.
  await page.click('#walk-toggle');
  await page.waitForFunction(() => document.querySelector('#walk-toggle').ariaPressed === 'true');
  assert.equal(await page.locator('#canvas .walk-bar').isVisible(), true);
  await page.locator('#canvas canvas').focus();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#walk-toggle').ariaPressed !== 'true');
  assert.equal(await page.locator('#canvas .walk-bar').isVisible(), false);
  await page.click('#walk-toggle');
  await page.waitForFunction(() => document.querySelector('#walk-toggle').ariaPressed === 'true');
  await page.click('[data-tool="sketch"]');
  await page.waitForFunction(() => document.querySelector('#walk-toggle').ariaPressed !== 'true');
  assert.deepEqual(errors, []);
  console.log('browser-walk: ok');
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
