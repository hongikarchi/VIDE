import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/core/store.mjs';
import { Workspace } from '../../src/core/workspace.mjs';
import { Execution } from '../../src/server/execution.mjs';

function fixture() {
  const store=new Store(':memory:'), workspace=new Workspace(store), project=store.createProject('test');
  const input={id:'request-1',body:'경계 검토',provider:'claude-cli',permission:'review',pins:[],sketches:[],files:[]};
  return {store,workspace,project,input};
}
test('request retry is idempotent and rejects changed payload or foreign project',()=>{
  const {store,workspace,project,input}=fixture();
  try {
    assert.equal(workspace.submit(project.id,input).created,true);
    assert.equal(workspace.submit(project.id,input).created,false);
    assert.throws(()=>workspace.submit(project.id,{...input,body:'다른 요청'}),{code:'REVISION_CONFLICT'});
    assert.throws(()=>workspace.submit(store.createProject('other').id,input),{code:'REVISION_CONFLICT'});
  } finally {store.close();}
});
test('provider response is persisted without claiming host execution',async()=>{
  const {store,workspace,project,input}=fixture();
  const execution=new Execution(workspace,{providerFactory:()=>({run:async()=>({text:'검토 결과'})})});
  execution.start(workspace.submit(project.id,input).request);
  await Promise.all([...execution.active.values()].map(x=>x.completion));
  assert.equal(workspace.get(project.id,input.id).result.hostExecuted,false);
  assert.equal(workspace.get(project.id,input.id).state,'succeeded');store.close();
});
test('provider failure and interrupted restart cannot become successful host work',async()=>{
  const {store,workspace,project,input}=fixture();
  const execution=new Execution(workspace,{providerFactory:()=>({run:async()=>{throw {code:'SUBSCRIPTION_LOGIN_REQUIRED'};}})});
  execution.start(workspace.submit(project.id,input).request);
  await Promise.all([...execution.active.values()].map(x=>x.completion));
  assert.equal(workspace.get(project.id,input.id).state,'failed');
  workspace.update(project.id,input.id,'running');new Workspace(store);
  assert.equal(workspace.get(project.id,input.id).state,'interrupted');store.close();
});
test('cross-host references are read-only input and cannot become the wrong output baseline',()=>{
  const {store,workspace,project,input}=fixture();
  try{
    workspace.submit(project.id,{...input,host:'zwcad'});
    workspace.update(project.id,input.id,'succeeded',{host:'zwcad',hostExecuted:true,objects:[{id:'boundary'}]});
    const cross={...input,id:'rhino-request',host:'rhino',pins:[{id:'boundary',basis:input.id,role:'target'}]};
    assert.throws(()=>workspace.submit(project.id,{...cross,baseRequestId:input.id}),{code:'TARGET_MISMATCH'});
    assert.equal(workspace.submit(project.id,cross).created,true);
    assert.throws(()=>workspace.submit(project.id,{...input,id:'overlap'}),{code:'PROJECT_BUSY'});
  }finally{store.close();}
});

test('restart during host execution preserves unknown intent and blocks new writes on that host',()=>{
 const {store,workspace,project,input}=fixture();
 try{
  workspace.submit(project.id,{...input,permission:'candidate'});
  workspace.update(project.id,input.id,'running',{phase:'host',objects:[{id:'planned'}],host:'rhino',hostExecuted:false});
  const resumed=new Workspace(store);const saved=resumed.get(project.id,input.id);
  assert.equal(saved.state,'unknown');assert.equal(saved.result.objects[0].id,'planned');
  assert.throws(()=>resumed.submit(project.id,{...input,id:'new-write',permission:'candidate'}),{code:'HOST_RESULT_UNRESOLVED'});
  assert.equal(resumed.submit(project.id,{...input,id:'read-only'}).created,true);
 }finally{store.close();}
});
test('host transport uncertainty retains intended geometry and cannot be reported as ordinary failure',async()=>{
 const {store,workspace,project,input}=fixture();
 const object={id:'box',kind:'box',name:'Box',origin:[0,0,0],size:[1,1,1]};
 const execution=new Execution(workspace,{host:{build:async()=>{throw {code:'HOST_RESULT_UNKNOWN'};}},providerFactory:()=>({run:async()=>({text:JSON.stringify({message:'create',operations:[object]})})})});
 try{
  execution.start(workspace.submit(project.id,{...input,permission:'candidate'}).request);
  await Promise.all([...execution.active.values()].map(x=>x.completion));
  const saved=workspace.get(project.id,input.id);assert.equal(saved.state,'unknown');assert.deepEqual(saved.result.objects,[object]);assert.equal(saved.result.hostExecuted,false);
 }finally{store.close();}
});
