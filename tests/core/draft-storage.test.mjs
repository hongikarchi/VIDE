import test from 'node:test';
import assert from 'node:assert/strict';
import {initial} from '../../src/ui/model.ts';
import {draftSnapshot,restoreDraft,restoreSavedDraft} from '../../src/ui/draft-storage.ts';

test('draft restore preserves empty basis, settings and instructions but ignores persisted runtime state',()=>{
 const draft={...initial(),body:'검토',instructions:['높이 유지'],baseRequestId:null,host:'zwcad',messages:[{id:'injected'}],selected:'foreign'};
 const messages=[];
 const restored=restoreDraft(draft,messages);
 assert.equal(restored.baseRequestId,undefined);
 assert.equal(restored.host,'zwcad');
 assert.equal(restored.selected,null);
 assert.equal(restored.messages,messages);
 assert.deepEqual(restored.instructions,['높이 유지']);
 assert.equal('messages' in draftSnapshot(draft),false);
 assert.throws(()=>restoreSavedDraft({version:4,projectId:'other',state:draft},'current',messages));
});

test('draft restore rejects invalid geometry and missing pin basis without retargeting',()=>{
 const draft=initial();
 assert.throws(()=>restoreDraft({...draft,sketches:[{plane:'XY',unit:'m',role:'boundary',points:[[0,0],['1',2]]}]},[]));
 assert.throws(()=>restoreDraft({...draft,pins:[{id:'wall',basis:'before',role:'target'}]},[]));
 const messages=[{id:'before',request:{result:{hostExecuted:true,objects:[{id:'wall'}]}}}];
 const restored=restoreDraft({...draft,baseRequestId:'before',pins:[{id:'wall',basis:'before',role:'preserve'}]},messages);
 assert.deepEqual(restored.pins,[{id:'wall',basis:'before',role:'preserve'}]);
 assert.throws(()=>restoreDraft({...draft,baseRequestId:'missing'},messages));
 assert.throws(()=>restoreDraft({...draft,instructions:[null]},messages));
});
