import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { startServer } from '../../../src/server/server.ts';
import { createProvider } from '../../../src/ai/providers.ts';
import { installedCodex } from '../../../src/ai/paths.ts';

// One synthetic call per invocation, no host, no user data, no raw provider/auth logs.
const provider=process.argv[2];
if(!['claude-cli','codex-cli'].includes(provider))throw Error('Specify claude-cli or codex-cli');
const directory=await mkdtemp(join(tmpdir(),'vide-agent-probe-'));
const app=await startServer({filename:join(directory,'test.sqlite')});
let queries=0;
const nonce=randomBytes(8).toString('hex');
const scope=app.agentTools.issue({targetRef:'synthetic:probe',isCurrent:()=>true,maxCalls:5,ttlMs:90000,
  handlers:{query:()=>{queries++;return {synthetic:true,nonce};}}});
const start=Date.now();
try{
  const cli=createProvider({provider,executable:provider==='codex-cli'?installedCodex():join(homedir(),'.local','bin','claude.exe'),
    timeoutMs:60000,effort:'low',agent:{url:app.origin+'/mcp',token:scope.token,tools:['query']},
    spawnProcess:(executable,args,options)=>{
      const child=spawn(executable,args,options);
      if(process.argv.includes('--diagnose')&&!['auth','login'].includes(args[0])){
        let buffer='';child.stdout.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);
            if(event.item?.type==='error')console.log(JSON.stringify({diagnostic:String(event.item.message).replaceAll(scope.token,'[redacted]')}));
            if(event.type==='system'&&event.subtype==='init')console.log(JSON.stringify({tools:event.tools,servers:event.mcp_servers}));
          }catch{}}});
      }return child;
    }});
  const result=await cli.run({goal:'Call the vide query tool exactly once with targetRef synthetic:probe. Reply only with the nonce returned by that tool. This is a synthetic connectivity test, not CAD work.',revision:1,items:[],includedIds:[]},
    {onProgress:event=>console.log(JSON.stringify({provider,...event}))});
  const passed=queries===1&&result.text.includes(nonce);
  console.log(JSON.stringify({provider,passed,queries,elapsedMs:Date.now()-start,usage:result.usage}));
  if(!passed&&process.argv.includes('--diagnose'))console.log(JSON.stringify({syntheticResponse:result.text.replaceAll(scope.token,'[redacted]')}));
  if(!passed)process.exitCode=1;
}catch(error){console.log(JSON.stringify({provider,passed:false,queries,elapsedMs:Date.now()-start,code:error.code||'PROBE_FAILED'}));process.exitCode=1;}
finally{scope.revoke();await app.close();await rm(directory,{recursive:true,force:true});}
