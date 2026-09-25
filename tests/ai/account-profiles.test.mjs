import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountProfiles } from '../../src/ai/account-profiles.ts';
test('profile metadata persists, provider identities stay separate and busy switch drains', () => {
  const root = mkdtempSync(join(tmpdir(), 'vide-profiles-'));
  let busy = true;
  try {
    const profiles = new AccountProfiles(root, () => busy);
    const a = profiles.add('codex-cli', 'Personal');
    const b = profiles.add('claude-cli', 'Claude');
    assert.throws(() => profiles.directory('codex-cli', b.id), /NOT_FOUND/);
    assert.throws(() => profiles.directory('codex-cli', '../outside'), /NOT_FOUND/);
    profiles.select('codex-cli', a.id);
    assert.throws(() => profiles.selected('codex-cli'), /PENDING/);
    assert.equal(profiles.list().active['codex-cli'], 'default');
    busy = false;
    assert.equal(profiles.selected('codex-cli'), a.id);
    const restored = new AccountProfiles(root, () => false);
    assert.equal(restored.selected('codex-cli'), a.id);
    assert.equal(restored.directory('codex-cli', 'default'), undefined);
    assert.equal(restored.directory('codex-cli', a.id), join(root, a.id));
    assert.equal(readFileSync(join(root, 'profiles.json'), 'utf8').includes(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
