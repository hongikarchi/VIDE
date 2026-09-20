import {test} from 'node:test';import assert from 'node:assert/strict';import {Store} from '../../src/core/store.mjs';import {Reviews} from '../../src/core/reviews.mjs';import {renderReport} from '../../src/server/report.mjs';
test('review snapshots freeze table, inputs and application state without native paths or file contents',()=>{
 const store=new Store(':memory:');try{
  const project=store.createProject('Review project'),other=store.createProject('Other'),reviews=new Reviews(store);
  const request={id:'candidate',projectId:project.id,createdAt:'2026-09-20',input:{body:'Original request',pins:[],sketches:[],files:[{name:'reference.txt',text:'private full content'}]},result:{hostExecuted:true,verified:true,filename:'C:/private/model.3dm',objects:[{id:'a',name:'<script>name</script>',kind:'box'}],scene:[{id:'a',nativeId:'native-a',nativeType:'Brep',area:20,volume:5}]},applications:[{id:'application',state:'unknown',result:{code:'HOST_RESULT_UNKNOWN'}}]};
  const created=reviews.create(project.id,{title:'Before change',image:'data:image/png;base64,iVBORw0KGgo=',query:{type:'Brep'}},request);
  request.result.scene[0].volume=500;request.input.body='Changed';request.applications[0].state='succeeded';
  const snapshot=reviews.get(project.id,created.id).payload;assert.equal(snapshot.table.rows[0].volume,5);assert.equal(snapshot.request.input.body,'Original request');assert.equal(snapshot.request.applications[0].state,'unknown');assert.equal(snapshot.request.result.filename,undefined);
  assert.ok(!JSON.stringify(snapshot).includes('private full content'));assert.throws(()=>reviews.get(other.id,created.id),{code:'NOT_FOUND'});
  const html=renderReport(snapshot.project,snapshot.request,snapshot.image,snapshot);assert.ok(html.includes('Before change'));assert.ok(html.includes('원본 적용 결과 미확인'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('C:/private'));
 }finally{store.close();}
});
