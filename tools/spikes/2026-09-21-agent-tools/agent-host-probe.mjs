// Real subscription agent -> scoped tool -> owned Rhino. Synthetic model only.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { launchRhinoWorker } from '../../../hosts/rhino/worker-client.ts';
import { startServer } from '../../../src/server/server.ts';
import { createProvider } from '../../../src/ai/providers.ts';
import { installedCodex } from '../../../src/ai/paths.ts';

const provider=process.argv[2];
if(!['claude-cli','codex-cli'].includes(provider))throw Error('Specify subscription CLI');
const base=resolve('.vide/agent-worker-probe');await mkdir(base,{recursive:true});
const directory=join(base,randomUUID());
let worker,app,scope;
const start=Date.now();let queries=0,executions=0,successfulWrites=0,revision=0,lastResult,lastError,uncertain=false;
try{
 worker=await launchRhinoWorker({directory,executable:'C:\\Program Files\\Rhino 8\\System\\Rhino.exe',
  plugin:resolve('.vide/build/rhino-worker/bin/net8.0-windows/VIDE.Worker.rhp'),bootstrap:resolve('hosts/rhino/worker/bootstrap.py')});
 app=await startServer({filename:join(directory,'probe.sqlite')});
 const targetRef='rhino:'+worker.identity.sessionId;
 scope=app.agentTools.issue({targetRef,maxCalls:6,ttlMs:150000,isCurrent:()=>true,handlers:{
  query:async()=>{queries++;return worker.query();},
  execute:async({code})=>{
   if(uncertain)throw Object.assign(Error('HOST_RESULT_UNKNOWN'),{code:'HOST_RESULT_UNKNOWN'});
   executions++;
   try{
    const result=await worker.execute(randomUUID(),revision,code);
    if(result.ok){successfulWrites++;revision=result.revision;lastResult=result;return {ok:true,revision,readbackVerified:result.readbackVerified,snapshot:result.snapshot};}
    lastError=result;
    if(result.code==='HOST_RESULT_UNKNOWN')uncertain=true;
    return result;
   }catch(error){uncertain=true;throw error;}
  },
 }});
 const cli=createProvider({provider,executable:provider==='codex-cli'?installedCodex():join(homedir(),'.local','bin','claude.exe'),timeoutMs:120000,effort:'low',agent:{url:app.origin+'/mcp',token:scope.token,tools:['query','execute']}});
 const response=await cli.run({goal:`Synthetic Rhino SDK test. You control only the dedicated working copy ${targetRef}. First call query. Then call execute, creating one 10 by 8 by 6 meter box at the world origin using RhinoCommon. Send only the method body as code, with no class, method declaration, markdown fence or using statements. The trusted wrapper runs it inside public static object Run(RhinoDoc doc), with System, System.Linq, Rhino and Rhino.Geometry imported. Use doc.Objects.AddBox(new Box(new BoundingBox(0,0,0,10,8,6))); as the SDK construction pattern. Do not save or open files yourself: the trusted worker saves and verifies after execute. Query again to verify exactly one object whose bounds max is [10,8,6]. If compilation fails, use its diagnostics to correct the code, at most two corrections. After one successful execute, never execute again. Never retry a write after uncertainty. Return a short Korean factual summary.`,revision:1,items:[],includedIds:[]});
 const snapshot=await worker.query();
 assert.equal(successfulWrites,1);assert.ok(executions<=3);assert.ok(queries>=2);assert.equal(snapshot.objects.length,1);assert.deepEqual(snapshot.objects[0].bounds,[[0,0,0],[10,8,6]]);
 assert.equal(lastResult?.readbackVerified,true);assert.ok((await readFile(lastResult.filename)).length>0);
 console.log(JSON.stringify({provider,passed:true,queries,executions,successfulWrites,objects:1,readbackVerified:true,elapsedMs:Date.now()-start,usage:response.usage,directory}));
}catch(error){console.log(JSON.stringify({provider,passed:false,queries,executions,elapsedMs:Date.now()-start,code:error.code||error.message||'PROBE_FAILED',lastError,directory}));process.exitCode=1;}
finally{scope?.revoke();if(app)await app.close();if(worker)await worker.stop();}
