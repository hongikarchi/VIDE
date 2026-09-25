import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  renameSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
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

test('removal cleans only an idle managed profile and persists default selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'vide-remove-profile-'));
  let busy = false;
  try {
    const profiles = new AccountProfiles(root, () => busy);
    const row = profiles.add('codex-cli', 'Remove');
    const keep = profiles.add('claude-cli', 'Keep');
    const directory = profiles.directory('codex-cli', row.id);
    mkdirSync(join(directory, 'history'));
    writeFileSync(join(directory, 'history', 'synthetic.txt'), 'test');
    profiles.select('codex-cli', row.id);
    busy = true;
    assert.throws(() => profiles.remove('codex-cli', row.id), { code: 'PROFILE_IN_USE' });
    assert.equal(existsSync(directory), true);
    busy = false;
    assert.throws(() => profiles.remove('codex-cli', 'default'), { code: 'PROFILE_NOT_FOUND' });
    assert.throws(() => profiles.remove('codex-cli', keep.id), { code: 'PROFILE_NOT_FOUND' });
    profiles.remove('codex-cli', row.id);
    assert.equal(existsSync(directory), false);
    const restored = new AccountProfiles(root, () => false);
    assert.equal(restored.selected('codex-cli'), 'default');
    assert.deepEqual(
      restored.list().profiles.map((p) => p.id),
      [keep.id],
    );
    assert.equal(existsSync(restored.directory('claude-cli', keep.id)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removal refuses nested junctions before deleting any profile content', () => {
  const root = mkdtempSync(join(tmpdir(), 'vide-remove-junction-'));
  try {
    const profiles = new AccountProfiles(join(root, 'profiles'), () => false);
    const row = profiles.add('codex-cli', 'Nested');
    const directory = profiles.directory('codex-cli', row.id);
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'untouched');
    symlinkSync(
      outside,
      join(directory, 'nested'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.throws(() => profiles.remove('codex-cli', row.id), { code: 'PROFILE_PATH_INVALID' });
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'untouched');
    assert.equal(profiles.list().profiles.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('managed profile rejects junction redirection and malformed metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'vide-profile-path-'));
  try {
    const profiles = new AccountProfiles(join(root, 'profiles'), () => false);
    const row = profiles.add('codex-cli', 'Test');
    const target = profiles.directory('codex-cli', row.id);
    renameSync(target, target + '-original');
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), target, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => profiles.directory('codex-cli', row.id), /PROFILE_PATH_INVALID/);
    writeFileSync(join(root, 'profiles', 'profiles.json'), '{}');
    assert.throws(() => new AccountProfiles(join(root, 'profiles'), () => false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
