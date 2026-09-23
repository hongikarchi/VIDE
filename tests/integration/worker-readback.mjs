// Synthetic documents only. Exercise the production verifier inside actual Rhino.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchRhinoWorker } from '../../hosts/rhino/worker-client.ts';

const directory = resolve('.vide/worker-readback', randomUUID());
await mkdir(directory, { recursive: true });
const worker = await launchRhinoWorker({
  directory: join(directory, 'worker'),
  executable: 'C:/Program Files/Rhino 8/System/Rhino.exe',
  plugin: resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),
  bootstrap: resolve('hosts/rhino/worker/bootstrap.py'),
});
try {
  const result = await worker.execute(
    randomUUID(),
    0,
    `
 var verify=AppDomain.CurrentDomain.GetAssemblies().Select(a=>a.GetType("Vide.Worker.WorkerReadback")).First(t=>t!=null).GetMethod("Verify",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);
 using(var expected=RhinoDoc.CreateHeadless(null)) using(var actual=RhinoDoc.CreateHeadless(null)) {
   expected.ModelUnitSystem=actual.ModelUnitSystem=UnitSystem.Meters;
   var attributes=new Rhino.DocObjects.ObjectAttributes();attributes.ObjectId=Guid.NewGuid();attributes.Name="Wall";attributes.SetUserString("Level","L02");
   using(var box=new Box(new BoundingBox(-1,-1,-1,1,1,1)).ToBrep()){
     expected.Objects.AddBrep(box,attributes);actual.Objects.AddBrep(box,attributes);
   }
   verify.Invoke(null,new object[]{expected,actual});
   // Sphere has exactly the same bounding box as the box: old bounds-only verification missed this.
   using(var sphere=new Sphere(Point3d.Origin,1).ToBrep()) actual.Objects.Replace(attributes.ObjectId,sphere);
   bool geometryRejected=false;try{verify.Invoke(null,new object[]{expected,actual});}catch(System.Reflection.TargetInvocationException error){geometryRejected=error.InnerException.Message=="Readback geometry mismatch";}
   if(!geometryRejected)throw new Exception("Same bounds hid changed geometry");
   actual.Objects.Replace(attributes.ObjectId,(Brep)expected.Objects.FindId(attributes.ObjectId).Geometry);
   var changed=actual.Objects.FindId(attributes.ObjectId).Attributes.Duplicate();changed.SetUserString("Level","L03");actual.Objects.ModifyAttributes(attributes.ObjectId,changed,true);
   bool attributesRejected=false;try{verify.Invoke(null,new object[]{expected,actual});}catch(System.Reflection.TargetInvocationException error){attributesRejected=error.InnerException.Message=="Readback attributes mismatch";}
   if(!attributesRejected)throw new Exception("Changed metadata was accepted");
 }
 doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)));
 `,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const model = await worker.exportModel();
  assert.equal(model.scene[0].volume, 24);
  const evidence = {
    passed: true,
    sameBoundsGeometryRejected: true,
    metadataChangeRejected: true,
    savedCandidateVerified: true,
    directory,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await worker.stop();
}
