// Isolated HTTP + React regression. No real CLI or host operations.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../../src/server/server.mjs';
const directory=await mkdtemp(join(tmpdir(),'vide-react-'));
let app,browser;
try{
 app=await startServer({filename:join(directory,'test.sqlite')});
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/v1/host',route=>route.fulfill({json:{available:false}}));
 await page.route('**/api/v1/providers',route=>route.fulfill({json:[{id:'claude-cli',available:false},{id:'codex-cli',available:false}]}));
 await page.route('**/api/v1/models',route=>route.fulfill({json:[{id:'codex-cli',name:'Test',provider:'codex-cli',efforts:['default']}]}));
 await page.goto(app.launchUrl);
 await page.waitForFunction(()=>document.querySelector('#project-picker')?.value);
 const first=await page.locator('#project-picker').inputValue();
 for(const text of ['first','second']){await page.locator('#body').fill(text);await page.locator('#add-request').click();}
 await page.getByLabel('요청 2',{exact:true}).fill('edited');
 assert.equal(await page.getByLabel('요청 2',{exact:true}).evaluate(node=>node===document.activeElement),true);
 await page.getByLabel('요청 1 삭제',{exact:true}).click();
 assert.equal(await page.getByLabel('요청 1',{exact:true}).inputValue(),'edited');
 assert.equal(await page.locator('#request-count').textContent(),'1');
 const second=await page.evaluate(async()=> (await(await fetch('/api/v1/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Second'})})).json()).id);
 await page.reload();await page.locator('#project-picker').selectOption(second);
 await page.waitForFunction(id=>document.querySelector('#project-picker')?.value===id,second);
 assert.equal(await page.locator('#pending-requests textarea').count(),0);
 await page.locator('#project-picker').selectOption(first);
 await page.waitForFunction(()=>document.querySelector('#pending-requests textarea')?.value==='edited');
 await page.route('**/api/v1/host/documents',route=>route.fulfill({json:{instance:'1:2',documents:[{id:1,name:'A',units:'Meters',objectCount:2,modified:false},{id:2,name:'B',units:'Meters',objectCount:3,modified:true}]}}));
 let release;const delayed=new Promise(resolve=>{release=resolve;});
 await page.route('**/api/v1/host/selection?*',async route=>{await delayed;await route.fulfill({json:{instance:'1:2',documentId:1,documentHash:'a'.repeat(64),selectedIds:[],observedAt:'test'}});});
 await page.getByText('열린 Rhino 문서',{exact:true}).click();await page.locator('#refresh-documents').click();
 await page.locator('#host-documents').selectOption('2');await page.locator('#inspect-selection').click();
 assert.equal(await page.locator('#host-documents').isDisabled(),true);
 assert.equal(await page.locator('#capture-document').isDisabled(),true);
 release();await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('문서 연결이 바뀌었습니다'));
 assert.equal(await page.locator('#host-documents').inputValue(),'2');
 await page.setViewportSize({width:390,height:844});await page.locator('[data-mobile="input"]').click();
 assert.equal(await page.getByLabel('요청 1',{exact:true}).inputValue(),'edited');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({requestEditing:true,projectIsolation:true,documentRaceGuard:true,mobileDraft:true}));
}finally{
 if(browser)await browser.close();if(app)await app.close();
 await rm(directory,{recursive:true,force:true});
}
