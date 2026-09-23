import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const root = resolve('.'),
  require = createRequire(join(root, 'src/sharing/package.json')),
  { build } = require('esbuild');
const directory = resolve('.vide/sharing-precision', randomUUID());
await mkdir(directory, { recursive: true });
const bundled = await build({
  stdin: {
    resolveDir: root,
    loader: 'jsx',
    contents: `
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {Model} from './src/sharing/web/model.tsx';
 const x=90000.001,y=80000.001,d=.002,model={format:'vide-public-scene-v1',unit:'m',objects:[{id:'detail',geometry:{type:'mesh',positions:[x,y,0,x+d,y,0,x+d,y+d,0,x,y+d,0],indices:[0,1,2,0,2,3]}}]};
 function Fixture(){const [selected,setSelected]=useState(null),[draft,setDraft]=useState({});return <Model model={model} selected={selected} onSelect={id=>{document.body.dataset.selected=id;setSelected(id);}} editable draft={draft} onPin={pin=>{document.body.dataset.pin=JSON.stringify(pin);setDraft({pin});}}/>;}
 createRoot(document.getElementById('root')).render(<Fixture/>);
 `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
});
const css = await readFile('src/sharing/web/style.css', 'utf8'),
  browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://precision.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill(
      path === '/fixture.js'
        ? { contentType: 'text/javascript', body: bundled.outputFiles[0].text }
        : path === '/style.css'
          ? {
              contentType: 'text/css',
              body: css + '#root{height:100vh;display:flex;flex-direction:column}',
            }
          : {
              contentType: 'text/html',
              body: '<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
            },
    );
  });
  await page.goto('http://precision.test/');
  await page.locator('canvas').waitFor();
  for (const view of ['위', '원근']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await page.evaluate(() => delete document.body.dataset.selected);
    await page.locator('canvas').click();
    assert.equal(await page.getAttribute('body', 'data-selected'), 'detail');
  }
  await page.getByRole('button', { name: '위', exact: true }).click();
  await page.getByRole('button', { name: '핀', exact: true }).click();
  await page.locator('canvas').click();
  const pin = JSON.parse(await page.getAttribute('body', 'data-pin'));
  assert.equal(pin.unit, 'm');
  assert.ok(Math.abs(pin.position[0] - 90000.002) < 1e-7);
  assert.ok(Math.abs(pin.position[1] - 80000.002) < 1e-7);
  assert.ok(Math.abs(pin.position[2]) < 1e-7);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: join(directory, 'precision.png') });
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    directory,
    worldCoordinate: 90000,
    detailMetres: 0.002,
    orthographicPick: true,
    perspectivePick: true,
    worldPinPreserved: true,
    scope: 'isolated actual sharing Model component; no remote network',
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
