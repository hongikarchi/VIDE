import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SdkExecution} from '../../src/server/sdk-execution.ts';

async function fixture(run){
 const directory=await mkdtemp(join(tmpdir(),'vide-sdk-'));let scope,stopped=0,revoked=0,calls=0;
 const worker={identity:{sessionId:'owned'},query:async()=>({objects:[]}),execute:async()=>{calls++;return {ok:true,revision:1,operationId:'write-1',filename:'saved.3dm',fileHash:'a'.repeat(64),snapshot:{objects:[]},readbackVerified:true};},exportModel:async()=>({objects:[],scene:[]}),stop:async()=>{stopped++;}};
 const sdk=new SdkExecution({directory,executable:'rhino',plugin:'plugin',bootstrap:'bootstrap',origin:()=> 'http://127.0.0.1:1234',launch:async()=>worker,tools:{issue:options=>{scope=options;return {token:'token',revoke:()=>{revoked++;}};}}});
 const input={id:'request',body:'task',provider:'codex-cli',permission:'candidate',pins:[],sketches:[],files:[]},updates=[];
 const task={input,items:[],signal:new AbortController().signal,update:value=>updates.push(value)};
 try{await run({sdk,task,worker,updates,scope:()=>scope,counts:()=>({stopped,revoked,calls})});}finally{await rm(directory,{recursive:true,force:true});}
}
test('SDK review cannot acquire execute and closes its owned worker',()=>fixture(async({sdk,task,scope,counts})=>{
 const result=await sdk.run({...task,input:{...task.input,permission:'review'},provider:connection=>({run:async()=>{assert.deepEqual(connection.tools,['query']);assert.equal(scope().handlers.execute,undefined);return {text:'Review'};}})});
 assert.equal(result.hostExecuted,false);assert.deepEqual(counts(),{stopped:1,revoked:1,calls:0});
}));
test('SDK saves host intent before execution and preserves protected IDs',()=>fixture(async({sdk,task,scope,worker,updates})=>{
 const changes={added:[],removed:['deleted'],modified:[{id:'changed',geometry:true,attributes:false,nativeIdentity:false}]};let protectedIds;worker.execute=async(id,revision,code,ids)=>{assert.equal(updates.at(-1).phase,'host');assert.equal(updates.at(-1).operationId,id);protectedIds=ids;return {ok:true,operationId:id,revision:1,filename:'saved.3dm',fileHash:'a'.repeat(64),snapshot:{},changes,readbackVerified:true};};
 const result=await sdk.run({...task,previous:{id:'basis',result:{filename:'source.3dm',fileHash:'b'.repeat(64)}},input:{...task.input,pins:[{id:'keep',basis:'basis',role:'preserve'}]},provider:()=>({run:async()=>{await scope().handlers.execute({code:'SDK code'});return {text:'Saved'};}})});
 assert.deepEqual(protectedIds,['keep']);assert.equal(result.hostExecuted,true);assert.equal(result.baseRequestId,'basis');assert.equal(result.executionMode,'sdk');assert.deepEqual(result.changes,changes);
}));
test('SDK compile rejection allows correction but lost write blocks subsequent writes',()=>fixture(async({sdk,task,scope,worker,counts})=>{
 let count=0;worker.execute=async()=>{count++;if(count===1)return {ok:false,code:'COMPILE_ERROR',diagnostics:['fix']};throw Error('lost response');};
 await assert.rejects(sdk.run({...task,provider:()=>({run:async()=>{assert.equal((await scope().handlers.execute({code:'invalid'})).code,'COMPILE_ERROR');await assert.rejects(scope().handlers.execute({code:'corrected'}));assert.equal(await scope().isCurrent(),false);await assert.rejects(scope().handlers.execute({code:'duplicate'}),{code:'HOST_RESULT_UNKNOWN'});return {text:'Not successful'};}})}),{code:'HOST_RESULT_UNKNOWN'});
 assert.equal(count,2);assert.equal(counts().stopped,1);
}));
test('SDK provider failure after successful write remains recoverable uncertainty',()=>fixture(async({sdk,task,scope,counts})=>{
 await assert.rejects(sdk.run({...task,provider:()=>({run:async()=>{await scope().handlers.execute({code:'SDK'});throw Error('CLI response lost');}})}),error=>error.code==='HOST_RESULT_UNKNOWN'&&typeof error.intent.operationId==='string');
 assert.equal(counts().stopped,1);
}));
