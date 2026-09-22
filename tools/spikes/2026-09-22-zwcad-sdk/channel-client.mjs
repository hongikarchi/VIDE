import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {launchOwnedHost as launchOwnedProcess} from '../../../hosts/common/owned-process.ts';
import {sendHostCommand as send} from '../../../hosts/common/transport.ts';

export async function launchProbe(directory,name,execution=false){
 const folder=join(directory,name);await mkdir(folder);
 const sessionId=randomUUID(),token=randomBytes(32).toString('hex');
 const plugin=resolve('.vide/build/zwcad-sdk-probe/VIDE.Zwcad.SdkProbe.dll');
 await readFile(plugin);
 const script=join(folder,'start.scr');
 await writeFile(script,`(command "_NETLOAD" ${JSON.stringify(plugin.replaceAll('\\','/'))})\nVIDEChannelProbe\n`);
 const owner=await launchOwnedProcess({executable:'C:/Program Files/ZWSOFT/ZWCAD 2023/ZWCAD.exe',args:['/b',script],visible:false,
  environment:{...process.env,VIDE_ZWCAD_PROBE_DIR:folder,VIDE_WORKER_SESSION:sessionId,VIDE_WORKER_TOKEN:token,VIDE_ZWCAD_EXECUTION:execution?'1':'0'}});
 try {
 await writeFile(join(folder,'process.json'),JSON.stringify(owner.identity,null,2));
 const deadline=Date.now()+90000;let ready;
 while(Date.now()<deadline){
  try{ready=JSON.parse(await readFile(join(folder,'ready.json'),'utf8'));break;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert.ok(ready,'ZWCAD_CHANNEL_START_TIMEOUT');
 assert.equal(ready.pid,owner.identity.pid);assert.equal(ready.startTicks,owner.identity.startTicks);assert.equal(ready.sessionId,sessionId);
 const base={token,sessionId,pid:ready.pid,startTicks:ready.startTicks,documentId:ready.documentId,revision:0,method:'query'};
 return {ready,owner,base,folder,call:(extra={})=>send('vide',{...base,...extra},{port:ready.port,timeoutMs:25000,beforeSend:()=>owner.verify(ready.port)})}; }catch(error){await owner.stop();throw error;}
}
