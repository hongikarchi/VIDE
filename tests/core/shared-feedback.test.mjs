import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../src/core/store.ts';
import {Workspace} from '../../src/core/workspace.ts';
import {SharedFeedback} from '../../src/core/shared-feedback.ts';

test('feedback matches a locally exported basis, preserves raw input, deduplicates and rejects altered or cross-project packets',()=>{
 const store=new Store(':memory:');try{
  const workspace=new Workspace(store),service=new SharedFeedback(store,workspace),project=store.createProject('A'),other=store.createProject('B');
  const input={id:'work',body:'fixture',permission:'review',provider:'claude-cli',pins:[],sketches:[],files:[]};workspace.submit(project.id,input);workspace.update(project.id,input.id,'succeeded',{hostExecuted:true,objects:[{id:'object'}]});
  const manifest={title:'Model',objectIds:['object'],assets:[{id:'scene',parts:[{sha256:'a'.repeat(64),size:5}]}]},exportId=service.record(project.id,input.id,manifest);
  const file={format:'vide-feedback-v1',origin:'https://review.example',projectId:'remote',publicationId:'published',exportId,manifest,comment:{id:'comment',authorId:'person',receivedAt:Date.now(),input:{body:'Keep original text',objectId:'object',pin:{unit:'m',position:[1,2,3]},sketches:[{plane:'XZ',unit:'m',role:'path',points:[[1,2],[3,4],[5,6]]}]}}};
  const received=service.receive(project.id,file);assert.equal(received.source,'file');assert.equal(received.requestId,'work');assert.deepEqual(received.original,file);assert.equal(service.receive(project.id,file).id,received.id);assert.equal(service.list(project.id).length,1);
  assert.throws(()=>service.receive(other.id,file),/PUBLICATION_BASIS_NOT_FOUND/);
  assert.throws(()=>service.receive(project.id,{...file,manifest:{...manifest,title:'changed'}}),/STALE_REFERENCE/);
  assert.throws(()=>service.receive(project.id,{...file,comment:{...file.comment,input:{...file.comment.input,body:'changed'}}}),/REVISION_CONFLICT/);
  assert.throws(()=>service.receive(project.id,{...file,comment:{...file.comment,id:'new',input:{...file.comment.input,objectId:'not-published'}}}),/TARGET_MISMATCH/);
  assert.equal(workspace.list(project.id).length,1);assert.equal(workspace.get(project.id,'work').state,'succeeded');
  workspace.update(project.id,input.id,'succeeded',{hostExecuted:true,objects:[{id:'changed'}]});assert.throws(()=>service.receive(project.id,file),/STALE_REFERENCE/);
 }finally{store.close();}
});
