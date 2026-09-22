import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchRhinoWorker} from '../../hosts/rhino/worker-client.ts';
const directory=resolve('.vide/editor-apply',randomUUID());await mkdir(directory,{recursive:true});
const options={executable:'C:/Program Files/Rhino 8/System/Rhino.exe',plugin:resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:resolve('hosts/rhino/worker/bootstrap.py')};
let worker,editor;
try{
 worker=await launchRhinoWorker({...options,directory:join(directory,'initial')});
 const initial=await worker.execute(randomUUID(),0,`foreach(var id in new[]{"change","keep","remove"}){var a=new Rhino.DocObjects.ObjectAttributes();a.Name=id;a.SetUserString("vide-id",id);doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,2,3,4)),a);}`);assert.equal(initial.ok,true,JSON.stringify(initial));
 const initialModel=await worker.exportModel();await worker.stop();worker=undefined;
 editor=await launchRhinoWorker({...options,directory:join(directory,'editor'),mode:'editor',visible:true,source:{filename:initial.filename,fileHash:initial.fileHash}});
 const captured=await editor.captureEditor(randomUUID());
 worker=await launchRhinoWorker({...options,directory:join(directory,'candidate'),source:{filename:captured.filename,fileHash:captured.fileHash}});
 const candidate=await worker.execute(randomUUID(),0,`
 var objects=doc.Objects.GetObjectList(Rhino.DocObjects.ObjectType.AnyObject).ToArray();var target=objects.Single(o=>o.Name=="change");
 var targetId=target.Id;var attributes=target.Attributes.Duplicate();attributes.SetUserString("Level","L02");
 if(!doc.Objects.ModifyAttributes(targetId,attributes,true))throw new Exception("Fixture attributes failed");
 if(doc.Objects.FindId(targetId).Attributes.GetUserString("Level")!="L02")throw new Exception("Fixture attribute value missing");
 using(var geometry=new Box(new BoundingBox(0,0,0,2,3,8)).ToBrep())if(!doc.Objects.Replace(targetId,geometry))throw new Exception("Fixture replace failed");

 doc.Objects.Delete(objects.Single(o=>o.Name=="remove").Id,true);
 var fresh=new Rhino.DocObjects.ObjectAttributes();fresh.Name="added";fresh.SetUserString("vide-id","added");doc.Objects.AddPoint(new Point3d(10,0,0),fresh);
 `,['keep']);assert.equal(candidate.ok,true,JSON.stringify(candidate));
 const expected=await worker.exportModel();assert.ok(expected.scene.find(obj=>obj.id==='change').attributes64.some(([key,value])=>Buffer.from(key,'base64').toString()==='Level'&&Buffer.from(value,'base64').toString()==='L02'),JSON.stringify(expected.scene.map(({id,attributes64})=>({id,attributes64}))));await worker.stop();worker=undefined;
 const preview=await editor.previewEditorApplication(candidate.filename,candidate.fileHash,captured.documentHash);
 assert.deepEqual([preview.added,preview.updated,preview.removed],[1,1,1]);
 const id=randomUUID(),applied=await editor.applyEditorCandidate(id,candidate.filename,candidate.fileHash,captured.documentHash);
 assert.equal(applied.state,'succeeded',JSON.stringify(applied));assert.equal(applied.result.saved,false);
 assert.equal((await editor.applyEditorCandidate(id,candidate.filename,candidate.fileHash,captured.documentHash)).state,'succeeded');
 const stale=await editor.applyEditorCandidate(randomUUID(),candidate.filename,candidate.fileHash,captured.documentHash);assert.equal(stale.state,'failed');assert.equal(stale.result.code,'SOURCE_CHANGED');
 const receiptPath=join(directory,'editor',id+'.application.json'),receipt=JSON.parse(await readFile(receiptPath,'utf8'));
 // Simulate loss of the final receipt update; intent contains the precomputed identity mapping.
 await writeFile(receiptPath,JSON.stringify({...receipt,state:'unknown',mapping:Object.fromEntries(expected.objects.map(obj=>[obj.id,obj.nativeId]))}));
 assert.equal((await editor.recoverEditorApplication(id,candidate.filename,candidate.fileHash,captured.documentHash)).state,'succeeded');
 const final=await editor.captureEditor(randomUUID());
 worker=await launchRhinoWorker({...options,directory:join(directory,'verify'),source:{filename:final.filename,fileHash:final.fileHash}});const actual=await worker.exportModel();
 assert.ok(Math.abs(actual.scene.find(obj=>obj.id==='change').volume-48)<1e-8);assert.equal(actual.objects.find(obj=>obj.id==='change').nativeId,initialModel.objects.find(obj=>obj.id==='change').nativeId);
 assert.equal(actual.objects.find(obj=>obj.id==='keep').nativeId,initialModel.objects.find(obj=>obj.id==='keep').nativeId);assert.ok(Math.abs(actual.scene.find(obj=>obj.id==='keep').volume-24)<1e-8);
 assert.ok(actual.scene.find(obj=>obj.id==='change').attributes64.some(([key,value])=>Buffer.from(key,'base64').toString()==='Level'&&Buffer.from(value,'base64').toString()==='L02'));
 const evidence={passed:true,directory,added:1,updated:1,removed:1,volume:48,nativeIdsPreserved:true,attributesApplied:true,duplicateNoReplay:true,staleRejected:true,uncertainRecovered:true};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(worker)await worker.stop();if(editor)await editor.stop();}
