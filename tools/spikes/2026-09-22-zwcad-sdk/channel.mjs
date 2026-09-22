import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {launchOwnedRhino as launchOwnedProcess} from '../../../hosts/rhino/owned-process.ts';
import {rhinoCommand as send} from '../../../hosts/rhino/transport.ts';

const directory=resolve('.vide/zwcad-channel',randomUUID());
await mkdir(directory,{recursive:true});
const owners=[];
async function launch(name){
 const folder=join(directory,name);await mkdir(folder);
 const sessionId=randomUUID(),token=randomBytes(32).toString('hex');
 const plugin=resolve('.vide/build/zwcad-sdk-probe/VIDE.Zwcad.SdkProbe.dll');
 await readFile(plugin);
 const script=join(folder,'start.scr');
 await writeFile(script,`(command "_NETLOAD" ${JSON.stringify(plugin.replaceAll('\\','/'))})\nVIDEChannelProbe\n`);
 const owner=await launchOwnedProcess({executable:'C:/Program Files/ZWSOFT/ZWCAD 2023/ZWCAD.exe',args:['/b',script],visible:false,
  environment:{...process.env,VIDE_ZWCAD_PROBE_DIR:folder,VIDE_WORKER_SESSION:sessionId,VIDE_WORKER_TOKEN:token}});
 owners.push(owner);await writeFile(join(folder,'process.json'),JSON.stringify(owner.identity,null,2));
 const deadline=Date.now()+90000;let ready;
 while(Date.now()<deadline){
  try{ready=JSON.parse(await readFile(join(folder,'ready.json'),'utf8'));break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert.ok(ready,'ZWCAD_CHANNEL_START_TIMEOUT');
 assert.equal(ready.pid,owner.identity.pid);assert.equal(ready.startTicks,owner.identity.startTicks);assert.equal(ready.sessionId,sessionId);
 const base={token,sessionId,pid:ready.pid,startTicks:ready.startTicks,documentId:ready.documentId,revision:0,method:'query'};
 return {ready,owner,call:(extra={})=>send('vide',{...base,...extra},{port:ready.port,timeoutMs:25000,beforeSend:()=>owner.verify(ready.port)})};
}
try{
 const first=await launch('first'),second=await launch('second');
 assert.notEqual(first.ready.pid,second.ready.pid);assert.notEqual(first.ready.documentId,second.ready.documentId);
 const queries=await Promise.all([first.call(),second.call()]);
 for(const [index,value] of queries.entries()){
  assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.areaSquareMetres,200);
  assert.equal(value.hostThreadVerified,true);assert.equal(value.activeDocumentAccessed,false);
  assert.equal(value.pid,[first,second][index].ready.pid);
 }
 const cases=[
  [{token:'0'.repeat(64)},'UNAUTHORIZED'],
  [{sessionId:second.ready.sessionId},'HOST_OWNERSHIP_MISMATCH'],
  [{pid:second.ready.pid},'HOST_OWNERSHIP_MISMATCH'],
  [{startTicks:'1'},'HOST_OWNERSHIP_MISMATCH'],
  [{documentId:second.ready.documentId},'DOCUMENT_MISMATCH'],
  [{revision:1},'STALE_REVISION'],
  [{method:'execute',code:'throw new Exception();'},'UNSUPPORTED_METHOD'],
 ];
 for(const [input,code] of cases)assert.deepEqual(await first.call(input),{ok:false,code});
 assert.equal((await first.call()).ok,true);assert.equal((await second.call()).ok,true);
 await first.owner.stop();
 await assert.rejects(first.call(),error=>['HOST_LEASE_EXPIRED','HOST_UNAVAILABLE'].includes(error.code));
 assert.equal((await second.call()).ok,true,'Stopping one owned process must not affect the other');
 const evidence={passed:true,directory,processes:[first.ready,second.ready],queries,rejections:cases.map(([,code])=>code),survivorAfterOtherStop:true};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({error:error.message,directory},null,2));throw error;}
finally{
 const stopped=await Promise.allSettled(owners.map(owner=>owner.stop()));
 const failures=stopped.filter(result=>result.status==='rejected');
 if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Owned ZWCAD cleanup failed');
}
