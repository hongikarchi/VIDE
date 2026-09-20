import {pathToFileURL} from 'node:url';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.argv[2]).href);
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:4317');await page.waitForSelector('#canvas canvas');await page.waitForTimeout(600);
 assert.equal(await page.locator('#height').count(),0);await page.locator('#document-tree').evaluate(e=>e.open=true);await page.locator('#object-tree').evaluate(e=>e.open=true);
 await page.locator('[data-tool=pin]').click();const pick=await page.locator('#canvas canvas').boundingBox();await page.mouse.click(pick.x+pick.width*.70,pick.y+pick.height*.55);assert.match(await page.locator('#context').textContent(),/주동 B/);await page.locator('#context button').click();await page.locator('[data-tool=select]').click();await page.locator('#objects button').first().click();
 const canvas=page.locator('#canvas canvas'),box=await canvas.boundingBox();const before=await canvas.screenshot();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:15});await page.mouse.up();await page.waitForTimeout(300);const after=await canvas.screenshot();assert.notDeepEqual(before,after,'orbit must change rendering');
 await page.mouse.wheel(0,-250);await page.waitForTimeout(300);assert.notDeepEqual(after,await canvas.screenshot(),'zoom must change rendering');
 await page.locator('#body').fill('이 모델의 동선을 검토하고 개선안을 제안해 줘.');await page.locator('#attach-menu summary').click();await page.locator('#pin').click();
 await page.locator('#objects button').nth(1).click();assert.match(await page.locator('#context').textContent(),/주동 A/);
 await page.locator('#model').selectOption('claude-fable-5');await page.locator('#effort').selectOption('max');await page.locator('#model').selectOption('gpt-5.6-terra');assert.equal(await page.locator('#effort').inputValue(),'medium');await page.locator('#permission').selectOption('candidate');
 await page.locator('[data-tool=sketch]').click();await page.locator('#line-role').selectOption('path');await page.waitForTimeout(300);
 const b=await canvas.boundingBox();await page.mouse.click(b.x+b.width*.3,b.y+b.height*.6);await page.mouse.click(b.x+b.width*.5,b.y+b.height*.7);await page.mouse.click(b.x+b.width*.7,b.y+b.height*.6);
 assert.equal(await page.locator('#finish-sketch').isEnabled(),true);await page.locator('#finish-sketch').click();assert.match(await page.locator('#context').textContent(),/스케치/);
 for(const view of ['plan','front','side']){await page.locator('#projection').selectOption(view);await page.waitForTimeout(100);assert.equal(await canvas.getAttribute('data-projection'),'orthographic');}await page.locator('#fit-view').click();await page.locator('#projection').selectOption('axon');await page.waitForTimeout(400);assert.equal(await canvas.getAttribute('data-projection'),'perspective');
 await page.locator('#draft-menu summary').click();await page.locator('#save').click();await page.locator('#body').fill('changed');await page.locator('#draft-menu summary').click();await page.locator('#load').click();assert.match(await page.locator('#body').inputValue(),/동선/);
 await page.locator('#toggle-right').click();await page.locator('#toggle-right').click();assert.match(await page.locator('#body').inputValue(),/동선/);
 await page.waitForTimeout(600);await mkdir('docs/assets/workspace-review',{recursive:true});await page.screenshot({path:'docs/assets/workspace-review/desktop.png',fullPage:true});
 await page.locator('#request').click();assert.match(await page.locator('#conversation').textContent(),/동선/);assert.match(await page.locator('#conversation').textContent(),/후보 작업 허용/);assert.equal(await page.locator('#body').inputValue(),'');assert.equal(await page.locator('#context .chip').count(),0);
 await page.setViewportSize({width:390,height:844});await page.locator('button[data-mobile=input]').click();assert.equal(await page.locator('#body').isVisible(),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'docs/assets/workspace-review/mobile.png',fullPage:true});await page.locator('button[data-mobile=model]').click();assert.equal(await canvas.isVisible(),true);
 assert.deepEqual(errors,[]);console.log('PASS: 3D render/orbit/zoom; generic input; pinned target; model/effort; permission packet; plane drawing attachment; draft save/restore; panel retention; send; mobile; no JS/CSP errors');
}finally{await browser.close();}
