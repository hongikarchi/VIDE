import {launchProbe} from './channel-client.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

const directory=resolve('.vide/zwcad-channel',randomUUID());
await mkdir(directory,{recursive:true});
const owners=[];

try{
 const first=await launchProbe(directory,'first');owners.push(first.owner);
 const second=await launchProbe(directory,'second');owners.push(second.owner);
 assert.notEqual(first.ready.pid,second.ready.pid);assert.notEqual(first.ready.documentId,second.ready.documentId);
 const queries=await Promise.all([first.call(),second.call()]);
 for(const [index,value] of queries.entries()){
  assert.equal(value.ok,true,JSON.stringify(value));assert.equal(value.areaSquareMetres,200);
  assert.equal(value.hostThreadVerified,true);assert.equal(value.activeDocumentAccessed,false);
  assert.equal(value.pid,[first,second][index].ready.pid);
 }
 const cases=[
  [{token:'0'.repeat(64)},'UNAUTHORIZED'],
  [{sessionId:second.ready.sessionId},'HOST_OWNERSHIP_MISMATCH'],
  [{pid:second.ready.pid},'HOST_OWNERSHIP_MISMATCH'],
  [{startTicks:'1'},'HOST_OWNERSHIP_MISMATCH'],
  [{documentId:second.ready.documentId},'DOCUMENT_MISMATCH'],
  [{revision:1},'STALE_REVISION'],
  [{method:'execute',code:'throw new Exception();'},'UNSUPPORTED_METHOD'],
 ];
 for(const [input,code] of cases)assert.deepEqual(await first.call(input),{ok:false,code});
 assert.equal((await first.call()).ok,true);assert.equal((await second.call()).ok,true);
 await first.owner.stop();
 await assert.rejects(first.call(),error=>['HOST_LEASE_EXPIRED','HOST_UNAVAILABLE'].includes(error.code));
 assert.equal((await second.call()).ok,true,'Stopping one owned process must not affect the other');
 const evidence={passed:true,directory,processes:[first.ready,second.ready],queries,rejections:cases.map(([,code])=>code),survivorAfterOtherStop:true};
 await writeFile(join(directory,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}catch(error){await writeFile(join(directory,'failure.json'),JSON.stringify({error:error.message,directory},null,2));throw error;}
finally{
 const stopped=await Promise.allSettled(owners.map(owner=>owner.stop()));
 const failures=stopped.filter(result=>result.status==='rejected');
 if(failures.length)throw new AggregateError(failures.map(result=>result.reason),'Owned ZWCAD cleanup failed');
}
