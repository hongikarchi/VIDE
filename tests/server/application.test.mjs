import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../src/core/store.mjs';
import {Workspace} from '../../src/core/workspace.mjs';
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
