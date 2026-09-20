// A two-millimetre mesh at survey coordinates must remain visible and pickable.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [playwright,launch]=process.argv.slice(2),{chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(url);await page.waitForFunction(()=>document.querySelector('#project-picker').value);
 await page.evaluate(async()=>{const {createViewport}=await import('/viewport.mjs');const container=document.createElement('div');container.id='precision-fixture';Object.assign(container.style,{position:'fixed',inset:'100px',zIndex:10000});document.body.append(container);window.precisionPicks=[];window.precisionView=createViewport(container,[],id=>window.precisionPicks.push(id),()=>{});const x=90000.001,y=80000.001,d=.002;window.precisionView.replace([{id:'tiny-detail',vertices:[x,y,0,x+d,y,0,x+d,y+d,0,x,y+d,0],indices:[0,1,2,0,2,3]}]);window.precisionView.plane('XY');});
 const canvas=page.locator('#precision-fixture canvas');await canvas.click();assert.deepEqual(await page.evaluate(()=>window.precisionPicks),['tiny-detail']);await page.screenshot({path:'docs/assets/native-workspace/large-coordinate-detail.png'});
 await page.evaluate(()=>{window.precisionView.projection('perspective');window.precisionView.fit();});await canvas.click();assert.equal((await page.evaluate(()=>window.precisionPicks)).length,2);assert.deepEqual(errors,[]);
 await page.evaluate(()=>{window.precisionView.dispose();document.getElementById('precision-fixture').remove();});console.log(JSON.stringify({coordinateMagnitude:90000,detailMetres:.002,orthographicPick:true,perspectivePick:true}));
}finally{await browser.close();}
