import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPublicationBundle} from '../../src/core/publication.ts';

const fixture=()=>({id:'request-1',state:'succeeded',input:{body:'private instruction',files:[{name:'private.pdf',text:'secret'}]},result:{verified:true,
 sourceDocument:{name:'private.3dm',capturedAt:'today',instance:'local-worker',documentId:1,path:'C:/private/model.3dm'},
 objects:[{id:'visible',name:'PRIVATE NAME',kind:'Brep',nativeId:'host-id',userText:{secret:'private'}},{id:'hidden',name:'hidden',kind:'Brep'}],
 scene:[{id:'visible',nativeId:'host-id',vertices:[0,0,0,1,0,0,0,1,0],indices:[0,1,2],area:0.5,layer64:'private-layer',other:'secret'},
 {id:'hidden',nativeType:'Point',origin:[100,100,100]}],
}});
test('public export only includes explicitly selected geometry; excludes source paths, input and hidden data',()=>{
 const bundle=createPublicationBundle(fixture(),{title:'Review',objectIds:['visible']});
 const encoded=Buffer.concat(bundle.chunks).toString('utf8'),scene=JSON.parse(encoded);
 assert.deepEqual(scene,{format:'vide-public-scene-v1',unit:'m',objects:[{id:'visible',geometry:{type:'mesh',positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,2]}}]});
 assert.doesNotMatch(encoded,/private|secret|hidden|host-id/i);
 assert.equal(bundle.manifest.assets[0].parts[0].sha256,createHash('sha256').update(encoded).digest('hex'));
 assert.deepEqual(bundle.manifest.objectIds,['visible']);
});
test('names and measurements require explicit inclusion and preserve cached values',()=>{
 const bundle=createPublicationBundle(fixture(),{title:'Review',objectIds:['visible'],includeNames:true,includeMeasurements:true});
 const object=JSON.parse(Buffer.concat(bundle.chunks).toString()).objects[0];assert.equal(object.name,'PRIVATE NAME');assert.deepEqual(object.measurements,{area:0.5});
 assert.equal(object.nativeId,undefined);
});
test('ambiguous, missing, invalid or unverified model data is refused instead of silently replacing geometry',()=>{
 const request=fixture();request.result.verified=false;assert.throws(()=>createPublicationBundle(request,{title:'Review',objectIds:['visible']}),/RESULT_NOT_VERIFIED/);
 assert.throws(()=>createPublicationBundle(fixture(),{title:'Review',objectIds:['missing']}),/OBJECT_NOT_FOUND/);
 assert.throws(()=>createPublicationBundle(fixture(),{title:'Review',objectIds:['visible','visible']}),/DUPLICATE_OBJECT/);
 const invalid=fixture();invalid.result.scene[0].indices=[0,1,999];assert.throws(()=>createPublicationBundle(invalid,{title:'Review',objectIds:['visible']}),/INVALID_GEOMETRY/);
 const ambiguous=fixture();ambiguous.result.scene.push({...ambiguous.result.scene[0]});assert.throws(()=>createPublicationBundle(ambiguous,{title:'Review',objectIds:['visible']}),/AMBIGUOUS_OBJECT/);
});
