import {test} from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {mkdtemp,readFile,access,rmdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../../src/core/store.ts';import {Workspace} from '../../src/core/workspace.ts';import {importModel,recoverDwgImport} from '../../src/server/import-model.ts';
import {rm} from 'node:fs/promises';import {createHash} from 'node:crypto';
const upload=bytes=>Object.assign(Readable.from([bytes]),{headers:{'content-type':'application/octet-stream'}});
test('DWG import routes to its own host and preserves input identity without exposing upload paths',async()=>{
 const store=new Store(':memory:'),workspace=new Workspace(store),project=store.createProject('DWG');const directory=await mkdtemp(join(tmpdir(),'vide-dwg-import-'));let source;
 const cad={directory,importFile:async(projectId,id,path)=>{source=path;assert.equal(projectId,project.id);assert.ok(path.endsWith('.upload.dwg'));assert.equal((await readFile(path)).toString(),'AC1032fixture');return {objects:[],scene:[],referenceOnly:true,verified:true};}};
 try{const request=await importModel(upload(Buffer.from('AC1032fixture')),project.id,'boundary.dwg',workspace,{importFile:()=>assert.fail('Wrong host')},cad);assert.equal(request.state,'succeeded');assert.equal(request.input.host,'zwcad');assert.equal(request.result.referenceOnly,true);await assert.rejects(access(source));
  await assert.rejects(()=>importModel(upload(Buffer.from('3D Geometry File Format')),project.id,'bad.dwg',workspace,{},cad),{code:'INVALID_INPUT'});
  await assert.rejects(()=>importModel(upload(Buffer.from('AC1032fixture')),project.id,'bad.3dm',workspace,{},cad),{code:'INVALID_INPUT'});
 }finally{store.close();await rmdir(join(directory,project.id));await rmdir(directory);}
});

test('uncertain DWG import requires persisted upload evidence, rejects changed bytes and recovers without repeating import',async()=>{
 const store=new Store(':memory:'),workspace=new Workspace(store),project=store.createProject('Recovery'),directory=await mkdtemp(join(tmpdir(),'vide-import-recover-'));let source,inspected=0,changed=true;
 const hash=createHash('sha256').update('AC1032fixture').digest('hex');
 const cad={directory,importFile:async(p,id,path)=>{source=path;throw {code:'HOST_RESULT_UNKNOWN'};},inspectImport:async(p,id,expected)=>{inspected++;assert.equal(expected,hash);return {fileHash:changed?'bad':hash,referenceOnly:true,verified:true,objects:[],scene:[]};}};
 try{
  const request=await importModel(upload(Buffer.from('AC1032fixture')),project.id,'test.dwg',workspace,{},cad);assert.equal(request.state,'unknown');assert.equal(request.result.sourceHash,hash);await access(source);
  await assert.rejects(recoverDwgImport(project.id,request.id,workspace,cad),{code:'HOST_VERIFICATION_FAILED'});assert.equal(workspace.get(project.id,request.id).state,'unknown');await access(source);
  changed=false;const result=await recoverDwgImport(project.id,request.id,workspace,cad);assert.equal(result.state,'succeeded');assert.equal(result.result.recovered,true);await assert.rejects(access(source));
  assert.deepEqual(await recoverDwgImport(project.id,request.id,workspace,cad),result);assert.equal(inspected,2);
  const other=store.createProject('Other');await assert.rejects(recoverDwgImport(other.id,request.id,workspace,cad),{code:'NOT_FOUND'});
  workspace.update(project.id,request.id,'unknown',{code:'HOST_RESULT_UNKNOWN'});await assert.rejects(recoverDwgImport(project.id,request.id,workspace,cad),{code:'IMPORT_EVIDENCE_MISSING'});
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
