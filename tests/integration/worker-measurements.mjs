import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchRhinoWorker} from '../../hosts/rhino/worker-client.ts';
const directory=resolve('.vide/worker-measurements',randomUUID());await mkdir(directory,{recursive:true});
const options={executable:'C:/Program Files/Rhino 8/System/Rhino.exe',plugin:resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:resolve('hosts/rhino/worker/bootstrap.py')};
let worker;
try{
 worker=await launchRhinoWorker({...options,directory:join(directory,'baseline')});
 const initial=await worker.execute(randomUUID(),0,`foreach(var name in new[]{"keep","resize","rename","mesh"}){var a=new Rhino.DocObjects.ObjectAttributes();a.Name=name;a.SetUserString("vide-id",name);var box=new Box(new BoundingBox(0,0,0,2,3,4));if(name=="mesh")doc.Objects.AddMesh(Mesh.CreateFromBox(box,1,1,1),a);else doc.Objects.AddBox(box,a);}`);
 assert.equal(initial.ok,true,JSON.stringify(initial));const model=await worker.exportModel();
 assert.equal(model.measurementVersion,1);assert.deepEqual(model.measurementStats,{measuredObjects:4,reusedObjects:0});
 for(const row of model.scene){assert.ok(Math.abs(row.volume-24)<1e-8);assert.ok(Math.abs(row.area-52)<1e-8);}
 const measurements=model.scene.map(({id,area,volume,length})=>({id,area,volume,length}));
 await worker.stop();worker=undefined;
 worker=await launchRhinoWorker({...options,directory:join(directory,'edit'),source:{filename:initial.filename,fileHash:initial.fileHash,measurements}});
 const unchanged=await worker.exportModel();assert.deepEqual(unchanged.measurementStats,{measuredObjects:0,reusedObjects:4});
 const changed=await worker.execute(randomUUID(),0,`
 var objects=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();
 var renamed=objects.Single(o=>o.Name=="rename");var a=renamed.Attributes.Duplicate();a.Name="New name";doc.Objects.ModifyAttributes(renamed.Id,a,true);
 var resized=objects.Single(o=>o.Name=="resize");using(var replacement=new Box(new BoundingBox(0,0,0,2,3,8)).ToBrep())doc.Objects.Replace(resized.Id,replacement);
 `);
 assert.equal(changed.ok,true,JSON.stringify(changed));const edited=await worker.exportModel();
 assert.deepEqual(edited.measurementStats,{measuredObjects:1,reusedObjects:3});assert.ok(Math.abs(edited.scene.find(row=>row.id==='resize').volume-48)<1e-8);
 const evidence={passed:true,directory,unchangedCalculated:0,changedCalculated:1,renamedReused:true,closedMeshVolume:24};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(worker)await worker.stop();}
