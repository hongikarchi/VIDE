// Real subscription CLI, task-scoped tools, owned ZWCAD and synthetic DWG only.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {launchProbe} from './channel-client.mjs';
import {startServer} from '../../../src/server/server.ts';
import {createProvider} from '../../../src/ai/providers.ts';
import {installedCodex} from '../../../src/ai/paths.ts';

const provider=process.argv[2];
if(!['claude-cli','codex-cli'].includes(provider))throw Error('Specify subscription CLI');
const directory=resolve('.vide/zwcad-agent',randomUUID());await mkdir(directory,{recursive:true});
let host,app,scope,revision=0,queries=0,executions=0,writes=0,lastResult,uncertain=false;
const diagnostics=[],started=Date.now();
try{
 host=await launchProbe(directory,'host',true);
 const seed=join(host.folder,'sdk-probe.dwg');
 const originalHash=createHash('sha256').update(await readFile(seed)).digest('hex');
 app=await startServer({filename:join(directory,'probe.sqlite')});
 const targetRef='zwcad:'+host.ready.sessionId;
 scope=app.agentTools.issue({targetRef,maxCalls:7,ttlMs:180000,isCurrent:()=>!uncertain,handlers:{
  query:async()=>{queries++;return host.call();},
  execute:async({code})=>{
   if(uncertain||writes||executions>=3)throw Object.assign(Error('HOST_REJECTED'),{code:'HOST_REJECTED'});
   executions++;uncertain=true;
   await writeFile(join(directory,`execution-${executions}.cs`),code);
   const result=await host.call({method:'execute',revision,operationId:randomUUID(),code});
   if(result.ok){writes++;revision=result.revision;lastResult=result;uncertain=false;
    return {ok:true,revision,readbackVerified:true,snapshot:result.snapshot};}
   diagnostics.push(result);
   if(result.code==='CODE_FAILED')uncertain=false;
   return result;
  },
 }});
 const cli=createProvider({provider,executable:provider==='codex-cli'?installedCodex():join(homedir(),'.local','bin','claude.exe'),timeoutMs:150000,effort:'low',agent:{url:app.origin+'/mcp',token:scope.token,tools:['query','execute']}});
 const response=await cli.run({goal:`This is a synthetic ZWCAD 2023 SDK connection test on ${targetRef}. First query the working copy. It contains a closed 20 m by 10 m XY Polyline at the world origin, in millimetres. Change its width from 20 m to 26 m, keeping its 10 m depth, Handle and color. Use execute with only a C# method body. The wrapper imports System, System.Linq, ZwSoft.ZwCAD.DatabaseServices and ZwSoft.ZwCAD.Geometry, and supplies Database db and Transaction tr. Read db.BlockTableId via tr.GetObject; open BlockTableRecord.ModelSpace and iterate its ObjectIds. Open the Polyline ForWrite and use SetPointAt(index,new Point2d(x,y)) to change its vertices. The points are (0,0),(20000,0),(20000,10000),(0,10000) mm. Do not add a new entity. Do not declare a class, method or using directives. The controller saves and reopens each edit, so never access files, other documents, networking, processes, application state, or perform SaveAs yourself. If compilation fails, use the returned diagnostics to correct it, at most twice. Stop after one successful execute; never retry uncertainty. Query again and verify 260 m² area and 72 m length. Return a brief factual Korean summary.`,revision:1,items:[],includedIds:[]});
 const final=await host.call();
 await writeFile(join(directory,'agent-result.json'),JSON.stringify({response,final,lastResult},null,2));
 assert.equal(writes,1,JSON.stringify(diagnostics));assert.ok(queries>=2);assert.equal(final.revision,1);
 assert.equal(final.snapshot.objects.length,1);assert.equal(final.snapshot.objects[0].area,260);assert.equal(final.snapshot.objects[0].length,72);
 assert.equal(final.snapshot.objects[0].color,3);assert.equal(final.snapshot.objects[0].handle,'44');
 assert.equal(createHash('sha256').update(await readFile(seed)).digest('hex'),originalHash);
 assert.equal(createHash('sha256').update(await readFile(lastResult.filename)).digest('hex'),lastResult.fileHash);
 const evidence={passed:true,provider,directory,elapsedMs:Date.now()-started,queries,executions,writes,final,usage:response.usage,diagnostics,text:response.text};
 await writeFile(join(directory,'verification.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){
 const evidence={passed:false,provider,directory,elapsedMs:Date.now()-started,queries,executions,writes,uncertain,diagnostics,code:error.code||error.message,message:error.message,lastResult};
 await writeFile(join(directory,'failure.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));process.exitCode=1;
}finally{scope?.revoke();try{if(app)await app.close();}finally{if(host)await host.owner.stop();}}
