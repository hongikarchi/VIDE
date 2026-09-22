import {installBrowserSupport} from './browser-support.mjs';
// Extracts only the generated package into a private test directory and uses its bundled runtime.
import assert from 'node:assert/strict';import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {randomUUID,createHash} from 'node:crypto';import {resolve,join,basename} from 'node:path';import {pathToFileURL} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {liveLaunch} from '../../src/server/lifecycle.ts';
const exec=promisify(execFile),[playwright,archive,dwgFixture]=process.argv.slice(2),workspace=resolve('.vide','package-check',randomUUID()),install=join(workspace,'install space'),data=join(workspace,'data');
await mkdir(install,{recursive:true});await mkdir(data);await exec('tar.exe',['-xf',resolve(archive),'-C',install],{windowsHide:true});
const packageRoot=join(install,basename(archive,'.zip')),manifest=JSON.parse(await readFile(join(packageRoot,'package-manifest.json'),'utf8'));
for(const required of ['app/hosts/common/owned-process.ts','app/hosts/common/transport.ts','app/hosts/zwcad/worker/runtime/VIDE.Zwcad.Worker.dll'])assert.ok(manifest.files.some(file=>file.path===required),'Missing packaged host file: '+required);
for(const file of manifest.files){const path=resolve(packageRoot,file.path);assert.ok(path.startsWith(packageRoot+'\\'));assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),file.sha256);}
const env={...process.env,VIDE_DATA_DIR:data,VIDE_PORT:'0',PATH:join(process.env.WINDIR,'System32')};delete env.VIDE_CODEX_PATH;delete env.VIDE_CLAUDE_PATH;
const launch=()=>exec(join(packageRoot,'VIDE.exe'),['--no-browser'],{env,windowsHide:true,timeout:15000});
const waitUrl=async()=>{const deadline=Date.now()+15000;while(Date.now()<deadline){const url=await liveLaunch(data);if(url)return url;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Package startup timed out');};
const {chromium}=await import(pathToFileURL(playwright).href);let browser;
try{
 await launch();let url=await waitUrl();browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await installBrowserSupport(page);await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));assert.equal(await page.locator('#canvas canvas').count(),1);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('ChatGPT 연결됨'),null,{timeout:20000});
 const projectId=await page.evaluate(async()=>{const api=window.testApi;return (await api('/projects','POST',{name:'Portable preserved project'})).id;});await launch();assert.equal(await waitUrl(),url);
 const feedback=await page.evaluate(async id=>window.testApi('/projects/'+id+'/shared-feedback'),projectId);assert.deepEqual(feedback,[]);
 await page.getByText('검토본',{exact:true}).click();await page.getByRole('button',{name:'외부 의견',exact:true}).click();await page.getByLabel('외부 의견 파일').waitFor();await page.getByRole('button',{name:'닫기',exact:true}).click();
 if(dwgFixture){
  await page.reload();await page.waitForFunction(id=>Array.from(document.querySelector('#project-picker')?.options||[]).some(option=>option.value===id),projectId);
  await page.locator('#project-picker').selectOption(projectId);
  await page.waitForURL(url=>url.searchParams.get('project')===projectId);
  await page.waitForFunction(id=>document.querySelector('#project-picker')?.value===id&&document.querySelector('#workspace-status')?.textContent.includes('Portable preserved project'),projectId);
  await page.locator('#model-file').setInputFiles(resolve(dwgFixture));
  const deadline=Date.now()+120000;let imported;
  while(Date.now()<deadline){const rows=await page.evaluate(async id=>window.testApi('/projects/'+id+'/requests'),projectId);if(rows.length&&!['queued','running'].includes(rows.at(-1).state)){imported=rows.at(-1);break;}await new Promise(resolve=>setTimeout(resolve,300));}
  assert.equal(imported?.state,'succeeded',JSON.stringify(imported));assert.equal(imported.result.importMode,'sdk');assert.equal(imported.result.scene[0].area,200);assert.equal(imported.result.scene[0].length,60);
  await page.getByRole('button',{name:'이 후보 보기',exact:true}).click();await page.screenshot({path:join(workspace,'dwg-import.png')});
 }
 await page.getByLabel('초안 메뉴').click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'앱 종료',exact:true}).click();await page.getByText('VIDE 종료 중입니다. 이 창을 닫아도 됩니다.',{exact:true}).waitFor();
 // Keep the shutdown page alive beyond the last toast lifetime to catch detached-DOM callbacks.
 await page.waitForTimeout(5000);assert.deepEqual(errors,[]);
 const deadline=Date.now()+10000;while(await liveLaunch(data)){if(Date.now()>deadline)throw Error('Shutdown timed out');await new Promise(resolve=>setTimeout(resolve,40));}
 await launch();url=await waitUrl();await page.goto(url);await page.waitForFunction(()=>document.querySelector('#connection-status').textContent.includes('연결됨'));const projects=await page.evaluate(async()=>{const api=window.testApi;return api('/projects');});assert.ok(projects.some(project=>project.id===projectId));assert.deepEqual(errors,[]);
 await page.evaluate(async()=>{const api=window.testApi;await api('/shutdown','POST',{});});while(await liveLaunch(data))await new Promise(resolve=>setTimeout(resolve,40));
 const backup=join(workspace,'saved backup'),runtime=join(packageRoot,'runtime','node.exe'),backupScript=join(packageRoot,'app','src','desktop','backup.mjs');await exec(runtime,[backupScript,'create',data,backup],{env,windowsHide:true});const verification=JSON.parse((await exec(runtime,[backupScript,'verify',backup],{env,windowsHide:true})).stdout);assert.ok(verification.verified);
 assert.ok(resolve(install).startsWith(workspace+'\\'));await rm(install,{recursive:true,force:true,maxRetries:20,retryDelay:100});assert.ok((await readFile(join(data,'vide.sqlite'))).length>0);
 const evidence={version:manifest.version,bundledRuntime:true,filesVerified:manifest.files.length,spaceInPath:true,duplicateLaunch:true,browserLoaded:true,sharedFeedbackAvailable:true,packagedDwgSdkRead:Boolean(dwgFixture),restarted:true,dataPreservedAfterRemoval:true,offlineBackupVerified:true,isolatedData:data};await writeFile(join(workspace,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){await writeFile(join(workspace,'failure.json'),JSON.stringify({error:error.message,version:manifest.version,workspace},null,2));throw error;}finally{if(browser)await browser.close();const url=await liveLaunch(data);if(url){const origin=new URL(url).origin;const auth=await fetch(origin+'/api/v1/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(url).hash.slice(1)})});await fetch(origin+'/api/v1/shutdown',{method:'POST',headers:{Origin:origin,Cookie:auth.headers.get('set-cookie').split(';')[0],'Content-Type':'application/json'},body:'{}'});}}
