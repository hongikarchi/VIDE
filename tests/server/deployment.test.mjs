import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billingDecisionRecorded, verifyStaging } from '../../tools/checks/deployment.mjs';
test('deployment rejects alternate accounts, storage and accidental uploads or email', () => {
  const config = JSON.parse(
    readFileSync('src/sharing/wrangler.staging.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  assert.doesNotThrow(() => verifyStaging(config, ''));
  assert.throws(() => verifyStaging(config, 'wrong'), /MISMATCH/);
  for (const change of [
    (c) => (c.name = 'production'),
    (c) => (c.d1_databases[0].database_id = 'wrong'),
    (c) => (c.r2_buckets[0].bucket_name = 'private'),
    (c) => (c.vars.UPLOADS_ENABLED = 'true'),
    (c) => (c.send_email = [{ name: 'EMAIL' }]),
  ]) {
    const changed = structuredClone(config);
    change(changed);
    assert.throws(() => verifyStaging(changed, ''), /MISMATCH/);
  }
});
test('deployment keeps PC snapshots off until an approved billing decision (C3) is recorded', () => {
  const config = JSON.parse(
    readFileSync('src/sharing/wrangler.staging.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  assert.equal(config.vars.SNAPSHOTS_ENABLED, 'false');
  assert.equal(config.vars.SNAPSHOT_TOTAL_MB, '0');
  // Settings left out (the Worker would treat a missing switch as on) or malformed.
  for (const change of [
    (c) => delete c.vars.SNAPSHOTS_ENABLED,
    (c) => delete c.vars.SNAPSHOT_TOTAL_MB,
    (c) => (c.vars.SNAPSHOTS_ENABLED = 'yes'),
    (c) => (c.vars.SNAPSHOT_TOTAL_MB = '-1'),
  ]) {
    const changed = structuredClone(config);
    change(changed);
    assert.throws(() => verifyStaging(changed, ''), /DEPLOYMENT_SNAPSHOT_POLICY_MISMATCH/);
  }
  // Turned on without a decision, or naming one that is not an approved C3 record.
  const recorded = (id) => id === 'ADR-999';
  for (const vars of [
    { SNAPSHOTS_ENABLED: 'true' },
    { SNAPSHOT_TOTAL_MB: '8000' },
    { SNAPSHOTS_ENABLED: 'true', SNAPSHOT_TOTAL_MB: '8000', SNAPSHOT_BILLING_DECISION: 'ADR-015' },
  ]) {
    const changed = structuredClone(config);
    Object.assign(changed.vars, vars);
    assert.throws(() => verifyStaging(changed, '', recorded), /SNAPSHOT_BILLING_UNDECIDED/);
  }
  const accepted = structuredClone(config);
  Object.assign(accepted.vars, {
    SNAPSHOTS_ENABLED: 'true',
    SNAPSHOT_TOTAL_MB: '8000',
    SNAPSHOT_BILLING_DECISION: 'ADR-999',
  });
  assert.doesNotThrow(() => verifyStaging(accepted, '', recorded));
  // The default reader accepts only an approved ADR that mentions C3.
  const dir = mkdtempSync(join(tmpdir(), 'vide-decisions-'));
  try {
    const adr = (id, status, body) =>
      writeFileSync(join(dir, `${id}-x.md`), `---\nid: ${id}\nstatus: ${status}\n---\n\n${body}\n`);
    adr('ADR-901', 'approved', 'R2 과금 수용(C3).');
    adr('ADR-902', 'draft', 'R2 과금 수용(C3).');
    adr('ADR-903', 'approved', '다른 결정.');
    assert.equal(billingDecisionRecorded('ADR-901', dir), true);
    assert.equal(billingDecisionRecorded('ADR-902', dir), false);
    assert.equal(billingDecisionRecorded('ADR-903', dir), false);
    assert.equal(billingDecisionRecorded('ADR-904', dir), false);
    assert.equal(billingDecisionRecorded('../ADR-901', dir), false);
    assert.equal(billingDecisionRecorded(undefined, dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // No ADR in the repository records C3 yet.
  assert.equal(billingDecisionRecorded('ADR-015'), false);
});
