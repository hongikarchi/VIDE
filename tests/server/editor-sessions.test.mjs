import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EditorSessions} from '../../hosts/rhino/editor-sessions.ts';

test('editor sessions route duplicate document IDs by process and never close editing windows',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'vide-editors-'));let detached=0,stopped=0;const workers=[];
 try{
  const sessions=new EditorSessions({directory,executable:'rhino',plugin:'plugin',bootstrap:'bootstrap',launch:async options=>{
   assert.equal(options.mode,'editor');assert.equal(options.visible,true);const pid=workers.length+1;
   const worker={identity:{pid,startTicks:'100',documentId:7},failure:null,detach(){detached++;},stop(){stopped++;},async inspectEditor(){if(this.failure)throw Object.assign(Error(this.failure),{code:this.failure});return {documentId:7,name:'Same.3dm',units:'Meters',objectCount:1,modified:true,documentHash:'a'.repeat(64),selectedIds:[]};},async captureEditor(){return {pid};}};
   workers.push(worker);return worker;
  }});
  const first=await sessions.open({filename:'first',fileHash:'a'.repeat(64)}),second=await sessions.open({filename:'second',fileHash:'b'.repeat(64)});
  assert.equal(detached,2);assert.deepEqual((await sessions.list()).documents.map(row=>row.instance),['1:100','2:100']);
  assert.deepEqual(await sessions.capture(second),{pid:2});await assert.rejects(sessions.capture({...first,documentId:8}),{code:'STALE_CONNECTION'});
  workers[0].failure='HOST_RESULT_UNKNOWN';assert.equal((await sessions.list()).documents.length,1);assert.equal(sessions.has(first.instance),true);
  workers[0].failure=null;assert.equal((await sessions.list()).documents.length,2);
  workers[0].failure='HOST_LEASE_EXPIRED';await sessions.list();assert.equal(sessions.has(first.instance),false);assert.equal(stopped,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
