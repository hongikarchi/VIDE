import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { installedCodex } from '../../../src/ai/paths.ts';
import { ClaudeCli } from '../../../src/ai/claude-cli.ts';
import { CodexCli } from '../../../src/ai/codex-cli.ts';
const root = await mkdtemp(join(tmpdir(), 'vide-profile-probe-'));
try {
  for (const [name, Cli, executable] of [
    ['claude', ClaudeCli, join(homedir(), '.local', 'bin', 'claude.exe')],
    ['codex', CodexCli, installedCodex()],
  ]) {
    const results = [];
    for (const profile of ['a', 'b']) {
      const configDirectory = join(root, name, profile);
      await mkdir(configDirectory, { recursive: true });
      const status = await new Cli({ executable, configDirectory }).status();
      results.push({ profile, available: status.available, reason: status.reason });
    }
    // Never print raw authentication output, directory contents or credentials.
    console.log(JSON.stringify({ provider: name, emptyProfiles: results }));
    if (results.some((x) => x.available)) process.exitCode = 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
