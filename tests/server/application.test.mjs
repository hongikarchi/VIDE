import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../src/core/store.mjs';
import {Workspace} from '../../src/core/workspace.ts';
import {Applications} from '../../src/server/application.mjs';
function setup(apply){
 const store=new Store(':memory:'),workspace=new Workspace(store),project=store.createProject('apply');
 workspace.submit(project.id,{id:'candidate',body:'create',provider:'codex-cli',permission:'candidate',pins:[],sketches:[],files:[]});workspace.update(project.id,'candidate','succeeded',{hostExecuted:true,host:'rhino',objects:[{kind:'box',id:'box'}],fileHash:'hash'});
 const applications=new Applications(store,workspace,{preview:async()=>({documentHash:'original-hash',added:1,updated:0,removed:0}),apply});
 return {store,workspace,project,applications};
}
test('inspected application requires a server preview, executes once and records unsaved success',async()=>{
 let calls=0;const f=setup(async()=>{calls++;return {state:'succeeded',result:{applied:true,saved:false}};});
 try{
  await assert.rejects(()=>f.applications.confirm(f.project.id,'forged'),{code:'PREVIEW_EXPIRED'});
  const preview=await f.applications.prepare(f.project.id,'candidate',{instance:'1:2',documentId:5});
  const result=await f.applications.confirm(f.project.id,preview.id);assert.equal(result.state,'succeeded');assert.equal(result.result.saved,false);
  assert.deepEqual(await f.applications.confirm(f.project.id,preview.id),result);assert.equal(calls,1);
 }finally{f.store.close();}
});
test('ambiguous application blocks future writes and cannot cross projects',async()=>{
 const f=setup(async()=>{throw {code:'HOST_RESULT_UNKNOWN'};});
 try{
  const preview=await f.applications.prepare(f.project.id,'candidate',{instance:'1:2',documentId:5});
  const other=f.store.createProject('other');await assert.rejects(()=>f.applications.confirm(other.id,preview.id),{code:'PREVIEW_EXPIRED'});
  const result=await f.applications.confirm(f.project.id,preview.id);assert.equal(result.state,'unknown');
  await assert.rejects(()=>f.applications.prepare(f.project.id,'candidate',{instance:'1:2',documentId:5}),{code:'WRITE_UNCERTAIN'});
 }finally{f.store.close();}
});

test('native application is bound to its captured document and approved cumulative movement',async()=>{
 const store=new Store(':memory:');try{
  const workspace=new Workspace(store),project=store.createProject('native');
  const sourceDocument={instance:'1:2',documentId:5,documentHash:'original-hash'};
  const object={id:'original',kind:'native',name:'Object',origin:[0,0,0]};
  for(const [id,source,origin,baseRequestId] of [['capture','document',[0,0,0],undefined],['moved','chat',[2,0,0],'capture']]){
   workspace.submit(project.id,{id,source,body:'move',provider:'codex-cli',permission:'candidate',pins:[],sketches:[],files:[],baseRequestId});
   workspace.update(project.id,id,'succeeded',{hostExecuted:true,host:'rhino',objects:[{...object,origin}],fileHash:'candidate-hash',sourceDocument,baseRequestId});
  }
  let calls=0;
  const application=new Applications(store,workspace,{nativePreview:async(instance,documentId,hash,moves)=>{assert.equal(hash,'original-hash');assert.deepEqual(moves,[{id:'original',delta:[2,0,0]}]);return {documentHash:hash,mode:'native-move',updated:1,added:0,removed:0};},nativeApply:async(id,candidate,payload)=>{calls++;assert.equal(payload.mode,'native-move');assert.deepEqual(payload.movements,[{id:'original',delta:[2,0,0]}]);return {state:'succeeded',result:{applied:true,saved:false}};}});
  await assert.rejects(()=>application.prepare(project.id,'moved',{instance:'2:3',documentId:5}),{code:'TARGET_MISMATCH'});
  const preview=await application.prepare(project.id,'moved',{instance:'1:2',documentId:5});
  const result=await application.confirm(project.id,preview.id);assert.equal(result.state,'succeeded');await application.confirm(project.id,preview.id);assert.equal(calls,1);
 }finally{store.close();}
});

test('unknown recovery is read-only, evidence-bound and preserves prior diagnostics',async()=>{
 const f=setup(async()=>({state:'unknown',result:{code:'HOST_RESULT_UNKNOWN'}}));try{
  const preview=await f.applications.prepare(f.project.id,'candidate',{instance:'1:2',documentId:5});
  await f.applications.confirm(f.project.id,preview.id);
  // Existing generated commands have no native-movement evidence and remain unresolved.
  await assert.rejects(()=>f.applications.recover(f.project.id,preview.id),{code:'APPLICATION_EVIDENCE_MISSING'});
  assert.equal(f.store.getCommand(f.project.id,preview.id).state,'unknown');
 }finally{f.store.close();}
});
