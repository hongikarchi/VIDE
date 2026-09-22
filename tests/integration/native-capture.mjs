import {installBrowserSupport} from './browser-support.mjs';
// Read-only snapshot of an explicitly identified Rhino test document; creates a VIDE project.
// args: playwright launch.json instance documentId --run-live
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {rhinoCommand} from '../../hosts/rhino/transport.ts';
import {documentGuard,documentFingerprint} from '../../hosts/rhino/document-contract.ts';
const [playwright,launch,instance,serial,flag]=process.argv.slice(2);if(flag!=='--run-live')throw Error('Explicit --run-live required');
const documentId=Number(serial);
const inspect=async()=>{
 const response=await rhinoCommand('execute_rhinocommon_csharp_code',{code:`${documentGuard(instance,documentId)}${documentFingerprint}output.AppendLine(fingerprint);output.AppendLine(document.Path);output.AppendLine(document.Name);output.AppendLine(document.Modified.ToString());foreach(var obj in document.Objects.GetSelectedObjects(false,false).OrderBy(o=>o.Id))output.AppendLine(obj.Id.ToString());`});
 assert.equal(response.success,true);return response.output;
};
const before=await inspect();
const {chromium}=await import(pathToFileURL(playwright).href),{url}=JSON.parse(await readFile(launch,'utf8'));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await installBrowserSupport(page);await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 const project=await page.evaluate(async()=>{const api=window.testApi;return api('/projects','POST',{name:'열린 문서 취득 검증'});});
 await page.goto(new URL('/?project='+project.id,url).href);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));
 await page.getByText('열린 Rhino 문서',{exact:true}).click();await page.locator('#refresh-documents').click();await page.locator('#host-documents').selectOption(String(documentId));
 await page.locator('#capture-document').click();
 await page.waitForFunction(()=>document.querySelectorAll('.chat-message').length===1&&document.querySelector('.chat-message').textContent.includes('현재 상태 미확인'),{},{timeout:60000});
 const requests=await page.evaluate(async id=>{const api=window.testApi;return api(`/projects/${id}/requests`);},project.id);
 const capture=requests[0];assert.equal(capture.state,'succeeded');assert.equal(capture.result.sourceDocument.instance,instance);assert.equal(capture.result.sourceDocument.documentId,documentId);
 assert.ok(capture.result.objects.length);assert.equal(await page.locator('#objects button').count(),capture.result.objects.length);assert.equal(capture.result.verified,true);
 const supported=capture.result.scene.find(object=>object.vertices.length);assert.ok(supported);assert.ok(supported.volume>0);
 await page.reload();await page.waitForFunction(()=>document.querySelector('.chat-message')?.textContent.includes('현재 상태 미확인'));
 assert.equal(await inspect(),before,'Source geometry, attributes, units, path, name, modified and selection must remain unchanged');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({projectId:project.id,requestId:capture.id,objects:capture.result.objects.length,volume:supported.volume,sourceUnchanged:true,restoredAfterReload:true}));
}finally{await browser.close();}
