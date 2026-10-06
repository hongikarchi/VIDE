import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const decisionsDir = fileURLToPath(new URL('../../docs/decisions/', import.meta.url));

/**
 * Whether `id` names an approved ADR that records accepting R2 charges for snapshots
 * (RESEARCH-10 §16 C3). The ADR must mention C3 so an unrelated approved ADR cannot stand in.
 */
export function billingDecisionRecorded(id, dir = decisionsDir) {
  if (typeof id !== 'string' || !/^ADR-\d{3}$/.test(id)) return false;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  const name = names.find((n) => n.startsWith(id + '-') && n.endsWith('.md'));
  if (!name) return false;
  const text = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  return /^status:\s*approved\s*(#.*)?$/m.test(head) && /\bC3\b/.test(text);
}

export function verifyStaging(
  config,
  accountOverride = process.env.CLOUDFLARE_ACCOUNT_ID,
  decisionRecorded = billingDecisionRecorded,
) {
  const expected = 'vide-sharing-staging';
  if (
    config.name !== expected ||
    config.account_id !== '04342c5d7e3c1adaf6da81a8964b3ed4' ||
    (accountOverride && accountOverride !== config.account_id)
  )
    throw Error('DEPLOYMENT_ACCOUNT_OR_WORKER_MISMATCH');
  if (
    config.d1_databases?.length !== 1 ||
    config.d1_databases[0].binding !== 'DB' ||
    config.d1_databases[0].database_name !== expected ||
    config.d1_databases[0].database_id !== 'c7f1541a-6fd5-43fb-b70f-6247af392a2e'
  )
    throw Error('DEPLOYMENT_DATABASE_MISMATCH');
  if (
    config.r2_buckets?.length !== 1 ||
    config.r2_buckets[0].binding !== 'ASSETS' ||
    config.r2_buckets[0].bucket_name !== expected
  )
    throw Error('DEPLOYMENT_BUCKET_MISMATCH');
  if (
    config.vars?.AUTH_MODE !== 'manual-approval' ||
    // Uploads stay off unless an approved R2 decision (C3) is named (ADR-038).
    (config.vars?.UPLOADS_ENABLED !== 'false' &&
      !decisionRecorded(config.vars?.SNAPSHOT_BILLING_DECISION)) ||
    config.vars?.AUTH_ORIGIN !== 'https://vide-sharing-staging.archivibe.workers.dev' ||
    config.send_email?.length ||
    config.routes?.length
  )
    throw Error('DEPLOYMENT_FREE_TRIAL_POLICY_MISMATCH');
  // PC snapshots store bytes in R2. Both settings must be written out (the Worker treats a missing
  // switch as on), and turning either on needs an approved R2 decision (C3, RESEARCH-10 §13.6)
  // named in SNAPSHOT_BILLING_DECISION: ADR-038 (R2 cleared, free tier with caps, 2026-10-06).
  const { SNAPSHOTS_ENABLED: enabled, SNAPSHOT_TOTAL_MB: totalMb } = config.vars ?? {};
  if (
    (enabled !== 'true' && enabled !== 'false') ||
    typeof totalMb !== 'string' ||
    !/^\d+(\.\d+)?$/.test(totalMb)
  )
    throw Error('DEPLOYMENT_SNAPSHOT_POLICY_MISMATCH');
  if (
    (enabled === 'true' || Number(totalMb) > 0) &&
    !decisionRecorded(config.vars.SNAPSHOT_BILLING_DECISION)
  )
    throw Error('DEPLOYMENT_SNAPSHOT_BILLING_UNDECIDED');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Current config uses line comments only; reject unsupported JSONC instead of guessing.
  const config = JSON.parse(
    readFileSync('src/sharing/wrangler.staging.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  verifyStaging(config);
  console.log(
    'Staging configuration matches the approved account, D1, R2 and free-only policy (uploads and snapshots off unless an approved R2 decision is named: ADR-038). This is not a live account/billing check.',
  );
}
