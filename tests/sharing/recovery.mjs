import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';

export async function verifyRecovery({call,current,restart,origin,alice,projectId,checkpoint,restore}){
  const base=`/api/projects/${projectId}/publications`,cookie=alice.cookie;
  const previous=(await call(base+'/current',{cookie})).value.id;
  const chunks=[Buffer.alloc(8*1024*1024,37),Buffer.alloc(2*1024*1024,83)];
  const part=bytes=>({size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  const manifest={title:'10 MiB recovery fixture',objectIds:[],assets:[{id:'fixture',parts:chunks.map(part)}]},requestId=randomUUID();
  const prepare=()=>call(base,{method:'POST',cookie,data:{requestId,manifest}});
  const prepared=await prepare();assert.equal(prepared.status,201);const id=prepared.value.id;
  const upload=async(index)=>{const response=await current().dispatchFetch(origin+base+'/'+id+'/assets/fixture/'+index,{method:'PUT',headers:{Origin:origin,Cookie:cookie,'Content-Length':String(chunks[index].length)},body:chunks[index]});assert.equal(response.status,200,await response.text());};
  const finish=()=>call(base+'/'+id+'/finalize',{method:'POST',cookie,data:{}});
  const started=performance.now();await upload(0);await restart();
  assert.equal((await prepare()).value.id,id);assert.equal((await finish()).status,409);assert.equal((await call(base+'/current',{cookie})).value.id,previous);
  await upload(0);await upload(1);assert.equal((await finish()).status,200);
  await restart();assert.equal((await finish()).status,200);assert.equal((await call(base+'/current',{cookie})).value.id,id);
  for(let i=0;i<chunks.length;i++){
    const response=await current().dispatchFetch(origin+base+'/'+id+'/assets/fixture/'+i,{headers:{Cookie:cookie}});assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual(part(bytes),manifest.assets[0].parts[i]);
  }
  const recoveryMs=Math.round(performance.now()-started),concurrentReads=[];
  for(const concurrency of [1,10,50]){
    const started=performance.now(),samples=await Promise.all(Array.from({length:concurrency},async()=>{
      const start=performance.now(),response=await current().dispatchFetch(origin+base+'/'+id+'/assets/fixture/1',{headers:{Cookie:cookie}});assert.equal(response.status,200);
      const bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual(part(bytes),manifest.assets[0].parts[1]);return performance.now()-start;
    }));samples.sort((a,b)=>a-b);const percentile=p=>Math.round(samples[Math.max(0,Math.ceil(samples.length*p)-1)]);
    concurrentReads.push({concurrency,bytesPerRead:chunks[1].length,elapsedMs:Math.round(performance.now()-started),p50Ms:percentile(.5),p95Ms:percentile(.95),errors:0});
  }
  let backupEvidence={};
  if(checkpoint&&restore){
    const note=await call(base+'/'+id+'/comments',{method:'POST',cookie,data:{submissionId:randomUUID(),body:'Checkpoint comment',objectId:null}});assert.equal(note.status,201);
    await checkpoint();const began=performance.now(),db=await current().getD1Database('DB'),bucket=await current().getR2Bucket('ASSETS');
    await db.prepare('DELETE FROM comments WHERE id=?').bind(note.value.id).run();await bucket.delete(`publications/${projectId}/${id}/fixture/0`);
    assert.equal((await call(base+'/'+id+'/comments',{cookie})).value.comments.length,0);
    assert.equal((await current().dispatchFetch(origin+base+'/'+id+'/assets/fixture/0',{headers:{Cookie:cookie}})).status,404);
    await restore();assert.equal((await call(base+'/current',{cookie})).value.id,id);
    assert.equal((await call(base+'/'+id+'/comments',{cookie})).value.comments[0].id,note.value.id);
    const restored=await current().dispatchFetch(origin+base+'/'+id+'/assets/fixture/0',{headers:{Cookie:cookie}});assert.equal(restored.status,200);assert.deepEqual(part(Buffer.from(await restored.arrayBuffer())),manifest.assets[0].parts[0]);
    backupEvidence={localCheckpointRestored:true,restoreAndValidationMs:Math.round(performance.now()-began),backupScope:'stopped local emulator state snapshot, not remote D1 export or production disaster recovery'};
  }
  return {runtimeRestartRecovery:true,tenMiBHashVerified:true,recoveryMs,concurrentReads,...backupEvidence,network:'loopback only; not remote latency or browser rendering'};
}
