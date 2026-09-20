import test from 'node:test';
import assert from 'node:assert/strict';
import { failedRequestDraft, initial } from '../../src/ui/model.mjs';

test('failed input restoration preserves original basis and settings without request identity or shared mutable references', () => {
  const state=initial();state.messages=[{id:'old',request:{result:{hostExecuted:true}}},{id:'latest',request:{result:{hostExecuted:true}}}];
  const request={id:'failed',state:'interrupted',input:{id:'failed',body:'Change this',baseRequestId:'old',pins:[{id:'one',basis:'old',role:'preserve'}],sketches:[{points:[[0,0],[1,1]]}],files:[{name:'context.md',text:'kept'}],host:'rhino',model:'unavailable-model',effort:'high',permission:'candidate'}};
  const draft=failedRequestDraft(state,request);
  assert.equal(draft.baseRequestId,'old');assert.equal(draft.model,'unavailable-model');assert.equal(draft.permission,'candidate');assert.equal(draft.id,undefined);
  draft.pins[0].role='target';assert.equal(request.input.pins[0].role,'preserve');assert.equal(state.body,'');
  assert.throws(()=>failedRequestDraft(state,{...request,state:'unknown'}));
  assert.throws(()=>failedRequestDraft(state,{...request,input:{...request.input,baseRequestId:'missing'}}));
  assert.equal(failedRequestDraft(state,{...request,input:{...request.input,baseRequestId:undefined}}).baseRequestId,undefined);
});
