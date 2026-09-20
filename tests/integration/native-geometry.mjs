// node tests/integration/native-geometry.mjs --run-live
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {RhinoWorkspace} from '../../hosts/rhino/workspace.mjs';
import {interpret} from '../../src/core/geometry.mjs';
if(process.argv[2]!=='--run-live')throw Error('Pass --run-live to create isolated Rhino test files.');
const host=new RhinoWorkspace('.vide/geometry-check');
const source={kind:'extrude',id:'outline',name:'Boundary edit check',points:[[0,0,0],[4,0,0],[4,3,0],[0,0,0]],height:6};
const first=await host.build('geometry-check',randomUUID(),[source]);
const proposal=interpret(JSON.stringify({message:'edit and copy',operations:[{kind:'vertices',id:'outline',points:[[0,0,0],[5,0,0],[5,3,0],[0,0,0]]},{kind:'copy',id:'copy',sourceId:'outline',name:'Copy',delta:[10,0,0]}]}),[source],'candidate');
const next=await host.build('geometry-check',randomUUID(),proposal.objects,{...first,objects:[source]});
assert.equal(next.scene.length,2);
for(const object of next.scene){assert.equal(object.nativeType,'Extrusion');assert.ok(Math.abs(object.volume-45)<.001);}
assert.equal(proposal.objects[0].height,6);assert.deepEqual(proposal.objects[1].points[0],[10,0,0]);
console.log(JSON.stringify({nativeTypes:next.scene.map(o=>o.nativeType),volumes:next.scene.map(o=>o.volume),height:6,copyOrigin:proposal.objects[1].points[0],savedAndReopened:next.verified}));
