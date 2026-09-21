// Actual browser -> subscription CLI -> owned Rhino SDK -> candidate -> pinned follow-up.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {resolve,join,basename} from 'node:path';
import {chromium} from 'playwright';
import {startServer} from '../../src/server/server.mjs';
const runId=process.argv[2]||randomUUID();assert.match(runId,/^[a-f0-9-]{36}$/);
const directory=resolve('.vide/sdk-workflow',runId);await mkdir(directory,{recursive:true});
let app,browser;
try{
 app=await startServer({filename:join(directory,'test.sqlite'),sdkOptions:{directory:join(directory,'workers'),executable:'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',plugin:resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:resolve('hosts/rhino/worker/bootstrap.py')}});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:900}});page.setDefaultTimeout(15000);
 await page.goto(app.launchUrl);await page.waitForFunction(()=>document.querySelector('#project-picker')?.value);
 const projectId=await page.locator('#project-picker').inputValue();
 const existing=await page.evaluate(async id=>(await(await fetch(`/api/v1/projects/${id}/requests`)).json()),projectId);
 await page.locator('#model').selectOption('claude-cli');await page.locator('#effort').selectOption('low');await page.locator('#permission').selectOption('candidate');
 const submit=async(body,count)=>{
  await page.locator('#body').fill(body);await page.locator('#request').click();
  let saved;const deadline=Date.now()+240000;
  while(Date.now()<deadline){
   const rows=await page.evaluate(async id=>(await(await fetch(`/api/v1/projects/${id}/requests`)).json()),projectId);
   if(rows.length===count&&!['queued','running'].includes(rows.at(-1).state)){saved=rows.at(-1);break;}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(saved,'Request did not finish; inspect '+directory);
  assert.equal(saved.state,'succeeded',JSON.stringify(saved.result));assert.equal(saved.result.executionMode,'sdk');assert.equal(saved.result.hostExecuted,true);return saved;
 };
 const first=existing[0]||await submit('원점에 폭 10 m, 깊이 8 m, 높이 6 m인 박스 하나를 만들어. 이름은 SDK 매스. Use 속성은 Study로 넣어줘.',1);
 assert.equal(first.result.objects.length,1);assert.deepEqual(first.result.scene[0].boundsSize,[10,8,6]);assert.equal(first.result.scene[0].volume,480);
 const hash=createHash('sha256').update(await readFile(first.result.filename)).digest('hex');
 await page.getByRole('button',{name:'이 후보 보기',exact:true}).last().click();await page.locator('#document-tree').evaluate(node=>node.open=true);await page.locator('#object-tree').evaluate(node=>node.open=true);
 await page.locator('#objects button').first().click();await page.locator('#selection-pin').click();
 const second=existing[1]||await submit('첨부한 객체의 높이만 4.5 m로 바꿔줘. 폭 10 m, 깊이 8 m, 원점과 기존 객체 식별자·속성은 유지해.',2);
 assert.equal(second.result.baseRequestId,first.id);assert.equal(second.input.pins.length,1);assert.equal(second.result.objects[0].id,first.result.objects[0].id);
 assert.deepEqual(second.result.scene[0].boundsSize,[10,8,4.5]);assert.ok(Math.abs(second.result.scene[0].volume-360)<1e-8);
 assert.equal(createHash('sha256').update(await readFile(first.result.filename)).digest('hex'),hash);
 // Inject a lost final response after its real successful receipt; recovery must not ask AI to rerun.
 app.store.db.prepare('UPDATE workspace_requests SET state=?,result=? WHERE id=?').run('unknown',JSON.stringify({...second.result,hostExecuted:false,phase:'host',code:'HOST_RESULT_UNKNOWN',operationId:basename(second.result.filename,'.3dm')}),second.id);
 await page.reload();await page.getByRole('button',{name:'저장된 후보 다시 확인',exact:true}).click();
 await page.getByRole('button',{name:'저장된 후보 다시 확인',exact:true}).waitFor({state:'detached',timeout:120000});
 const recovered=await page.evaluate(async({projectId,id})=>(await(await fetch(`/api/v1/projects/${projectId}/requests/${id}`)).json()),{projectId,id:second.id});
 assert.equal(recovered.state,'succeeded');assert.equal(recovered.result.fileHash,second.result.fileHash);assert.equal(recovered.result.objects[0].id,first.result.objects[0].id);
 await page.getByRole('button',{name:'이 후보 보기',exact:true}).last().click();
 await page.locator('#document-tree').evaluate(node=>node.open=true);await page.locator('#object-tree').evaluate(node=>node.open=true);await page.locator('#objects button').first().click();
 await page.screenshot({path:join(directory,'viewport.png')});
 const evidence={passed:true,directory,projectId,first:first.id,second:second.id,firstVolume:480,secondVolume:360,originalUnchanged:true,browserReceiptRecovery:true,usage:[first.result.usage,second.result.usage]};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(browser)await browser.close();if(app)await app.close();}
