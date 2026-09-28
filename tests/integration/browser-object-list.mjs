import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../../src/server/server.ts';
import { installBrowserSupport } from './browser-support.mjs';
const directory = await mkdtemp(join(tmpdir(), 'vide-list-'));
let app, browser;
try {
  app = await startServer({ filename: join(directory, 'workspace.sqlite') });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await installBrowserSupport(page, { fixtures: true });
  await page.goto(app.launchUrl);
  const result = await page.evaluate(async () => {
    const { createObjectList } = await import('/__test__/fixture.mjs');
    const container = document.createElement('div');
    document.body.append(container);
    let clicked;
    const render = createObjectList(container, (ids, mode) => (clicked = { ids, mode }));
    const objects = Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      name: 'Object ' + i,
      layer: 'Layer ' + (i % 20),
      type: i % 2 ? 'Brep' : 'Curve',
    }));
    const start = performance.now();
    render(objects, []);
    const initialMs = performance.now() - start;
    // Large models start collapsed: one row per layer, no object rows yet.
    const layers = container.querySelectorAll('.object-group[data-depth="0"]').length;
    const lazyRows = container.querySelectorAll('.object').length;
    const layer = container.querySelector('.object-group[data-depth="0"]');
    layer.open = true;
    layer.dispatchEvent(new Event('toggle'));
    const type = layer.querySelector('.object-group[data-depth="1"]');
    type.open = true;
    type.dispatchEvent(new Event('toggle'));
    const first = type.querySelector('.object');
    first.focus();
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true });
    const repeat = performance.now();
    for (let i = 0; i < 100; i++) render(objects, [first.textContent.replace('Object ', '')]);
    const repeatedMs = performance.now() - repeat;
    const replaced = observer.takeRecords().length;
    observer.disconnect();
    const focusRetained = document.activeElement === first;
    const selected = container.querySelectorAll('.object[aria-pressed="true"]').length;
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const clickCorrect = clicked.ids.length === 1 && clicked.mode === 'add';
    layer.querySelector('.group-select').click();
    const groupSelect = clicked.ids.length === 500 && clicked.mode === 'replace';
    render([{ id: 'new', name: 'New object', layer: 'A', type: 'Brep' }], ['new']);
    const small = container.querySelectorAll('.object').length === 1;
    render([], []);
    const empty = container.querySelectorAll('.object-group').length === 0;
    container.remove();
    return {
      initialMs,
      repeatedMs,
      replaced,
      layers,
      lazyRows,
      focusRetained,
      selected,
      clickCorrect,
      groupSelect,
      small,
      empty,
    };
  });
  assert.equal(result.replaced, 0);
  assert.equal(result.layers, 20);
  assert.equal(result.lazyRows, 0);
  assert.equal(result.selected, 1);
  assert.ok(result.initialMs < 500, 'initial render ' + result.initialMs);
  for (const key of ['focusRetained', 'clickCorrect', 'groupSelect', 'small', 'empty'])
    assert.equal(result[key], true, key);
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
