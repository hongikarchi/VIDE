import assert from 'node:assert/strict';
import { join } from 'node:path';
import { AccountProfiles } from '../../../src/ai/account-profiles.ts';
import { installedCodex } from '../../../src/ai/paths.ts';
import { CodexCli } from '../../../src/ai/codex-cli.ts';

// Two tiny read-only requests. Never inspect or copy CLI credentials or change selection.
const profiles = new AccountProfiles(
  join(process.env.LOCALAPPDATA, 'VIDE', 'cli-profiles'),
  () => true,
);
const second = profiles.list().profiles.find(
  (row) => row.provider === 'codex-cli' && row.label === 'ChatGPT 2',
);
assert.ok(second, 'SECOND_PROFILE_REQUIRED');
const ids=process.argv.includes('--parallel') ? [second.id,second.id] : ['default',second.id];
const run=async(id,index)=>{
  const cli = new CodexCli({
    executable: installedCodex(),
    configDirectory: profiles.directory('codex-cli', id),
    timeoutMs: 90000,
  });
  const status = await cli.status();
  assert.equal(status.available, true, status.reason);
  const marker='VIDE_PROFILE_OK_'+index;
  const result = await cli.run({
    goal: 'Reply with exactly '+marker+'. Do not use tools.',
    revision: 1,
    items: [],
    includedIds: [],
  });
  assert.equal(result.text.trim(), marker);
  console.log(JSON.stringify({
    profile: id === 'default' ? 'default' : 'second',
    authenticated: true,
    responseVerified: true,
    parallel: process.argv.includes('--parallel'),
    request: index,
  }));
};
if(process.argv.includes('--parallel'))await Promise.all(ids.map(run));
else for(const [index,id] of ids.entries())await run(id,index);
