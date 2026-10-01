import test from 'node:test';
import assert from 'node:assert/strict';
import { interventionInput } from '../../src/core/intervention.ts';
test('intervention keeps the service, carries no account and rejects account/provider replacement', () => {
  const original = {
    id: 'one',
    body: 'Original',
    provider: 'codex-cli',
    accountProfileId: 'default',
    permission: 'review',
    pins: [],
    sketches: [],
    files: [],
  };
  const next = { ...original, id: 'two', body: 'More' };
  delete next.accountProfileId;
  // Accounts are the CLI's default login (ADR-025): an older request's account is not copied on.
  assert.equal(interventionInput(original, next).accountProfileId, undefined);
  assert.throws(
    () => interventionInput(original, { ...next, accountProfileId: 'default' }),
    /INVALID_INPUT/,
  );
  assert.throws(
    () => interventionInput(original, { ...next, provider: 'claude-cli' }),
    /INVALID_INPUT/,
  );
});
