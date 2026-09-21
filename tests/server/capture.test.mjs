import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../src/core/store.mjs';
import {Workspace} from '../../src/core/workspace.ts';
import {captureModel} from '../../src/server/import-model.mjs';

test('document capture is idempotent, pins its source and rejects changed identity',async()=>{
 const store=new Store(':memory:');try{
  const workspace=new Workspace(store),project=store.createProject('capture');let calls=0;
  const capture=async(host,projectId,id,instance,documentId)=>{calls++;return {objects:[],scene:[],sourceDocument:{instance,documentId},verified:true};};
  const target={id:'capture-1',instance:'1:2',documentId:4};
  const result=await captureModel(project.id,target,workspace,{},capture);
  assert.equal(result.state,'succeeded');assert.equal(result.result.sourceDocument.documentId,4);
  assert.deepEqual(await captureModel(project.id,target,workspace,{},capture),result);assert.equal(calls,1);
  await assert.rejects(()=>captureModel(project.id,{...target,documentId:5},workspace,{},capture),{code:'REVISION_CONFLICT'});
  await assert.rejects(()=>captureModel(project.id,{...target,documentId:-1},workspace,{},capture),{code:'INVALID_INPUT'});
 }finally{store.close();}
});
test('failed capture preserves prior basis without marking read-only copy as an uncertain original write',async()=>{
 const store=new Store(':memory:');try{
  const workspace=new Workspace(store),project=store.createProject('capture');
  const target={id:'capture-1',instance:'1:2',documentId:4};
  await captureModel(project.id,target,workspace,{},async()=>({objects:[],scene:[]}));
  const failed=await captureModel(project.id,{...target,id:'capture-2'},workspace,{},async()=>{throw {code:'HOST_RESULT_UNKNOWN'};});
  assert.equal(failed.state,'failed');assert.equal(workspace.get(project.id,'capture-1').result.hostExecuted,true);
  assert.equal(workspace.submit(project.id,{id:'next',provider:'codex-cli',permission:'candidate',body:'continue',pins:[],sketches:[],files:[]}).created,true);
 }finally{store.close();}
});
