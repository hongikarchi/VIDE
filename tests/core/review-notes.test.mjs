import {test} from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../../src/core/store.mjs';import {Reviews} from '../../src/core/reviews.mjs';import {ReviewNotes} from '../../src/core/review-notes.mjs';
import {attachReviewNote,initial} from '../../src/ui/model.ts';
test('review notes preserve original basis, deduplicate retries and reject foreign objects and changed submissions',()=>{
 const store=new Store(':memory:');try{
  const project=store.createProject('Notes'),other=store.createProject('Other'),reviews=new Reviews(store),notes=new ReviewNotes(store,reviews);
  const request={id:'basis',projectId:project.id,input:{body:'',pins:[],sketches:[],files:[]},result:{hostExecuted:true,objects:[{id:'a',name:'A',kind:'box'}],scene:[{id:'a',volume:1,area:6}]}};
  const review=reviews.create(project.id,{title:'Review',image:'data:image/png;base64,iVBORw0KGgo='},request),input={id:'note-1',body:'Move by 1 m',objectId:'a'};
  const first=notes.create(project.id,review.id,input);assert.deepEqual(notes.create(project.id,review.id,input),first);assert.equal(notes.list(project.id,review.id).length,1);assert.equal(first.requestId,'basis');
  assert.throws(()=>notes.create(project.id,review.id,{...input,body:'Changed'}),{code:'REVISION_CONFLICT'});
  assert.throws(()=>notes.create(project.id,review.id,{...input,id:'note-2',objectId:'foreign'}),{code:'INVALID_INPUT'});
  assert.throws(()=>notes.list(other.id,review.id),{code:'NOT_FOUND'});
  const state=initial(),snapshot=reviews.get(project.id,review.id);state.baseRequestId='other';assert.throws(()=>attachReviewNote(state,first,snapshot));assert.equal(state.files.length,0);
  state.baseRequestId='basis';state.body='Keep my draft';attachReviewNote(state,first,snapshot);assert.equal(state.body,'Keep my draft');assert.equal(state.pins[0].basis,'basis');assert.equal(JSON.parse(state.files[0].text).noteId,first.id);assert.throws(()=>attachReviewNote(state,first,snapshot));assert.equal(state.files.length,1);
 }finally{store.close();}
});
