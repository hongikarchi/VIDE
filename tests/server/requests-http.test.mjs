import {Workspace} from '../../src/core/workspace.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer} from '../../src/server/server.mjs';

test('authenticated requests execute once, persist results and protect cross-project access',async()=>{
  let calls=0;
  const app=await startServer({filename:':memory:',host:{status:async()=>({available:true})},
    providerFactory:()=>({run:async()=>{calls++;return {text:JSON.stringify({message:'검토 결과',operations:[]})};}})});
  try{
    const login=await fetch(app.origin+'/api/v1/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token:new URL(app.launchUrl).hash.slice(1)})});
    const headers={Origin:app.origin,'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0]};
    const api=async(path,method='GET',data)=>fetch(app.origin+'/api/v1'+path,{method,headers,body:data?JSON.stringify(data):undefined});
    const p=await (await api('/projects','POST',{name:'first'})).json();
    const other=await (await api('/projects','POST',{name:'other'})).json();
    const input={id:'request-one',provider:'codex-cli',permission:'review',body:'검토',pins:[],sketches:[],files:[]};
    const path=`/projects/${p.id}/requests`;
    assert.equal((await api(path,'POST',input)).status,202);
    assert.equal((await api(path,'POST',input)).status,200);
    const result=await (await api(path+'/request-one')).json();
    assert.equal(result.state,'succeeded');assert.equal(result.result.hostExecuted,false);assert.equal(calls,1);
    assert.equal((await api(`/projects/${other.id}/requests/request-one`)).status,404);
    assert.equal((await api(`/projects/${other.id}/requests/request-one/model`)).status,404);
    assert.equal((await api(path+'/request-one/model')).status,404);
    assert.equal((await api(path,'POST',{...input,id:'stale',pins:[{id:'missing',basis:'old'}]})).status,409);
    const workspace=new Workspace(app.store);
    const object={id:'box',name:'Box',kind:'box',origin:[0,0,0],size:[2,2,2]};
    for(const [id,base,size,volume] of [['before',undefined,2,8],['after','before',3,12]]){
      workspace.submit(p.id,{...input,id,baseRequestId:base});
      workspace.update(p.id,id,'succeeded',{hostExecuted:true,host:'rhino',objects:[{...object,size:[2,2,size]}],scene:[{id:'box',volume}],baseRequestId:base});
    }
    const comparison=await(await api(`/projects/${p.id}/comparison?before=before&after=after`)).json();
    assert.equal(comparison.rows[0].status,'changed');assert.equal(comparison.rows[0].delta.volume,4);
    assert.equal((await api(`/projects/${other.id}/comparison?before=before&after=after`)).status,404);
    assert.equal((await api(`/projects/${other.id}/requests/after/quantities`)).status,404);

  }finally{await app.close();}
});
