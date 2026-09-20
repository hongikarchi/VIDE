import {test} from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';import {mkdtemp,readFile,access,rmdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../../src/core/store.mjs';import {Workspace} from '../../src/core/workspace.mjs';import {importModel} from '../../src/server/import-model.mjs';
const upload=bytes=>Object.assign(Readable.from([bytes]),{headers:{'content-type':'application/octet-stream'}});
test('DWG import routes to its own host and preserves input identity without exposing upload paths',async()=>{
 const store=new Store(':memory:'),workspace=new Workspace(store),project=store.createProject('DWG');const directory=await mkdtemp(join(tmpdir(),'vide-dwg-import-'));let source;
 const cad={directory,importFile:async(projectId,id,path)=>{source=path;assert.equal(projectId,project.id);assert.ok(path.endsWith('.upload.dwg'));assert.equal((await readFile(path)).toString(),'AC1032fixture');return {objects:[],scene:[],referenceOnly:true,verified:true};}};
 try{const request=await importModel(upload(Buffer.from('AC1032fixture')),project.id,'boundary.dwg',workspace,{importFile:()=>assert.fail('Wrong host')},cad);assert.equal(request.state,'succeeded');assert.equal(request.input.host,'zwcad');assert.equal(request.result.referenceOnly,true);await assert.rejects(access(source));
  await assert.rejects(()=>importModel(upload(Buffer.from('3D Geometry File Format')),project.id,'bad.dwg',workspace,{},cad),{code:'INVALID_INPUT'});
  await assert.rejects(()=>importModel(upload(Buffer.from('AC1032fixture')),project.id,'bad.3dm',workspace,{},cad),{code:'INVALID_INPUT'});
 }finally{store.close();await rmdir(directory);}
});
