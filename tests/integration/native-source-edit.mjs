// Uses an existing synthetic capture; consumes at most one subscription call. Restores test selection.
// args: playwright launch.json projectId --run-live
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
import {rhinoCommand} from '../../hosts/rhino/transport.ts';
import {documentGuard,documentFingerprint} from '../../hosts/rhino/document-contract.ts';
const [playwright,launch,projectId,flag]=process.argv.slice(2);if(flag!=='--run-live')throw Error('Explicit --run-live required');
const {chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});let restore;
try{
 const page=await browser.newPage();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 await page.goto(new URL('/?project='+projectId,url).href);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const read=()=>page.evaluate(async id=>(await fetch(`/api/v1/projects/${id}/requests`)).json(),projectId);
 const existing=await read(),first=existing[0],source=first.result.sourceDocument;assert.equal(first.input.source,'document');assert.equal(first.result.objects.length,2);
 const solid=first.result.scene.find(object=>object.volume>0),unrelated=first.result.objects.find(object=>object.id!==solid.id);
 const guard=documentGuard(source.instance,source.documentId);
 const inspect=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`${guard}${documentFingerprint}output.AppendLine(fingerprint);foreach(var obj in document.Objects.GetSelectedObjects(false,false))output.AppendLine(obj.Id.ToString());`});assert.equal(inspect.success,true);
 const [hash,...selected]=inspect.output.trim().split(/\r?\n/);assert.equal(hash,source.documentHash);
 restore=`${guard}document.Objects.UnselectAll();${selected.map(id=>`document.Objects.Select(new Guid("${id}"),true);`).join('')}document.Views.Redraw();`;
 const select=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`${guard}document.Objects.UnselectAll();document.Objects.Select(new Guid("${solid.id}"),true);document.Views.Redraw();`});assert.equal(select.success,true);
 await page.getByText('열린 Rhino 문서',{exact:true}).click();await page.locator('#refresh-documents').click();await page.locator('#host-documents').selectOption(String(source.documentId));
 await page.locator('#inspect-selection').click();await page.waitForFunction(()=>document.querySelectorAll('#context .chip').length>0);
 await page.locator('#inspect-selection').click();assert.equal(await page.locator('#context .chip').count(),1);
 let second=existing[1];
 if(!second){
  const model=await page.locator('#model option').evaluateAll(options=>options.find(option=>/sol/i.test(option.textContent)&&/gpt/i.test(option.textContent))?.value);assert.ok(model);
  await page.selectOption('#model',model);await page.selectOption('#effort','low');await page.selectOption('#permission','candidate');
  await page.fill('#body','첨부한 객체만 X 방향으로 2 m 이동해. 크기와 다른 객체는 그대로 유지해.');await page.locator('#request').click();
  const deadline=Date.now()+210000;while(true){const rows=await read();if(rows.length>1&&!['queued','running'].includes(rows.at(-1).state)){second=rows.at(-1);break;}if(Date.now()>deadline)throw Error('Inspect saved job before retry');await new Promise(resolve=>setTimeout(resolve,500));}
 }
 assert.equal(second.state,'succeeded',JSON.stringify(second.result));assert.equal(second.result.hostExecuted,true);assert.equal(second.result.baseRequestId,first.id);assert.deepEqual(second.result.sourceDocument,source);
 const original=first.result.objects.find(object=>object.id===solid.id),moved=second.result.objects.find(object=>object.id===solid.id);
 assert.deepEqual(moved.origin,original.origin.map((n,i)=>n+(i===0?2:0)));assert.deepEqual(second.result.objects.find(object=>object.id===unrelated.id).origin,unrelated.origin);
 assert.ok(Math.abs(second.result.scene.find(object=>object.id===solid.id).volume-solid.volume)<.001);
 const after=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`${guard}${documentFingerprint}output.AppendLine(fingerprint);`});assert.equal(after.output.trim(),hash);
 console.log(JSON.stringify({projectId,first:first.id,second:second.id,moveMeters:2,volume:solid.volume,unrelatedPreserved:true,originalUnchanged:true}));
}finally{if(restore)await rhinoCommand('execute_rhinocommon_csharp_code',{code:restore});await browser.close();}
