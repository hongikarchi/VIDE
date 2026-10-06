import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { ClaudeCli } from '../../src/ai/claude-cli.ts';
import { CodexCli } from '../../src/ai/codex-cli.ts';

// ADR-025: VIDE runs each CLI on its default login (AccountSwitch selects the account). No CLI
// gets a config folder from VIDE; one the user set on this PC is that CLI's default login and is
// passed on unchanged (2026-10-06, PLAN-38 T-175).
test('the CLIs run on the default login: VIDE names no config folder, the PC one stays', () => {
  for (const [Cli, key] of [
    [ClaudeCli, 'CLAUDE_CONFIG_DIR'],
    [CodexCli, 'CODEX_HOME'],
  ]) {
    const before = process.env[key];
    process.env[key] = resolve('some-profile');
    try {
      const cli = new Cli({ executable: resolve('test-cli.exe') });
      assert.equal(cli.environment()[key], resolve('some-profile'), key);
      assert.ok(!cli.arguments().some((arg) => arg.includes('cli_auth_credentials_store')));
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  }
});
