import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachHostSelection,initial} from '../../src/ui/model.mjs';
const source={instance:'1:2',documentId:3,documentHash:'hash'};
const request={id:'snapshot',result:{sourceDocument:source,objects:[{id:'one',name:'Object 1'},{id:'two',name:'Object 2'}]}};
test('host selection attaches all matched objects once and preserves existing roles and draft',()=>{
 const state=initial();state.body='Keep dimensions';state.pins=[{id:'one',basis:'snapshot',role:'preserve',name:'Object 1'}];
 const selection={...source,selectedIds:['one','two']};
 assert.equal(attachHostSelection(state,request,selection),1);assert.equal(state.pins[0].role,'preserve');assert.equal(state.pins[1].basis,'snapshot');assert.equal(state.body,'Keep dimensions');
 assert.equal(attachHostSelection(state,request,selection),0);assert.equal(state.selected,'one');
});
test('stale document, different instance and absent objects never partially append pins',()=>{
 for(const change of [{documentHash:'changed'},{instance:'1:3'},{documentId:4},{selectedIds:['one','missing']}]){
  const state=initial();assert.throws(()=>attachHostSelection(state,request,{...source,selectedIds:['one'],...change}));assert.deepEqual(state.pins,[]);
 }
});
