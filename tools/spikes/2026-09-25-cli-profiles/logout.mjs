import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountLogin } from '../../../src/ai/account-login.ts';
import { createProvider } from '../../../src/ai/providers.ts';
import { installedCodex } from '../../../src/ai/paths.ts';

// Never log out a real user profile. Exercise the installed command in an empty owned home.
const directory = await mkdtemp(join(tmpdir(), 'vide-empty-logout-'));
const executable = installedCodex();
const provider = createProvider({ provider: 'codex-cli', executable, configDirectory: directory });
const original = createProvider({ provider: 'codex-cli', executable });
const login = new AccountLogin();
try {
  const before = await original.status();
  const empty = await provider.status();
  assert.equal(empty.available, false);
  assert.equal(empty.reason, 'SUBSCRIPTION_LOGIN_REQUIRED');
  login.start({
    provider: 'codex-cli',
    profileId: 'synthetic',
    directory,
    executable,
    operation: 'logout',
    verify: () => provider.status(),
  });
  const deadline = Date.now() + 20000;
  while (login.busy('codex-cli') && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(login.list()[0].state, 'succeeded', JSON.stringify(login.list()));
  const after = await original.status();
  assert.deepEqual(after, before);
  console.log(
    JSON.stringify({
      passed: true,
      emptyManagedProfileLogout: true,
      defaultStatusUnchanged: true,
      realUserLogout: false,
    }),
  );
} finally {
  await login.close();
  await rm(directory, { recursive: true, force: true });
}
