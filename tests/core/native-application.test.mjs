import {test} from 'node:test';import assert from 'node:assert/strict';
import {nativeMoves} from '../../src/core/native-application.mjs';
const source={sourceDocument:{instance:'1:2'},objects:[{id:'one',kind:'native',name:'One',origin:[0,0,0]},{id:'two',kind:'native',name:'Two',origin:[10,0,0]}]};
test('native original application computes only bounded cumulative translations',()=>{
 const candidate=structuredClone(source);candidate.objects[0].origin=[2,0,0];
 assert.deepEqual(nativeMoves(candidate,source),[{id:'one',delta:[2,0,0]}]);assert.deepEqual(source.objects[0].origin,[0,0,0]);
 assert.throws(()=>nativeMoves(source,source),{code:'NO_CHANGES'});
});
test('unsupported deletion, additions, reconstruction and duplicate identities cannot masquerade as moves',()=>{
 for(const objects of [source.objects.slice(1),[...source.objects,{id:'new',kind:'native'}],[{...source.objects[0],kind:'box'},source.objects[1]],[source.objects[0],source.objects[0]],[{...source.objects[0],origin:[Infinity,0,0]},source.objects[1]]]){
  assert.throws(()=>nativeMoves({objects},source),{code:'UNSUPPORTED_APPLICATION'});
 }
});
