// Interactive acceptance fixture: move + SaveAs with Rhino's normal UI, then verify independently.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,access} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {launchRhinoWorker} from '../../hosts/rhino/worker-client.ts';
const sourceDirectory=resolve(process.argv[2]||''),within=relative(resolve('.vide/browser-owned-editor'),sourceDirectory);
assert.ok(within&&!within.startsWith('..')&&!isAbsolute(within));
const prior=JSON.parse(await readFile(join(sourceDirectory,'result.json'),'utf8'));assert.equal(prior.passed,true);
const database=new DatabaseSync(join(sourceDirectory,'test.sqlite'),{readOnly:true});
const row=database.prepare("SELECT result FROM workspace_requests WHERE state='succeeded' ORDER BY createdAt DESC LIMIT 1").get();database.close();
const source=JSON.parse(row.result),directory=resolve('.vide/native-editor-followup',randomUUID());await mkdir(directory,{recursive:true});
const saved=join(directory,'manually-saved.3dm'),options={executable:'C:/Program Files/Rhino 8/System/Rhino.exe',plugin:resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:resolve('hosts/rhino/worker/bootstrap.py')};
let editor,verify;
try{
 editor=await launchRhinoWorker({...options,directory:join(directory,'editor'),mode:'editor',visible:true,source:{filename:source.filename,fileHash:source.fileHash}});
 const before=await editor.inspectEditor();
 const waiting={directory,pid:editor.identity.pid,saved,instruction:'In this synthetic Rhino window: select the object, Move by +1 m world X, then SaveAs the saved path.'};
 await writeFile(join(directory,'waiting.json'),JSON.stringify(waiting,null,2));console.log(JSON.stringify(waiting));
 const deadline=Date.now()+15*60*1000;let exists=false;
 while(Date.now()<deadline){try{await access(saved);exists=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,1000));}}
 assert.ok(exists,'Native UI save was not completed');
 // Allow SaveAs to release its file before the separate native reader opens it.
 await new Promise(resolve=>setTimeout(resolve,1500));
 const after=await editor.inspectEditor();assert.equal(after.modified,false);assert.notEqual(after.documentHash,before.documentHash);
 const captured=await editor.captureEditor(randomUUID());
 const hash=createHash('sha256').update(await readFile(saved)).digest('hex');
 verify=await launchRhinoWorker({...options,directory:join(directory,'reopened'),source:{filename:saved,fileHash:hash}});
 const restored=await verify.exportModel();assert.equal(restored.objects.length,1);assert.equal(restored.objects[0].nativeId,source.objects[0].nativeId);
 const actual=restored.scene[0],expected=source.scene[0];
 assert.ok(Math.abs(actual.origin[0]-expected.origin[0]-1)<1e-8);assert.ok(Math.abs(actual.origin[1]-expected.origin[1])<1e-8);assert.ok(Math.abs(actual.origin[2]-expected.origin[2])<1e-8);
 assert.deepEqual(actual.attributes64,expected.attributes64);assert.ok(Math.abs(actual.volume-expected.volume)<1e-8);
 assert.equal(captured.documentHash,after.documentHash);
 const evidence={passed:true,directory,sourceDirectory,nativeMoveX:1,nativeSaveAs:true,reopened:true,nativeIdentityPreserved:true,attributesPreserved:true,volume:actual.volume};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{if(verify)await verify.stop();if(editor)await editor.stop();}
