import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createConnection} from 'node:net';
import {launchProbe} from './channel-client.mjs';

const directory=resolve('.vide/zwcad-session',randomUUID());await mkdir(directory,{recursive:true});
const owners=[];
const resize=width=>`var blocks=(BlockTable)tr.GetObject(db.BlockTableId,OpenMode.ForRead);var space=(BlockTableRecord)tr.GetObject(blocks[BlockTableRecord.ModelSpace],OpenMode.ForRead);foreach(ObjectId id in space){var line=tr.GetObject(id,OpenMode.ForWrite) as Polyline;if(line!=null){line.SetPointAt(1,new Point2d(${width*1000},0));line.SetPointAt(2,new Point2d(${width*1000},10000));}}return "resized";`;
const operation=(revision,code)=>({method:'execute',revision,code,operationId:randomUUID()});
async function hash(path){return createHash('sha256').update(await readFile(path)).digest('hex');}
async function loseResponse(host,request){
 await host.owner.verify(host.ready.port);
 await new Promise((accept,reject)=>{
  const socket=createConnection({host:'127.0.0.1',port:host.ready.port});
  socket.setTimeout(5000,()=>{socket.destroy();reject(Error('LOST_RESPONSE_SEND_TIMEOUT'));});
  socket.once('error',reject);
  socket.once('connect',()=>{
   const body=Buffer.from(JSON.stringify({type:'vide',params:{...host.base,...request}})),header=Buffer.alloc(4);header.writeUInt32BE(body.length);
   socket.write(Buffer.concat([header,body]),()=>{socket.destroy();accept();});
  });
 });
 const receipt=join(host.folder,request.operationId+'.receipt.json'),deadline=Date.now()+20000;
 while(Date.now()<deadline){try{return JSON.parse(await readFile(receipt,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,200));}
 throw Error('OPERATION_RECEIPT_TIMEOUT');
}
try{
 const first=await launchProbe(directory,'first',true);owners.push(first.owner);
 const second=await launchProbe(directory,'second',true);owners.push(second.owner);
 const seed=join(first.folder,'sdk-probe.dwg'),seedHash=await hash(seed);
 assert.equal((await first.call()).snapshot.objects[0].area,200);
 const edit=operation(0,resize(24)),result=await first.call(edit);
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.revision,1);
 assert.equal(result.snapshot.objects[0].area,240);assert.equal(result.readbackVerified,true);
 assert.deepEqual(await first.call(edit),result,'Same operation returns its original receipt');
 assert.equal((await first.call({...edit,code:resize(28)})).code,'OPERATION_CONFLICT');
 assert.equal((await first.call(operation(0,resize(28)))).code,'STALE_REVISION');
 assert.equal((await first.call()).revision,1);
 assert.equal((await second.call()).snapshot.objects[0].area,200);
 const beforeFailure=await hash(result.filename);
 for(const code of ['invalid C#;',resize(22).replace('return "resized";','throw new InvalidOperationException("EXPECTED_FAILURE");')]){
  const request=operation(1,code),failed=await first.call(request);
  assert.equal(failed.ok,false);assert.equal(failed.code,'CODE_FAILED',JSON.stringify(failed));
  assert.equal(failed.revision,1);assert.deepEqual(await first.call(request),failed);
 }
 assert.equal(await hash(result.filename),beforeFailure);
 assert.equal((await first.call()).uncertain,false);
 const concurrent=await Promise.all([first.call(operation(1,resize(28))),first.call(operation(1,resize(32)))]);
 assert.equal(concurrent.filter(value=>value.ok).length,1);
 assert.equal(concurrent.filter(value=>value.code==='STALE_REVISION').length,1);
 assert.equal((await first.call()).revision,2);
 const lost=operation(2,resize(36)),receipt=await loseResponse(first,lost);
 assert.equal(receipt.result.ok,true,JSON.stringify(receipt));assert.equal(receipt.result.revision,3);
 assert.deepEqual(await first.call(lost),receipt.result);
 const after=await first.call();assert.equal(after.revision,3);assert.equal(after.snapshot.objects[0].area,360);
 assert.equal(await hash(seed),seedHash);
 assert.equal((await readdir(first.folder)).filter(name=>name.endsWith('.dwg')).length,4,'Seed and three successful writes only');
 const other=await second.call();assert.equal(other.revision,0);assert.equal(other.snapshot.objects[0].area,200);
 const evidence={passed:true,directory,processes:[first.ready,second.ready],initialEdit:result,after,other,
  duplicateReceipt:true,operationConflict:true,staleRejected:true,compilerAndRuntimeFailurePreserved:true,
  concurrentSameRevisionOneSuccess:true,lostResponseReceiptRecovered:true,seedHashPreserved:true};
 await writeFile(join(directory,'verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({error:error.message,directory},null,2));throw error;}
finally{
 const stopped=await Promise.allSettled(owners.map(owner=>owner.stop()));
 const failures=stopped.filter(result=>result.status==='rejected');
 if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Owned ZWCAD cleanup failed');
}
