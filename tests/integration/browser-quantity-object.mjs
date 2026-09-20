import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
const [playwright,launch]=process.argv.slice(2),{chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#project-picker').value);
 const choice=await page.evaluate(async()=>{const {api}=await import('/gateway.mjs');for(const project of await api('/projects')){const requests=await api(`/projects/${project.id}/requests`);const request=requests.find(r=>r.result?.hostExecuted&&r.result.objects.length>1);if(request)return {project:project.id,request:request.id,object:request.result.objects[0].id};}throw Error('Need stored multi-object candidate');});
 await page.evaluate(async choice=>{const {showQuantities}=await import('/quantities.mjs');await showQuantities(choice.project,choice.request,()=>{},choice.object);},choice);
 assert.equal(await page.getByLabel('집계 객체',{exact:true}).inputValue(),choice.object);
 await page.waitForFunction(()=>document.querySelector('.quantity-dialog [role=status]').textContent.startsWith('1 /'));
 const href=await page.getByText('CSV 내려받기',{exact:true}).getAttribute('href');assert.equal(new URL(href,url).searchParams.get('objectId'),choice.object);
 const csv=await page.evaluate(async href=>(await fetch(href)).text(),href);assert.equal(csv.split('\r\n').filter(Boolean).length,2);
 await page.getByLabel('집계 객체',{exact:true}).selectOption('');await page.waitForFunction(()=>!document.querySelector('.quantity-dialog [role=status]').textContent.startsWith('1 /'));
 console.log(JSON.stringify({objectFilter:true,csvSameScope:true,allObjectsRestored:true}));
}finally{await browser.close();}
