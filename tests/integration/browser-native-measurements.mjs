// Imports a supplied isolated circle fixture; browser UI and native readback, no AI or original writes.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [playwright,launch,fixture]=process.argv.slice(2),{chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const projectId=await page.evaluate(async()=>{const {api}=await import('/gateway.mjs');return (await api('/projects','POST',{name:'실측 기하 정보 검증'})).id;});await page.goto(new URL('/?project='+projectId,url).href);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 await page.locator('#model-file').setInputFiles(fixture);await page.getByText('작업 사본을 열었습니다.',{exact:true}).waitFor();
 const rows=await page.evaluate(async id=>(await fetch('/api/v1/projects/'+id+'/requests')).json(),projectId),circle=rows[0].result.scene[0];assert.equal(rows[0].state,'succeeded');assert.deepEqual(circle.boundsSize,[4,4,0]);assert.ok(Math.abs(circle.length-4*Math.PI)/(4*Math.PI)<1e-8);
 await page.locator('#document-tree').evaluate(node=>node.open=true);await page.locator('#object-tree').evaluate(node=>node.open=true);await page.locator('#objects button').first().click();await page.locator('#inspector-toggle').click();
 assert.ok((await page.locator('#inspector-content').innerText()).includes('Site'));await page.locator('[data-inspect="geometry"]').click();const text=await page.locator('#inspector-content').innerText();assert.ok(text.includes('곡선 길이'));assert.ok(text.includes('12.566 m'));assert.ok(text.includes('폭 X'));assert.ok(!text.includes('표시 폭'));
 await page.screenshot({path:'docs/assets/native-workspace/native-measurements.png'});console.log(JSON.stringify({projectId,bounds:circle.boundsSize,length:circle.length,layer:'Site',inspectorVerified:true}));
}finally{await browser.close();}
