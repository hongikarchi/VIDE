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
    // The left panel's section (its styles indent sublayers).
    container.className = 'nav-section';
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
    // Rhino sublayers (user request 2026-10-08): a tree in Rhino's panel order, subtree counts,
    // subtree 선택, remembered expand state, inherited off state, search keeps the ancestors.
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const table = [
      ['Site', null, 1, true, 0],
      ['Bldg', null, 2, true, 0],
      ['Bldg::L1', 2, 3, true, 0],
      ['Bldg::L1::Walls', 3, 4, true, 2],
      ['Bldg::L1::Walls::Ext', 4, 5, true, 1],
      ['Bldg::L1::Slab', 3, 6, true, 1],
      ['Bldg::L2', 2, 7, false, 0],
      ['Bldg::L2::Walls', 7, 8, true, 3],
    ].map(([fullPath, parent, n, visible, objectCount]) => ({
      id: uuid(n),
      parentId: parent ? uuid(parent) : null,
      fullPath,
      visible,
      locked: fullPath === 'Bldg::L1::Slab',
      color: '#336699',
      // Rhino's order: Bldg before Site.
      order: fullPath === 'Site' ? 10 : n,
      objectCount,
    }));
    const rhino = [
      ['w1', 'Bldg::L1::Walls'],
      ['w2', 'Bldg::L1::Walls'],
      ['e1', 'Bldg::L1::Walls::Ext'],
      ['s1', 'Bldg::L1::Slab'],
      ['t1', 'Site'],
    ].map(([id, path]) => ({
      id,
      name: 'Obj ' + id,
      layer: path,
      layerName: path,
      documentKey: 'doc-rhino',
      documentName: 'model.3dm',
      layerTable: table,
      host: 'rhino',
      type: 'Brep',
    }));
    render(rhino, []);
    const topNames = () =>
      [...container.querySelectorAll('.object-groups > .layer > .layer-row .layer-name')].map(
        (node) => node.textContent,
      );
    const rowOf = (path) => container.querySelector(`.layer[data-path="${path}"]`);
    const roots = topNames().join('|') === 'Bldg|Site';
    const bldg = rowOf('Bldg');
    const subtreeCount = bldg.querySelector('.layer-count').textContent === '4';
    const collapsed =
      bldg.querySelector('.layer-row').getAttribute('aria-expanded') === 'false' &&
      !rowOf('Bldg::L1');
    bldg.querySelector('.layer-row').click();
    const children = [...bldg.querySelector('.layer-objects').children]
      .map((node) => node.dataset.path)
      .join('|');
    const childOrder = children === 'Bldg::L1|Bldg::L2';
    // Bldg::L2 is off: greyed, with the host's count of what was not brought in.
    const l2 = rowOf('Bldg::L2');
    const offShown =
      l2.classList.contains('layer-off') &&
      l2.querySelector('.layer-count').textContent === '3' &&
      !l2.querySelector('.group-select');
    rowOf('Bldg::L1').querySelector('.layer-row').click();
    rowOf('Bldg::L1::Walls').querySelector('.layer-row').click();
    // Sublayers first, then own objects; indent grows with depth.
    const walls = rowOf('Bldg::L1::Walls');
    const wallsBody = [...walls.querySelector('.layer-objects').children].map(
      (node) => node.dataset.path ?? node.getAttribute('aria-label'),
    );
    const sublayersFirst = wallsBody.join('|') === 'Bldg::L1::Walls::Ext|Obj w1|Obj w2';
    const indent =
      walls.querySelector('.layer-row').style.getPropertyValue('--depth') === '2' &&
      parseFloat(getComputedStyle(walls.querySelector('.layer-row')).paddingLeft) >
        parseFloat(getComputedStyle(bldg.querySelector('.layer-row')).paddingLeft);
    const locked = Boolean(rowOf('Bldg::L1::Slab').querySelector('.layer-state'));
    bldg.querySelector('.group-select').click();
    const subtreeSelect =
      clicked.ids.slice().sort().join(',') === 'e1,s1,w1,w2' && clicked.mode === 'replace';
    // The expand state is remembered per file: a redraw (new table) keeps Bldg and L1 open.
    render(
      rhino.map((row) => ({ ...row, layerTable: [...table] })),
      [],
    );
    const remembered =
      rowOf('Bldg').querySelector('.layer-row').getAttribute('aria-expanded') === 'true' &&
      rowOf('Bldg::L1::Walls').querySelector('.layer-row').getAttribute('aria-expanded') ===
        'true' &&
      rowOf('Bldg::L2').querySelector('.layer-row').getAttribute('aria-expanded') !== 'true';
    // Collapse Bldg: its sublayers leave the list and stay remembered as closed.
    rowOf('Bldg').querySelector('.layer-row').click();
    const collapsedAgain = rowOf('Bldg').querySelector('.layer-objects').hidden === true;
    // Search: a match deep in the tree shows its ancestors, opened.
    toggle.click();
    search.value = 'Ext';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const searchPaths = [...container.querySelectorAll('.layer')].map((node) => node.dataset.path);
    const searchKeepsAncestors =
      searchPaths.join('|') === 'Bldg|Bldg::L1|Bldg::L1::Walls|Bldg::L1::Walls::Ext' &&
      rowOf('Bldg::L1::Walls::Ext').querySelector('.object')?.getAttribute('aria-label') ===
        'Obj e1';
    toggle.click();
    const searchCleared =
      rowOf('Bldg').querySelector('.layer-row').getAttribute('aria-expanded') === 'false';
    // An older Sync without the table: full paths still nest by '::'.
    render(
      rhino.map(({ layerTable: _table, ...row }) => row),
      [],
    );
    const inferred = topNames().join('|') === 'Bldg|Site' && Boolean(rowOf('Bldg'));
    // ZWCAD/DWG: flat, whole names.
    render(
      [
        { id: 'z1', name: 'Line', layer: 'A-WALL', host: 'zwcad', type: 'Curve' },
        { id: 'z2', name: 'Line', layer: 'S-BEAM', host: 'zwcad', type: 'Curve' },
      ],
      [],
    );
    const cadFlat =
      topNames().join('|') === 'A-WALL|S-BEAM' &&
      container.querySelectorAll('.layer .layer').length === 0;
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
      roots,
      subtreeCount,
      collapsed,
      childOrder,
      offShown,
      sublayersFirst,
      indent,
      locked,
      subtreeSelect,
      remembered,
      collapsedAgain,
      searchKeepsAncestors,
      searchCleared,
      inferred,
      cadFlat,
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
    'roots',
    'subtreeCount',
    'collapsed',
    'childOrder',
    'offShown',
    'sublayersFirst',
    'indent',
    'locked',
    'subtreeSelect',
    'remembered',
    'collapsedAgain',
    'searchKeepsAncestors',
    'searchCleared',
    'inferred',
    'cadFlat',
  ])
    assert.equal(result[key], true, key);
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
