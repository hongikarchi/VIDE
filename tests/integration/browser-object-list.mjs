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
    const render = createObjectList(container, (id) => (clicked = id));
    const objects = Array.from({ length: 10000 }, (_, i) => ({
      id: String(i),
      name: 'Object ' + i,
    }));
    const start = performance.now();
    render(objects, null);
    const initialMs = performance.now() - start;
    const first = container.firstElementChild;
    first.focus();
    const observer = new MutationObserver(() => {});
    observer.observe(container, { childList: true, subtree: true });
    const repeat = performance.now();
    for (let i = 0; i < 100; i++) render(objects, String(i));
    const repeatedMs = performance.now() - repeat;
    const replaced = observer.takeRecords().length;
    observer.disconnect();
    const focusRetained = document.activeElement === first;
    const identityRetained = container.firstElementChild === first;
    const selected = container.querySelectorAll('[aria-pressed="true"]').length;
    container.children[99].click();
    const clickCorrect = clicked === '99';
    const last = container.lastElementChild;
    objects.reverse();
    objects[0].name = 'Renamed';
    render(objects, '9999');
    const reordered = container.firstElementChild === last && last.textContent === 'Renamed';
    render([{ id: 'new', name: 'New object' }], 'new');
    const removed = container.children.length === 1 && !first.isConnected && !last.isConnected;
    render([], null);
    const empty = container.childElementCount === 0;
    container.remove();
    return {
      initialMs,
      repeatedMs,
      replaced,
      focusRetained,
      identityRetained,
      selected,
      clickCorrect,
      reordered,
      removed,
      empty,
    };
  });
  assert.equal(result.replaced, 0);
  assert.equal(result.selected, 1);
  for (const key of [
    'focusRetained',
    'identityRetained',
    'clickCorrect',
    'reordered',
    'removed',
    'empty',
  ])
    assert.equal(result[key], true, key);
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await app?.close();
  await rm(directory, { recursive: true, force: true });
}
