import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyStaging} from '../../tools/checks/deployment.mjs';
test('deployment rejects alternate accounts, storage and accidental uploads or email',()=>{
 const config=JSON.parse(readFileSync('src/sharing/wrangler.staging.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''));
 assert.doesNotThrow(()=>verifyStaging(config,''));
 assert.throws(()=>verifyStaging(config,'wrong'),/MISMATCH/);
 for(const change of [c=>c.name='production',c=>c.d1_databases[0].database_id='wrong',c=>c.r2_buckets[0].bucket_name='private',c=>c.vars.UPLOADS_ENABLED='true',c=>c.send_email=[{name:'EMAIL'}]]) {
  const changed=structuredClone(config);change(changed);assert.throws(()=>verifyStaging(changed,''),/MISMATCH/);
 }
});
