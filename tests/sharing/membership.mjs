import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve,join,sep} from 'node:path';
import {mkdir,readFile,writeFile,readdir,realpath,rm,cp} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {verifyPublications} from './publications.mjs';

const root=fileURLToPath(new URL('../../src/sharing/',import.meta.url));
const require=createRequire(join(root,'package.json'));
const {Miniflare,Log,LogLevel}=require('miniflare'),{build}=require('esbuild');
const directory=resolve(root,'../../.vide/sharing-membership',randomUUID());await mkdir(directory,{recursive:true});
const bundled=await build({entryPoints:[join(root,'worker.ts')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],conditions:['workerd','worker','browser']});
let mf;
let passed=false;
const server=createServer(async(request,response)=>{
  try{
    const url=new URL(request.url,origin);
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const result=await mf.dispatchFetch(url.href,{method:request.method,headers:request.headers,...(!['GET','HEAD'].includes(request.method)?{body:Buffer.concat(chunks)}:{})});
      for(const [key,value] of result.headers)response.setHeader(key,value);
      if(result.headers.getSetCookie().length)response.setHeader('Set-Cookie',result.headers.getSetCookie());
      response.statusCode=result.status;response.end(Buffer.from(await result.arrayBuffer()));return;
    }
    const webRoot=resolve(root,'../../dist/sharing'),path=url.pathname.startsWith('/assets/')?resolve(webRoot,'.'+url.pathname):join(webRoot,'index.html');
    if(!path.startsWith(webRoot+'\\')){response.writeHead(404).end();return;}
    const contents=await readFile(path);response.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');response.end(contents);
  }catch{response.writeHead(500).end('Test bridge failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,secret=randomBytes(32).toString('hex');
let logs='';
class TestLog extends Log { log(message){logs+=message+'\n';} }
const runtimeOptions={resourcePersistencePath:join(directory,'state'),telemetry:{enabled:false},log:new TestLog(LogLevel.NONE),workers:[{config:{
  name:'vide-sharing-test',compatibilityDate:'2026-09-22',compatibilityFlags:['nodejs_compat'],
  manifest:{mainModule:'worker.js',modules:{'worker.js':{type:'esm',contents:bundled.outputFiles[0].text}}},
  env:{DB:{type:'d1',id:'test-db',dev:{remote:false}},ASSETS:{type:'r2',name:'test-assets',dev:{remote:false}},EMAIL:{type:'send-email',dev:{remote:false}},
    AUTH_ORIGIN:{type:'text',value:origin},AUTH_SECRET:{type:'text',value:secret},EMAIL_FROM:{type:'text',value:'VIDE <noreply@example.com>'}},
}}]};
mf=new Miniflare(runtimeOptions);
const restart=async()=>{await mf.dispose();mf=new Miniflare(runtimeOptions);};
const checkpoint=async()=>{await mf.dispose();await cp(runtimeOptions.resourcePersistencePath,join(directory,'state-backup'),{recursive:true,errorOnExist:true,force:false});mf=new Miniflare(runtimeOptions);};
const restore=async()=>{await mf.dispose();const restored=join(directory,'state-restored');await cp(join(directory,'state-backup'),restored,{recursive:true,errorOnExist:true,force:false});runtimeOptions.resourcePersistencePath=restored;mf=new Miniflare(runtimeOptions);};
const call=async(path,{method='GET',data,cookie,origin:requestOrigin=origin}={})=>{
  const response=await mf.dispatchFetch(origin+path,{method,headers:{Origin:requestOrigin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.20',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});
  const raw=await response.text();let value;try{value=JSON.parse(raw);}catch{value=raw;}
  return {status:response.status,value,cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
};
try{
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir(join(root,'migrations'))).sort()){
    const sql=(await readFile(join(root,'migrations',name),'utf8')).replace(/^--.*$/gm,'');
    for(const statement of sql.split(';').filter(v=>v.trim()))await db.prepare(statement).run();
  }
  const account=async(name)=>{
    const email=name+'@example.com',password=randomBytes(20).toString('hex');
    let response=await call('/api/auth/sign-up/email',{method:'POST',data:{name,email,password}});assert.equal(response.status,200,JSON.stringify(response));
    // Account verification itself is covered by the auth spike. No test-only product route.
    await db.prepare('UPDATE user SET emailVerified=1 WHERE email=?').bind(email).run();
    response=await call('/api/auth/sign-in/email',{method:'POST',data:{email,password}});assert.equal(response.status,200,JSON.stringify(response));
    assert.ok(response.cookie);return {id:response.value.user.id,email,cookie:response.cookie,password};
  };
  const alice=await account('alice'),bob=await account('bob'),eve=await account('eve');
  assert.equal((await call('/api/projects')).status,401);
  const make=async(user,name)=>{const r=await call('/api/projects',{method:'POST',cookie:user.cookie,data:{name}});assert.equal(r.status,201,JSON.stringify(r));return r.value.id;};
  const a=await make(alice,'A'),b=await make(bob,'B');
  assert.equal((await call('/api/projects/'+a,{cookie:bob.cookie})).status,404);
  assert.equal((await call('/api/projects/'+b,{cookie:alice.cookie})).status,404);
  assert.equal((await call('/api/projects',{method:'POST',cookie:alice.cookie,data:{name:'Wrong origin'},origin:'https://foreign.example'})).status,403);
  const invite=async(email,selectedRole='viewer')=>{
    const r=await call(`/api/projects/${a}/invitations`,{method:'POST',cookie:alice.cookie,data:{email,role:selectedRole}});assert.equal(r.status,201,JSON.stringify(r));
    return {...r.value,token:new URL(r.value.link).hash.slice(1)};
  };
  const accept=(user,invitation)=>call('/api/invitations/accept',{method:'POST',cookie:user.cookie,data:{token:invitation.token}});
  const invitation=await invite(bob.email);
  assert.equal((await accept(eve,invitation)).status,409);
  const simultaneous=await Promise.all([accept(bob,invitation),accept(bob,invitation)]);
  for(const r of simultaneous)assert.equal(r.status,200,JSON.stringify(r));
  assert.equal((await db.prepare('SELECT count(*) n FROM project_members WHERE project_id=? AND user_id=?').bind(a,bob.id).first()).n,1);
  assert.equal((await call(`/api/projects/${a}`,{cookie:bob.cookie})).status,200);
  assert.equal((await call(`/api/projects/${a}/invitations`,{method:'POST',cookie:bob.cookie,data:{email:eve.email,role:'viewer'}})).status,403);
  let r=await call(`/api/projects/${a}/members/${bob.id}`,{method:'PATCH',cookie:alice.cookie,data:{role:'commenter'}});assert.equal(r.status,200);
  r=await call('/api/projects',{cookie:bob.cookie});assert.equal(r.value.projects.find(p=>p.id===a).role,'commenter');
  assert.equal((await call(`/api/projects/${a}/members/${alice.id}`,{method:'DELETE',cookie:alice.cookie})).status,409);
  r=await call(`/api/projects/${a}/members/${bob.id}`,{method:'DELETE',cookie:alice.cookie});assert.equal(r.status,200);
  assert.equal((await call(`/api/projects/${a}`,{cookie:bob.cookie})).status,404);
  assert.equal((await accept(bob,invitation)).status,409);
  const revoked=await invite(eve.email);assert.equal((await call(`/api/projects/${a}/invitations/${revoked.id}`,{method:'DELETE',cookie:alice.cookie})).status,200);
  assert.equal((await accept(eve,revoked)).status,409);
  const expired=await invite(eve.email);await db.prepare('UPDATE invitations SET expires_at=0 WHERE id=?').bind(expired.id).run();assert.equal((await accept(eve,expired)).status,409);
  assert.equal((await call(`/api/projects/${a}/invitations`,{method:'POST',cookie:alice.cookie,data:{email:eve.email,role:'owner'}})).status,400);
  const stored=await db.prepare('SELECT * FROM invitations WHERE id=?').bind(invitation.id).first();assert.ok(!JSON.stringify(stored).includes(invitation.token));
  assert.equal((await call('/__test/migrate',{method:'POST',cookie:alice.cookie,data:{}})).status,404);
  assert.equal((await call('/api/host/execute',{method:'POST',cookie:alice.cookie,data:{code:'test'}})).status,404);
  const publicationEvidence=await verifyPublications({call,mf,db,alice,bob,eve,projectId:a,invite,accept,origin});
  let browserEvidence={};
  if(process.argv.includes('--browser')){
    await accept(bob,await invite(bob.email,'commenter'));
    const {verifyBrowser}=await import('./browser.mjs');browserEvidence=await verifyBrowser({origin,bob,alice,directory,db,projectId:a});
  }
  let recoveryEvidence={};if(process.argv.includes('--recovery')||process.argv.includes('--backup')){const {verifyRecovery}=await import('./recovery.mjs');recoveryEvidence=await verifyRecovery({call,current:()=>mf,restart,origin,alice,projectId:a,...(process.argv.includes('--backup')?{checkpoint,restore}:{})});}
  let transferEvidence={};if(process.argv.includes('--large')){const {verifyLargeTransfer}=await import('./large-transfer.mjs');transferEvidence=await verifyLargeTransfer({call,current:()=>mf,origin,alice,projectId:a});}
  const evidence={passed:true,directory,localWorkerdD1:true,accounts:3,projects:2,crossProjectRejected:true,concurrentAcceptIdempotent:true,revokedMembershipNotRestored:true,expiredAndRevokedInvitationRejected:true,ownerProtected:true,noProductTestRoutes:true,...publicationEvidence,...browserEvidence,...recoveryEvidence,...transferEvidence,remoteDeployed:false};
  passed=true;
  await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{
 await new Promise(resolve=>server.close(resolve));await mf.dispose();await writeFile(join(directory,'worker.log'),logs);
 if(passed&&process.argv.includes('--large')){
  const target=await realpath(runtimeOptions.resourcePersistencePath),expected=resolve(runtimeOptions.resourcePersistencePath),allowed=resolve(root,'../../.vide/sharing-membership')+sep;
  assert.equal(target,expected);assert.ok(target.startsWith(allowed));
  const check=async path=>{for(const item of await readdir(path,{withFileTypes:true})){assert.equal(item.isSymbolicLink(),false);if(item.isDirectory())await check(join(path,item.name));}};await check(target);
  await rm(target,{recursive:true});
  const evidence=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));evidence.generatedRuntimeStateRemoved=true;await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log('Removed this successful large-transfer test runtime state; retained result and log.');
 }
}
