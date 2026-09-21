import {installBrowserSupport} from './browser-support.mjs';
// Simulates losing the first read result after a real isolated DWG import. Never writes a user drawing.
import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {readFile,access} from 'node:fs/promises';import {resolve,join} from 'node:path';import {pathToFileURL} from 'node:url';
import {startServer} from '../../src/server/server.ts';import {ZwcadWorkspace} from '../../hosts/zwcad/workspace.mjs';
const [playwright,source,flag]=process.argv.slice(2);if(flag!=='--run-live')throw Error('Explicit --run-live required');
const data=resolve('.vide','import-recovery-check',randomUUID()),cad=new ZwcadWorkspace(join(data,'cad-models')),originalImport=cad.importFile.bind(cad),originalInspect=cad.inspectImport.bind(cad);let imports=0,inspections=0;
cad.importFile=async(...args)=>{imports++;await originalImport(...args);throw {code:'HOST_RESULT_UNKNOWN'};};cad.inspectImport=async(...args)=>{inspections++;if(inspections>1)await new Promise(resolve=>setTimeout(resolve,150));return originalInspect(...args);};
const before=createHash('sha256').update(await readFile(source)).digest('hex'),app=await startServer({filename:join(data,'vide.sqlite'),cadHost:cad,host:{status:async()=>({available:false})},providerFactory:()=>({status:async()=>({available:false})})});
const {chromium}=await import(pathToFileURL(playwright).href),browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}});await installBrowserSupport(page);await page.goto(app.launchUrl);await page.waitForFunction(()=>document.querySelector('#project-picker')?.value);const project=await page.locator('#project-picker').inputValue();await page.locator('#model-file').setInputFiles(source);
 const recover=page.getByRole('button',{name:'불러오기 결과 확인',exact:true});await recover.waitFor({timeout:110000});const read=()=>page.evaluate(async id=>(await fetch('/api/v1/projects/'+id+'/requests')).json(),project);const first=(await read())[0];assert.equal(first.state,'unknown');assert.equal(first.result.sourceHash,before);
 await recover.click();const duplicate=await page.evaluate(async({project,id})=>{const api=window.testApi;return api(`/projects/${project}/imports/${id}/reconcile`,'POST',{});},{project,id:first.id});assert.equal(duplicate.state,'succeeded');
 await page.getByText('업로드 당시와 같은 DWG 복사본을 다시 읽어 참고 경계를 확인했습니다.',{exact:true}).waitFor();const rows=await read();assert.equal(rows.length,1);assert.equal(rows[0].id,first.id);assert.equal(rows[0].result.scene[0].area,200);assert.equal(rows[0].result.scene[0].length,60);assert.equal(imports,1);assert.equal(inspections,2);await assert.rejects(access(join(cad.directory,project,first.id+'.upload.dwg')));assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),before);
 console.log(JSON.stringify({data,projectId:project,requestId:first.id,importedOnce:true,concurrentRecoveryReadOnce:true,area:200,length:60,sourceUnchanged:true}));
}finally{await browser.close();await app.close();}
