import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ClaudeCli } from '../../src/ai/claude-cli.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';

test('profile directory is explicit and provider-specific; default remains compatible', () => {
  for (const [Cli, key] of [
    [ClaudeCli, 'CLAUDE_CONFIG_DIR'],
    [CodexCli, 'CODEX_HOME'],
  ]) {
    const executable = resolve('test-cli.exe');
    const a = new Cli({ executable, configDirectory: resolve('profile-a') });
    const b = new Cli({ executable, configDirectory: resolve('profile-b') });
    assert.equal(a.environment()[key], resolve('profile-a'));
    assert.equal(b.environment()[key], resolve('profile-b'));
    assert.equal(new Cli({ executable }).environment()[key], undefined);
    assert.throws(
      () => new Cli({ executable, configDirectory: '../outside' }),
      /INVALID_PROFILE_DIRECTORY/,
    );
  }
});
