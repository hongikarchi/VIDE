import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export function verifyStaging(config, accountOverride=process.env.CLOUDFLARE_ACCOUNT_ID) {
 const expected='vide-sharing-staging';
 if(config.name!==expected || config.account_id!=='04342c5d7e3c1adaf6da81a8964b3ed4' || (accountOverride && accountOverride!==config.account_id)) throw Error('DEPLOYMENT_ACCOUNT_OR_WORKER_MISMATCH');
 if(config.d1_databases?.length!==1 || config.d1_databases[0].binding!=='DB' || config.d1_databases[0].database_name!==expected || config.d1_databases[0].database_id!=='c7f1541a-6fd5-43fb-b70f-6247af392a2e') throw Error('DEPLOYMENT_DATABASE_MISMATCH');
 if(config.r2_buckets?.length!==1 || config.r2_buckets[0].binding!=='ASSETS' || config.r2_buckets[0].bucket_name!==expected) throw Error('DEPLOYMENT_BUCKET_MISMATCH');
 if(config.vars?.AUTH_MODE!=='manual-approval' || config.vars?.UPLOADS_ENABLED!=='false' || config.vars?.AUTH_ORIGIN!=='https://vide-sharing-staging.archivibe.workers.dev' || config.send_email?.length || config.routes?.length) throw Error('DEPLOYMENT_FREE_TRIAL_POLICY_MISMATCH');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 // Current config uses line comments only; reject unsupported JSONC instead of guessing.
 const config=JSON.parse(readFileSync('src/sharing/wrangler.staging.jsonc','utf8').replace(/^\s*\/\/.*$/gm,''));
 verifyStaging(config);console.log('Staging configuration matches the approved account, D1, R2 and free-only policy. This is not a live account/billing check.');
}
