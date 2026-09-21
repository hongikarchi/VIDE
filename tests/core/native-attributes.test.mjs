import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeAttributes,attachNativeAttributes} from '../../src/ui/native-attributes.ts';
const encode=value=>Buffer.from(value).toString('base64');
test('native attributes decode literal UTF-8 and preserve incomplete evidence',()=>{
 const scene={attributes64:[[encode('층'),encode('<script>"L03"</script>')]],attributesComplete:false};
 assert.deepEqual(nativeAttributes(scene),{known:true,complete:false,entries:[{key:'층',value:'<script>"L03"</script>'}]});
 for(const attributes64 of [null,[[encode('key'),'%%%']],Array(33).fill(['',''])])assert.equal(nativeAttributes({attributes64}).known,false);
});
test('explicit attribute attachment preserves draft basis and rejects duplicates',()=>{
 const state={files:[],baseRequestId:'other',host:'zwcad',pins:[]};
 const object={id:'object',name:'Synthetic'};
 const request={id:'basis',result:{scene:[{id:'object',attributes64:[[encode('BuildingId'),encode('TEST-01')]],attributesComplete:true}]}};
 attachNativeAttributes(state,request,object);
 assert.equal(state.baseRequestId,'other');assert.equal(state.host,'zwcad');assert.deepEqual(state.pins,[]);
 const data=JSON.parse(state.files[0].text);assert.equal(data.basis,'basis');assert.equal(data.attributes[0].value,'TEST-01');
 assert.throws(()=>attachNativeAttributes(state,request,object));assert.equal(state.files.length,1);
});
