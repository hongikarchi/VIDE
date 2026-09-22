import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { launchOwnedHost } from '../../../hosts/common/owned-process.ts';
import { rhinoCommand } from '../../../hosts/rhino/transport.ts';

const directory=resolve('.vide','worker-probe',randomUUID());await mkdir(directory,{recursive:true});
const report=join(directory,'ready.json'),sessionId=randomUUID(),token=randomBytes(32).toString('hex');
const plugin=resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp');
const start=Date.now();
const lease=await launchOwnedHost({executable:'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
  visible:process.argv.includes('--visible'),
  spawnProcess:(file,args,options)=>spawn(file,args,{...options,windowsVerbatimArguments:true}),
  args:['/nosplash','/notemplate','/scheme=VIDE-Worker-Test',`/runscript="_-RunPythonScript (${resolve('hosts/rhino/worker/bootstrap.py')})"`],
  environment:{...process.env,VIDE_WORKER_PLUGIN:plugin,VIDE_WORKER_TOKEN:token,VIDE_WORKER_SESSION:sessionId,VIDE_WORKER_REPORT:report}});
console.log(JSON.stringify({phase:'launched',pid:lease.identity.pid,directory}));
try{
  let ready;const deadline=Date.now()+90000;
  while(Date.now()<deadline){try{ready=JSON.parse(await readFile(report,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,250));}}
  if(!ready)throw Error('WORKER_START_TIMEOUT');
  assert.equal(ready.pid,lease.identity.pid);assert.equal(ready.startTicks,lease.identity.startTicks);assert.equal(ready.sessionId,sessionId);
  const call=(method,extra={})=>rhinoCommand('vide',{token,sessionId,pid:ready.pid,startTicks:ready.startTicks,documentId:ready.documentId,method,...extra},
    {port:ready.port,timeoutMs:30000,beforeSend:()=>lease.verify(ready.port)});
  const before=await call('query');assert.equal(before.objects.length,0);
  assert.equal((await call('query',{documentId:ready.documentId+1})).code,'TARGET_MISMATCH');
  assert.equal((await call('query',{sessionId:randomUUID()})).code,'HOST_OWNERSHIP_MISMATCH');
  const operationId=randomUUID(),code='doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,10,8,6)));';
  const invalid=await call('execute',{operationId:randomUUID(),revision:0,code:'doc.Objects.AddBox(new BoundingBox(0,0,0,1,1,1));'});assert.equal(invalid.code,'COMPILE_ERROR');
  const wrong=await call('execute',{operationId,revision:99,code});assert.equal(wrong.code,'STALE_REFERENCE');
  const result=await call('execute',{operationId,revision:0,code});assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.snapshot.objects.length,1);assert.equal(result.snapshot.objects[0].bounds[1][2],6);
  const duplicate=await call('execute',{operationId,revision:0,code});assert.deepEqual(duplicate,result);
  assert.equal((await call('execute',{operationId,revision:0,code:code+' // changed'})).code,'OPERATION_CONFLICT');
  const after=await call('query');assert.equal(after.objects.length,1);
  const saved=await readFile(result.filename);assert.ok(saved.length>0);assert.equal(result.readbackVerified,true);assert.equal(createHash('sha256').update(saved).digest('hex'),result.fileHash);
  console.log(JSON.stringify({phase:'passed',pid:ready.pid,elapsedMs:Date.now()-start,objects:1,readbackVerified:true,compileErrorRejected:true,targetRejected:true,operationConflictRejected:true,staleRejected:true,duplicateSuppressed:true,modelBytes:saved.length,directory}));
}finally{await lease.stop();console.log(JSON.stringify({phase:'owned-process-stopped',pid:lease.identity.pid}));}
