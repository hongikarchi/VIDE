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
    // Layers start collapsed: one row per layer, no object rows yet.
    const layers = container.querySelectorAll('.layer-row').length;
    const lazyRows = container.querySelectorAll('.object').length;
    const layer = container.querySelector('.layer');
    layer.querySelector('.layer-row').click();
    const expanded = layer.querySelector('.layer-row').getAttribute('aria-expanded') === 'true';
    // Rows are capped per layer; the rest is reached by search or 전체 선택.
    const capped = layer.querySelectorAll('.object').length === 400;
    const first = layer.querySelector('.object');
    first.focus();
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true });
    const repeat = performance.now();
    for (let i = 0; i < 100; i++)
      render(objects, [first.getAttribute('aria-label').replace('Object ', '')]);
    const repeatedMs = performance.now() - repeat;
    const replaced = observer.takeRecords().length;
    observer.disconnect();
    const focusRetained = document.activeElement === first;
    const selected = container.querySelectorAll('.object[aria-pressed="true"]').length;
    first.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const clickCorrect = clicked.ids.length === 1 && clicked.mode === 'add';
    layer.querySelector('.group-select').click();
    const groupSelect = clicked.ids.length === 500 && clicked.mode === 'replace';
    // Search opens from the icon and filters layers and objects; closing it clears the filter.
    const toggle = container.querySelector('.layer-search-toggle');
    const searchHidden = container.querySelector('.object-search').hidden;
    toggle.click();
    const search = container.querySelector('.object-search');
    search.value = 'Layer 7';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const searched =
      !search.hidden &&
      container.querySelectorAll('.layer-row').length === 1 &&
      container.querySelector('.object-summary').textContent.startsWith('500개 객체 · 1개 레이어');
    toggle.click();
    const cleared = search.hidden && container.querySelectorAll('.layer-row').length === 20;
    // Several files: each file's name heads its layers, and the swatch takes the layer colour.
    render(
      [
        {
          id: 'a::1',
          name: 'Beam',
          layer: 'a.3dm › S-BEAM',
          layerName: 'S-BEAM',
          documentName: 'a.3dm',
          layerColor: '#ff0000',
          type: 'Curve',
        },
        {
          id: 'b::1',
          name: 'Wall',
          layer: 'b.dwg › A-WALL',
          layerName: 'A-WALL',
          documentName: 'b.dwg',
          type: 'Curve',
        },
      ],
      [],
    );
    const byFile =
      [...container.querySelectorAll('.layer-file')].map((node) => node.textContent).join('|') ===
        'a.3dm|b.dwg' &&
      [...container.querySelectorAll('.layer-name')].map((node) => node.textContent).join('|') ===
        'S-BEAM|A-WALL' &&
      container.querySelector('.sw').style.background !== '';
    render([{ id: 'new', name: 'New object', layer: 'A', type: 'Brep' }], ['new']);
    container.querySelector('.layer-row').click();
    const small =
      container.querySelectorAll('.object').length === 1 &&
      container.querySelector('.object').getAttribute('aria-label') === 'New object';
    render([], []);
    const empty = container.querySelectorAll('.layer').length === 0;
    container.remove();
    return {
      initialMs,
      repeatedMs,
      replaced,
      layers,
      lazyRows,
      expanded,
      capped,
      searchHidden,
      searched,
      cleared,
      byFile,
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
  for (const key of [
    'expanded',
    'capped',
    'searchHidden',
    'searched',
    'cleared',
    'byFile',
    'focusRetained',
    'clickCorrect',
    'groupSelect',
    'small',
    'empty',
  ])
    assert.equal(result[key], true, key);
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
