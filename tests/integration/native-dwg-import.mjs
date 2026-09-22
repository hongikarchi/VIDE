import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {ZwcadWorkspace} from '../../hosts/zwcad/workspace.ts';
if(process.argv[2]!=='--run-live')throw Error('Pass --run-live for isolated DWG files.');
const host=new ZwcadWorkspace('.vide/dwg-import-check'),project=randomUUID();
const source=process.argv[3]?{filename:process.argv[3]}:await host.build(project,randomUUID(),[{id:'boundary',kind:'polyline',name:'Boundary',points:[[0,0,0],[20,0,0],[20,10,0],[0,10,0],[0,0,0]]}]);
const hash=createHash('sha256').update(await readFile(source.filename)).digest('hex');const imported=await host.importFile(project,randomUUID(),source.filename);
assert.equal(imported.referenceOnly,true);assert.equal(imported.sourceUnits,4);assert.equal(imported.scene.length,1);assert.equal(imported.scene[0].area,200);assert.equal(imported.scene[0].length,60);assert.deepEqual(imported.objects[0].points,[[0,0,0],[20,0,0],[20,10,0],[0,10,0],[0,0,0]]);
assert.equal(createHash('sha256').update(await readFile(source.filename)).digest('hex'),hash);await assert.rejects(()=>host.build(project,randomUUID(),imported.objects,{...imported,dwgEditMode:undefined}),{code:'ZWCAD_REFERENCE_ONLY'});
console.log(JSON.stringify({filename:source.filename,area:200,length:60,units:4,referenceOnly:true,sourceUnchanged:true}));
