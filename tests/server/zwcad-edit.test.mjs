import test from 'node:test';import assert from 'node:assert/strict';import {validateDwgEdit,verifyDwgEdit} from '../../hosts/zwcad/edit-contract.mjs';
const object={id:'cad-47',nativeId:'47',kind:'polyline',name:'Site',points:[[0,0,0],[2,0,0],[2,2,0],[0,0,0]]};
const baseline={dwgEditMode:'polyline-vertices-v1',sourceUnits:4,objects:[object],scene:[{id:'cad-47',layer64:'U2l0ZQ==',color:3}]};
test('native DWG edit preserves identity and rejects unsupported scope before host writes',()=>{
 validateDwgEdit([object],baseline);
 for(const objects of [[],[{...object,id:'new'}],[{...object,nativeId:'48'}],[{...object,name:'Other'}],[{...object,points:[[0,0,0],[1,1,2]]}],[object,object]])assert.throws(()=>validateDwgEdit(objects,baseline),{code:'UNSUPPORTED_DWG_EDIT'});
 assert.throws(()=>validateDwgEdit([object],{...baseline,dwgEditMode:null}),{code:'UNSUPPORTED_DWG_EDIT'});
});
test('saved DWG readback must preserve points, handles and declared appearance',()=>{
 const result={...structuredClone(baseline),verified:true};verifyDwgEdit([object],baseline,result);
 result.scene[0].color=5;assert.throws(()=>verifyDwgEdit([object],baseline,result),{code:'UNSUPPORTED_DWG_EDIT'});
 result.scene[0].color=3;result.objects[0].points[1][0]=3;assert.throws(()=>verifyDwgEdit([object],baseline,result),{code:'UNSUPPORTED_DWG_EDIT'});
});
